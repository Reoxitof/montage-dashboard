const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const multer = require("multer");
const OBSWebSocket = require("obs-websocket-js").default;
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const bcrypt = require("bcryptjs");

/* ================= PERSISTENT STATE FILE ================= */

const STATE_FILE = path.join(__dirname, "state.json");

function loadPersistentState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
        }
    } catch (e) {
        console.log("[STATE] Erreur lecture state.json :", e.message);
    }
    return null;
}

function savePersistentState() {
    try {
        const data = {
            subGoal: state.subGoal,
            stats: state.stats,
            points: state.points,
            customCommands: state.customCommands,
            moderation: state.moderation,
            moderationWarnings: state.moderationWarnings,
            moderationLogs: state.moderationLogs,
            theme: state.theme,
            scene: state.scene,
            alertMessages: state.alertMessages,
            recentFollows: state.recentFollows || [],
            recentSubs: state.recentSubs || [],
            recentTips: state.recentTips || [],
            recentCheers: state.recentCheers || [],
            recentRaids: state.recentRaids || [],
            alertLog: state.alertLog || []
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
        console.log("[STATE] Erreur sauvegarde :", e.message);
    }
}

/* ================= CONFIG ================= */

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));

// Les variables d'environnement ont priorité sur config.json (utile pour Sliplane/Docker)
if (process.env.SERVER_PORT)       config.server.port       = parseInt(process.env.SERVER_PORT);
if (process.env.PUBLIC_URL)        config.server.publicUrl  = process.env.PUBLIC_URL;
if (process.env.TWITCH_CHANNEL)    config.twitch.channel    = process.env.TWITCH_CHANNEL;
if (process.env.TWITCH_CHANNEL)    config.twitch.owner      = process.env.TWITCH_CHANNEL;
if (process.env.TWITCH_CHANNEL)    config.twitch.botUsername = process.env.TWITCH_CHANNEL;
if (process.env.TWITCH_OAUTH)      config.twitchApi.oauthToken = process.env.TWITCH_OAUTH;
if (process.env.TWITCH_CLIENT_ID)  config.twitchApi.clientId   = process.env.TWITCH_CLIENT_ID;
if (process.env.TWITCH_BROADCASTER_ID) config.twitchApi.broadcasterId = process.env.TWITCH_BROADCASTER_ID;
if (process.env.OBS_BRIDGE_URL)    config.obsBridge.url     = process.env.OBS_BRIDGE_URL;
if (process.env.OBS_BRIDGE_TOKEN)  config.obsBridge.token   = process.env.OBS_BRIDGE_TOKEN;
if (process.env.SESSION_SECRET)    config.localAuth.sessionSecret = process.env.SESSION_SECRET;
if (process.env.OWNER_USERNAME)    config.localAuth.ownerUsername = process.env.OWNER_USERNAME;

const APP_PORT = config.server.port || 8080;
const APP_HOST = config.server.mode === "local" ? "127.0.0.1" : (config.server.host || "0.0.0.0");
const PUBLIC_URL = config.server.publicUrl || `http://${APP_HOST === "0.0.0.0" ? "127.0.0.1" : APP_HOST}:${APP_PORT}`;

const TWITCH_CHANNEL = config.twitch.channel;
const OWNER_TWITCH = config.twitch.owner;

const TWITCH_CLIENT_ID = config.twitchApi?.clientId || "";
const TWITCH_OAUTH = config.twitchApi?.oauthToken || "";
const TWITCH_BROADCASTER_ID = config.twitchApi?.broadcasterId || "";


/* ================= OBS WEBSOCKET PRO ================= */

const obs = new OBSWebSocket();
let obsConnected = false;
let obsConnecting = false;

let obsState = {
    connected: false,
    connecting: false,
    lastError: null,
    lastConnect: null,
    lastDisconnect: null,
    reconnectCount: 0
};

function emitOBSStatus() {
    try {
        io.emit("obsStatus", obsState);
    } catch (e) {}
}

async function connectOBS(force = false) {
    if (!config.obs?.enabled) {
        obsState.connected = false;
        obsState.connecting = false;
        obsState.lastError = obsBridgeEnabled() ? "OBS direct désactivé : bridge actif" : "OBS désactivé dans config.json";
        emitOBSStatus();
        return false;
    }

    if (obsState.connected && !force) return true;
    if (obsState.connecting && !force) return obsState.connected;

    obsState.connecting = true;
    obsState.lastError = null;
    emitOBSStatus();

    try {
        if (force && obsConnected) {
            try { await obs.disconnect(); } catch (e) {}
        }

        await obs.connect(config.obs.url || "ws://127.0.0.1:4455", config.obs.password || "");

        obsState.connected = true;
        obsState.connecting = false;
        obsState.lastError = null;
        obsState.lastConnect = new Date().toISOString();
        obsState.reconnectCount++;

        obsConnected = true;

        console.log("[OBS] ✅ Connecté");
        emitOBSStatus();
        return true;
    } catch (e) {
        obsState.connected = false;
        obsState.connecting = false;
        obsState.lastError = e.message;
        obsConnected = false;

        console.log("[OBS] ❌ Erreur :", e.message);
        emitOBSStatus();
        return false;
    }
}

async function safeOBSCall(request, data = {}) {
    const connected = await connectOBS();

    if (!connected) {
        const err = new Error(obsState.lastError || "OBS non connecté");
        err.code = "OBS_NOT_CONNECTED";
        throw err;
    }

    try {
        return await obs.call(request, data);
    } catch (e) {
        obsState.connected = false;
        obsState.lastError = e.message;
        obsConnected = false;
        emitOBSStatus();
        throw e;
    }
}

obs.on("ConnectionClosed", () => {
    obsState.connected = false;
    obsState.connecting = false;
    obsState.lastDisconnect = new Date().toISOString();
    obsConnected = false;
    console.log("[OBS] 🔌 Déconnecté");
    emitOBSStatus();
});

obs.on("Identified", () => {
    console.log("[OBS] 🔐 Auth OK");
});

if (config.obs?.enabled && !obsBridgeEnabled()) {
    connectOBS();
}

/* Auto reconnexion OBS */
setInterval(() => {
    if (config.obs?.enabled && !obsBridgeEnabled() && !obsState.connected && !obsState.connecting) {
        connectOBS();
    }
}, 5000);

/* ================= EXPRESS + SOCKET.IO ================= */

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());

// Créer le dossier sessions si inexistant (évite crash FileStore)
try { fs.mkdirSync(path.join(__dirname, "sessions"), { recursive: true }); } catch(e) {}

