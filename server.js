const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); 

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Errore database:', err.message);
    else {
        console.log('📦 Connesso al database SQLite.');
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS Impostazioni (
                chiave TEXT PRIMARY KEY,
                valore TEXT NOT NULL
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS Reparti (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL UNIQUE,
                richiede_veicolo INTEGER DEFAULT 0
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS Utenti (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                ruolo TEXT NOT NULL,
                reparto TEXT,
                password TEXT NOT NULL
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS Veicoli (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                tipo TEXT NOT NULL
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS Turni (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giorno TEXT NOT NULL,
                orario TEXT NOT NULL,
                utente_id INTEGER,
                sostituto_id INTEGER, 
                veicolo_id INTEGER,
                reparto TEXT NOT NULL,
                stato TEXT NOT NULL,
                FOREIGN KEY(utente_id) REFERENCES Utenti(id),
                FOREIGN KEY(sostituto_id) REFERENCES Utenti(id),
                FOREIGN KEY(veicolo_id) REFERENCES Veicoli(id)
            )`);

            // Seed Dati Iniziali
            db.get("SELECT COUNT(*) AS count FROM Impostazioni", (err, row) => {
                if (row && row.count === 0) {
                    db.run("INSERT INTO Impostazioni (chiave, valore) VALUES ('nome_business', 'Pannello Operativo')");
                    db.run("INSERT INTO Impostazioni (chiave, valore) VALUES ('emoji_business', '🍔🛵')");
                }
            });

            db.get("SELECT COUNT(*) AS count FROM Reparti", (err, row) => {
                if (row && row.count === 0) {
                    const insertR = db.prepare("INSERT INTO Reparti (nome, richiede_veicolo) VALUES (?, ?)");
                    insertR.run("Delivery", 1);
                    insertR.run("Sala", 0);
                    insertR.run("Cucina", 0);
                    insertR.run("Bar", 0);
                    insertR.run("Cassa", 0);
                    insertR.finalize();
                }
            });

            db.get("SELECT COUNT(*) AS count FROM Utenti", (err, row) => {
                if (row && row.count === 0) {
                    const insertU = db.prepare("INSERT INTO Utenti (nome, ruolo, reparto, password) VALUES (?, ?, ?, ?)");
                    insertU.run("Titolare", "manager", "Tutti", "admin123");
                    insertU.run("Marco", "staff", "Delivery", "staff123");
                    insertU.run("Sara", "staff", "Sala", "staff123");
                    insertU.finalize();
                }
            });

            db.get("SELECT COUNT(*) AS count FROM Veicoli", (err, row) => {
                if (row && row.count === 0) {
                    const insertV = db.prepare("INSERT INTO Veicoli (nome, tipo) VALUES (?, ?)");
                    insertV.run("Panda Rossa", "Auto");
                    insertV.run("Scooter 1", "Moto");
                    insertV.run("Scooter 2", "Moto");
                    insertV.finalize();
                }
            });
        });
    }
});

// Funzione ausiliaria per aggiungere N settimane mantenendo il formato YYYY-MM-DD
function calcolaDataFutura(dateStr, numSettimane) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    d.setDate(d.getDate() + (numSettimane * 7));
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// --- API STATISTICHE MENSILI ---
app.get('/api/statistiche/mensili', (req, res) => {
    const mese = req.query.mese; // Formato YYYY-MM
    if (!mese) return res.status(400).json({ error: "Seleziona un mese valido" });

    const query = `
        SELECT Utenti.id, Utenti.nome, Utenti.reparto, COUNT(Turni.id) AS totale_turni
        FROM Utenti
        LEFT JOIN Turni ON Utenti.id = Turni.utente_id AND strftime('%Y-%m', Turni.giorno) = ?
        WHERE Utenti.ruolo != 'manager'
        GROUP BY Utenti.id
    `;
    db.all(query, [mese], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- API IMPOSTAZIONI ---
app.get('/api/impostazioni', (req, res) => {
    db.all("SELECT * FROM Impostazioni", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const impostazioni = {};
        rows.forEach(r => impostazioni[r.chiave] = r.valore);
        res.json(impostazioni);
    });
});

app.put('/api/impostazioni', (req, res) => {
    const { nome_business, emoji_business } = req.body;
    db.serialize(() => {
        if (nome_business) db.run("UPDATE Impostazioni SET valore = ? WHERE chiave = 'nome_business'", [nome_business]);
        if (emoji_business) db.run("UPDATE Impostazioni SET valore = ? WHERE chiave = 'emoji_business'", [emoji_business]);
    });
    res.json({ success: true, message: "Impostazioni aggiornate!" });
});

// --- API REPARTI ---
app.get('/api/reparti', (req, res) => {
    db.all("SELECT * FROM Reparti", [], (err, rows) => res.json(rows));
});

app.post('/api/reparti', (req, res) => {
    const { nome, richiede_veicolo } = req.body;
    if (!nome) return res.status(400).json({ error: "Inserisci il nome del reparto!" });
    db.run("INSERT INTO Reparti (nome, richiede_veicolo) VALUES (?, ?)", [nome, richiede_veicolo ? 1 : 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, message: "Reparto aggiunto!" });
    });
});

app.delete('/api/reparti/:id', (req, res) => {
    db.run("DELETE FROM Reparti WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Reparto eliminato!" });
    });
});

// --- API UTENTI ---
app.get('/api/utenti', (req, res) => {
    db.all("SELECT id, nome, ruolo, reparto FROM Utenti", [], (err, rows) => res.json(rows));
});

app.post('/api/utenti', (req, res) => {
    const { nome, ruolo, reparto, password } = req.body;
    if (!nome || !ruolo || !password) return res.status(400).json({ error: "Compila tutti i campi!" });
    db.run(`INSERT INTO Utenti (nome, ruolo, reparto, password) VALUES (?, ?, ?, ?)`, 
        [nome, ruolo, reparto || 'Generale', password], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, message: "Utente creato!" });
    });
});

app.delete('/api/utenti/:id', (req, res) => {
    db.run(`DELETE FROM Utenti WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Utente rimosso!" });
    });
});

// --- API LOGIN ---
app.post('/api/login', (req, res) => {
    const { utente_id, password } = req.body;
    db.get("SELECT id, nome, ruolo, reparto FROM Utenti WHERE id = ? AND password = ?", [utente_id, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) res.json({ success: true, utente: row });
        else res.status(401).json({ success: false, message: "Password errata!" });
    });
});

