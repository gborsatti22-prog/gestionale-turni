const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const morgan = require('morgan');

app.use(express.json());
app.use(morgan('dev'));
app.use(cors());
app.use(express.static('public'));

// 1. CONNESSIONE AL DATABASE CLOUD (NEON)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query("SELECT NOW()", (err, res) => {
    if (err) console.error("Errore di connessione a PostgreSQL:", err);
    else {
        console.log("🚀 Connesso con successo a PostgreSQL su Neon!");
        creaTabelle();
    }
});

// 2. CREAZIONE TABELLE (Sintassi PostgreSQL)
function creaTabelle() {
    const queries = `
        CREATE TABLE IF NOT EXISTS impostazioni (id SERIAL PRIMARY KEY, nome_business TEXT, emoji_business TEXT);
        CREATE TABLE IF NOT EXISTS reparti (id SERIAL PRIMARY KEY, nome TEXT, richiede_veicolo BOOLEAN);
        CREATE TABLE IF NOT EXISTS utenti (id SERIAL PRIMARY KEY, nome TEXT, ruolo TEXT, reparto TEXT, password TEXT);
        CREATE TABLE IF NOT EXISTS veicoli (id SERIAL PRIMARY KEY, nome TEXT, tipo TEXT);
        CREATE TABLE IF NOT EXISTS turni (
            id SERIAL PRIMARY KEY, 
            giorno TEXT, 
            orario TEXT, 
            utente_id INTEGER, 
            reparto TEXT, 
            veicolo_id INTEGER, 
            sostituto_id INTEGER, 
            stato TEXT
        );
    `;
    pool.query(queries, (err) => {
        if (err) console.error("Errore creazione tabelle:", err);
        else controllaDatiIniziali();
    });
}

function controllaDatiIniziali() {
    pool.query("SELECT COUNT(*) AS count FROM utenti", (err, result) => {
        if (!err && parseInt(result.rows[0].count) === 0) {
            pool.query("INSERT INTO utenti (nome, ruolo, reparto, password) VALUES ('Titolare', 'manager', 'Tutti', 'admin123')");
            pool.query("INSERT INTO impostazioni (nome_business, emoji_business) VALUES ('Gestionale Turni', '🍔🛵')");
            console.log("Dati iniziali inseriti.");
        }
    });
}

// --- API ENDPOINTS ---