app.use(session({
    store: new FileStore({
        path: path.join(__dirname, "sessions"),
        ttl: 60 * 60 * 24 * 7,
        retries: 0,
        reapInterval: 3600,
        logFn: () => {}
    }),
    secret: config.localAuth?.sessionSecret || "CHANGE_ME_LOCAL_SESSION",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

// ═══ PostgreSQL Auth ═══
const { Pool } = require("pg");

const pgPool = new Pool({
    host:     process.env.PG_HOST     || "postgres-5ljq.internal",
    port:     parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DB       || "mydb",
    user:     process.env.PG_USER     || "postgres",
    password: process.env.PG_PASSWORD || "montage2026",
    ssl: false,
    connectionTimeoutMillis: 5000
});

async function initDb() {
    console.log("[AUTH] Connexion PostgreSQL →", process.env.PG_HOST || "postgres-3ixu.internal", "| user:", process.env.PG_USER || "postgres", "| pass défini:", !!(process.env.PG_PASSWORD));
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            "passwordHash" TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'neutre',
            "createdAt" TEXT NOT NULL,
            "lastLoginAt" TEXT,
            "lastSeenAt" TEXT,
            "loginCount" INTEGER DEFAULT 0,
            "twitchToken" TEXT
        )
    `);
    // Table tokens de session (pour FiveM / clients sans cookies)
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS session_tokens (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            last_used_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    // Nettoyage des tokens expirés au démarrage
    await pgPool.query(`DELETE FROM session_tokens WHERE expires_at < NOW()`).catch(() => {});
    console.log("[AUTH] PostgreSQL prêt");
}

function dbSave() {} // no-op avec Postgres

async function dbRow(sql, params=[]) {
    // Convertit les ? en $1, $2...
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const res = await pgPool.query(pgSql, params);
    return res.rows[0] || null;
}

async function dbAll(sql, params=[]) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const res = await pgPool.query(pgSql, params);
    return res.rows;
}

function localAuthEnabled() {
    return config.localAuth?.enabled !== false;
}

async function loadUsers() {
    return { users: await dbAll('SELECT * FROM users') };
}

function saveUsers() {}

async function dbGetUser(username) {
    return dbRow('SELECT * FROM users WHERE username = $1', [username]);
}

async function dbGetUserById(id) {
    return dbRow('SELECT * FROM users WHERE id = $1', [id]);
}

async function dbCreateUser(user) {
    await pgPool.query(
        `INSERT INTO users (id,username,email,"passwordHash",role,"createdAt","lastLoginAt","lastSeenAt","loginCount")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [user.id, user.username, user.email||null, user.passwordHash, user.role, user.createdAt, user.lastLoginAt||null, user.lastSeenAt||null, user.loginCount||0]
    );
}

async function dbUpdateUser(id, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
    await pgPool.query(
        `UPDATE users SET ${sets} WHERE id = $${keys.length + 1}`,
        [...keys.map(k => fields[k]), id]
    );
}

async function dbCountUsers() {
    const res = await pgPool.query("SELECT COUNT(*) as c FROM users");
    return parseInt(res.rows[0]?.c || 0);
}

// Init DB au démarrage
initDb().catch(e => console.error("[AUTH] Erreur PostgreSQL :", e.message));

// Charger le profil overlay sauvegardé
async function loadSavedProfile() {
    try {
        await pgPool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
        const res = await pgPool.query(`SELECT value FROM settings WHERE key = 'activeProfile'`);
        if (res.rows.length > 0) {
            const profileId = res.rows[0].value;
            if (config.overlayProfiles?.[profileId]) {
                config.overlay.activeProfile = profileId;
                const p = config.overlayProfiles[profileId];
                config.overlay.rotatingTexts = p.rotatingTexts;
                config.overlay.discordInvite = p.discordInvite;
                console.log("[PROFILE] Profil restauré :", profileId);
            }
        }
    } catch(e) {










    }
}
// loadSavedProfile() est appelé dans start() async


/* ================= TOKEN AUTH (FiveM / sans cookies) ================= */

const TOKEN_TTL_DAYS = 30;

async function createSessionToken(userId) {
    const token = crypto.randomBytes(48).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await pgPool.query(
        `INSERT INTO session_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
        [token, userId, expiresAt]
    );
    return token;
}

async function validateSessionToken(token) {
    if (!token || typeof token !== "string" || token.length < 10) return null;
    try {
        const res = await pgPool.query(
            `SELECT st.token, st.user_id, st.expires_at, u.*
             FROM session_tokens st
             JOIN users u ON u.id = st.user_id
             WHERE st.token = $1 AND st.expires_at > NOW()`,
            [token]
        );
        if (!res.rows.length) return null;
        const row = res.rows[0];
        // Mise à jour last_used_at (fire-and-forget)
        pgPool.query(`UPDATE session_tokens SET last_used_at = NOW() WHERE token = $1`, [token]).catch(() => {});
        return row;
    } catch (e) {
        return null;
    }
}

async function revokeSessionToken(token) {
    await pgPool.query(`DELETE FROM session_tokens WHERE token = $1`, [token]).catch(() => {});
}

// Nettoyage tokens expirés toutes les heures
setInterval(() => {
    pgPool.query(`DELETE FROM session_tokens WHERE expires_at < NOW()`).catch(() => {});
}, 60 * 60 * 1000);

/**
 * Middleware : accepte session cookie OU Bearer token OU ?token= dans l'URL.
 * Remplit req.session.user si token valide.
 */
async function resolveAuthFromToken(req, res, next) {
    // Déjà authentifié via session cookie
    if (req.session?.user) return next();

    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const queryToken = req.query.token ? String(req.query.token).trim() : null;
    const token = bearerToken || queryToken;

    if (!token) return next();

    const user = await validateSessionToken(token);
    if (user) {
        req.session.user = sanitizeUser(user);
        req.tokenAuth = true; // flag pour savoir qu'on est passé par token
    }
    next();
}

function sanitizeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        email: user.email || null,
        role: user.role,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt || null,
        lastSeenAt: user.lastSeenAt || null,
        loginCount: user.loginCount || 0
    };
}


function isValidDashboardRole(role) {
    return ["admin", "mod", "neutre"].includes(String(role || "").toLowerCase());
}

function requireDashboardAuth(req, res, next) {
    if (!localAuthEnabled()) return next();
    if (req.session?.user?.role === "admin" || req.session?.user?.role === "mod") return next();
    if (req.session?.user?.role === "neutre") return res.redirect("/welcome.html");
    return res.redirect("/login.html");
}

function requireLogin(req, res, next) {
    if (!localAuthEnabled()) return next();
    if (req.session?.user) return next();
    return res.status(401).json({ error: "login_required" });
}

function requireAdmin(req, res, next) {
    if (!localAuthEnabled()) return next();
    if (req.session?.user?.role === "admin") return next();
    return res.status(403).json({ error: "admin_required" });
}

function requireModOrAdmin(req, res, next) {
    if (!localAuthEnabled()) return next();
    if (req.session?.user?.role === "admin" || req.session?.user?.role === "mod") return next();
    return res.status(403).json({ error: "moderator_required" });
}

function renderAuthPage(type, req, res) {
    const isRegister = type === "register";
    const title = isRegister ? "Créer un compte" : "Connexion";
    const switchText = isRegister ? "Déjà un compte ?" : "Pas encore de compte ?";
    const switchUrl = isRegister ? "/login.html" : "/register.html";
    const switchLabel = isRegister ? "Se connecter" : "Créer un compte";
    const error = req.query.error ? `<div class="auth-error">${String(req.query.error)}</div>` : "";

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Reoxitof — ${title}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Anton&display=swap');
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#2b1642,#08040d 52%,#020105);color:#e8e0f0;font-family:Inter,Arial;display:flex;align-items:center;justify-content:center}
.card{width:min(460px,92vw);background:rgba(26,18,40,.94);border:1px solid rgba(155,89,182,.35);border-radius:22px;padding:34px;box-shadow:0 20px 70px rgba(0,0,0,.55),0 0 50px rgba(155,89,182,.16)}
h1{font-family:Anton,Arial;letter-spacing:3px;margin:0 0 8px;font-size:30px}
p{color:#9a8fb0;line-height:1.5;margin:0 0 24px}
label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#c39bd3;font-weight:800;margin:14px 0 7px}
input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid rgba(155,89,182,.28);background:#08040d;color:white;font-weight:700;outline:none}
input:focus{border-color:#9b59b6}
.btn{width:100%;margin-top:18px;border:0;color:white;background:linear-gradient(135deg,#9b59b6,#7d3c98);padding:14px 18px;border-radius:12px;font-weight:900;letter-spacing:1px;cursor:pointer;box-shadow:0 12px 30px rgba(155,89,182,.25)}
.auth-error{margin-bottom:16px;padding:10px 12px;border-radius:10px;background:rgba(226,64,64,.16);border:1px solid rgba(226,64,64,.35);color:#ffb8b8;font-weight:800}
.switch{display:block;margin-top:18px;color:#c39bd3;text-decoration:none;font-weight:800}
small{display:block;margin-top:16px;color:#7f7394;line-height:1.4}
</style>
</head>
<body>
<div class="card">
${error}
<h1>REOXITOF PANEL</h1>
<p>${title} sécurisé pour le dashboard. Admin = accès complet, Modérateur = modération + vote.</p>
<form method="POST" action="${isRegister ? "/auth/register" : "/auth/login"}">
<label>Pseudo</label>
<input name="username" autocomplete="username" required minlength="3" maxlength="32">
<label>Mot de passe</label>
<input name="password" type="password" autocomplete="${isRegister ? "new-password" : "current-password"}" required minlength="6">
<button class="btn" type="submit">${title}</button>
</form>
<a class="switch" href="${switchUrl}">${switchText} ${switchLabel}</a>
<small>Premier compte = admin si aucun utilisateur n'existe.</small>
</div>
</body>
</html>`);
}

app.use(express.urlencoded({ extended: true }));

// Résolution auth par token Bearer / ?token= (avant tous les middlewares de protection)
app.use(resolveAuthFromToken);

/* AUTH STATIC FINAL + ROLE NEUTRE */
app.get(["/login.html", "/login"], (req, res) => {
    console.log("[AUTH] LOGIN STATIC FILE SERVED");

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get(["/register.html", "/register"], (req, res) => {
    if (config.localAuth?.allowRegister === false) {
        return res.redirect("/login.html?error=register_disabled");
    }

    console.log("[AUTH] REGISTER STATIC FILE SERVED");

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.sendFile(path.join(__dirname, "public", "register.html"));
});
/* END AUTH STATIC FINAL + ROLE NEUTRE */






app.post("/auth/register", async (req, res) => {
    try {
        if (config.localAuth?.allowRegister === false) {
            if (req.headers["accept"]?.includes("application/json") || req.headers["x-requested-with"] === "fetch") {
                return res.status(403).json({ error: "register_disabled" });
            }
            return res.redirect("/login.html?error=register_disabled");
        }

        const username = String(req.body.username || "").toLowerCase().trim();
        const email = String(req.body.email || "").toLowerCase().trim() || null;
        const password = String(req.body.password || "");

        const isJsonRequest = req.headers["accept"]?.includes("application/json") || req.headers["x-requested-with"] === "fetch";

        if (!/^[a-z0-9_]{3,32}$/.test(username)) {
            if (isJsonRequest) return res.status(400).json({ error: "pseudo_invalide" });
            return res.redirect("/register.html?error=pseudo_invalide");
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (isJsonRequest) return res.status(400).json({ error: "email_invalide" });
            return res.redirect("/register.html?error=email_invalide");
        }
        if (!email) {
            if (isJsonRequest) return res.status(400).json({ error: "email_requis" });
            return res.redirect("/register.html?error=email_requis");
        }
        if (password.length < 8) {
            if (isJsonRequest) return res.status(400).json({ error: "mot_de_passe_trop_court" });
            return res.redirect("/register.html?error=mot_de_passe_trop_court");
        }
        if (await dbGetUser(username)) {
            if (isJsonRequest) return res.status(409).json({ error: "compte_existe" });
            return res.redirect("/register.html?error=compte_existe");
        }
        if (email) {
            const existing = await dbRow("SELECT id FROM users WHERE email = $1", [email]);
            if (existing) {
                if (isJsonRequest) return res.status(409).json({ error: "email_existe" });
                return res.redirect("/register.html?error=email_existe");
            }
        }

        const isFirst = (await dbCountUsers()) === 0;
        const owner = String(config.localAuth?.ownerUsername || "reoxitof").toLowerCase();
        const role = (isFirst && config.localAuth?.firstUserAdmin !== false) || username === owner ? "admin" : "neutre";
        const now = new Date().toISOString();
        const user = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            username,
            email,
            passwordHash: await bcrypt.hash(password, 12),
            role,
            createdAt: now,
            lastLoginAt: now,
            lastSeenAt: now,
            loginCount: 1
        };
        await dbCreateUser(user);
        req.session.user = sanitizeUser(user);

        if (isJsonRequest) {
            const token = await createSessionToken(user.id);
            return res.json({ success: true, token, user: sanitizeUser(user) });
        }

        const returnTo = req.body.returnTo || req.query.returnTo || "/dashboard.html";
        res.redirect(returnTo.startsWith("/") ? returnTo : "/dashboard.html");
    } catch (e) {
        console.log("[AUTH] Register error :", e.message);
        if (req.headers["accept"]?.includes("application/json") || req.headers["x-requested-with"] === "fetch") {
            return res.status(500).json({ error: "server_error" });
        }
        res.redirect("/register.html?error=server_error");
    }
});
app.post("/auth/login", async (req, res) => {
    try {
        const identifier = String(req.body.username || "").toLowerCase().trim();
        const password = String(req.body.password || "");
        const isJsonRequest = req.headers["accept"]?.includes("application/json") || req.headers["x-requested-with"] === "fetch";

        // Support login by username or email
        let user = await dbGetUser(identifier);
        if (!user && identifier.includes("@")) {
            user = await dbRow("SELECT * FROM users WHERE email = $1", [identifier]);
        }
        if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
            if (isJsonRequest) return res.status(401).json({ error: "identifiants_invalides" });
            return res.redirect("/login.html?error=identifiants_invalides");
        }
        const now = new Date().toISOString();
        await dbUpdateUser(user.id, { lastLoginAt: now, lastSeenAt: now, loginCount: (user.loginCount || 0) + 1 });
        req.session.user = sanitizeUser({ ...user, lastLoginAt: now });

        if (isJsonRequest) {
            const token = await createSessionToken(user.id);
            return res.json({ success: true, token, user: sanitizeUser({ ...user, lastLoginAt: now }) });
        }

        const role = user.role || "neutre";
        res.redirect(role === "neutre" ? "/welcome.html" : "/dashboard.html");
    } catch (e) {
        console.log("[AUTH] Login error :", e.message);
        if (req.headers["accept"]?.includes("application/json") || req.headers["x-requested-with"] === "fetch") {
            return res.status(500).json({ error: "server_error" });
        }
        res.redirect("/login.html?error=server_error");
    }
});
app.get("/auth/me", async (req, res) => {
    if (req.session?.user?.id) {
        try {
            const user = await dbGetUserById(req.session.user.id);
            if (user) {
                const now = new Date().toISOString();
                await dbUpdateUser(user.id, { lastSeenAt: now });
                req.session.user = sanitizeUser({ ...user, lastSeenAt: now });
            }
        } catch (e) {
            console.log("[AUTH] lastSeen update error :", e.message);
        }
    }
    res.json({ user: req.session?.user || null });
});
app.post("/auth/logout", async (req, res) => {
    // Révoquer le token Bearer si présent
    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const queryToken = req.query.token ? String(req.query.token).trim() : null;
    const token = bearerToken || queryToken;
    if (token) await revokeSessionToken(token);

    req.session.destroy(() => res.json({ success: true }));
});

// Génère un token depuis une session cookie existante (pour les clients qui veulent passer en token)
app.post("/auth/token", async (req, res) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: "login_required" });
    try {
        const token = await createSessionToken(req.session.user.id);
        res.json({ success: true, token, user: req.session.user });
    } catch (e) {
        res.status(500).json({ error: "token_creation_failed" });
    }
});

