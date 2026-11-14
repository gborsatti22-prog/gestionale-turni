const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

// 2. CREAZIONE TABELLE (Sintassi PostgreSQL Multi-Tenant)
function creaTabelle() {
    const queries = `
        CREATE TABLE IF NOT EXISTS aziende (id SERIAL PRIMARY KEY, nome_locale TEXT);
        CREATE TABLE IF NOT EXISTS impostazioni (id SERIAL PRIMARY KEY, nome_business TEXT, emoji_business TEXT, azienda_id INTEGER);
        CREATE TABLE IF NOT EXISTS reparti (id SERIAL PRIMARY KEY, nome TEXT, richiede_veicolo BOOLEAN, azienda_id INTEGER);
        CREATE TABLE IF NOT EXISTS utenti (id SERIAL PRIMARY KEY, nome TEXT, ruolo TEXT, reparto TEXT, password TEXT, azienda_id INTEGER);
        CREATE TABLE IF NOT EXISTS veicoli (id SERIAL PRIMARY KEY, nome TEXT, tipo TEXT, azienda_id INTEGER);
        CREATE TABLE IF NOT EXISTS turni (
            id SERIAL PRIMARY KEY, 
            giorno TEXT, 
            orario TEXT, 
            utente_id INTEGER, 
            reparto TEXT, 
            veicolo_id INTEGER, 
            sostituto_id INTEGER, 
            stato TEXT,
            azienda_id INTEGER
        );
    `;
    pool.query(queries, (err) => {
        if (err) console.error("Errore creazione tabelle:", err);
        else controllaDatiIniziali();
    });
}

function controllaDatiIniziali() {
    pool.query("SELECT COUNT(*) AS count FROM aziende", (err, result) => {
        if (!err && parseInt(result.rows[0].count) === 0) {
            pool.query("INSERT INTO aziende (nome_locale) VALUES ('La Mia Pizzeria')");
        }
    });

    pool.query("SELECT COUNT(*) AS count FROM utenti", (err, result) => {
        if (!err && parseInt(result.rows[0].count) === 0) {
            pool.query("INSERT INTO utenti (nome, ruolo, reparto, password, azienda_id) VALUES ('Titolare', 'manager', 'Tutti', 'admin123', 1)");
            pool.query("INSERT INTO impostazioni (nome_business, emoji_business, azienda_id) VALUES ('Gestionale Turni', '🍔🛵', 1)");
            console.log("Dati iniziali inseriti.");
        }
    });
}

// --- MIDDLEWARE DI SICUREZZA MULTI-TENANT ---
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/verifica-azienda') || req.path === '/login') {
        return next();
    }
    
    const aziendaId = req.headers['x-azienda-id'];
    if (!aziendaId) {
        return res.status(401).json({ error: "Accesso negato: Codice Azienda mancante." });
    }
    
    req.azienda_id = aziendaId;
    next();
});

// --- API ENDPOINTS ---

