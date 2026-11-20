const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPERADMIN_CODE = 0;
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASSWORD || 'superadmin123';

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@gestionale-turni.it';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log("🔔 Web Push VAPID configurato correttamente!");
} else {
    console.warn("⚠️ Chiavi VAPID non configurate: imposta VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY su Render.");
}

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
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id SERIAL PRIMARY KEY,
            utente_id INTEGER NOT NULL,
            azienda_id INTEGER NOT NULL,
            endpoint TEXT UNIQUE NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL
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

function parseCompitiList(repartoStr) {
    if (!repartoStr) return [];
    return String(repartoStr)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

// --- HELPER INVIO NOTIFICHE PUSH MIRATE ---
async function inviaNotificaUtenti(utenteIds, aziendaId, title, body, tag = 'turno-notifica') {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
    const idsPuliti = [...new Set((utenteIds || []).map(Number).filter(n => !isNaN(n) && n > 0))];
    if (idsPuliti.length === 0) return;

    try {
        const subsRes = await pool.query(
            "SELECT * FROM push_subscriptions WHERE azienda_id = $1 AND utente_id = ANY($2::int[])",
            [Number(aziendaId), idsPuliti]
        );
        if (subsRes.rows.length === 0) return;

        const payload = JSON.stringify({ title, body, tag });

        for (const sub of subsRes.rows) {
            const pushConfig = {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth }
            };
            try {
                await webpush.sendNotification(pushConfig, payload);
            } catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]);
                } else {
                    console.error("Errore invio push a sub", sub.id, err.message);
                }
            }
        }
    } catch (err) {
        console.error("Errore query invio push:", err.message);
    }
}

async function notificaManagerAzienda(aziendaId, title, body, tag = 'manager-notifica') {
    try {
        const res = await pool.query(
            "SELECT id FROM utenti WHERE azienda_id = $1 AND ruolo = 'manager'",
            [Number(aziendaId)]
        );
        const managerIds = res.rows.map(r => r.id);
        await inviaNotificaUtenti(managerIds, aziendaId, title, body, tag);
    } catch (err) {
        console.error("Errore notifica manager:", err.message);
    }
}

async function notificaColleghiReparto(aziendaId, repartoTurno, excludeUtenteId, title, body, tag = 'scambio-notifica') {
    if (!repartoTurno) return;
    try {
        const target = String(repartoTurno).trim().toLowerCase();
        const res = await pool.query(
            "SELECT id, reparto FROM utenti WHERE azienda_id = $1 AND ruolo != 'manager' AND id != $2",
            [Number(aziendaId), Number(excludeUtenteId)]
        );
        const destinatari = res.rows
            .filter(u => parseCompitiList(u.reparto).map(c => c.toLowerCase()).includes(target))
            .map(u => u.id);

        await inviaNotificaUtenti(destinatari, aziendaId, title, body, tag);
    } catch (err) {
        console.error("Errore notifica colleghi reparto:", err.message);
    }
}

// --- HELPER CONTROLLO CONFLITTI E RIPOSO CCNL (11 ORE) ---
function parseIntervalloMinuti(giornoStr, orarioStr) {
    if (!giornoStr || !orarioStr) return null;
    const dateParts = String(giornoStr).split('-').map(Number);
    if (dateParts.length !== 3 || dateParts.some(isNaN)) return null;

    const match = String(orarioStr).match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|\/|alle|a)\s*(\d{1,2})(?:[:.](\d{2}))?/i);
    if (!match) return null;

    const hInizio = parseInt(match[1], 10);
    const mInizio = parseInt(match[2] || '0', 10);
    const hFine = parseInt(match[3], 10);
    const mFine = parseInt(match[4] || '0', 10);

    if (isNaN(hInizio) || isNaN(hFine)) return null;

    const baseDayMin = Math.floor(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]) / 60000);
    const minInizio = hInizio * 60 + mInizio;
    let minFine = hFine * 60 + mFine;

    if (minFine <= minInizio) {
        minFine += 24 * 60;
    }

    return {
        minInizio,
        minFine,
        startEpochMin: baseDayMin + minInizio,
        endEpochMin: baseDayMin + minFine,
        durationHours: (minFine - minInizio) / 60
    };
}

function spostaGiornoStr(giornoStr, deltaGiorni) {
    const [anno, mese, day] = giornoStr.split('-').map(Number);
    const d = new Date(Date.UTC(anno, mese - 1, day + deltaGiorni));
    return d.toISOString().split('T')[0];
}