app.post("/auth/users/:id/role", requireAdmin, async (req, res) => {
    const user = await dbGetUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const role = String(req.body.role || "");
    if (!isValidDashboardRole(role)) return res.status(400).json({ error: "bad_role" });
    await dbUpdateUser(user.id, { role });
    res.json({ success: true, user: sanitizeUser({ ...user, role }) });
});

/* TOKEN TWITCH MODO */
app.post("/auth/twitch-token", requireLogin, async (req, res) => {
    const token = String(req.body.token || "").trim();
    if (!token) return res.status(400).json({ error: "Token requis" });
    const cleanToken = token.replace(/^oauth:/i, "");
    await dbUpdateUser(req.session.user.id, { twitchToken: cleanToken });
    res.json({ success: true, message: "Token Twitch enregistré" });
});

app.delete("/auth/twitch-token", requireLogin, async (req, res) => {
    await dbUpdateUser(req.session.user.id, { twitchToken: null });
    res.json({ success: true, message: "Token Twitch supprimé" });
});

/* ROLE NEUTRE */
app.post("/auth/users/:id/neutral", requireAdmin, async (req, res) => {
    const user = await dbGetUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    await dbUpdateUser(user.id, { role: "neutre" });
    res.json({ success: true, user: sanitizeUser({ ...user, role: "neutre" }) });
});

app.get("/auth/users", requireAdmin, async (req, res) => {
    const users = await dbAll("SELECT * FROM users ORDER BY \"createdAt\" DESC");
    res.json({ users: users.map(sanitizeUser) });
});


/* ================= BACKUP COMPTES ================= */