// VERIFICA CODICE ATTIVITÀ
app.get('/api/verifica-azienda/:codice', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nome_locale FROM aziende WHERE id = $1", [req.params.codice]);
        if (result.rows.length > 0) res.json({ success: true, azienda: result.rows[0] });
        else res.json({ success: false, message: "Codice attività inesistente." });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// IMPOSTAZIONI
app.get('/api/impostazioni', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM impostazioni WHERE azienda_id = $1 LIMIT 1", [req.azienda_id]);
        res.json(result.rows[0] || {});
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/impostazioni', async (req, res) => {
    try {
        const { nome_business, emoji_business } = req.body;
        await pool.query(
            "UPDATE impostazioni SET nome_business = $1, emoji_business = $2 WHERE azienda_id = $3", 
            [nome_business, emoji_business, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// REPARTI
app.get('/api/reparti', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM reparti WHERE azienda_id = $1", [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reparti', async (req, res) => {
    try {
        await pool.query(
            "INSERT INTO reparti (nome, richiede_veicolo, azienda_id) VALUES ($1, $2, $3)", 
            [req.body.nome, req.body.richiede_veicolo, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reparti/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM reparti WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// UTENTI & LOGIN
app.get('/api/utenti', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nome, ruolo, reparto FROM utenti WHERE azienda_id = $1", [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/utenti', async (req, res) => {
    try {
        const { nome, ruolo, reparto, password } = req.body;
        await pool.query(
            "INSERT INTO utenti (nome, ruolo, reparto, password, azienda_id) VALUES ($1, $2, $3, $4, $5)", 
            [nome, ruolo, reparto, password, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/utenti/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM utenti WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { utente_id, password } = req.body;
        const result = await pool.query(
            "SELECT id, nome, ruolo, reparto, azienda_id FROM utenti WHERE id = $1 AND password = $2", 
            [utente_id, password]
        );
        if (result.rows.length > 0) res.json({ success: true, utente: result.rows[0] });
        else res.json({ success: false, message: "Password errata" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// VEICOLI
app.get('/api/veicoli', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM veicoli WHERE azienda_id = $1", [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/veicoli', async (req, res) => {
    try {
        await pool.query(
            "INSERT INTO veicoli (nome, tipo, azienda_id) VALUES ($1, $2, $3)", 
            [req.body.nome, req.body.tipo, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/veicoli/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM veicoli WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);
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
            WHERE t.azienda_id = $1
            ORDER BY t.giorno ASC, t.orario ASC
        `;
        const result = await pool.query(query, [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/turni', async (req, res) => {
    try {
        // BUG 1 FIXATO: Leggiamo 'ricorrenza' anziché 'settimane' come ci manda il frontend
        let { giorno, orario, utente_id, veicolo_id, ricorrenza, stato } = req.body;
        
        let numSettimane = parseInt(ricorrenza) || 1;
        // BUG 2 FIXATO: Se veicolo_id è una stringa vuota, trasformalo in null per Postgres
        let idVeicoloSafe = veicolo_id ? parseInt(veicolo_id) : null;

        // Ricavo in automatico il reparto associato a questo utente
        const uRes = await pool.query("SELECT reparto FROM utenti WHERE id = $1", [utente_id]);
        let reparto = uRes.rows.length > 0 ? uRes.rows[0].reparto : null;

        let dataCorrente = new Date(giorno);
        
        for (let i = 0; i < numSettimane; i++) {
            // FIX per evitare spostamenti di timezone
            let dataGiorno = new Date(dataCorrente.getTime() - (dataCorrente.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
            
            await pool.query(
                "INSERT INTO turni (giorno, orario, utente_id, reparto, veicolo_id, stato, azienda_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", 
                [dataGiorno, orario, utente_id, reparto, idVeicoloSafe, stato, req.azienda_id]
            );
            dataCorrente.setDate(dataCorrente.getDate() + 7);
        }
        res.json({ success: true });
    } catch (err) { 
        console.error("Errore salvataggio turno:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/turni/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM turni WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ROTTA AGGIUNTA: Modifica orario (chiamata dal tasto "✏️ Modifica Orario")
app.put('/api/turni/:id/orario', async (req, res) => {
    try {
        await pool.query(
            "UPDATE turni SET orario = $1 WHERE id = $2 AND azienda_id = $3", 
            [req.body.orario, req.params.id, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ROTTA AGGIUNTA: Conferma proposta (chiamata dal tasto "✅ Conferma")
app.put('/api/turni/:id/conferma', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET stato = 'confermato' WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/stato', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET stato = $1 WHERE id = $2 AND azienda_id = $3", [req.body.stato, req.params.id, req.azienda_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// FUNZIONE CALCOLO ORE
function calcolaOreTurno(orarioStr) {
    if (!orarioStr || !orarioStr.includes('-')) return 0;
    try {
        const [inizio, fine] = orarioStr.split('-').map(s => s.trim());
        const [hInizio, mInizio] = inizio.split(':').map(Number);
        const [hFine, mFine] = fine.split(':').map(Number);
        let dataInizio = new Date(2000, 0, 1, hInizio, mInizio || 0);
        let dataFine = new Date(2000, 0, 1, hFine, mFine || 0);
        
        // Se il turno finisce dopo mezzanotte
        if (dataFine < dataInizio) dataFine.setDate(dataFine.getDate() + 1);
        
        return (dataFine - dataInizio) / (1000 * 60 * 60);
    } catch (e) { return 0; }
}

// STATISTICHE MENSILI
app.get('/api/statistiche/mensili', async (req, res) => {
    try {
        const mese = req.query.mese; 
        const query = `
            SELECT u.id, u.nome, u.reparto, t.orario
            FROM utenti u
            LEFT JOIN turni t ON u.id = t.utente_id 
                AND t.giorno LIKE $1
                AND t.stato = 'confermato' -- BUG 4 FIXATO (prima era 'assegnato')
                AND t.azienda_id = $2
            WHERE u.ruolo != 'manager' AND u.azienda_id = $2
        `;
        const result = await pool.query(query, [`${mese}-%`, req.azienda_id]);
        
        const statistiche = {};
        result.rows.forEach(row => {
            if (!statistiche[row.id]) statistiche[row.id] = { nome: row.nome, reparto: row.reparto, totale_turni: 0, totale_ore: 0 };
            if (row.orario) { 
                statistiche[row.id].totale_turni += 1;
                statistiche[row.id].totale_ore += calcolaOreTurno(row.orario);
            }
        });

        const statsArray = Object.values(statistiche).sort((a, b) => b.totale_turni - a.totale_turni);
        res.json(statsArray);
    } catch (err) { 
        console.error("Errore statistiche:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// AVVIO SERVER
app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});