// --- HELPER FESTIVITÀ ITALIANE & CALCOLO ORE ORDINARIE / NOTTURNE / FESTIVE ---
function calcolaPasquaUTC(anno) {
    const a = anno % 19;
    const b = Math.floor(anno / 100);
    const c = anno % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mese = Math.floor((h + l - 7 * m + 114) / 31);
    const giorno = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(anno, mese - 1, giorno));
}

function isGiornoFestivoItalia(giornoStr) {
    const [anno, mese, day] = giornoStr.split('-').map(Number);
    const dataUTC = new Date(Date.UTC(anno, mese - 1, day));

    if (dataUTC.getUTCDay() === 0) return true;

    const mmdd = `${String(mese).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const festiviFissi = [
        '01-01', '01-06', '04-25', '05-01', '06-02',
        '08-15', '11-01', '12-08', '12-25', '12-26'
    ];
    if (festiviFissi.includes(mmdd)) return true;

    const pasqua = calcolaPasquaUTC(anno);
    const pasquetta = new Date(pasqua.getTime() + 24 * 60 * 60 * 1000);
    return giornoStr === pasqua.toISOString().split('T')[0] || giornoStr === pasquetta.toISOString().split('T')[0];
}

function calcolaDettaglioOreTurno(giornoStr, orarioStr) {
    const intervallo = parseIntervalloMinuti(giornoStr, orarioStr);
    if (!intervallo) {
        return {
            ore_ordinarie: 0,
            ore_notturne: 0,
            ore_festive: 0,
            ore_notturne_festive: 0,
            totale_ore: 0
        };
    }

    let minOrdinarie = 0;
    let minNotturne = 0;
    let minFestive = 0;
    let minNotturneFestive = 0;

    for (let m = intervallo.minInizio; m < intervallo.minFine; m++) {
        const dayOffset = Math.floor(m / 1440);
        const mod = m % 1440;
        const dataCorrente = dayOffset === 0 ? giornoStr : spostaGiornoStr(giornoStr, dayOffset);

        const isNotturno = (mod >= 22 * 60 || mod < 6 * 60);
        const isFestivo = isGiornoFestivoItalia(dataCorrente);

        if (!isNotturno && !isFestivo) minOrdinarie++;
        else if (isNotturno && !isFestivo) minNotturne++;
        else if (!isNotturno && isFestivo) minFestive++;
        else minNotturneFestive++;
    }

    const round2 = (n) => Math.round((n / 60) * 100) / 100;

    return {
        ore_ordinarie: round2(minOrdinarie),
        ore_notturne: round2(minNotturne),
        ore_festive: round2(minFestive),
        ore_notturne_festive: round2(minNotturneFestive),
        totale_ore: round2(intervallo.minFine - intervallo.minInizio)
    };
}

async function verificaConflittiTurni(aziendaId, candidati, excludeTurnoId = null) {
    const statiAttivi = ['confermato', 'assegnato', 'scambio', 'scambio_proposto'];
    const warningsRiposo = [];

    const utentiRes = await pool.query("SELECT id, nome FROM utenti WHERE azienda_id = $1", [aziendaId]);
    const mappaUtenti = {};
    utentiRes.rows.forEach(u => { mappaUtenti[Number(u.id)] = u.nome; });

    const veicoliRes = await pool.query("SELECT id, nome FROM veicoli WHERE azienda_id = $1", [aziendaId]);
    const mappaVeicoli = {};
    veicoliRes.rows.forEach(v => { mappaVeicoli[Number(v.id)] = v.nome; });

    const tuttiTurniRes = await pool.query(
        `SELECT t.*, u.nome AS nome_proprietario, v.nome AS nome_veicolo
         FROM turni t
         LEFT JOIN utenti u ON t.utente_id = u.id
         LEFT JOIN veicoli v ON t.veicolo_id = v.id
         WHERE t.azienda_id = $1`,
        [aziendaId]
    );

    const turniEsistenti = tuttiTurniRes.rows.filter(t => excludeTurnoId === null || Number(t.id) !== Number(excludeTurnoId));
    const processatiNelBatch = [];

    for (const cand of candidati) {
        const uid = Number(cand.utente_id);
        const vid = cand.veicolo_id ? Number(cand.veicolo_id) : null;
        const nomeDip = mappaUtenti[uid] || 'Il dipendente';
        const intervalloCand = parseIntervalloMinuti(cand.giorno, cand.orario);

        const assenza = turniEsistenti.find(
            t => Number(t.utente_id) === uid && t.giorno === cand.giorno && t.stato === 'indisponibile'
        );
        if (assenza) {
            return {
                bloccato: true,
                message: `❌ Impossibile assegnare il turno il ${cand.giorno}: ${nomeDip} ha segnalato un'assenza/indisponibilità (${assenza.orario || 'Non disponibile'}).`
            };
        }

        const poolConfronto = [...turniEsistenti, ...processatiNelBatch];

        for (const es of poolConfronto) {
            if (!statiAttivi.includes(es.stato)) continue;
            const intervalloEs = parseIntervalloMinuti(es.giorno, es.orario);

            if (Number(es.utente_id) === uid) {
                if (intervalloCand && intervalloEs) {
                    const siSovrappongono =
                        intervalloCand.startEpochMin < intervalloEs.endEpochMin &&
                        intervalloEs.startEpochMin < intervalloCand.endEpochMin;

                    if (siSovrappongono) {
                        return {
                            bloccato: true,
                            message: `❌ Conflitto orario il ${cand.giorno}: ${nomeDip} ha già un turno (${es.giorno} | ${es.orario}${es.reparto ? ` - ${es.reparto}` : ''}) che si sovrappone a ${cand.orario}.`
                        };
                    }

                    let gapMinuti = null;
                    if (intervalloEs.endEpochMin <= intervalloCand.startEpochMin) {
                        gapMinuti = intervalloCand.startEpochMin - intervalloEs.endEpochMin;
                    } else if (intervalloCand.endEpochMin <= intervalloEs.startEpochMin) {
                        gapMinuti = intervalloEs.startEpochMin - intervalloCand.endEpochMin;
                    }

                    if (gapMinuti !== null && gapMinuti < 660) {
                        const oreRiposo = (gapMinuti / 60).toFixed(1);
                        warningsRiposo.push(
                            `• ${cand.giorno} (${cand.orario}): per ${nomeDip} passano solo ${oreRiposo} ore di riposo rispetto al turno del ${es.giorno} (${es.orario}) — minimo consigliato CCNL: 11 ore.`
                        );
                    }
                } else if (es.giorno === cand.giorno) {
                    return {
                        bloccato: true,
                        message: `❌ Conflitto turno il ${cand.giorno}: ${nomeDip} ha già un turno registrato (${es.orario}).`
                    };
                }
            }

            if (vid && es.veicolo_id && Number(es.veicolo_id) === vid) {
                const nomeMezzo = mappaVeicoli[vid] || es.nome_veicolo || 'Veicolo';
                const altroRider = es.nome_proprietario || mappaUtenti[Number(es.utente_id)] || 'un altro dipendente';

                if (intervalloCand && intervalloEs) {
                    const mezzoSovrapposto =
                        intervalloCand.startEpochMin < intervalloEs.endEpochMin &&
                        intervalloEs.startEpochMin < intervalloCand.endEpochMin;

                    if (mezzoSovrapposto) {
                        return {
                            bloccato: true,
                            message: `❌ Conflitto mezzo il ${cand.giorno}: "${nomeMezzo}" è già assegnato a ${altroRider} nella fascia ${es.giorno} | ${es.orario}.`
                        };
                    }
                } else if (es.giorno === cand.giorno) {
                    return {
                        bloccato: true,
                        message: `❌ Conflitto mezzo il ${cand.giorno}: "${nomeMezzo}" è già assegnato a ${altroRider} (${es.orario}).`
                    };
                }
            }
        }

        processatiNelBatch.push({
            giorno: cand.giorno,
            orario: cand.orario,
            utente_id: uid,
            veicolo_id: vid,
            reparto: cand.reparto,
            stato: 'confermato',
            nome_proprietario: nomeDip,
            nome_veicolo: vid ? mappaVeicoli[vid] : null
        });
    }

    return {
        bloccato: false,
        warnings: [...new Set(warningsRiposo)]
    };
}