app.get("/auth/users/backup", requireAdmin, (req, res) => {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            return res.status(404).json({ error: "users_file_not_found" });
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="users-backup-${stamp}.json"`);
        res.send(fs.readFileSync(USERS_FILE, "utf-8"));
    } catch (e) {
        console.log("[AUTH] Backup users error :", e.message);
        res.status(500).json({ error: "backup_error" });
    }
});

app.post("/auth/users/backup-file", requireAdmin, (req, res) => {
    try {
        const backupDir = path.join(__dirname, "backups");
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = path.join(backupDir, `users-backup-${stamp}.json`);

        const data = fs.existsSync(USERS_FILE)
            ? fs.readFileSync(USERS_FILE, "utf-8")
            : JSON.stringify({ users: [] }, null, 2);

        fs.writeFileSync(backupPath, data, "utf-8");

        res.json({
            success: true,
            file: path.basename(backupPath),
            path: backupPath
        });
    } catch (e) {
        console.log("[AUTH] Backup file error :", e.message);
        res.status(500).json({ error: "backup_error" });
    }
});

function secureWriteApis(req, res, next) {
    if (!localAuthEnabled()) return next();

    const modPaths = [
        "/moderation/action",
        "/moderation/reset-warning",
        "/moderation/bannedWords",
        "/vote/start",
        "/vote/stop",
        "/poll/start",
        "/poll/stop"
    ];

    if (modPaths.some(p => req.path.startsWith(p))) {
        return requireModOrAdmin(req, res, next);
    }

    const adminPaths = [
        "/theme",
        "/scene",
        "/subgoal",
        "/custom-command",
        "/screen-overlay",
        "/brb",
        "/upload-sound"
    ];

    if (adminPaths.some(p => req.path.startsWith(p))) {
        return requireAdmin(req, res, next);
    }

    next();
}

app.use(secureWriteApis);

app.get("/dashboard.html", requireDashboardAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/vote.html", (req, res) => res.sendFile(path.join(__dirname, "public", "vote.html")));
app.get("/radio.html", (req, res) => res.sendFile(path.join(__dirname, "public", "radio.html")));
// Redirige reoxitof.online vers la page vitrine
app.get("/", (req, res) => {
    const host = req.hostname || "";
    if (host === "reoxitof.online" || host === "www.reoxitof.online") {
        return res.sendFile(path.join(__dirname, "public", "home.html"));
    }
    return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/home", (req, res) => res.sendFile(path.join(__dirname, "public", "home.html")));

app.use(express.static(path.join(__dirname, "public"), { index: false }));


/* ================= FULL OBS CONTROL — LOCAL BRIDGE PROXY ================= */

function getObsBridgeConfig() {
    return {
        enabled: !!config.obsBridge?.enabled,
        url: String(config.obsBridge?.url || "").trim().replace(/\/+$/, ""),
        token: process.env.OBS_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || config.obsBridge?.token || ""
    };
}


/* ================= AUTO OBS BRIDGE FIX ================= */

function getObsBridgeUrl() {
    const url =
        process.env.OBS_BRIDGE_URL ||
        config.obsBridge?.url ||
        "";

    return String(url || "").trim().replace(/\/+$/, "");
}

function getObsBridgeToken() {
    return String(
        process.env.OBS_BRIDGE_TOKEN ||
        process.env.BRIDGE_TOKEN ||
        config.obsBridge?.token ||
        ""
    ).trim();
}

function obsBridgeEnabled() {
    return Boolean(config.obsBridge?.enabled || process.env.OBS_BRIDGE_URL);
}

/* Appel via relay Socket.IO quand pas d'URL directe */
function callObsBridgeViaRelay(endpoint, body = {}, method = "GET") {
    return new Promise((resolve, reject) => {
        if (!relaySocket) return reject(Object.assign(new Error("relay_not_connected"), { code: "RELAY_NOT_CONNECTED" }));
        const timeout = setTimeout(() => reject(Object.assign(new Error("obs_bridge_timeout"), { code: "OBS_BRIDGE_CALL_FAILED" })), 8000);
        const token = getObsBridgeToken();
        relaySocket.emit("relay:request", {
            path: endpoint,
            query: "",
            method,
            headers: token ? { "x-bridge-token": token } : {},
            body: method !== "GET" ? Buffer.from(JSON.stringify(body)).toString("base64") : null
        }, (data) => {
            clearTimeout(timeout);
            if (!data) return reject(Object.assign(new Error("relay_empty_response"), { code: "OBS_BRIDGE_CALL_FAILED" }));
            try {
                const parsed = JSON.parse(Buffer.from(data.body, "base64").toString("utf-8"));
                if (data.status >= 400) return reject(Object.assign(new Error(parsed.error || `obs_bridge_http_${data.status}`), { code: "OBS_BRIDGE_CALL_FAILED" }));
                resolve(parsed);
            } catch (e) {
                reject(Object.assign(new Error("relay_parse_error"), { code: "OBS_BRIDGE_CALL_FAILED" }));
            }
        });
    });
}

async function callObsBridge(endpoint, body = {}, method = "POST") {
    if (!obsBridgeEnabled()) {
        const err = new Error("obs_bridge_disabled");
        err.code = "OBS_BRIDGE_DISABLED";
        throw err;
    }

    const baseUrl = getObsBridgeUrl();

    // Pas d'URL directe → on passe par le relay
    if (!baseUrl) {
        return callObsBridgeViaRelay(endpoint, body, method);
    }

    const url = baseUrl + endpoint;
    const token = getObsBridgeToken();

    const headers = {
        "Content-Type": "application/json"
    };

    if (token) {
        headers["x-bridge-token"] = token;
        headers["authorization"] = `Bearer ${token}`;
    }

    const options = { method, headers };

    if (method !== "GET") {
        options.body = JSON.stringify(body || {});
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    options.signal = controller.signal;

    try {
        const res = await fetch(url, options);
        clearTimeout(timeout);

        const text = await res.text();
        let data = {};

        try {
            data = text ? JSON.parse(text) : {};
        } catch (e) {
            data = { raw: text };
        }

        if (!res.ok) {
            const error = data.error || data.message || `obs_bridge_http_${res.status}`;
            throw new Error(error);
        }

        return data;
    } catch (e) {
        clearTimeout(timeout);
        const msg = e.name === "AbortError" ? "obs_bridge_timeout" : (e.message || String(e));
        const err = new Error(msg);
        err.code = "OBS_BRIDGE_CALL_FAILED";
        throw err;
    }
}

app.get("/health", (req, res) => res.json({ success: true, name: "Reoxitof Final God Panel", time: new Date().toISOString() }));

app.get("/obs/bridge/status", async (req, res) => {
    try {
        if (!obsBridgeEnabled()) {
            return res.json({
                success: false,
                enabled: false,
                error: "obs_bridge_disabled",
                url: getObsBridgeUrl()
            });
        }

        const data = await callObsBridge("/health", {}, "GET").catch(async () => {
            return await callObsBridge("/", {}, "GET");
        });

        res.json({
            success: true,
            enabled: true,
            url: getObsBridgeUrl(),
            bridge: data
        });
    } catch (e) {
        res.json({
            success: false,
            enabled: obsBridgeEnabled(),
            url: getObsBridgeUrl(),
            error: e.message || String(e)
        });
    }
});



function obsControlAdminOnly(req, res, next) {
    if (!localAuthEnabled()) return next();

    const role = String(req.session?.user?.role || "").toLowerCase();
    const username = String(req.session?.user?.username || "").toLowerCase();
    const owner = String(config.localAuth?.ownerUsername || config.twitch?.owner || "reoxitof").toLowerCase();

    if (role === "admin" || role === "owner" || username === owner) return next();

    return res.status(403).json({ error: "admin_required" });
}

app.get("/obs/full/status", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/health", {}, "GET").catch(async () => {
            return await callObsBridge("/", {}, "GET");
        });
        res.json({ success: true, bridge: true, ...data });
    } catch (e) {
        // Retourne 200 avec success:false au lieu de 503 pour éviter le spam d'erreurs
        res.json({ success: false, bridge: false, error: e.message });
    }
});

// Route manquante — évite les 404 en boucle
app.get("/process/status", requireDashboardAuth, (req, res) => {
    res.json({ isRemote: true, platform: "sliplane", status: "running" });
});

app.get("/obs/full/audio-sources", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/audio-sources", {}, "GET");
        res.json(data);
    } catch (e) {
        res.json({ success: false, error: e.message, sources: [] });
    }
});

app.get("/obs/full/audio-levels", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/audio-levels", {}, "GET");
        res.json(data);
    } catch (e) {
        res.json({ success: false, error: e.message, levels: {} });
    }
});

app.get("/obs/full/scenes", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/scenes", {}, "GET");
        res.json(data);
    } catch (e) {
        res.json({ success: false, error: e.message, scenes: [] });
    }
});

app.post("/obs/full/audio-toggle", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/audio-toggle", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/full/audio-volume", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/audio-volume", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/full/scene", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/scene", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/full/stream/start", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/stream/start", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/full/stream/stop", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/stream/stop", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/full/record/start", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/record/start", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/full/record/stop", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/record/stop", req.body);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});



/* ================= OBS PANEL PRO — AUDIO SOURCES ================= */

function requireObsAdmin(req, res, next) {
    // Admin only pour éviter qu'un modo coupe tes sources OBS
    if (!localAuthEnabled()) return next();
    if (req.session?.user?.role === "admin") return next();
    return res.status(403).json({ error: "admin_required" });
}

app.get("/obs/audio-sources", requireObsAdmin, async (req, res) => {
    try {
        if (config.obsBridge?.enabled) {
            const data = await callObsBridge("/audio-sources", {}, "GET");
            return res.json(data);
        }
        const connected = await connectOBS();
        if (!connected) {
            return res.json({
                success: false,
                connected: false,
                error: obsState.lastError || "OBS non connecté",
                sources: []
            });
        }

        const inputList = await obs.call("GetInputList");
        const inputs = inputList.inputs || [];

        const sources = [];

        for (const input of inputs) {
            const inputName = input.inputName;
            const inputKind = String(input.inputKind || "").toLowerCase();

            // Exclure les sources qui ne peuvent jamais avoir d'audio
            const noAudioKinds = ["image_source", "color_source", "text_gdiplus", "text_ft2_source", "slideshow", "ffmpeg_source_image"];
            if (noAudioKinds.some(k => inputKind.includes(k))) continue;

            // Tenter GetInputMute — si ça échoue, la source n'est pas dans le mixer audio
            let muted = false;
            let volumeDb = 0;
            let volumeMul = 1;

            try {
                const muteInfo = await obs.call("GetInputMute", { inputName });
                muted = !!muteInfo.inputMuted;
            } catch (e) {
                continue; // Pas de canal audio dans le mixer
            }

            try {
                const volInfo = await obs.call("GetInputVolume", { inputName });
                volumeDb = Number(volInfo.inputVolumeDb ?? 0);
                volumeMul = Number(volInfo.inputVolumeMul ?? 1);
            } catch (e) {}

            sources.push({
                name: inputName,
                kind: input.inputKind,
                muted,
                volumeDb,
                volumeMul
            });
        }

        res.json({
            success: true,
            connected: true,
            obs: obsState,
            sources
        });
    } catch (e) {
        console.log("[OBS PANEL] audio-sources error:", e.message);
        res.status(500).json({ success: false, connected: false, error: e.message, sources: [] });
    }
});

app.post("/obs/audio-mute", requireObsAdmin, async (req, res) => {
    try {
        const { source, muted } = req.body;
        if (!source) return res.status(400).json({ error: "source_required" });

        const connected = await connectOBS(true);
        if (!connected) return res.status(503).json({ error: obsState.lastError || "obs_not_connected" });

        await obs.call("SetInputMute", {
            inputName: source,
            inputMuted: !!muted
        });

        io.emit("obsAudioUpdate", { source, muted: !!muted });

        res.json({ success: true, source, muted: !!muted });
    } catch (e) {
        console.log("[OBS PANEL] mute error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/obs/audio-toggle", requireObsAdmin, async (req, res) => {
    try {
        if (config.obsBridge?.enabled) {
            const data = await callObsBridge("/audio-toggle", req.body);
            return res.json(data);
        }
        const { source } = req.body;
        if (!source) return res.status(400).json({ error: "source_required" });

        const connected = await connectOBS(true);
        if (!connected) return res.status(503).json({ error: obsState.lastError || "obs_not_connected" });

        const current = await obs.call("GetInputMute", { inputName: source });
        const muted = !current.inputMuted;

        await obs.call("SetInputMute", {
            inputName: source,
            inputMuted: muted
        });

        io.emit("obsAudioUpdate", { source, muted });

        res.json({ success: true, source, muted });
    } catch (e) {
        console.log("[OBS PANEL] toggle error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/obs/audio-volume", requireObsAdmin, async (req, res) => {
    try {
        if (config.obsBridge?.enabled) {
            const data = await callObsBridge("/audio-volume", req.body);
            return res.json(data);
        }
        const { source, volume } = req.body;
        if (!source) return res.status(400).json({ error: "source_required" });

        const vol = Math.max(0, Math.min(1, Number(volume)));

        const connected = await connectOBS(true);
        if (!connected) return res.status(503).json({ error: obsState.lastError || "obs_not_connected" });

        await obs.call("SetInputVolume", {
            inputName: source,
            inputVolumeMul: vol
        });

        io.emit("obsAudioUpdate", { source, volumeMul: vol });

        res.json({ success: true, source, volumeMul: vol });
    } catch (e) {
        console.log("[OBS PANEL] volume error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/obs/reconnect", requireObsAdmin, async (req, res) => {
    try {
        if (config.obsBridge?.enabled) {
            const data = await callObsBridge("/status", {}, "GET");
            return res.json({ success: true, bridge: true, data });
        }
        const ok = await connectOBS(true);
        res.json({ success: ok, obs: obsState });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, obs: obsState });
    }
});



/* ================= PHP TOKEN API SECURITY ================= */

const PHP_DASHBOARD_DIR = path.join(__dirname, "dashboard");
const PHP_TOKENS_FILE = path.join(PHP_DASHBOARD_DIR, "data", "api_tokens.json");
const PHP_CONFIG_FILE = path.join(PHP_DASHBOARD_DIR, "config.php");

function readPhpTokenPepper() {
    try {
        const raw = fs.readFileSync(PHP_CONFIG_FILE, "utf-8");
        const m = raw.match(/define\('TOKEN_PEPPER',\s*'([^']+)'\)/);
        return m ? m[1] : "";
    } catch (e) {
        return "";
    }
}

function validatePhpDashboardToken(token) {
    if (!token) return null;

    try {
        const pepper = readPhpTokenPepper();
        if (!pepper) return null;

        const hash = crypto.createHash("sha256").update(token + pepper).digest("hex");
        const data = JSON.parse(fs.readFileSync(PHP_TOKENS_FILE, "utf-8"));
        const info = data.tokens?.[hash];

        if (!info) return null;

        // Optionnel : expiration 7 jours
        if (info.createdAt && Date.now() - new Date(info.createdAt).getTime() > 7 * 24 * 60 * 60 * 1000) {
            return null;
        }

        return {
            id: info.userId,
            username: info.username,
            role: info.role
        };
    } catch (e) {
        return null;
    }
}

function requirePhpApiAuth(req, res, next) {
    // Si la session locale est valide, on accepte directement (pas besoin du token PHP)
    if (req.session?.user) {
        req.dashboardUser = req.session.user;
        return next();
    }
    const token = req.headers["x-dashboard-token"] || req.query.dashboardToken;
    const user = validatePhpDashboardToken(token);

    if (!user) return res.status(401).json({ error: "php_token_required" });

    req.dashboardUser = user;
    next();
}

function requirePhpAdmin(req, res, next) {
    requirePhpApiAuth(req, res, () => {
        if (req.dashboardUser.role !== "admin") {
            return res.status(403).json({ error: "admin_required" });
        }
        next();
    });
}

function requirePhpModOrAdmin(req, res, next) {
    requirePhpApiAuth(req, res, () => {
        if (!["admin", "mod"].includes(req.dashboardUser.role)) {
            return res.status(403).json({ error: "mod_required" });
        }
        next();
    });
}

function securePhpWriteApis(req, res, next) {
    // Laisse les pages publiques et assets tranquilles
    if (req.method === "GET") return next();

    const modPaths = [
        "/moderation/action",
        "/moderation/reset-warning",
        "/moderation/bannedWords",
        "/vote/start",
        "/vote/stop",
        "/poll/start",
        "/poll/stop"
    ];

    const adminPaths = [
        "/theme",
        "/scene",
        "/subgoal",
        "/custom-command",
        "/screen-overlay",
        "/brb",
        "/upload-sound"
    ];

    if (adminPaths.some(p => req.path.startsWith(p))) {
        return requirePhpAdmin(req, res, next);
    }

    if (modPaths.some(p => req.path.startsWith(p))) {
        return requirePhpModOrAdmin(req, res, next);
    }

    next();
}

app.use(securePhpWriteApis);

/* ================= MULTER — Upload sons ================= */

const soundStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, "public", "sounds");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const name = req.query.name || file.originalname;
        cb(null, name);
    }
});
const uploadSound = multer({
    storage: soundStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("audio/")) cb(null, true);
        else cb(new Error("Seuls les fichiers audio sont acceptés"));
    }
});

/* ================= STATE ================= */

const saved = loadPersistentState();

let state = {
    alertId: 0,
    alert: null,
    subGoal: saved?.subGoal || {
        current: config.subGoal?.current || 0,
        target: config.subGoal?.target || 50,
        label: config.subGoal?.label || "OBJECTIF ABONNÉS"
    },
    // Statistiques de stream
    stats: saved?.stats || {
        follows: 0,
        subs: 0,
        tips: 0,
        cheers: 0,
        raids: 0,
        chatMessages: 0,
        followsPerHour: [],
        subsPerHour: [],
        chatPerMinute: [],
        peakViewers: 0,
        currentViewers: 0
    },
    // Points mini-jeux
    points: saved?.points || {},
    // Commandes custom
    customCommands: saved?.customCommands || config.customCommands || {},
    // Modération Twitch
    moderation: saved?.moderation || config.moderation || {
        enabled: true,
        antiBypass: true,
        blockLinks: true,
        blockCaps: true,
        maxCapsPercent: 70,
        spamLimit: 5,
        spamWindowSeconds: 8,
        deleteMessage: true,
        exemptMods: true,
        warnOnlyFirstOffense: true,
        warningResetHours: 24,
        timeoutSteps: [30, 120, 600],
        banAtWarnings: 4,
        bannedWords: []
    },
    moderationWarnings: saved?.moderationWarnings || {},
    moderationLogs: saved?.moderationLogs || [],
    // Thème
    theme: saved?.theme || config.theme || {
        primary: "#9b59b6",
        primaryDim: "#7d3c98",
        primaryBright: "#c39bd3",
        primaryGlow: "#d2b4de",
        accent: "#e879f9"
    },
    // Scène active
    scene: saved?.scene || config.scenes?.active || "gaming",
    // Messages d'alerte personnalisables
    alertMessages: saved?.alertMessages || config.overlay?.alertMessages || {
        "follower-latest": { title: "NOUVEAU FOLLOW", subtitle: "MERCI DE ME SUIVRE !" },
        "subscriber-latest": { title: "NOUVEAU SUB", subtitle: "BIENVENUE DANS LA FAMILLE !" },
        "tip-latest": { title: "NOUVEAU DON", subtitle: "MERCI POUR TA GÉNÉROSITÉ !" },
        "cheer-latest": { title: "CHEER", subtitle: "MERCI POUR LES BITS !" },
        "raid-latest": { title: "RAID EN APPROCHE", subtitle: "BIENVENUE À TOUS !" }
    },
    // Historique alertes pour afficher les noms dans le dashboard
    recentFollows: saved?.recentFollows || [],
    recentSubs: saved?.recentSubs || [],
    recentTips: saved?.recentTips || [],
    recentCheers: saved?.recentCheers || [],
    recentRaids: saved?.recentRaids || [],
    alertLog: saved?.alertLog || [],
    // BRB mode
    brb: false,
    brbMessage: "STREAM EN PAUSE — ON REVIENT !",
    // Screen overlay (start/pause/fin)
    screenOverlay: {
        active: false,
        type: ""
    }
};

// Charger le thème depuis PostgreSQL (appelé après init de state)
async function loadSavedTheme() {
    try {
        const res = await pgPool.query("SELECT value FROM settings WHERE key = 'theme'");
        if (res.rows.length > 0) {
            const saved = JSON.parse(res.rows[0].value);
            Object.assign(state.theme, saved);
            console.log('[THEME] Thème restauré depuis DB :', state.theme.primary);
        }
    } catch(e) {
        console.log('[THEME] Erreur chargement thème DB :', e.message);
    }
}
// loadSavedTheme() est appelé dans start() avant server.listen

/* ================= VOTE STATE ================= */

let voteState = {
    visible: false,
    active: false,
    finished: false,
    target: "",
    jailVotes: 0,
    banVotes: 0,
    freeVotes: 0,
    voters: {},
    timeLeft: 0,
    timer: null
};

/* ================= POLL STATE (multi-options) ================= */

let pollState = {
    visible: false,
    active: false,
    finished: false,
    question: "",
    options: [],
    votes: {},
    voters: {},
    timeLeft: 0,
    timer: null
};

/* ================= HIGHLIGHT STATE ================= */

let highlightState = {
    visible: false,
    username: "",
    message: "",
    color: "#9b59b6"
};

/* ================= MINI-GAMES STATE ================= */

let pendingDuels = {};


/* ================= CHAT LIVE DASHBOARD ================= */

let dashboardChatMessages = [];

function pushDashboardChatMessage(message) {
    dashboardChatMessages.push(message);
    if (dashboardChatMessages.length > 120) dashboardChatMessages.shift();
    io.emit("chatMessage", message);
}

app.get("/chat/messages", requireDashboardAuth, (req, res) => {
    res.json({ messages: dashboardChatMessages.slice(-80) });
});

app.post("/chat/send", requireModOrAdmin, async (req, res) => {
    try {
        const text = String(req.body.message || "").trim();
        if (!text) return res.status(400).json({ error: "message_required" });
        const sender = req.session?.user?.username || null;
        const role = req.session?.user?.role || "admin";
        // Préfixe uniquement si c'est un modo (pas owner/admin)
        const finalText = (sender && role === "mod") ? `[${sender}] ${text}` : text;

        const twitchClient =
            global.twitchClient ||
            (typeof client !== "undefined" && client) ||
            (typeof twitchClientGlobal !== "undefined" && twitchClientGlobal) ||
            null;

        if (!twitchClient || typeof twitchClient.say !== "function") {
            return res.status(500).json({ error: "twitch_client_missing" });
        }

        await twitchClient.say(TWITCH_CHANNEL, finalText);

        if (typeof pushDashboardChatMessage === "function") {
            pushDashboardChatMessage({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2),
                username: config.twitch?.botUsername || config.twitch?.username || "Dashboard",
                message: finalText,
                isMod: true,
                isSub: false,
                isOwner: true,
                color: "#c39bd3",
                time: new Date().toISOString()
            });
        }

        res.json({ success: true });
    } catch (e) {
        console.log("[CHAT] Envoi impossible :", e.message);
        res.status(500).json({ error: e.message || "send_failed" });
    }
});

/* ================= STATS TRACKING ================= */

let statsHourTimer = null;
let statsMinuteTimer = null;
let chatCountThisMinute = 0;

function initStatsTracking() {
    // Compteur messages/minute
    statsMinuteTimer = setInterval(() => {
        state.stats.chatPerMinute.push(chatCountThisMinute);
        if (state.stats.chatPerMinute.length > 60) state.stats.chatPerMinute.shift();
        chatCountThisMinute = 0;
    }, 60000);

    // Compteur follows/subs par heure
    statsHourTimer = setInterval(() => {
        state.stats.followsPerHour.push(0);
        state.stats.subsPerHour.push(0);
        if (state.stats.followsPerHour.length > 24) state.stats.followsPerHour.shift();
        if (state.stats.subsPerHour.length > 24) state.stats.subsPerHour.shift();
    }, 3600000);
}

/* ================= AUTO-SAVE ================= */

setInterval(savePersistentState, 30000);

/* ================= HELPERS ================= */

function userIsAllowed(tags, username) {
    const name = String(username).toLowerCase();
    const badges = tags.badges || {};
    return (
        name === OWNER_TWITCH.toLowerCase() ||
        tags.mod === true ||
        badges.broadcaster === "1" ||
        badges.moderator === "1"
    );
}


function normalizeAlertName(name) {
    const value = String(name || "Viewer").trim();
    return value || "Viewer";
}

function rememberAlert(alertType, name, extra = "") {
    if (!state.recentFollows) state.recentFollows = [];
    if (!state.recentSubs) state.recentSubs = [];
    if (!state.recentTips) state.recentTips = [];
    if (!state.recentCheers) state.recentCheers = [];
    if (!state.recentRaids) state.recentRaids = [];
    if (!state.alertLog) state.alertLog = [];
    const cleanName = normalizeAlertName(name);
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2), type: alertType, name: cleanName, extra: String(extra || ""), time: new Date().toISOString() };
    const map = { "follower-latest": state.recentFollows, "subscriber-latest": state.recentSubs, "tip-latest": state.recentTips, "cheer-latest": state.recentCheers, "raid-latest": state.recentRaids };
    if (map[alertType]) { map[alertType].unshift(entry); map[alertType].splice(20); }
    state.alertLog.unshift(entry); state.alertLog.splice(60);
    return entry;
}

function sendAlert(alertType, name, extra = "") {
    state.alertId++;
    const rememberedAlert = rememberAlert(alertType, name, extra);
    state.alert = { alertType, name: rememberedAlert.name, extra, id: rememberedAlert.id, time: rememberedAlert.time };
    console.log("[ALERT]", alertType, rememberedAlert.name, extra);

    // Stats
    if (alertType === "follower-latest") {
        state.stats.follows++;
        if (state.stats.followsPerHour.length > 0) {
            state.stats.followsPerHour[state.stats.followsPerHour.length - 1]++;
        }
        state.subGoal.current += 1;
        io.emit("subGoal", state.subGoal);
        // Check goal reached
        if (state.subGoal.current >= state.subGoal.target) {
            console.log("[OBJECTIF] Atteint :", state.subGoal.current + "/" + state.subGoal.target);
        }
    }
    if (alertType === "subscriber-latest") {
        state.stats.subs++;
        if (state.stats.subsPerHour.length > 0) {
            state.stats.subsPerHour[state.stats.subsPerHour.length - 1]++;
        }
    }
    if (alertType === "tip-latest") state.stats.tips++;
    if (alertType === "cheer-latest") state.stats.cheers++;
    if (alertType === "raid-latest") {
        state.stats.raids++;
    }

    io.emit("alert", state.alert);
    io.emit("state", state);
    io.emit("alertTracking", { recentFollows: state.recentFollows || [], recentSubs: state.recentSubs || [], recentTips: state.recentTips || [], recentCheers: state.recentCheers || [], recentRaids: state.recentRaids || [], alertLog: state.alertLog || [], stats: state.stats, subGoal: state.subGoal });
    savePersistentState();

    // Effacer l'alerte après 8s pour éviter qu'elle reste sur rechargement
    setTimeout(() => { state.alert = null; }, 8000);
}

function sendVoteCommand(username, message, tags = {}) {
    io.emit("chatCommand", {
        username, message,
        isMod: tags.mod === true,
        isBroadcaster: tags.badges && tags.badges.broadcaster === "1"
    });
}


/* ================= MODERATION HELPERS ================= */

const moderationMemory = {
    logs: state.moderationLogs || []
};

state.moderationWarnings = state.moderationWarnings || {};
state.moderationLogs = state.moderationLogs || [];
moderationMemory.logs = state.moderationLogs;


function addModerationLog(username, reason, action, message = "", warns = null) {
    const entry = { time: new Date().toISOString(), username, reason, action, warns, message: String(message).slice(0, 220) };
    state.moderationLogs = state.moderationLogs || [];
    state.moderationLogs.unshift(entry);
    if (state.moderationLogs.length > 200) state.moderationLogs.pop();
    moderationMemory.logs = state.moderationLogs;
    io.emit("moderationLog", entry);
    savePersistentState();
    console.log("[MODERATION]", username, reason, action);
}

/* ================= MINI-GAMES ================= */

function getPoints(username) {
    const name = username.toLowerCase();
    if (state.points[name] === undefined) {
        state.points[name] = config.miniGames?.startingPoints || 100;
    }
    return state.points[name];
}

function setPoints(username, amount) {
    state.points[username.toLowerCase()] = Math.max(0, amount);
}

function handleMiniGame(username, cmd, args, twitchClient, channel) {
    if (!config.miniGames?.enabled) return;
    const name = username.toLowerCase();

    // !points
    if (cmd === "!points") {
        const pts = getPoints(username);
        twitchClient.say(channel, `@${username} tu as ${pts} points 💰`);
        return;
    }

    // !dice <mise>
    if (cmd === "!dice") {
        const bet = parseInt(args[0]) || 10;
        const pts = getPoints(username);
        if (bet > pts) {
            twitchClient.say(channel, `@${username} tu n'as pas assez de points (${pts}) 😢`);
            return;
        }
        const roll = Math.floor(Math.random() * 6) + 1;
        const win = roll >= 4;
        if (win) {
            setPoints(username, pts + bet);
            twitchClient.say(channel, `@${username} 🎲 ${roll} — Tu gagnes ${bet} points ! (${pts + bet} total)`);
        } else {
            setPoints(username, pts - bet);
            twitchClient.say(channel, `@${username} 🎲 ${roll} — Tu perds ${bet} points ! (${pts - bet} total)`);
        }
        return;
    }

    // !roulette <mise>
    if (cmd === "!roulette") {
        const bet = parseInt(args[0]) || (config.miniGames?.rouletteMinBet || 5);
        const pts = getPoints(username);
        if (bet > pts) {
            twitchClient.say(channel, `@${username} pas assez de points (${pts}) 😢`);
            return;
        }
        const win = Math.random() < 0.45;
        if (win) {
            const winAmount = Math.floor(bet * 1.5);
            setPoints(username, pts + winAmount);
            twitchClient.say(channel, `@${username} 🎰 GAGNÉ ! +${winAmount} points (${pts + winAmount} total) 🎉`);
        } else {
            setPoints(username, pts - bet);
            twitchClient.say(channel, `@${username} 🎰 PERDU ! -${bet} points (${pts - bet} total) 💀`);
        }
        return;
    }

    // !duel @user <mise>
    if (cmd === "!duel") {
        const targetRaw = args[0] || "";
        const target = targetRaw.replace("@", "").toLowerCase();
        const bet = parseInt(args[1]) || (config.miniGames?.duelMinBet || 10);
        const pts = getPoints(username);

        if (!target || target === name) {
            twitchClient.say(channel, `@${username} utilise !duel @pseudo <mise>`);
            return;
        }
        if (bet > pts) {
            twitchClient.say(channel, `@${username} pas assez de points (${pts}) 😢`);
            return;
        }

        pendingDuels[target] = { challenger: name, bet, timestamp: Date.now() };
        twitchClient.say(channel, `@${target} ⚔️ ${username} te défie pour ${bet} points ! Tape !accept ou !decline`);
        // Auto-expire après 60s
        setTimeout(() => {
            if (pendingDuels[target]?.challenger === name) {
                delete pendingDuels[target];
            }
        }, 60000);
        return;
    }

    // !accept
    if (cmd === "!accept") {
        const duel = pendingDuels[name];
        if (!duel) {
            twitchClient.say(channel, `@${username} aucun duel en attente.`);
            return;
        }
        const challengerPts = getPoints(duel.challenger);
        const accepterPts = getPoints(name);
        if (duel.bet > accepterPts) {
            twitchClient.say(channel, `@${username} pas assez de points (${accepterPts}) 😢`);
            delete pendingDuels[name];
            return;
        }
        if (duel.bet > challengerPts) {
            twitchClient.say(channel, `@${duel.challenger} n'a plus assez de points !`);
            delete pendingDuels[name];
            return;
        }
        const challengerWins = Math.random() < 0.5;
        if (challengerWins) {
            setPoints(duel.challenger, challengerPts + duel.bet);
            setPoints(name, accepterPts - duel.bet);
            twitchClient.say(channel, `⚔️ ${duel.challenger} bat ${username} et gagne ${duel.bet} points !`);
        } else {
            setPoints(duel.challenger, challengerPts - duel.bet);
            setPoints(name, accepterPts + duel.bet);
            twitchClient.say(channel, `⚔️ ${username} bat ${duel.challenger} et gagne ${duel.bet} points !`);
        }
        delete pendingDuels[name];
        return;
    }

    // !decline
    if (cmd === "!decline") {
        if (pendingDuels[name]) {
            twitchClient.say(channel, `@${username} a refusé le duel de ${pendingDuels[name].challenger}.`);
            delete pendingDuels[name];
        }
        return;
    }
}

