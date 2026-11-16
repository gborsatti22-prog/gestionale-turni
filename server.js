const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPERADMIN_CODE = 0;
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASSWORD || 'superadmin123';

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
        if (!err && parseInt(result.rows[0].count, 10) === 0) {
            pool.query("INSERT INTO aziende (id, nome_locale) VALUES (1, 'La Mia Pizzeria')");
        }
    });

    pool.query("SELECT COUNT(*) AS count FROM utenti", (err, result) => {
        if (!err && parseInt(result.rows[0].count, 10) === 0) {
            pool.query("INSERT INTO utenti (nome, ruolo, reparto, password, azienda_id) VALUES ('Titolare', 'manager', 'Tutti', 'admin123', 1)");
            pool.query("INSERT INTO impostazioni (nome_business, emoji_business, azienda_id) VALUES ('Gestionale Turni', '🍔🛵', 1)");
            console.log("Dati iniziali inseriti.");
        }
    });
}

// --- MIDDLEWARE DI SICUREZZA MULTI-TENANT & SUPER ADMIN ---
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/verifica-azienda') || req.path === '/login') {
        return next();
    }

    if (req.path.startsWith('/superadmin')) {
        const token = req.headers['x-superadmin-token'];
        if (token !== SUPERADMIN_PASS) {
            return res.status(403).json({ error: "Accesso negato: privilegi Super Admin richiesti." });
        }
        return next();
    }
    
    const aziendaId = req.headers['x-azienda-id'];
    if (aziendaId === undefined || aziendaId === null || aziendaId === '') {
        return res.status(401).json({ error: "Accesso negato: Codice Azienda mancante." });
    }
    
    req.azienda_id = aziendaId;
    next();
});