// --- API VEICOLI ---
app.get('/api/veicoli', (req, res) => {
    db.all("SELECT * FROM Veicoli", [], (err, rows) => res.json(rows));
});

app.post('/api/veicoli', (req, res) => {
    const { nome, tipo } = req.body;
    if (!nome || !tipo) return res.status(400).json({ error: "Compila tutti i campi!" });
    db.run(`INSERT INTO Veicoli (nome, tipo) VALUES (?, ?)`, [nome, tipo], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, message: "Veicolo aggiunto!" });
    });
});

app.delete('/api/veicoli/:id', (req, res) => {
    db.run(`DELETE FROM Veicoli WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Veicolo rimosso!" });
    });
});

// --- API TURNI (CON SUPPORTO TURNI RICORRENTI) ---
app.post('/api/turni', (req, res) => {
    const { giorno, orario, utente_id, reparto, veicolo_id, settimane } = req.body;
    const numSettimane = Math.max(1, parseInt(settimane) || 1);
    
    const query = `INSERT INTO Turni (giorno, orario, utente_id, reparto, veicolo_id, stato) VALUES (?, ?, ?, ?, ?, 'assegnato')`;
    
    db.serialize(() => {
        const stmt = db.prepare(query);
        for (let i = 0; i < numSettimane; i++) {
            const dataTurno = calcolaDataFutura(giorno, i);
            stmt.run([dataTurno, orario, utente_id, reparto, veicolo_id || null]);
        }
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `${numSettimane} turni salvati con successo!` });
        });
    });
});

app.get('/api/turni', (req, res) => {
    const query = `
        SELECT Turni.*, 
               Proprietario.nome AS nome_proprietario,
               Sostituto.nome AS nome_sostituto,
               Veicoli.nome AS nome_veicolo
        FROM Turni 
        JOIN Utenti AS Proprietario ON Turni.utente_id = Proprietario.id
        LEFT JOIN Utenti AS Sostituto ON Turni.sostituto_id = Sostituto.id
        LEFT JOIN Veicoli ON Turni.veicolo_id = Veicoli.id
        ORDER BY Turni.giorno ASC
    `;
    db.all(query, [], (err, rows) => res.json(rows));
});

app.put('/api/turni/:id/veicolo', (req, res) => {
    const { veicolo_id } = req.body;
    db.run(`UPDATE Turni SET veicolo_id = ? WHERE id = ?`, [veicolo_id || null, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "Veicolo aggiornato!" });
    });
});

app.put('/api/turni/:id/stato', (req, res) => {
    db.run(`UPDATE Turni SET stato = ? WHERE id = ?`, [req.body.stato, req.params.id], () => res.json({ success: true }));
});

app.put('/api/turni/:id/proponi', (req, res) => {
    db.run(`UPDATE Turni SET stato = 'in_approvazione', sostituto_id = ? WHERE id = ?`, [req.body.sostituto_id, req.params.id], () => res.json({ success: true }));
});

app.put('/api/turni/:id/approva', (req, res) => {
    db.run(`UPDATE Turni SET utente_id = sostituto_id, sostituto_id = NULL, stato = 'assegnato' WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.listen(PORT, () => {
    console.log(`🚀 Server acceso sulla porta ${PORT}`);
});