/* ================= ROUTE CONFIG (pour le client) ================= */

app.get("/config", (req, res) => {
    const activeProfileId = config.overlay?.activeProfile || "reoxitof";
    const profiles = config.overlayProfiles || {};
    const activeProfile = profiles[activeProfileId] || null;
    res.json({
        publicUrl: PUBLIC_URL,
        fivem: config.fivem,
        overlay: config.overlay,
        overlayProfiles: profiles,
        activeProfile: activeProfileId,
        activeProfileData: activeProfile,
        subGoal: state.subGoal,
        theme: state.theme,
        scene: state.scene,
        alertMessages: state.alertMessages,
        brb: state.brb,
        brbMessage: state.brbMessage,
        screenOverlay: state.screenOverlay,
        customCommands: config.customCommands || {}
    });
});

/* ── PROFILE SWITCH ── */
app.post("/overlay/profile", requireAdmin, async (req, res) => {
    const profileId = String(req.body.profile || "").trim();
    const profiles = config.overlayProfiles || {};
    if (!profiles[profileId]) return res.status(400).json({ error: "profile_not_found" });

    config.overlay.activeProfile = profileId;
    const profileData = profiles[profileId];

    // Sync rotatingTexts in overlay
    config.overlay.rotatingTexts = profileData.rotatingTexts;
    config.overlay.discordInvite = profileData.discordInvite;

    // Sauvegarde dans PostgreSQL
    try {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        `);
        await pgPool.query(
            `INSERT INTO settings (key, value) VALUES ('activeProfile', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1`,
            [profileId]
        );
    } catch (e) {
        console.log("[PROFILE] Erreur sauvegarde PG :", e.message);
    }

    // Emit to all overlays
    io.emit("profileChange", { profileId, profile: profileData });

    res.json({ success: true, profileId, profile: profileData });
});

/* ── PROFILE UPDATE TEXTS ── */
app.post("/overlay/profile/texts", requireAdmin, (req, res) => {
    const profileId = String(req.body.profile || "").trim();
    const texts = req.body.texts;
    if (!config.overlayProfiles?.[profileId]) return res.status(400).json({ error: "profile_not_found" });
    if (!Array.isArray(texts)) return res.status(400).json({ error: "texts_must_be_array" });

    config.overlayProfiles[profileId].rotatingTexts = texts.map(t => String(t).trim()).filter(Boolean);

    // If active profile, sync
    if (config.overlay.activeProfile === profileId) {
        config.overlay.rotatingTexts = config.overlayProfiles[profileId].rotatingTexts;
        io.emit("profileChange", { profileId, profile: config.overlayProfiles[profileId] });
    }

    try {
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(config, null, 2), "utf-8");
    } catch (e) {}

    res.json({ success: true });
});

/* Route proxy FiveM — profile-aware */
app.get("/fivem/status", async (req, res) => {
    try {
        // Check active overlay profile for a custom fivem endpoint
        const activeProfileId = config.overlay?.activeProfile || "reoxitof";
        const activeProfile = config.overlayProfiles?.[activeProfileId];

        // If active profile has a cfx endpoint
        if (activeProfile?.fivemEndpoint && activeProfile?.fivemType === "cfx") {
            const r = await fetch(activeProfile.fivemEndpoint, { cache: "no-store" });
            const data = await r.json();
            const d = data.Data || data;
            return res.json({
                success: true,
                clients: d.clients ?? 0,
                maxClients: d.sv_maxclients ?? d.svMaxclients ?? 0,
                hostname: d.hostname || d.vars?.sv_projectName || activeProfile.name || ""
            });
        }

        // Default: use config.fivem.endpoint
        const endpoint = config.fivem?.endpoint;
        if (!endpoint) return res.json({ success: false, error: "endpoint non configuré" });
        const r = await fetch(endpoint, { cache: "no-store" });
        const data = await r.json();
        res.json({ success: true, clients: data.clients ?? 0, maxClients: data.sv_maxclients ?? 0, hostname: data.hostname || "" });
    } catch (e) {
        res.json({ success: false, clients: 0, maxClients: 0, error: e.message });
    }
});

/* ================= ROUTES — PROFILS INTÉRIMAIRES ================= */

// Middleware : accepte les requêtes du bot Discord via token interne
function requireBotOrModOrAdmin(req, res, next) {
    const botToken = req.headers["x-bot-token"] || String(req.headers["authorization"] || "").replace("Bearer ", "");
    if (botToken && process.env.BOT_INTERNAL_TOKEN && botToken === process.env.BOT_INTERNAL_TOKEN) return next();
    return requireModOrAdmin(req, res, next);
}

// Initialiser la table interim_profiles si elle n'existe pas
async function ensureInterimTable() {
    try {
        await pgPool.query(`CREATE TABLE IF NOT EXISTS interim_profiles (
            id               SERIAL PRIMARY KEY,
            discord_user_id  TEXT NOT NULL DEFAULT '',
            discord_username TEXT NOT NULL DEFAULT '',
            guild_id         TEXT NOT NULL DEFAULT '',
            channel_id       TEXT NOT NULL DEFAULT '',
            channel_name     TEXT NOT NULL DEFAULT '',
            message_id       TEXT NOT NULL UNIQUE,
            thread_id        TEXT,
            nom              TEXT,
            prenom           TEXT,
            poste            TEXT,
            entreprise       TEXT,
            id_employe       TEXT,
            perso            TEXT,
            compte           TEXT,
            date_debut       TEXT,
            date_fin         TEXT,
            salaire          TEXT,
            adresse          TEXT,
            telephone        TEXT,
            email            TEXT,
            notes            TEXT,
            photo_url        TEXT,
            raw_content      TEXT,
            statut           TEXT DEFAULT 'actif',
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        )`);
        for (const col of ["id_employe","perso","compte","photo_url","thread_id"]) {
            await pgPool.query(`ALTER TABLE interim_profiles ADD COLUMN IF NOT EXISTS ${col} TEXT`).catch(() => {});
        }
    } catch(e) { console.log("[INTERIM] ensureTable:", e.message); }
}
ensureInterimTable();

// POST /interim/profiles — créer ou mettre à jour (anti-doublon via message_id)
app.post("/interim/profiles", requireBotOrModOrAdmin, async (req, res) => {
    try {
        const b = req.body;
        if (!b.messageId) return res.status(400).json({ error: "messageId_required" });
        await pgPool.query(
            `INSERT INTO interim_profiles (
                discord_user_id,discord_username,guild_id,channel_id,channel_name,
                message_id,thread_id,nom,prenom,poste,entreprise,id_employe,perso,compte,
                date_debut,date_fin,salaire,adresse,telephone,email,notes,photo_url,raw_content,statut,updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'actif',NOW())
            ON CONFLICT (message_id) DO UPDATE SET
                discord_username=EXCLUDED.discord_username,
                thread_id  =COALESCE(EXCLUDED.thread_id,  interim_profiles.thread_id),
                nom        =COALESCE(EXCLUDED.nom,        interim_profiles.nom),
                prenom     =COALESCE(EXCLUDED.prenom,     interim_profiles.prenom),
                poste      =COALESCE(EXCLUDED.poste,      interim_profiles.poste),
                entreprise =COALESCE(EXCLUDED.entreprise, interim_profiles.entreprise),
                id_employe =COALESCE(EXCLUDED.id_employe, interim_profiles.id_employe),
                perso      =COALESCE(EXCLUDED.perso,      interim_profiles.perso),
                compte     =COALESCE(EXCLUDED.compte,     interim_profiles.compte),
                date_debut =COALESCE(EXCLUDED.date_debut, interim_profiles.date_debut),
                date_fin   =COALESCE(EXCLUDED.date_fin,   interim_profiles.date_fin),
                salaire    =COALESCE(EXCLUDED.salaire,    interim_profiles.salaire),
                adresse    =COALESCE(EXCLUDED.adresse,    interim_profiles.adresse),
                telephone  =COALESCE(EXCLUDED.telephone,  interim_profiles.telephone),
                email      =COALESCE(EXCLUDED.email,      interim_profiles.email),
                notes      =COALESCE(EXCLUDED.notes,      interim_profiles.notes),
                photo_url  =COALESCE(EXCLUDED.photo_url,  interim_profiles.photo_url),
                raw_content=EXCLUDED.raw_content,
                updated_at =NOW()`,
            [
                b.discordUserId||"", b.discordUsername||"", b.guildId||"", b.channelId||"", b.channelName||"",
                b.messageId, b.threadId||null,
                b.nom||null, b.prenom||null, b.poste||null, b.entreprise||null,
                b.id_employe||null, b.perso||null, b.compte||null,
                b.date_debut||null, b.date_fin||null, b.salaire||null, b.adresse||null,
                b.telephone||null, b.email||null, b.notes||null,
                b.photoUrl||null, b.rawContent||null
            ]
        );
        const r = await pgPool.query(`SELECT * FROM interim_profiles WHERE message_id = $1`, [b.messageId]);
        res.json({ success: true, profile: r.rows[0] });
    } catch(e) {
        console.log("[INTERIM] POST error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// PATCH /interim/profiles/:id — mise à jour partielle
app.patch("/interim/profiles/:id", requireBotOrModOrAdmin, async (req, res) => {
    try {
        const b = req.body;
        const allowed = ["nom","prenom","poste","entreprise","id_employe","perso","compte",
                         "date_debut","date_fin","salaire","adresse","telephone","email","notes","photo_url","statut"];
        const sets = []; const params = [];
        for (const f of allowed) {
            if (b[f] !== undefined) { params.push(b[f]); sets.push(f + " = $" + params.length); }
        }
        if (!sets.length) return res.status(400).json({ error: "no_fields" });
        params.push(req.params.id);
        await pgPool.query("UPDATE interim_profiles SET " + sets.join(", ") + ", updated_at = NOW() WHERE id = $" + params.length, params);
        const r = await pgPool.query(`SELECT * FROM interim_profiles WHERE id = $1`, [req.params.id]);
        res.json({ success: true, profile: r.rows[0] || null });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /interim/profiles/by-message/:messageId — anti-doublon
app.get("/interim/profiles/by-message/:messageId", requireBotOrModOrAdmin, async (req, res) => {
    try {
        const r = await pgPool.query(`SELECT * FROM interim_profiles WHERE message_id = $1`, [req.params.messageId]);
        if (!r.rows.length) return res.status(404).json({ error: "not_found" });
        res.json({ success: true, profile: r.rows[0] });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /interim/profiles/search?q=
app.get("/interim/profiles/search", requireModOrAdmin, async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        if (!q || q.length < 2) return res.status(400).json({ error: "query_too_short" });
        const like = "%" + q + "%";
        const r = await pgPool.query(
            `SELECT * FROM interim_profiles
             WHERE nom ILIKE $1 OR prenom ILIKE $1 OR poste ILIKE $1
                OR entreprise ILIKE $1 OR id_employe ILIKE $1
                OR perso ILIKE $1 OR compte ILIKE $1 OR discord_username ILIKE $1
             ORDER BY updated_at DESC LIMIT 20`,
            [like]
        );
        res.json({ success: true, profiles: r.rows, count: r.rows.length });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /interim/stats
app.get("/interim/stats", requireModOrAdmin, async (req, res) => {
    try {
        const r = await pgPool.query(
            `SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE statut='actif')      AS actifs,
                    COUNT(*) FILTER (WHERE statut='inactif')    AS inactifs,
                    COUNT(*) FILTER (WHERE statut='en_attente') AS en_attente,
                    COUNT(DISTINCT channel_name)                AS canaux
             FROM interim_profiles`
        );
        res.json({ success: true, stats: r.rows[0] });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /interim/profiles — liste
app.get("/interim/profiles", requireModOrAdmin, async (req, res) => {
    try {
        const statut = req.query.statut || null;
        const limit  = Math.min(parseInt(req.query.limit  || "50"), 200);
        const offset = parseInt(req.query.offset || "0");
        const params = []; let where = "WHERE 1=1";
        if (statut) { params.push(statut); where += " AND statut = $" + params.length; }
        params.push(limit, offset);
        const r = await pgPool.query(
            "SELECT * FROM interim_profiles " + where + " ORDER BY created_at DESC LIMIT $" + (params.length-1) + " OFFSET $" + params.length,
            params
        );
        const cp = statut ? [statut] : []; const cw = statut ? "WHERE statut = $1" : "";
        const cr = await pgPool.query("SELECT COUNT(*) as c FROM interim_profiles " + cw, cp);
        res.json({ success: true, profiles: r.rows, total: parseInt(cr.rows[0]?.c || 0), limit, offset });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /interim/profiles/:id
app.get("/interim/profiles/:id", requireModOrAdmin, async (req, res) => {
    try {
        const r = await pgPool.query(`SELECT * FROM interim_profiles WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: "not_found" });
        res.json({ success: true, profile: r.rows[0] });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// PATCH /interim/profiles/:id/statut
app.patch("/interim/profiles/:id/statut", requireModOrAdmin, async (req, res) => {
    try {
        const statut = String(req.body.statut || "").toLowerCase();
        if (!["actif","inactif","en_attente"].includes(statut)) return res.status(400).json({ error: "statut_invalide" });
        await pgPool.query(`UPDATE interim_profiles SET statut = $1, updated_at = NOW() WHERE id = $2`, [statut, req.params.id]);
        res.json({ success: true, statut });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /interim/profiles/:id
app.delete("/interim/profiles/:id", requireAdmin, async (req, res) => {
    try {
        await pgPool.query(`DELETE FROM interim_profiles WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ================= ROUTES — BOTS PANEL ================= */

// Config bots stockée en mémoire (chargée depuis DB au démarrage)
let botsConfig = {
    discord: {
        deployHook: process.env.DISCORD_BOT_DEPLOY_HOOK || "",
        publicUrl: "https://discord-bot-3cm7nt.sliplane.app",
        vars: {}
    },
    twitch: {
        deployHook: process.env.TWITCH_BOT_DEPLOY_HOOK || "",
        publicUrl: "https://bot-twitch.sliplane.app",
        vars: {}
    }
};

// Buffer de logs en mémoire (100 entrées max par bot)
const botsLogs = { discord: [], twitch: [] };

function pushBotLog(bot, level, message) {
    const entry = { time: new Date().toISOString(), level, message: String(message).slice(0, 500) };
    botsLogs[bot] = botsLogs[bot] || [];
    botsLogs[bot].unshift(entry);
    if (botsLogs[bot].length > 100) botsLogs[bot].pop();
    io.emit("botLog", { bot, ...entry });
}

// Charger la config bots depuis PostgreSQL
async function loadBotsConfig() {
    try {
        await pgPool.query(`CREATE TABLE IF NOT EXISTS bots_config (key TEXT PRIMARY KEY, value TEXT)`);
        const res = await pgPool.query(`SELECT key, value FROM bots_config`);
        for (const row of res.rows) {
            try {
                const data = JSON.parse(row.value);
                if (row.key === "discord") Object.assign(botsConfig.discord, data);
                if (row.key === "twitch") Object.assign(botsConfig.twitch, data);
            } catch(e) {}
        }
        console.log("[BOTS] Config chargée depuis DB");
    } catch(e) {
        console.log("[BOTS] Erreur chargement config :", e.message);
    }
}

async function saveBotsConfig(bot) {
    try {
        const val = JSON.stringify(botsConfig[bot]);
        await pgPool.query(
            `INSERT INTO bots_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
            [bot, val]
        );
    } catch(e) {
        console.log("[BOTS] Erreur sauvegarde config :", e.message);
    }
}

// Statut d'un bot via healthcheck HTTP
async function getBotStatus(bot) {
    const url = botsConfig[bot]?.publicUrl;
    if (!url) return { online: false, error: "URL non configurée" };
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return { online: r.ok, statusCode: r.status };
    } catch(e) {
        return { online: false, error: e.name === "AbortError" ? "Timeout" : e.message };
    }
}

// GET /bots/status — statut des deux bots
app.get("/bots/status", requireDashboardAuth, async (req, res) => {
    const [discord, twitch] = await Promise.all([
        getBotStatus("discord"),
        getBotStatus("twitch")
    ]);
    res.json({ discord, twitch });
});

// GET /bots/logs/:bot — logs en mémoire
app.get("/bots/logs/:bot", requireDashboardAuth, (req, res) => {
    const bot = req.params.bot;
    if (!["discord", "twitch"].includes(bot)) return res.status(400).json({ error: "bot invalide" });
    res.json({ logs: botsLogs[bot] || [] });
});

// POST /bots/restart/:bot — redéploie via Sliplane Deploy Hook
app.post("/bots/restart/:bot", requireAdmin, async (req, res) => {
    const bot = req.params.bot;
    if (!["discord", "twitch"].includes(bot)) return res.status(400).json({ error: "bot invalide" });
    const hook = botsConfig[bot]?.deployHook;
    if (!hook) return res.status(400).json({ error: "Deploy hook non configuré" });
    try {
        const r = await fetch(hook, { method: "GET", signal: AbortSignal.timeout(10000) });
        pushBotLog(bot, "info", `Redémarrage déclenché par ${req.session?.user?.username || "admin"}`);
        res.json({ success: true, status: r.status });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /bots/config/:bot — récupère la config vars
app.get("/bots/config/:bot", requireAdmin, (req, res) => {
    const bot = req.params.bot;
    if (!["discord", "twitch"].includes(bot)) return res.status(400).json({ error: "bot invalide" });
    res.json({
        deployHook: botsConfig[bot]?.deployHook || "",
        publicUrl: botsConfig[bot]?.publicUrl || "",
        vars: botsConfig[bot]?.vars || {}
    });
});

// POST /bots/config/:bot — sauvegarde la config vars
app.post("/bots/config/:bot", requireAdmin, async (req, res) => {
    const bot = req.params.bot;
    if (!["discord", "twitch"].includes(bot)) return res.status(400).json({ error: "bot invalide" });
    const { deployHook, publicUrl, vars } = req.body;
    if (deployHook !== undefined) botsConfig[bot].deployHook = String(deployHook).trim();
    if (publicUrl !== undefined) botsConfig[bot].publicUrl = String(publicUrl).trim();
    if (vars && typeof vars === "object") botsConfig[bot].vars = vars;
    await saveBotsConfig(bot);
    pushBotLog(bot, "info", `Config mise à jour par ${req.session?.user?.username || "admin"}`);
    res.json({ success: true });
});

// Charger la config bots au démarrage (appelé dans start())

(async () => {
    try { await loadSavedTheme(); } catch(e) { console.log("[START] loadSavedTheme:", e.message); }
    try { await loadSavedProfile(); } catch(e) { console.log("[START] loadSavedProfile:", e.message); }
    try { await loadBotsConfig(); } catch(e) { console.log("[START] loadBotsConfig:", e.message); }
server.listen(APP_PORT, APP_HOST, () => {
    console.log("═══════════════════════════════════════════");
    console.log(" Reoxitof Overlay — NUI Edition v3.0");
    console.log(`  Mode     : ${config.server.mode === "local" ? "LOCAL (127.0.0.1)" : "HÉBERGÉ (0.0.0.0)"}`);
    console.log(`  Port     : ${APP_PORT}`);
    console.log(`  URL      : ${PUBLIC_URL}`);
    console.log(`  Twitch   : ${TWITCH_CHANNEL}`);
    console.log("═══════════════════════════════════════════");
    console.log(`  Overlay  : ${PUBLIC_URL}`);
    console.log(`  Dashboard: ${PUBLIC_URL}/dashboard.html`);
    console.log(`  Vote     : ${PUBLIC_URL}/vote.html`);
    console.log("═══════════════════════════════════════════");

    initStatsTracking();

    if (TWITCH_CLIENT_ID && TWITCH_OAUTH && TWITCH_BROADCASTER_ID) {
        fetchFollowerCount();
        fetchViewerCount();
        setInterval(fetchFollowerCount, 60000);
        setInterval(fetchViewerCount, 30000);
        console.log("[TWITCH API] Sync followers + viewers activée");
    }

    savePersistentState();
    console.log("[STATE] Sauvegarde persistante activée (toutes les 30s)");

    // ── Auto-lancement OBS Bridge (local uniquement) ──
    if (config.server?.mode === "local") {
        const bridgePath = path.join(__dirname, "..", "obs-local-bridge");

        const bridge = spawn("node", ["obs-bridge.js"], {
            cwd: bridgePath,
            env: {
                ...process.env,
                OBS_URL: "ws://127.0.0.1:4455",
                OBS_PASSWORD: "YGv1V28epPidKsMD",
                BRIDGE_TOKEN: "3CvH3Dt3sSzbIgkvUp7rB8obXm2_2Jd6wwo1qBC5zjgVWRvdc",
                BRIDGE_PORT: "3001"
            },
            stdio: ["ignore", "pipe", "pipe"]
        });
        bridge.stdout.on("data", d => console.log("[BRIDGE]", d.toString().trim()));
        bridge.stderr.on("data", d => console.log("[BRIDGE ERR]", d.toString().trim()));
        bridge.on("error", e => console.log("[BRIDGE] Erreur:", e.message));
        bridge.on("exit", code => console.log(`[BRIDGE] Arrêté (code ${code})`));
        console.log("[BRIDGE] OBS Bridge démarré (PID", bridge.pid + ")");

        process.on("exit", () => { try { bridge.kill(); } catch (e) {} });
        process.on("SIGINT", () => { try { bridge.kill(); } catch (e) {} process.exit(); });
    }
});
})();