// --- API VERIFICA CODICE & LOGIN ---
app.get('/api/verifica-azienda/:codice', async (req, res) => {
    try {
        const codiceNum = parseInt(req.params.codice, 10);
        if (codiceNum === SUPERADMIN_CODE) {
            return res.json({
                success: true,
                isSuperAdmin: true,
                azienda: { id: SUPERADMIN_CODE, nome_locale: 'Console Super Admin' }
            });
        }

        const result = await pool.query("SELECT id, nome_locale FROM aziende WHERE id = $1", [codiceNum]);
        if (result.rows.length > 0) {
            res.json({ success: true, isSuperAdmin: false, azienda: result.rows[0] });
        } else {
            res.json({ success: false, message: "Codice attività inesistente." });
        }
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { utente_id, password } = req.body;

        if (utente_id === 'superadmin') {
            if (password === SUPERADMIN_PASS) {
                return res.json({
                    success: true,
                    utente: { id: 0, nome: 'Super Admin', ruolo: 'superadmin', reparto: 'Sistema', azienda_id: 0 },
                    superadminToken: SUPERADMIN_PASS
                });
            } else {
                return res.json({ success: false, message: "Password Super Admin errata" });
            }
        }

        const result = await pool.query(
            "SELECT id, nome, ruolo, reparto, azienda_id FROM utenti WHERE id = $1 AND password = $2", 
            [utente_id, password]
        );
        if (result.rows.length > 0) res.json({ success: true, utente: result.rows[0] });
        else res.json({ success: false, message: "Password errata" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API SUPER ADMIN ---
app.get('/api/superadmin/aziende', async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id, 
                a.nome_locale,
                i.emoji_business,
                (SELECT COUNT(*)::int FROM utenti u WHERE u.azienda_id = a.id) AS totale_utenti,
                (SELECT COUNT(*)::int FROM turni t WHERE t.azienda_id = a.id) AS totale_turni
            FROM aziende a
            LEFT JOIN impostazioni i ON i.azienda_id = a.id
            ORDER BY a.id ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/superadmin/aziende', async (req, res) => {
    try {
        const { codice, nome_locale, emoji_business, password_titolare } = req.body;
        const codiceNum = parseInt(codice, 10);

        if (isNaN(codiceNum) || codiceNum <= 0) {
            return res.json({ success: false, message: "Il codice attività deve essere un numero maggiore di 0 (lo 0 è riservato al Super Admin)." });
        }
        if (!nome_locale || !nome_locale.trim()) {
            return res.json({ success: false, message: "Inserisci il nome dell'attività." });
        }

        const esistente = await pool.query("SELECT id FROM aziende WHERE id = $1", [codiceNum]);
        if (esistente.rows.length > 0) {
            return res.json({ success: false, message: `Il codice #${codiceNum} è già assegnato a un'altra attività!` });
        }

        const nomePulito = nome_locale.trim();
        const emojiPulita = (emoji_business && emoji_business.trim()) ? emoji_business.trim() : '🏢';
        const passTitolare = (password_titolare && password_titolare.trim()) ? password_titolare.trim() : 'admin123';

        await pool.query("INSERT INTO aziende (id, nome_locale) VALUES ($1, $2)", [codiceNum, nomePulito]);
        await pool.query("SELECT setval(pg_get_serial_sequence('aziende', 'id'), COALESCE((SELECT MAX(id) FROM aziende), 1), true)");

        await pool.query(
            "INSERT INTO impostazioni (nome_business, emoji_business, azienda_id) VALUES ($1, $2, $3)",
            [nomePulito, emojiPulita, codiceNum]
        );

        await pool.query(
            "INSERT INTO utenti (nome, ruolo, reparto, password, azienda_id) VALUES ('Titolare', 'manager', 'Tutti', $1, $2)",
            [passTitolare, codiceNum]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("Errore creazione azienda:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/superadmin/aziende/:id/codice', async (req, res) => {
    const vecchioCodice = parseInt(req.params.id, 10);
    const nuovoCodice = parseInt(req.body.nuovo_codice, 10);

    if (isNaN(vecchioCodice) || isNaN(nuovoCodice) || nuovoCodice <= 0) {
        return res.json({ success: false, message: "Il nuovo codice deve essere un numero maggiore di 0 (lo 0 è riservato al Super Admin)." });
    }
    if (vecchioCodice === nuovoCodice) {
        return res.json({ success: false, message: "Il nuovo codice coincide con quello attuale." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const oldCheck = await client.query("SELECT id FROM aziende WHERE id = $1", [vecchioCodice]);
        if (oldCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: "Attività originale non trovata." });
        }

        const newCheck = await client.query("SELECT id FROM aziende WHERE id = $1", [nuovoCodice]);
        if (newCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: `Il codice #${nuovoCodice} è già assegnato a un'altra attività!` });
        }

        await client.query("UPDATE aziende SET id = $1 WHERE id = $2", [nuovoCodice, vecchioCodice]);
        await client.query("UPDATE impostazioni SET azienda_id = $1 WHERE azienda_id = $2", [nuovoCodice, vecchioCodice]);
        await client.query("UPDATE reparti SET azienda_id = $1 WHERE azienda_id = $2", [nuovoCodice, vecchioCodice]);
        await client.query("UPDATE utenti SET azienda_id = $1 WHERE azienda_id = $2", [nuovoCodice, vecchioCodice]);
        await client.query("UPDATE veicoli SET azienda_id = $1 WHERE azienda_id = $2", [nuovoCodice, vecchioCodice]);
        await client.query("UPDATE turni SET azienda_id = $1 WHERE azienda_id = $2", [nuovoCodice, vecchioCodice]);

        await client.query("SELECT setval(pg_get_serial_sequence('aziende', 'id'), COALESCE((SELECT MAX(id) FROM aziende), 1), true)");

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Errore cambio codice azienda:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/superadmin/aziende/:id', async (req, res) => {
    try {
        const idNum = parseInt(req.params.id, 10);
        await pool.query("DELETE FROM turni WHERE azienda_id = $1", [idNum]);
        await pool.query("DELETE FROM veicoli WHERE azienda_id = $1", [idNum]);
        await pool.query("DELETE FROM reparti WHERE azienda_id = $1", [idNum]);
        await pool.query("DELETE FROM utenti WHERE azienda_id = $1", [idNum]);
        await pool.query("DELETE FROM impostazioni WHERE azienda_id = $1", [idNum]);
        await pool.query("DELETE FROM aziende WHERE id = $1", [idNum]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/superadmin/accedi-azienda/:id', async (req, res) => {
    try {
        const idNum = parseInt(req.params.id, 10);
        const azRes = await pool.query("SELECT id, nome_locale FROM aziende WHERE id = $1", [idNum]);
        if (azRes.rows.length === 0) {
            return res.json({ success: false, message: "Attività non trovata." });
        }

        const mgrRes = await pool.query(
            "SELECT id, nome, ruolo, reparto, azienda_id FROM utenti WHERE azienda_id = $1 AND ruolo = 'manager' ORDER BY id ASC LIMIT 1",
            [idNum]
        );

        const managerUtente = mgrRes.rows[0] || {
            id: 0,
            nome: 'Super Admin (Titolare)',
            ruolo: 'manager',
            reparto: 'Tutti',
            azienda_id: idNum
        };

        res.json({ success: true, azienda: azRes.rows[0], utente: managerUtente });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API IMPOSTAZIONI ---
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
        await pool.query(
            "UPDATE aziende SET nome_locale = $1 WHERE id = $2",
            [nome_business, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API REPARTI ---
app.get('/api/reparti', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM reparti WHERE azienda_id = $1 ORDER BY id ASC", [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reparti', async (req, res) => {
    try {
        const nomePulito = (req.body.nome || '').trim();
        await pool.query(
            "INSERT INTO reparti (nome, richiede_veicolo, azienda_id) VALUES ($1, $2, $3)", 
            [nomePulito, Boolean(req.body.richiede_veicolo), req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/reparti/:id/veicolo', async (req, res) => {
    try {
        await pool.query(
            "UPDATE reparti SET richiede_veicolo = $1 WHERE id = $2 AND azienda_id = $3",
            [Boolean(req.body.richiede_veicolo), req.params.id, req.azienda_id]
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

// --- API UTENTI ---
app.get('/api/utenti', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nome, ruolo, reparto FROM utenti WHERE azienda_id = $1 ORDER BY id ASC", [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/utenti', async (req, res) => {
    try {
        const { nome, ruolo, reparto, password } = req.body;
        await pool.query(
            "INSERT INTO utenti (nome, ruolo, reparto, password, azienda_id) VALUES ($1, $2, $3, $4, $5)", 
            [(nome || '').trim(), ruolo, (reparto || '').trim(), password, req.azienda_id]
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

// --- API VEICOLI ---
app.get('/api/veicoli', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM veicoli WHERE azienda_id = $1 ORDER BY id ASC", [req.azienda_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/veicoli', async (req, res) => {
    try {
        await pool.query(
            "INSERT INTO veicoli (nome, tipo, azienda_id) VALUES ($1, $2, $3)", 
            [(req.body.nome || '').trim(), req.body.tipo, req.azienda_id]
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

// --- API TURNI ---
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
        let { giorno, orario, utente_id, veicolo_id, ricorrenza, stato } = req.body;
        
        let numSettimane = parseInt(ricorrenza, 10) || 1;
        let idVeicoloSafe = veicolo_id ? parseInt(veicolo_id, 10) : null;

        const uRes = await pool.query("SELECT reparto FROM utenti WHERE id = $1", [utente_id]);
        let reparto = uRes.rows.length > 0 ? uRes.rows[0].reparto : null;

        const [anno, mese, day] = giorno.split('-').map(Number);
        let dataCorrente = new Date(Date.UTC(anno, mese - 1, day));
        
        for (let i = 0; i < numSettimane; i++) {
            let dataGiorno = dataCorrente.toISOString().split('T')[0];
            
            await pool.query(
                "INSERT INTO turni (giorno, orario, utente_id, reparto, veicolo_id, stato, azienda_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", 
                [dataGiorno, orario, utente_id, reparto, idVeicoloSafe, stato, req.azienda_id]
            );
            dataCorrente.setUTCDate(dataCorrente.getUTCDate() + 7);
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

app.put('/api/turni/:id', async (req, res) => {
    try {
        const { giorno, orario, utente_id, reparto, veicolo_id } = req.body;
        await pool.query(
            "UPDATE turni SET giorno = $1, orario = $2, utente_id = $3, reparto = $4, veicolo_id = $5 WHERE id = $6 AND azienda_id = $7", 
            [giorno, orario, utente_id, reparto, veicolo_id || null, req.params.id, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/orario', async (req, res) => {
    try {
        await pool.query(
            "UPDATE turni SET orario = $1 WHERE id = $2 AND azienda_id = $3", 
            [req.body.orario, req.params.id, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    if (!orarioStr) return 0;
    const match = String(orarioStr).match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|\/|alle|a)\s*(\d{1,2})(?:[:.](\d{2}))?/i);
    if (!match) return 0;

    const hInizio = parseInt(match[1], 10);
    const mInizio = parseInt(match[2] || '0', 10);
    const hFine = parseInt(match[3], 10);
    const mFine = parseInt(match[4] || '0', 10);

    if (isNaN(hInizio) || isNaN(hFine)) return 0;

    let minutiInizio = hInizio * 60 + mInizio;
    let minutiFine = hFine * 60 + mFine;

    if (minutiFine <= minutiInizio) {
        minutiFine += 24 * 60;
    }

    return (minutiFine - minutiInizio) / 60;
}

// STATISTICHE MENSILI
app.get('/api/statistiche/mensili', async (req, res) => {
    try {
        const mese = req.query.mese;
        if (!mese) return res.json([]);

        const query = `
            SELECT u.id, u.nome, u.reparto, t.orario
            FROM utenti u
            LEFT JOIN turni t ON u.id = t.utente_id 
                AND t.giorno LIKE $1
                AND t.stato IN ('confermato', 'assegnato')
                AND t.azienda_id = $2
            WHERE u.ruolo != 'manager' AND u.azienda_id = $2
        `;
        const result = await pool.query(query, [`${mese}-%`, Number(req.azienda_id)]);
        
        const statistiche = {};
        result.rows.forEach(row => {
            if (!statistiche[row.id]) {
                statistiche[row.id] = { nome: row.nome, reparto: row.reparto, totale_turni: 0, totale_ore: 0 };
            }
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