// IMPOSTAZIONI
app.get('/api/impostazioni', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM impostazioni LIMIT 1");
        res.json(result.rows[0] || {});
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/impostazioni', async (req, res) => {
    try {
        const { nome_business, emoji_business } = req.body;
        await pool.query("UPDATE impostazioni SET nome_business = $1, emoji_business = $2", [nome_business, emoji_business]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// REPARTI
app.get('/api/reparti', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM reparti");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reparti', async (req, res) => {
    try {
        await pool.query("INSERT INTO reparti (nome, richiede_veicolo) VALUES ($1, $2)", [req.body.nome, req.body.richiede_veicolo]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reparti/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM reparti WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// UTENTI & LOGIN
app.get('/api/utenti', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nome, ruolo, reparto FROM utenti");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/utenti', async (req, res) => {
    try {
        const { nome, ruolo, reparto, password } = req.body;
        await pool.query("INSERT INTO utenti (nome, ruolo, reparto, password) VALUES ($1, $2, $3, $4)", [nome, ruolo, reparto, password]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/utenti/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM utenti WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { utente_id, password } = req.body;
        const result = await pool.query("SELECT id, nome, ruolo, reparto FROM utenti WHERE id = $1 AND password = $2", [utente_id, password]);
        if (result.rows.length > 0) res.json({ success: true, utente: result.rows[0] });
        else res.json({ success: false, message: "Password errata" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// VEICOLI
app.get('/api/veicoli', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM veicoli");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/veicoli', async (req, res) => {
    try {
        await pool.query("INSERT INTO veicoli (nome, tipo) VALUES ($1, $2)", [req.body.nome, req.body.tipo]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/veicoli/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM veicoli WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// TURNI
app.get('/api/turni', async (req, res) => {
    try {
        const query = `
            SELECT t.*, u.nome as nome_proprietario, v.nome as nome_veicolo, s.nome as nome_sostituto 
            FROM turni t 
            LEFT JOIN utenti u ON t.utente_id = u.id 
            LEFT JOIN veicoli v ON t.veicolo_id = v.id
            LEFT JOIN utenti s ON t.sostituto_id = s.id
            ORDER BY t.giorno ASC, t.orario ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/turni', async (req, res) => {
    try {
        let { giorno, orario, utente_id, reparto, veicolo_id, settimane, stato } = req.body;
        let dataCorrente = new Date(giorno);
        
        for (let i = 0; i < settimane; i++) {
            let dataGiorno = dataCorrente.toISOString().split('T')[0];
            await pool.query(
                "INSERT INTO turni (giorno, orario, utente_id, reparto, veicolo_id, stato) VALUES ($1, $2, $3, $4, $5, $6)", 
                [dataGiorno, orario, utente_id, reparto, veicolo_id, stato]
            );
            dataCorrente.setDate(dataCorrente.getDate() + 7);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/turni/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM turni WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---> NUOVA: MODIFICA DI UN TURNO ESISTENTE (Titolare) <---
app.put('/api/turni/:id', async (req, res) => {
    try {
        const { giorno, orario, utente_id, reparto, veicolo_id } = req.body;
        await pool.query(
            "UPDATE turni SET giorno = $1, orario = $2, utente_id = $3, reparto = $4, veicolo_id = $5 WHERE id = $6", 
            [giorno, orario, utente_id, reparto, veicolo_id, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/stato', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET stato = $1 WHERE id = $2", [req.body.stato, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/veicolo', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET veicolo_id = $1 WHERE id = $2", [req.body.veicolo_id, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/proponi', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET sostituto_id = $1, stato = 'in_approvazione' WHERE id = $2", [req.body.sostituto_id, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/approva', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET utente_id = sostituto_id, sostituto_id = NULL, stato = 'assegnato' WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ---> NUOVA: STATISTICHE MENSILI CON CALCOLO ORE LORDE <---

// Funzione helper per calcolare le ore da una stringa (es. "08:00 - 14:30")
function calcolaOreTurno(orarioStr) {
    if (!orarioStr || !orarioStr.includes('-')) return 0;
    
    try {
        const [inizio, fine] = orarioStr.split('-').map(s => s.trim());
        const [hInizio, mInizio] = inizio.split(':').map(Number);
        const [hFine, mFine] = fine.split(':').map(Number);

        let dataInizio = new Date(2000, 0, 1, hInizio, mInizio || 0);
        let dataFine = new Date(2000, 0, 1, hFine, mFine || 0);

        // Se il turno finisce il giorno dopo (es. 22:00 - 06:00)
        if (dataFine < dataInizio) dataFine.setDate(dataFine.getDate() + 1);

        const diffMs = dataFine - dataInizio;
        return diffMs / (1000 * 60 * 60); // Converte i millisecondi in ore decimali
    } catch (e) {
        return 0; // Se l'orario non è un range standard (es. "Mattina"), calcola 0 ore
    }
}

app.get('/api/statistiche/mensili', async (req, res) => {
    try {
        const mese = req.query.mese; // Formato YYYY-MM
        const query = `
            SELECT u.id, u.nome, u.reparto, t.orario
            FROM utenti u
            LEFT JOIN turni t ON u.id = t.utente_id 
                AND t.giorno LIKE $1
                AND t.stato = 'assegnato'
            WHERE u.ruolo != 'manager'
        `;
        const result = await pool.query(query, [`${mese}-%`]);
        
        const statistiche = {};
        
        // Raggruppiamo i dati per utente ed eseguiamo la somma in JavaScript
        result.rows.forEach(row => {
            if (!statistiche[row.id]) {
                statistiche[row.id] = { nome: row.nome, reparto: row.reparto, totale_turni: 0, totale_ore: 0 };
            }
            if (row.orario) { // Se è stato trovato un turno assegnato a questo utente
                statistiche[row.id].totale_turni += 1;
                statistiche[row.id].totale_ore += calcolaOreTurno(row.orario);
            }
        });

        // Trasformiamo l'oggetto in un array ordinato per turni totali
        const statsArray = Object.values(statistiche).sort((a, b) => b.totale_turni - a.totale_turni);
        res.json(statsArray);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// AVVIO SERVER
app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});