// --- HEALTHCHECK LEGGERO (NON TOCCA IL DB) ---
app.get('/ping', (req, res) => res.status(200).send('OK'));

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

// --- API NOTIFICHE PUSH (ATTIVA / VERIFICA / DISATTIVA) ---
app.get('/api/push/vapid-public-key', (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        return res.status(503).json({ error: "Chiavi VAPID non configurate sul server." });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/check', async (req, res) => {
    try {
        const { utente_id, endpoint } = req.body;
        if (!utente_id || !endpoint) {
            return res.json({ active: false });
        }
        const result = await pool.query(
            "SELECT id FROM push_subscriptions WHERE utente_id = $1 AND azienda_id = $2 AND endpoint = $3 LIMIT 1",
            [Number(utente_id), Number(req.azienda_id), endpoint]
        );
        res.json({ active: result.rows.length > 0 });
    } catch (err) {
        res.json({ active: false });
    }
});

app.post('/api/push/subscribe', async (req, res) => {
    try {
        const { utente_id, subscription } = req.body;
        if (!utente_id || !subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({ success: false, message: "Dati subscription non validi." });
        }

        await pool.query(
            `INSERT INTO push_subscriptions (utente_id, azienda_id, endpoint, p256dh, auth)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (endpoint) DO UPDATE
             SET utente_id = EXCLUDED.utente_id,
                 azienda_id = EXCLUDED.azienda_id,
                 p256dh = EXCLUDED.p256dh,
                 auth = EXCLUDED.auth`,
            [
                Number(utente_id),
                Number(req.azienda_id),
                subscription.endpoint,
                subscription.keys.p256dh,
                subscription.keys.auth
            ]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Errore salvataggio push subscription:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/push/unsubscribe', async (req, res) => {
    try {
        const { utente_id, endpoint } = req.body;
        if (!utente_id) {
            return res.status(400).json({ success: false, message: "Utente non valido." });
        }

        if (endpoint) {
            await pool.query(
                "DELETE FROM push_subscriptions WHERE utente_id = $1 AND azienda_id = $2 AND endpoint = $3",
                [Number(utente_id), Number(req.azienda_id), endpoint]
            );
        } else {
            await pool.query(
                "DELETE FROM push_subscriptions WHERE utente_id = $1 AND azienda_id = $2",
                [Number(utente_id), Number(req.azienda_id)]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error("Errore disattivazione push subscription:", err.message);
        res.status(500).json({ error: err.message });
    }
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
        await client.query("UPDATE push_subscriptions SET azienda_id = $1 WHERE azienda_id = $2", [nuovoCodice, vecchioCodice]);

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
        await pool.query("DELETE FROM push_subscriptions WHERE azienda_id = $1", [idNum]);
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

// --- API REPARTI / COMPITI ---
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
        const { nome, ruolo, reparto, reparti, password } = req.body;
        let repartoFinale = '';
        if (Array.isArray(reparti) && reparti.length > 0) {
            repartoFinale = reparti.map(r => String(r).trim()).filter(Boolean).join(', ');
        } else {
            repartoFinale = (reparto || '').trim();
        }
        await pool.query(
            "INSERT INTO utenti (nome, ruolo, reparto, password, azienda_id) VALUES ($1, $2, $3, $4, $5)", 
            [(nome || '').trim(), ruolo, repartoFinale, password, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/utenti/:id/reparti', async (req, res) => {
    try {
        const { reparti, reparto } = req.body;
        let repartoFinale = '';
        if (Array.isArray(reparti)) {
            repartoFinale = reparti.map(r => String(r).trim()).filter(Boolean).join(', ');
        } else {
            repartoFinale = (reparto || '').trim();
        }
        await pool.query(
            "UPDATE utenti SET reparto = $1 WHERE id = $2 AND azienda_id = $3",
            [repartoFinale, req.params.id, req.azienda_id]
        );
        res.json({ success: true, reparto: repartoFinale });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/utenti/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM push_subscriptions WHERE utente_id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);
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

// --- API TURNI & SCAMBI ---
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
        let { giorno, orario, utente_id, reparto, veicolo_id, ricorrenza, stato, forza_riposo } = req.body;
        
        let numSettimane = parseInt(ricorrenza, 10) || 1;
        let idVeicoloSafe = veicolo_id ? parseInt(veicolo_id, 10) : null;

        const uRes = await pool.query("SELECT nome, reparto FROM utenti WHERE id = $1", [utente_id]);
        const nomeDip = uRes.rows.length > 0 ? uRes.rows[0].nome : 'Dipendente';
        let repartoFinale = (reparto || '').trim();
        if (!repartoFinale && stato !== 'indisponibile') {
            const compitiUtente = uRes.rows.length > 0 ? parseCompitiList(uRes.rows[0].reparto) : [];
            repartoFinale = compitiUtente[0] || null;
        }

        const candidati = [];
        for (let i = 0; i < numSettimane; i++) {
            candidati.push({
                giorno: spostaGiornoStr(giorno, i * 7),
                orario,
                utente_id,
                reparto: repartoFinale,
                veicolo_id: idVeicoloSafe
            });
        }

        if (stato !== 'indisponibile') {
            const check = await verificaConflittiTurni(req.azienda_id, candidati);
            if (check.bloccato) {
                return res.json({ success: false, message: check.message });
            }
            if (check.warnings.length > 0 && !forza_riposo) {
                return res.json({
                    success: false,
                    richiedeConfermaRiposo: true,
                    warnings: check.warnings
                });
            }
        }

        for (const cand of candidati) {
            await pool.query(
                "INSERT INTO turni (giorno, orario, utente_id, reparto, veicolo_id, stato, azienda_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", 
                [cand.giorno, cand.orario, cand.utente_id, cand.reparto, cand.veicolo_id, stato, req.azienda_id]
            );
        }

        // Notifiche push mirate in base al tipo di inserimento
        if (stato === 'confermato') {
            const msg = numSettimane > 1
                ? `Ti sono stati assegnati ${numSettimane} turni dal ${giorno} (${orario})${repartoFinale ? ` • ${repartoFinale}` : ''}.`
                : `Nuovo turno il ${giorno} (${orario})${repartoFinale ? ` • ${repartoFinale}` : ''}.`;
            await inviaNotificaUtenti([utente_id], req.azienda_id, '📅 Nuovo Turno Assegnato', msg, 'nuovo-turno');
        } else if (stato === 'proposta') {
            await notificaManagerAzienda(
                req.azienda_id,
                '✋ Nuova Proposta Turno',
                `${nomeDip} ha proposto disponibilità per il ${giorno} (${orario}).`,
                'proposta-turno'
            );
        } else if (stato === 'indisponibile') {
            await notificaManagerAzienda(
                req.azienda_id,
                '🚫 Assenza Segnalata',
                `${nomeDip} ha segnalato assenza il ${giorno} (${orario}).`,
                'assenza-turno'
            );
        }

        res.json({ success: true });
    } catch (err) { 
        console.error("Errore salvataggio turno:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/turni/:id', async (req, res) => {
    try {
        const turnoRes = await pool.query(
            "SELECT * FROM turni WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );
        const t = turnoRes.rows[0];

        await pool.query("DELETE FROM turni WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);

        if (t && t.utente_id) {
            if (t.stato === 'proposta') {
                await inviaNotificaUtenti(
                    [t.utente_id],
                    req.azienda_id,
                    '❌ Proposta Turno Rimossa',
                    `La proposta per il ${t.giorno} (${t.orario}) non è più attiva.`,
                    'turno-eliminato'
                );
            } else if (t.stato !== 'indisponibile') {
                await inviaNotificaUtenti(
                    [t.utente_id],
                    req.azienda_id,
                    '🗑️ Turno Annullato',
                    `Il turno del ${t.giorno} (${t.orario}) è stato rimosso dalla bacheca.`,
                    'turno-eliminato'
                );
            }
        }

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id', async (req, res) => {
    try {
        const { giorno, orario, utente_id, reparto, veicolo_id, forza_riposo } = req.body;
        const check = await verificaConflittiTurni(
            req.azienda_id,
            [{ giorno, orario, utente_id, reparto, veicolo_id: veicolo_id || null }],
            req.params.id
        );
        if (check.bloccato) {
            return res.json({ success: false, message: check.message });
        }
        if (check.warnings.length > 0 && !forza_riposo) {
            return res.json({ success: false, richiedeConfermaRiposo: true, warnings: check.warnings });
        }

        await pool.query(
            "UPDATE turni SET giorno = $1, orario = $2, utente_id = $3, reparto = $4, veicolo_id = $5 WHERE id = $6 AND azienda_id = $7", 
            [giorno, orario, utente_id, reparto, veicolo_id || null, req.params.id, req.azienda_id]
        );

        await inviaNotificaUtenti(
            [utente_id],
            req.azienda_id,
            '✏️ Turno Aggiornato',
            `Il tuo turno del ${giorno} è stato aggiornato (${orario}).`,
            'turno-modificato'
        );

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/orario', async (req, res) => {
    try {
        const turnoRes = await pool.query(
            "SELECT * FROM turni WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );
        if (turnoRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Turno non trovato." });
        }
        const t = turnoRes.rows[0];

        const check = await verificaConflittiTurni(
            req.azienda_id,
            [{ giorno: t.giorno, orario: req.body.orario, utente_id: t.utente_id, reparto: t.reparto, veicolo_id: t.veicolo_id }],
            req.params.id
        );
        if (check.bloccato) {
            return res.json({ success: false, message: check.message });
        }
        if (check.warnings.length > 0 && !req.body.forza_riposo) {
            return res.json({ success: false, richiedeConfermaRiposo: true, warnings: check.warnings });
        }

        await pool.query(
            "UPDATE turni SET orario = $1 WHERE id = $2 AND azienda_id = $3", 
            [req.body.orario, req.params.id, req.azienda_id]
        );

        await inviaNotificaUtenti(
            [t.utente_id],
            req.azienda_id,
            '✏️ Orario Turno Modificato',
            `Il tuo turno del ${t.giorno} ha un nuovo orario: ${req.body.orario}.`,
            'turno-modificato'
        );

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/conferma', async (req, res) => {
    try {
        const turnoRes = await pool.query(
            "SELECT * FROM turni WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );
        if (turnoRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Turno non trovato." });
        }
        const t = turnoRes.rows[0];

        const check = await verificaConflittiTurni(
            req.azienda_id,
            [{ giorno: t.giorno, orario: t.orario, utente_id: t.utente_id, reparto: t.reparto, veicolo_id: t.veicolo_id }],
            req.params.id
        );
        if (check.bloccato) {
            return res.json({ success: false, message: check.message });
        }
        if (check.warnings.length > 0 && !(req.body && req.body.forza_riposo)) {
            return res.json({ success: false, richiedeConfermaRiposo: true, warnings: check.warnings });
        }

        await pool.query("UPDATE turni SET stato = 'confermato' WHERE id = $1 AND azienda_id = $2", [req.params.id, req.azienda_id]);

        await inviaNotificaUtenti(
            [t.utente_id],
            req.azienda_id,
            '✅ Turno Confermato',
            `La tua proposta per il ${t.giorno} (${t.orario}) è stata confermata!`,
            'turno-confermato'
        );

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/stato', async (req, res) => {
    try {
        await pool.query("UPDATE turni SET stato = $1 WHERE id = $2 AND azienda_id = $3", [req.body.stato, req.params.id, req.azienda_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ENDPOINT SCAMBIO TURNO ---
app.put('/api/turni/:id/richiedi-scambio', async (req, res) => {
    try {
        const turnoRes = await pool.query(
            `SELECT t.*, u.nome AS nome_proprietario
             FROM turni t
             LEFT JOIN utenti u ON t.utente_id = u.id
             WHERE t.id = $1 AND t.azienda_id = $2 AND t.stato = 'confermato'`,
            [req.params.id, req.azienda_id]
        );
        if (turnoRes.rows.length === 0) {
            return res.json({ success: false, message: "Turno non disponibile per lo scambio." });
        }
        const t = turnoRes.rows[0];

        await pool.query(
            "UPDATE turni SET stato = 'scambio', sostituto_id = NULL WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );

        await notificaColleghiReparto(
            req.azienda_id,
            t.reparto,
            t.utente_id,
            '🔄 Richiesta Scambio Turno',
            `${t.nome_proprietario || 'Un collega'} cerca sostituzione il ${t.giorno} (${t.orario}) • ${t.reparto || ''}.`,
            'scambio-aperto'
        );

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/annulla-scambio', async (req, res) => {
    try {
        await pool.query(
            "UPDATE turni SET stato = 'confermato', sostituto_id = NULL WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/accetta-scambio', async (req, res) => {
    try {
        const sostitutoId = parseInt(req.body.sostituto_id, 10);
        if (!sostitutoId) {
            return res.status(400).json({ success: false, message: "Utente non valido." });
        }

        const turnoRes = await pool.query(
            `SELECT t.*, u.nome AS nome_proprietario
             FROM turni t
             LEFT JOIN utenti u ON t.utente_id = u.id
             WHERE t.id = $1 AND t.azienda_id = $2`,
            [req.params.id, req.azienda_id]
        );
        if (turnoRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Turno non trovato." });
        }
        const turno = turnoRes.rows[0];

        if (turno.stato !== 'scambio') {
            return res.json({ success: false, message: "Questo turno non è più disponibile per lo scambio." });
        }
        if (Number(turno.utente_id) === sostitutoId) {
            return res.json({ success: false, message: "Non puoi accettare il tuo stesso turno." });
        }

        const candidatoRes = await pool.query(
            "SELECT id, nome, reparto FROM utenti WHERE id = $1 AND azienda_id = $2",
            [sostitutoId, req.azienda_id]
        );
        if (candidatoRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Dipendente non trovato." });
        }

        const compitiCandidato = parseCompitiList(candidatoRes.rows[0].reparto).map(c => c.toLowerCase());
        const repartoTurno = (turno.reparto || '').trim().toLowerCase();

        if (!repartoTurno || !compitiCandidato.includes(repartoTurno)) {
            return res.status(403).json({
                success: false,
                message: `Puoi accettare solo scambi del tuo stesso reparto/compito (${turno.reparto || 'non specificato'}).`
            });
        }

        const check = await verificaConflittiTurni(
            req.azienda_id,
            [{ giorno: turno.giorno, orario: turno.orario, utente_id: sostitutoId, reparto: turno.reparto, veicolo_id: null }],
            req.params.id
        );
        if (check.bloccato) {
            return res.json({ success: false, message: check.message });
        }

        await pool.query(
            "UPDATE turni SET stato = 'scambio_proposto', sostituto_id = $1 WHERE id = $2 AND azienda_id = $3",
            [sostitutoId, req.params.id, req.azienda_id]
        );

        const nomeSostituto = candidatoRes.rows[0].nome;
        await notificaManagerAzienda(
            req.azienda_id,
            '🤝 Scambio da Approvare',
            `${nomeSostituto} si è proposto al posto di ${turno.nome_proprietario || 'un collega'} il ${turno.giorno} (${turno.orario}).`,
            'scambio-proposto'
        );
        await inviaNotificaUtenti(
            [turno.utente_id],
            req.azienda_id,
            '🤝 Sostituto Trovato',
            `${nomeSostituto} ha accettato il tuo turno del ${turno.giorno} (${turno.orario}). In attesa del Titolare.`,
            'scambio-proposto'
        );

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/ritira-scambio', async (req, res) => {
    try {
        await pool.query(
            "UPDATE turni SET stato = 'scambio', sostituto_id = NULL WHERE id = $1 AND azienda_id = $2 AND stato = 'scambio_proposto'",
            [req.params.id, req.azienda_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/approva-scambio', async (req, res) => {
    try {
        const turnoRes = await pool.query(
            "SELECT * FROM turni WHERE id = $1 AND azienda_id = $2 AND stato = 'scambio_proposto'",
            [req.params.id, req.azienda_id]
        );
        if (turnoRes.rows.length === 0 || !turnoRes.rows[0].sostituto_id) {
            return res.json({ success: false, message: "Nessun sostituto da approvare per questo turno." });
        }
        const t = turnoRes.rows[0];

        const check = await verificaConflittiTurni(
            req.azienda_id,
            [{ giorno: t.giorno, orario: t.orario, utente_id: t.sostituto_id, reparto: t.reparto, veicolo_id: t.veicolo_id }],
            req.params.id
        );
        if (check.bloccato) {
            return res.json({ success: false, message: check.message });
        }
        if (check.warnings.length > 0 && !(req.body && req.body.forza_riposo)) {
            return res.json({ success: false, richiedeConfermaRiposo: true, warnings: check.warnings });
        }

        await pool.query(
            "UPDATE turni SET utente_id = sostituto_id, sostituto_id = NULL, stato = 'confermato' WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );

        await inviaNotificaUtenti(
            [t.utente_id],
            req.azienda_id,
            '✅ Scambio Approvato',
            `Lo scambio per il turno del ${t.giorno} (${t.orario}) è stato confermato dal Titolare.`,
            'scambio-approvato'
        );
        await inviaNotificaUtenti(
            [t.sostituto_id],
            req.azienda_id,
            '✅ Nuovo Turno da Scambio',
            `Scambio approvato! Ora il turno del ${t.giorno} (${t.orario}) è assegnato a te.`,
            'scambio-approvato'
        );

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/turni/:id/rifiuta-scambio', async (req, res) => {
    try {
        const turnoRes = await pool.query(
            "SELECT * FROM turni WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );
        const t = turnoRes.rows[0];

        await pool.query(
            "UPDATE turni SET stato = 'confermato', sostituto_id = NULL WHERE id = $1 AND azienda_id = $2",
            [req.params.id, req.azienda_id]
        );

        if (t) {
            await inviaNotificaUtenti(
                [t.utente_id],
                req.azienda_id,
                '❌ Scambio Rifiutato',
                `Lo scambio per il ${t.giorno} (${t.orario}) non è stato approvato: il turno resta a te.`,
                'scambio-rifiutato'
            );
            if (t.sostituto_id) {
                await inviaNotificaUtenti(
                    [t.sostituto_id],
                    req.azienda_id,
                    '❌ Scambio Rifiutato',
                    `La proposta di sostituzione per il ${t.giorno} (${t.orario}) non è stata approvata.`,
                    'scambio-rifiutato'
                );
            }
        }

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- STATISTICHE MENSILI CON ORE ORDINARIE / NOTTURNE / FESTIVE ---
app.get('/api/statistiche/mensili', async (req, res) => {
    try {
        const mese = req.query.mese;
        if (!mese) return res.json({ mese: '', riepilogo: [], dettaglio_turni: [] });

        const query = `
            SELECT 
                u.id, 
                u.nome, 
                u.reparto, 
                t.id AS turno_id,
                t.giorno,
                t.orario,
                t.reparto AS reparto_turno,
                v.nome AS nome_veicolo
            FROM utenti u
            LEFT JOIN turni t ON u.id = t.utente_id 
                AND t.giorno LIKE $1
                AND t.stato IN ('confermato', 'assegnato', 'scambio', 'scambio_proposto')
                AND t.azienda_id = $2
            LEFT JOIN veicoli v ON t.veicolo_id = v.id
            WHERE u.ruolo != 'manager' AND u.azienda_id = $2
            ORDER BY u.id ASC, t.giorno ASC, t.orario ASC
        `;
        const result = await pool.query(query, [`${mese}-%`, Number(req.azienda_id)]);
        
        const statistiche = {};
        const dettaglioTurni = [];
        const round2 = (n) => Math.round(n * 100) / 100;

        result.rows.forEach(row => {
            if (!statistiche[row.id]) {
                statistiche[row.id] = {
                    id: row.id,
                    nome: row.nome,
                    reparto: row.reparto,
                    totale_turni: 0,
                    ore_ordinarie: 0,
                    ore_notturne: 0,
                    ore_festive: 0,
                    ore_notturne_festive: 0,
                    totale_ore: 0
                };
            }
            if (row.orario && row.giorno) {
                const dett = calcolaDettaglioOreTurno(row.giorno, row.orario);
                statistiche[row.id].totale_turni += 1;
                statistiche[row.id].ore_ordinarie = round2(statistiche[row.id].ore_ordinarie + dett.ore_ordinarie);
                statistiche[row.id].ore_notturne = round2(statistiche[row.id].ore_notturne + dett.ore_notturne);
                statistiche[row.id].ore_festive = round2(statistiche[row.id].ore_festive + dett.ore_festive);
                statistiche[row.id].ore_notturne_festive = round2(statistiche[row.id].ore_notturne_festive + dett.ore_notturne_festive);
                statistiche[row.id].totale_ore = round2(statistiche[row.id].totale_ore + dett.totale_ore);

                dettaglioTurni.push({
                    giorno: row.giorno,
                    dipendente: row.nome,
                    reparto: row.reparto_turno || row.reparto || '-',
                    orario: row.orario,
                    mezzo: row.nome_veicolo || '-',
                    ore_ordinarie: dett.ore_ordinarie,
                    ore_notturne: dett.ore_notturne,
                    ore_festive: dett.ore_festive,
                    ore_notturne_festive: dett.ore_notturne_festive,
                    totale_ore: dett.totale_ore
                });
            }
        });

        dettaglioTurni.sort((a, b) => a.giorno.localeCompare(b.giorno) || a.dipendente.localeCompare(b.dipendente));
        const statsArray = Object.values(statistiche).sort((a, b) => b.totale_ore - a.totale_ore || b.totale_turni - a.totale_turni);

        res.json({
            mese,
            riepilogo: statsArray,
            dettaglio_turni: dettaglioTurni
        });
    } catch (err) { 
        console.error("Errore statistiche:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// AVVIO SERVER
app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});
