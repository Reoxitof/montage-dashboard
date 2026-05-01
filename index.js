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

app.use(session({
    store: new FileStore({
        path: path.join(__dirname, "sessions"),
        ttl: 60 * 60 * 24 * 7,
        retries: 1,
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
<title>BlueSky — ${title}</title>
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
<h1>BLUESKY PANEL</h1>
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
        if (config.localAuth?.allowRegister === false) return res.redirect("/login.html?error=register_disabled");

        const username = String(req.body.username || "").toLowerCase().trim();
        const email = String(req.body.email || "").toLowerCase().trim() || null;
        const password = String(req.body.password || "");

        if (!/^[a-z0-9_]{3,32}$/.test(username)) return res.redirect("/register.html?error=pseudo_invalide");
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.redirect("/register.html?error=email_invalide");
        if (!email) return res.redirect("/register.html?error=email_requis");
        if (password.length < 8) return res.redirect("/register.html?error=mot_de_passe_trop_court");
        if (await dbGetUser(username)) return res.redirect("/register.html?error=compte_existe");
        if (email) {
            const existing = await dbRow("SELECT id FROM users WHERE email = $1", [email]);
            if (existing) return res.redirect("/register.html?error=email_existe");
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
        res.redirect("/dashboard.html");
    } catch (e) {
        console.log("[AUTH] Register error :", e.message);
        res.redirect("/register.html?error=server_error");
    }
});
app.post("/auth/login", async (req, res) => {
    try {
        const identifier = String(req.body.username || "").toLowerCase().trim();
        const password = String(req.body.password || "");
        // Support login by username or email
        let user = await dbGetUser(identifier);
        if (!user && identifier.includes("@")) {
            user = await dbRow("SELECT * FROM users WHERE email = $1", [identifier]);
        }
        if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
            return res.redirect("/login.html?error=identifiants_invalides");
        }
        const now = new Date().toISOString();
        await dbUpdateUser(user.id, { lastLoginAt: now, lastSeenAt: now, loginCount: (user.loginCount || 0) + 1 });
        req.session.user = sanitizeUser({ ...user, lastLoginAt: now });
        res.redirect("/dashboard.html");
    } catch (e) {
        console.log("[AUTH] Login error :", e.message);
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
app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
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
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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

app.get("/health", (req, res) => res.json({ success: true, name: "BlueSky Final God Panel", time: new Date().toISOString() }));

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
        res.status(503).json({ success: false, bridge: false, error: e.message });
    }
});

app.get("/obs/full/audio-sources", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/audio-sources", {}, "GET");
        res.json(data);
    } catch (e) {
        res.status(503).json({ success: false, error: e.message, sources: [] });
    }
});

app.get("/obs/full/audio-levels", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/audio-levels", {}, "GET");
        res.json(data);
    } catch (e) {
        res.status(503).json({ success: false, error: e.message, levels: {} });
    }
});

app.get("/obs/full/scenes", obsControlAdminOnly, async (req, res) => {
    try {
        const data = await callObsBridge("/scenes", {}, "GET");
        res.json(data);
    } catch (e) {
        res.status(503).json({ success: false, error: e.message, scenes: [] });
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
    messages: {},
    logs: state.moderationLogs || []
};

function normalizeTextHard(input) {
    let text = String(input || "").toLowerCase();
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const leet = { "0":"o", "1":"i", "!":"i", "|":"i", "3":"e", "4":"a", "@":"a", "5":"s", "$":"s", "7":"t", "+":"t", "8":"b", "9":"g" };
    text = text.replace(/[01345789!|@+$]/g, c => leet[c] || c);
    text = text.replace(/[^a-z0-9]/g, "");
    text = text.replace(/(.)\1{2,}/g, "$1$1");
    return text;
}

function normalizeTextSoft(input) {
    return String(input || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function normalizeModeration() {
    const defaults = {
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
    };
    state.moderation = Object.assign({}, defaults, state.moderation || {});
    if (!Array.isArray(state.moderation.bannedWords)) state.moderation.bannedWords = [];
    if (!Array.isArray(state.moderation.timeoutSteps)) {
        state.moderation.timeoutSteps = String(state.moderation.timeoutSteps || "30,120,600").split(/[,\n]/).map(x => Math.max(1, parseInt(x) || 0)).filter(Boolean);
    }
    if (!state.moderation.timeoutSteps.length) state.moderation.timeoutSteps = [30, 120, 600];
    state.moderationWarnings = state.moderationWarnings || {};
    state.moderationLogs = state.moderationLogs || [];
    moderationMemory.logs = state.moderationLogs;
    return state.moderation;
}

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

function hasLink(message) {
    return /(https?:\/\/|www\.|discord\.gg\/|\b[a-z0-9-]+\.(com|fr|net|gg|io|org|tv)\b)/i.test(message);
}

function capsPercent(message) {
    const letters = message.replace(/[^a-zA-ZÀ-ÿ]/g, "");
    if (letters.length < 8) return 0;
    const caps = letters.replace(/[^A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]/g, "").length;
    return Math.round((caps / letters.length) * 100);
}

function findBannedWord(message, bannedWords, antiBypass) {
    const softMessage = normalizeTextSoft(message);
    const hardMessage = normalizeTextHard(message);
    for (const raw of bannedWords || []) {
        const word = String(raw || "").trim();
        if (!word) continue;
        const softWord = normalizeTextSoft(word);
        if (softWord && softMessage.includes(softWord)) return word;
        if (antiBypass) {
            const hardWord = normalizeTextHard(word);
            if (hardWord && hardMessage.includes(hardWord)) return word;
        }
    }
    return null;
}

function getWarningRecord(username) {
    const m = normalizeModeration();
    const key = String(username).toLowerCase();
    const now = Date.now();
    const resetMs = Number(m.warningResetHours || 24) * 3600000;
    let rec = state.moderationWarnings[key] || { count: 0, last: 0, reasons: [] };
    if (rec.last && now - rec.last > resetMs) rec = { count: 0, last: 0, reasons: [] };
    return { key, rec };
}

function addWarning(username, reason) {
    const { key, rec } = getWarningRecord(username);
    rec.count = Number(rec.count || 0) + 1;
    rec.last = Date.now();
    rec.reasons = Array.isArray(rec.reasons) ? rec.reasons : [];
    rec.reasons.unshift({ time: new Date().toISOString(), reason });
    rec.reasons = rec.reasons.slice(0, 10);
    state.moderationWarnings[key] = rec;
    return rec;
}

function detectModerationViolation(username, message, tags) {
    const m = normalizeModeration();
    if (!m.enabled) return null;
    if (m.exemptMods && userIsAllowed(tags, username)) return null;

    const banned = findBannedWord(message, m.bannedWords, m.antiBypass);
    if (banned) return { reason: "mot interdit", details: banned };

    if (m.blockLinks && hasLink(message)) return { reason: "lien interdit" };

    if (m.blockCaps && capsPercent(message) >= Number(m.maxCapsPercent || 70)) return { reason: "majuscules abusives" };

    const now = Date.now();
    const key = String(username).toLowerCase();
    const windowMs = Number(m.spamWindowSeconds || 8) * 1000;
    moderationMemory.messages[key] = (moderationMemory.messages[key] || []).filter(t => now - t < windowMs);
    moderationMemory.messages[key].push(now);
    if (moderationMemory.messages[key].length > Number(m.spamLimit || 5)) return { reason: "spam" };

    return null;
}

async function applyModeration(channel, tags, username, message, violation) {
    const m = normalizeModeration();
    const safeName = tags.username || username;
    const rec = addWarning(safeName, violation.reason + (violation.details ? " : " + violation.details : ""));
    const warns = rec.count;

    try {
        if (m.deleteMessage && tags.id && typeof twitchClient.deletemessage === "function") {
            await twitchClient.deletemessage(channel, tags.id).catch(() => {});
        }

        if (m.banAtWarnings > 0 && warns >= Number(m.banAtWarnings)) {
            await twitchClient.ban(channel, safeName, violation.reason);
            twitchClient.say(channel, "⛔ @" + username + " banni : trop d'avertissements (" + warns + ")").catch(() => {});
            addModerationLog(username, violation.reason, "ban auto", message, warns);
            return;
        }

        if (m.warnOnlyFirstOffense && warns === 1) {
            twitchClient.say(channel, "⚠️ @" + username + " avertissement 1/" + m.banAtWarnings + " : " + violation.reason).catch(() => {});
            addModerationLog(username, violation.reason, "warn auto", message, warns);
            return;
        }

        const stepIndex = Math.max(0, warns - (m.warnOnlyFirstOffense ? 2 : 1));
        const timeout = Number(m.timeoutSteps[Math.min(stepIndex, m.timeoutSteps.length - 1)] || 30);
        await twitchClient.timeout(channel, safeName, timeout, violation.reason);
        twitchClient.say(channel, "⚠️ @" + username + " timeout " + timeout + "s — warn " + warns + "/" + m.banAtWarnings + " : " + violation.reason).catch(() => {});
        addModerationLog(username, violation.reason, "timeout auto " + timeout + "s", message, warns);
    } catch (e) {
        addModerationLog(username, violation.reason, "échec action Twitch", message, warns);
        console.log("[MODERATION] Action impossible :", e.message);
    }
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
    const activeProfileId = config.overlay?.activeProfile || "bluesky";
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
app.post("/overlay/profile", requireAdmin, (req, res) => {
    const profileId = String(req.body.profile || "").trim();
    const profiles = config.overlayProfiles || {};
    if (!profiles[profileId]) return res.status(400).json({ error: "profile_not_found" });

    config.overlay.activeProfile = profileId;
    const profileData = profiles[profileId];

    // Sync rotatingTexts in overlay
    config.overlay.rotatingTexts = profileData.rotatingTexts;
    config.overlay.discordInvite = profileData.discordInvite;

    // Save config
    try {
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(config, null, 2), "utf-8");
    } catch (e) {
        console.log("[PROFILE] Erreur sauvegarde config :", e.message);
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
        const activeProfileId = config.overlay?.activeProfile || "bluesky";
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

/* ================= ROUTES — STATE ================= */

app.get("/state", (req, res) => {
    // Ne pas renvoyer une alerte trop vieille (évite qu'elle reste sur rechargement)
    const alertAge = state.alert?.time ? Date.now() - new Date(state.alert.time).getTime() : Infinity;
    const safeState = { ...state, alert: alertAge < 7000 ? state.alert : null };
    res.json(safeState);
});

/* ================= ROUTES — TEST ALERTS ================= */

app.get("/test/follow", (req, res) => {
    sendAlert("follower-latest", "Reoxitof");
    res.send("follow test");
});
app.get("/test/sub", (req, res) => {
    sendAlert("subscriber-latest", "Reoxitof", "1 mois");
    res.send("sub test");
});
app.get("/test/tip", (req, res) => {
    sendAlert("tip-latest", "Reoxitof", "5€");
    res.send("tip test");
});
app.get("/test/cheer", (req, res) => {
    sendAlert("cheer-latest", "Reoxitof", "100 bits");
    res.send("cheer test");
});
app.get("/test/raid", (req, res) => {
    sendAlert("raid-latest", "Reoxitof", "10 viewers");
    res.send("raid test");
});

app.get("/test/custom", (req, res) => {
    const typeMap = {
        follow: "follower-latest", sub: "subscriber-latest",
        tip: "tip-latest", cheer: "cheer-latest", raid: "raid-latest"
    };
    const alertType = typeMap[req.query.type] || "follower-latest";
    const name = req.query.name || "Viewer";
    const extra = req.query.extra || "";
    sendAlert(alertType, name, extra);
    res.send("custom test: " + alertType);
});

/* ================= ROUTES — SUB GOAL ================= */

app.get("/subgoal", (req, res) => res.json(state.subGoal));

app.get("/subgoal/set/:current/:target", (req, res) => {
    state.subGoal.current = parseInt(req.params.current) || 0;
    state.subGoal.target = parseInt(req.params.target) || 50;
    io.emit("subGoal", state.subGoal);
    savePersistentState();
    res.json(state.subGoal);
});

app.get("/subgoal/add/:amount", (req, res) => {
    state.subGoal.current += parseInt(req.params.amount) || 1;
    if (state.subGoal.current > state.subGoal.target) state.subGoal.current = state.subGoal.target;
    io.emit("subGoal", state.subGoal);
    savePersistentState();
    res.json(state.subGoal);
});

app.get("/subgoal/reset", (req, res) => {
    state.subGoal.current = 0;
    io.emit("subGoal", state.subGoal);
    savePersistentState();
    res.json(state.subGoal);
});

/* ================= ROUTES — VOTE ================= */

app.get("/vote/state", (req, res) => {
    res.json({
        visible: voteState.visible, active: voteState.active, finished: voteState.finished,
        target: voteState.target, jailVotes: voteState.jailVotes, banVotes: voteState.banVotes,
        freeVotes: voteState.freeVotes, timeLeft: voteState.timeLeft
    });
});

app.get("/vote/show", (req, res) => {
    voteState.visible = true; voteState.active = false; voteState.finished = false;
    voteState.jailVotes = 0; voteState.banVotes = 0; voteState.freeVotes = 0; voteState.voters = {};
    voteState.target = ""; voteState.timeLeft = 0;
    if (voteState.timer) clearInterval(voteState.timer);
    res.json({ ok: true });
});

app.get("/vote/hide", (req, res) => {
    voteState.visible = false; voteState.active = false;
    if (voteState.timer) clearInterval(voteState.timer);
    res.json({ ok: true });
});

app.get("/vote/start", (req, res) => {
    const target = req.query.target || "Joueur";
    const duration = parseInt(req.query.duration) || 60;
    voteState.visible = true; voteState.active = true; voteState.finished = false;
    voteState.target = target; voteState.jailVotes = 0; voteState.banVotes = 0; voteState.freeVotes = 0;
    voteState.voters = {}; voteState.timeLeft = duration;
    if (voteState.timer) clearInterval(voteState.timer);
    voteState.timer = setInterval(() => {
        voteState.timeLeft--;
        if (voteState.timeLeft <= 0) {
            voteState.active = false; voteState.finished = true;
            clearInterval(voteState.timer);
        }
    }, 1000);
    res.json({ ok: true });
});

app.get("/vote/stop", (req, res) => {
    voteState.active = false; voteState.finished = true;
    if (voteState.timer) clearInterval(voteState.timer);
    res.json({ ok: true });
});

/* ================= ROUTES — POLL (multi-options) ================= */

app.get("/poll/state", (req, res) => {
    const voteCounts = {};
    pollState.options.forEach(opt => { voteCounts[opt] = pollState.votes[opt] || 0; });
    res.json({
        visible: pollState.visible, active: pollState.active, finished: pollState.finished,
        question: pollState.question, options: pollState.options,
        votes: voteCounts, timeLeft: pollState.timeLeft
    });
});

app.get("/poll/start", (req, res) => {
    const question = req.query.question || "Sondage";
    const options = (req.query.options || "Option A,Option B").split(",").map(s => s.trim()).filter(Boolean);
    const duration = parseInt(req.query.duration) || 60;

    pollState.visible = true; pollState.active = true; pollState.finished = false;
    pollState.question = question; pollState.options = options;
    pollState.votes = {}; pollState.voters = {}; pollState.timeLeft = duration;
    options.forEach(opt => { pollState.votes[opt] = 0; });

    if (pollState.timer) clearInterval(pollState.timer);
    pollState.timer = setInterval(() => {
        pollState.timeLeft--;
        if (pollState.timeLeft <= 0) {
            pollState.active = false; pollState.finished = true;
            clearInterval(pollState.timer);
        }
    }, 1000);
    io.emit("pollUpdate", pollState);
    res.json({ ok: true });
});

app.get("/poll/stop", (req, res) => {
    pollState.active = false; pollState.finished = true;
    if (pollState.timer) clearInterval(pollState.timer);
    io.emit("pollUpdate", pollState);
    res.json({ ok: true });
});

app.get("/poll/hide", (req, res) => {
    pollState.visible = false; pollState.active = false;
    if (pollState.timer) clearInterval(pollState.timer);
    io.emit("pollUpdate", pollState);
    res.json({ ok: true });
});

/* ================= ROUTES — HIGHLIGHT ================= */

app.get("/highlight/show", (req, res) => {
    highlightState.visible = true;
    highlightState.username = req.query.username || "Viewer";
    highlightState.message = req.query.message || "Message";
    highlightState.color = req.query.color || "#9b59b6";
    io.emit("highlight", highlightState);
    // Auto-hide après 8s
    setTimeout(() => {
        highlightState.visible = false;
        io.emit("highlight", highlightState);
    }, 8000);
    res.json({ ok: true });
});

app.get("/highlight/hide", (req, res) => {
    highlightState.visible = false;
    io.emit("highlight", highlightState);
    res.json({ ok: true });
});

/* ================= ROUTES — THEME ================= */

app.get("/theme", (req, res) => res.json(state.theme));

app.post("/theme", (req, res) => {
    const t = req.body;
    if (t.primary) state.theme.primary = t.primary;
    if (t.primaryDim) state.theme.primaryDim = t.primaryDim;
    if (t.primaryBright) state.theme.primaryBright = t.primaryBright;
    if (t.primaryGlow) state.theme.primaryGlow = t.primaryGlow;
    if (t.accent) state.theme.accent = t.accent;
    io.emit("themeUpdate", state.theme);
    savePersistentState();
    res.json(state.theme);
});

/* ================= ROUTES — ALERT MESSAGES ================= */

app.get("/alert-messages", (req, res) => res.json(state.alertMessages));

app.post("/alert-messages", (req, res) => {
    const msgs = req.body;
    Object.keys(msgs).forEach(key => {
        if (state.alertMessages[key]) {
            if (msgs[key].title) state.alertMessages[key].title = msgs[key].title;
            if (msgs[key].subtitle) state.alertMessages[key].subtitle = msgs[key].subtitle;
        }
    });
    io.emit("alertMessagesUpdate", state.alertMessages);
    savePersistentState();
    res.json(state.alertMessages);
});

/* ================= ROUTES — SCENES ================= */

app.get("/scene", (req, res) => res.json({ scene: state.scene }));

app.get("/scene/set/:name", (req, res) => {
    state.scene = req.params.name;
    io.emit("sceneChange", state.scene);
    savePersistentState();
    res.json({ scene: state.scene });
});

/* ================= ROUTES — BRB ================= */

app.get("/brb/on", (req, res) => {
    state.brb = true;
    state.brbMessage = req.query.message || state.brbMessage;
    io.emit("brbUpdate", { brb: true, message: state.brbMessage });
    res.json({ brb: true, message: state.brbMessage });
});

app.get("/brb/off", (req, res) => {
    state.brb = false;
    io.emit("brbUpdate", { brb: false, message: "" });
    res.json({ brb: false });
});

app.get("/brb/state", (req, res) => {
    res.json({ brb: state.brb, message: state.brbMessage });
});

/* ================= ROUTES — CLIP TWITCH ================= */

app.post("/clip/create", obsControlAdminOnly, async (req, res) => {
    try {
        const cfg = config.twitchApi || {};
        const clientId = cfg.clientId;
        const token = (cfg.oauthToken || "").replace(/^oauth:/, "");
        const broadcasterId = cfg.broadcasterId;
        if (!clientId || !token || !broadcasterId) return res.json({ success: false, error: "Twitch API non configurée" });

        const r = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`, {
            method: "POST",
            headers: { "Client-ID": clientId, "Authorization": `Bearer ${token}` }
        });
        const data = await r.json();
        if (data.data && data.data[0]) {
            const clipId = data.data[0].id;
            const editUrl = data.data[0].edit_url;
            console.log("[CLIP] Créé :", clipId);
            res.json({ success: true, clipId, editUrl, url: `https://clips.twitch.tv/${clipId}` });
        } else {
            res.json({ success: false, error: data.message || "Erreur Twitch" });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get("/clip/history", async (req, res) => {
    try {
        const cfg = config.twitchApi || {};
        const clientId = cfg.clientId;
        const token = (cfg.oauthToken || "").replace(/^oauth:/, "");
        const broadcasterId = cfg.broadcasterId;
        if (!clientId || !token || !broadcasterId) return res.json({ success: false, error: "API Twitch non configurée", clips: [] });
        const r = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=10`, {
            headers: { "Client-ID": clientId, "Authorization": `Bearer ${token}` }
        });
        const data = await r.json();
        console.log("[CLIPS]", JSON.stringify(data).slice(0, 200));
        if (data.error || data.status === 401) return res.json({ success: false, error: "Token Twitch expiré — mets à jour oauthToken dans config.json", clips: [] });
        res.json({ success: true, clips: (data.data || []).map(c => ({ id: c.id, title: c.title, url: c.url, thumbnail: c.thumbnail_url, views: c.view_count, created: c.created_at })) });
    } catch (e) {
        console.log("[CLIPS ERROR]", e.message);
        res.json({ success: false, error: e.message, clips: [] });
    }
});

/* ================= ROUTES — SCREEN OVERLAY (start/pause/fin) ================= */

/* ================= ROUTES — OBS PREVIEW ================= */

app.get("/obs/preview", obsControlAdminOnly, async (req, res) => {
    try {
        const width = parseInt(req.query.width) || 640;
        const height = parseInt(req.query.height) || 360;
        const baseUrl = getObsBridgeUrl();
        const token = getObsBridgeToken();
        if (!baseUrl) return res.status(503).json({ error: "bridge_url_missing" });

        const headers = {};
        if (token) { headers["x-bridge-token"] = token; headers["authorization"] = `Bearer ${token}`; }

        const r = await fetch(`${baseUrl}/preview?width=${width}&height=${height}`, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return res.status(r.status).json({ error: "bridge_error" });

        const buf = await r.arrayBuffer();
        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "no-store");
        res.send(Buffer.from(buf));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});




app.get("/screen/hide", (req, res) => {
    state.screenOverlay = { active: false, type: "" };
    io.emit("screenOverlay", state.screenOverlay);
    console.log("[SCREEN] Masqué");
    res.json({ ok: true });
});

app.get("/screen/:type", (req, res) => {
    const type = req.params.type;
    if (!["start", "pause", "fin"].includes(type)) {
        return res.status(400).json({ error: "Type invalide. Utilise: start, pause, fin" });
    }
    state.screenOverlay = { active: true, type };
    io.emit("screenOverlay", state.screenOverlay);
    console.log("[SCREEN]", type.toUpperCase(), "affiché");
    res.json({ ok: true, type });
});


/* ================= ROUTES — MODERATION ================= */

app.get("/moderation", (req, res) => {
    res.json(normalizeModeration());
});

app.post("/moderation", (req, res) => {
    const body = req.body || {};
    const current = normalizeModeration();
    state.moderation = {
        enabled: body.enabled === true || body.enabled === "true",
        antiBypass: body.antiBypass !== false && body.antiBypass !== "false",
        blockLinks: body.blockLinks === true || body.blockLinks === "true",
        blockCaps: body.blockCaps === true || body.blockCaps === "true",
        maxCapsPercent: Math.max(1, Math.min(100, parseInt(body.maxCapsPercent) || current.maxCapsPercent || 70)),
        spamLimit: Math.max(2, parseInt(body.spamLimit) || current.spamLimit || 5),
        spamWindowSeconds: Math.max(2, parseInt(body.spamWindowSeconds) || current.spamWindowSeconds || 8),
        deleteMessage: body.deleteMessage === true || body.deleteMessage === "true",
        exemptMods: body.exemptMods !== false && body.exemptMods !== "false",
        warnOnlyFirstOffense: body.warnOnlyFirstOffense !== false && body.warnOnlyFirstOffense !== "false",
        warningResetHours: Math.max(1, parseInt(body.warningResetHours) || current.warningResetHours || 24),
        timeoutSteps: Array.isArray(body.timeoutSteps)
            ? body.timeoutSteps.map(x => Math.max(1, parseInt(x) || 0)).filter(Boolean)
            : String(body.timeoutSteps || "30,120,600").split(/[,\n]/).map(x => Math.max(1, parseInt(x) || 0)).filter(Boolean),
        banAtWarnings: Math.max(0, parseInt(body.banAtWarnings) || current.banAtWarnings || 4),
        bannedWords: Array.isArray(body.bannedWords)
            ? body.bannedWords.map(w => String(w).trim()).filter(Boolean)
            : String(body.bannedWords || "").split(/[\n,]/).map(w => w.trim()).filter(Boolean)
    };
    savePersistentState();
    res.json(state.moderation);
});

app.get("/moderation/logs", (req, res) => {
    res.json(moderationMemory.logs);
});

app.get("/moderation/warnings", (req, res) => {
    res.json(state.moderationWarnings || {});
});

app.delete("/moderation/warnings/:username", (req, res) => {
    const username = String(req.params.username || "").toLowerCase();
    if (state.moderationWarnings) delete state.moderationWarnings[username];
    addModerationLog(username, "reset warnings", "reset manuel", "", 0);
    savePersistentState();
    res.json({ ok: true });
});

app.post("/moderation/timeout", async (req, res) => {
    const username = String(req.body.username || "").replace(/^@/, "").trim();
    const seconds = Math.max(1, parseInt(req.body.seconds) || (normalizeModeration().timeoutSteps?.[0] || 30));
    const reason = req.body.reason || "modération dashboard";
    if (!username) return res.status(400).json({ error: "username requis" });

    // Utiliser le token du modo connecté si disponible
    const sessionUser = req.session?.user?.id ? dbGetUserById(req.session.user.id) : null;
    const modoToken = sessionUser?.twitchToken;
    const modoName = sessionUser?.username || "dashboard";

    try {
        if (modoToken) {
            // Utiliser le token du modo — la sanction apparaît sous son nom
            const tmi = require("tmi.js");
            const modoClient = new tmi.Client({
                identity: { username: modoName, password: "oauth:" + modoToken },
                channels: [TWITCH_CHANNEL],
                connection: { reconnect: false }
            });
            await modoClient.connect();
            await modoClient.timeout(TWITCH_CHANNEL, username, seconds, reason);
            await modoClient.disconnect();
        } else {
            // Fallback : utiliser le bot principal
            await twitchClient.timeout(TWITCH_CHANNEL, username, seconds, reason);
        }
        addModerationLog(username, reason, "timeout " + seconds + "s par " + modoName, "");
        res.json({ ok: true, by: modoName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/moderation/ban", async (req, res) => {
    const username = String(req.body.username || "").replace(/^@/, "").trim();
    const reason = req.body.reason || "ban dashboard";
    if (!username) return res.status(400).json({ error: "username requis" });

    // Utiliser le token du modo connecté si disponible
    const sessionUser = req.session?.user?.id ? dbGetUserById(req.session.user.id) : null;
    const modoToken = sessionUser?.twitchToken;
    const modoName = sessionUser?.username || "dashboard";

    try {
        if (modoToken) {
            const tmi = require("tmi.js");
            const modoClient = new tmi.Client({
                identity: { username: modoName, password: "oauth:" + modoToken },
                channels: [TWITCH_CHANNEL],
                connection: { reconnect: false }
            });
            await modoClient.connect();
            await modoClient.ban(TWITCH_CHANNEL, username, reason);
            await modoClient.disconnect();
        } else {
            await twitchClient.ban(TWITCH_CHANNEL, username, reason);
        }
        addModerationLog(username, reason, "ban par " + modoName, "");
        res.json({ ok: true, by: modoName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ================= ROUTES — CUSTOM COMMANDS ================= */

app.get("/commands", (req, res) => res.json(state.customCommands));

app.post("/commands", (req, res) => {
    const { command, response } = req.body;
    if (!command || !response) return res.status(400).json({ error: "command et response requis" });
    const cmd = command.startsWith("!") ? command.toLowerCase() : "!" + command.toLowerCase();
    state.customCommands[cmd] = response;
    savePersistentState();
    res.json(state.customCommands);
});

app.delete("/commands/:cmd", (req, res) => {
    const cmd = "!" + req.params.cmd.toLowerCase();
    delete state.customCommands[cmd];
    savePersistentState();
    res.json(state.customCommands);
});

/* ================= ROUTES — STATS ================= */

app.get("/stats", (req, res) => res.json(state.stats));

app.get("/stats/reset", (req, res) => {
    state.stats = {
        follows: 0, subs: 0, tips: 0, cheers: 0, raids: 0, chatMessages: 0,
        followsPerHour: [], subsPerHour: [], chatPerMinute: [],
        peakViewers: 0, currentViewers: 0
    };
    savePersistentState();
    res.json(state.stats);
});

/* ================= ROUTES — VIEWERS COUNT ================= */

app.get("/viewers", (req, res) => {
    res.json({ current: state.stats.currentViewers, peak: state.stats.peakViewers });
});

/* ================= ROUTES — SOUND UPLOAD ================= */

app.post("/sounds/upload", uploadSound.single("sound"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier" });
    res.json({ ok: true, filename: req.file.filename, path: "/sounds/" + req.file.filename });
});

app.get("/sounds/list", (req, res) => {
    const dir = path.join(__dirname, "public", "sounds");
    try {
        const files = fs.readdirSync(dir).filter(f => !f.startsWith("."));
        res.json(files);
    } catch (e) {
        res.json([]);
    }
});

app.delete("/sounds/:filename", (req, res) => {
    const filePath = path.join(__dirname, "public", "sounds", req.params.filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ ok: true });
        } else {
            res.status(404).json({ error: "Fichier non trouvé" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});



/* ================= SOCKET.IO ================= */

let relaySocket = null;

io.on("connection", (socket) => {
    console.log("[SOCKET] Overlay connecté :", socket.id);
    socket.emit("state", state);
    socket.emit("themeUpdate", state.theme);
    socket.emit("sceneChange", state.scene);
    socket.emit("brbUpdate", { brb: state.brb, message: state.brbMessage });
    socket.emit("screenOverlay", state.screenOverlay);
    socket.emit("alertMessagesUpdate", state.alertMessages);
    if (highlightState.visible) socket.emit("highlight", highlightState);
    if (pollState.visible) socket.emit("pollUpdate", pollState);

    // ── RELAY CLIENT ──
    socket.on("relay:register", (data) => {
        const token = data?.token || "";
        const expected = config.obsBridge?.token || "";
        if (expected && token !== expected) {
            socket.emit("relay:registered", { ok: false, message: "token invalide" });
            return;
        }
        socket.join("relay-clients");
        relaySocket = socket;
        console.log("[RELAY] Client local connecté :", socket.id);
        socket.emit("relay:registered", { ok: true, message: "Relay actif" });
        io.emit("relayStatus", { connected: true });
    });

    socket.on("disconnect", () => {
        if (relaySocket && relaySocket.id === socket.id) {
            relaySocket = null;
            console.log("[RELAY] Client local déconnecté");
            io.emit("relayStatus", { connected: false });
        }
        console.log("[SOCKET] Overlay déconnecté :", socket.id);
    });
});

/* ================= RELAY — forward HTTP vers bridge local ================= */

app.get("/relay/status", (req, res) => {
    res.json({ connected: !!relaySocket, socketId: relaySocket?.id || null });
});

app.post("/relay/exec", requireAdmin, (req, res) => {
    if (!relaySocket) return res.status(503).json({ error: "relay_not_connected" });
    const command = String(req.body.command || "");
    const allowed = ["start_rtmp", "start_relay", "start_bridge"];
    if (!allowed.includes(command)) return res.status(400).json({ error: "command_not_allowed" });
    relaySocket.emit("relay:exec", { command });
    res.json({ success: true, command });
});

app.get("/relay/hls", async (req, res) => {
    try {
        const file = req.query.file || "live/index.m3u8";
        const result = await new Promise((resolve, reject) => {
            if (!relaySocket) return reject(new Error("relay_not_connected"));
            const timeout = setTimeout(() => reject(new Error("relay_timeout")), 8000);
            relaySocket.emit("relay:request", {
                path: `/${file}`,
                query: "",
                method: "GET",
                headers: {},
                body: null
            }, (data) => { clearTimeout(timeout); resolve(data); });
        });
        if (!result || result.status >= 400) return res.status(result?.status || 502).end();
        const buf = Buffer.from(result.body, "base64");
        const ct = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
        res.set("Content-Type", ct);
        res.set("Cache-Control", "no-store");
        res.set("Access-Control-Allow-Origin", "*");
        res.send(buf);
    } catch(e) {
        res.status(503).end();
    }
});

app.get("/relay/mjpeg", (req, res) => {
    // Proxy du flux MJPEG depuis la machine locale via relay socket
    if (!relaySocket) return res.status(503).json({ error: "relay_not_connected" });

    res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=--frame",
        "Cache-Control": "no-store",
        "Connection": "close"
    });

    relaySocket.emit("relay:mjpeg:start", { token: config.obsBridge?.token || "" });

    const onChunk = (data) => {
        try { res.write(Buffer.from(data, "base64")); } catch(e) {}
    };

    relaySocket.on("relay:mjpeg:chunk", onChunk);

    req.on("close", () => {
        relaySocket?.off("relay:mjpeg:chunk", onChunk);
        relaySocket?.emit("relay:mjpeg:stop");
    });
});

app.get("/relay/preview", async (req, res) => {
    try {
        const width = parseInt(req.query.width) || 640;
        const height = parseInt(req.query.height) || 360;
        if (!relaySocket) return res.status(503).json({ error: "relay_not_connected" });

        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("relay_timeout")), 10000);
            relaySocket.emit("relay:request", {
                path: `/preview?width=${width}&height=${height}`,
                query: "",
                method: "GET",
                headers: { "x-bridge-token": config.obsBridge?.token || "" },
                body: null
            }, (data) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        if (!result || result.status >= 400) return res.status(result?.status || 502).json({ error: "bridge_error" });
        const buf = Buffer.from(result.body, "base64");
        res.set("Content-Type", result.headers?.["content-type"] || "image/jpeg");
        res.set("Cache-Control", "no-store");
        res.send(buf);
    } catch(e) {
        res.status(503).json({ error: e.message });
    }
});

/* ================= TWITCH ================= */

const twitchClient = new tmi.Client({
    connection: { reconnect: true, secure: true },
    identity: TWITCH_OAUTH ? {
        username: config.twitch?.botUsername || OWNER_TWITCH,
        password: TWITCH_OAUTH.startsWith("oauth:") ? TWITCH_OAUTH : "oauth:" + TWITCH_OAUTH
    } : undefined,
    channels: [TWITCH_CHANNEL]
});

global.twitchClient = twitchClient;

twitchClient.connect().then(() => {
    console.log("[TWITCH] connecté au chat :", TWITCH_CHANNEL);
}).catch((err) => {
    console.log("[TWITCH] erreur connexion :", err);
});

twitchClient.on("message", (channel, tags, message, self) => {
    if (self) return;

    const username = tags["display-name"] || tags.username || "Viewer";
    const msg = String(message).trim();
    const cmd = msg.toLowerCase();
    const args = cmd.split(" ").slice(1);

    // Stats
    state.stats.chatMessages++;
    chatCountThisMinute++;

    console.log("[CHAT]", username, ":", msg);

    const moderationViolation = detectModerationViolation(username, msg, tags);
    if (moderationViolation) {
        applyModeration(channel, tags, username, msg, moderationViolation);
        return;
    }

    // Émettre + sauvegarder le message chat vers overlay/dashboard
    const liveChatMessage = {
        id: tags.id || (Date.now().toString(36) + Math.random().toString(36).slice(2)),
        username,
        message: msg,
        color: tags.color || "#9b59b6",
        badges: tags.badges || {},
        isOwner: !!(tags.badges && tags.badges.broadcaster),
        isMod: !!(tags.mod || (tags.badges && tags.badges.moderator)),
        isSub: !!(tags.subscriber || (tags.badges && tags.badges.subscriber)),
        time: new Date().toISOString()
    };

    if (typeof pushDashboardChatMessage === "function") {
        pushDashboardChatMessage(liveChatMessage);
    } else {
        io.emit("chatMessage", liveChatMessage);
    }

    // Vote commands
    if (cmd.startsWith("!vote") || cmd === "!jail" || cmd === "!ban" || cmd === "!free" || cmd === "!stopvote") {
        sendVoteCommand(username, msg, tags);
    }

    // Vote intégré
    if (cmd === "!jail" && voteState.active && !voteState.voters[username]) {
        voteState.voters[username] = "jail"; voteState.jailVotes++;
    }
    if (cmd === "!ban" && voteState.active && !voteState.voters[username]) {
        voteState.voters[username] = "ban"; voteState.banVotes++;
    }
    if (cmd === "!free" && voteState.active && !voteState.voters[username]) {
        voteState.voters[username] = "free"; voteState.freeVotes++;
    }
    if (cmd === "!stopvote" && userIsAllowed(tags, username)) {
        voteState.active = false; voteState.finished = true;
        if (voteState.timer) clearInterval(voteState.timer);
    }

    // Poll votes — !1, !2, !3, etc.
    const pollVoteMatch = cmd.match(/^!(\d+)$/);
    if (pollVoteMatch && pollState.active) {
        const idx = parseInt(pollVoteMatch[1]) - 1;
        if (idx >= 0 && idx < pollState.options.length && !pollState.voters[username]) {
            const opt = pollState.options[idx];
            pollState.voters[username] = opt;
            pollState.votes[opt] = (pollState.votes[opt] || 0) + 1;
        }
    }

    // Custom commands
    const customResp = state.customCommands[cmd];
    if (customResp) {
        twitchClient.say(channel, customResp);
        return;
    }

    // Mini-games
    if (["!points", "!dice", "!roulette", "!duel", "!accept", "!decline"].includes(cmd.split(" ")[0])) {
        handleMiniGame(username, cmd.split(" ")[0], args, twitchClient, channel);
        return;
    }

    // Highlight (mod/owner)
    if (cmd.startsWith("!highlight ") && userIsAllowed(tags, username)) {
        const hlMsg = msg.substring(11).trim();
        if (hlMsg) {
            highlightState.visible = true;
            highlightState.username = username;
            highlightState.message = hlMsg;
            highlightState.color = tags.color || "#9b59b6";
            io.emit("highlight", highlightState);
            setTimeout(() => {
                highlightState.visible = false;
                io.emit("highlight", highlightState);
            }, 8000);
        }
        return;
    }

    // Poll start (mod/owner) — !poll "Question" "Opt1" "Opt2" "Opt3" 60
    if (cmd.startsWith("!poll ") && userIsAllowed(tags, username)) {
        const matches = msg.match(/"([^"]+)"/g);
        if (matches && matches.length >= 3) {
            const question = matches[0].replace(/"/g, "");
            const options = matches.slice(1).map(m => m.replace(/"/g, ""));
            const durationMatch = msg.match(/(\d+)\s*$/);
            const duration = durationMatch ? parseInt(durationMatch[1]) : 60;

            pollState.visible = true; pollState.active = true; pollState.finished = false;
            pollState.question = question; pollState.options = options;
            pollState.votes = {}; pollState.voters = {}; pollState.timeLeft = duration;
            options.forEach(opt => { pollState.votes[opt] = 0; });

            if (pollState.timer) clearInterval(pollState.timer);
            pollState.timer = setInterval(() => {
                pollState.timeLeft--;
                if (pollState.timeLeft <= 0) {
                    pollState.active = false; pollState.finished = true;
                    clearInterval(pollState.timer);
                }
            }, 1000);
            io.emit("pollUpdate", pollState);
            twitchClient.say(channel, `📊 Sondage : ${question} — Votez avec !1, !2, !3... (${duration}s)`);
        }
        return;
    }

    if (cmd === "!stoppoll" && userIsAllowed(tags, username)) {
        pollState.active = false; pollState.finished = true;
        if (pollState.timer) clearInterval(pollState.timer);
        io.emit("pollUpdate", pollState);
        return;
    }

    // BRB (mod/owner)
    if (cmd === "!brb" && userIsAllowed(tags, username)) {
        state.brb = true;
        io.emit("brbUpdate", { brb: true, message: state.brbMessage });
        return;
    }
    if (cmd === "!back" && userIsAllowed(tags, username)) {
        state.brb = false;
        io.emit("brbUpdate", { brb: false, message: "" });
        return;
    }

    // Test alerts (mod/owner)
    if (!userIsAllowed(tags, username)) return;

    if (cmd === "!test follow") sendAlert("follower-latest", username);
    if (cmd === "!test sub") sendAlert("subscriber-latest", username, "1 mois");
    if (cmd === "!test tip") sendAlert("tip-latest", username, "5€");
    if (cmd === "!test cheer") sendAlert("cheer-latest", username, "100 bits");
    if (cmd === "!test raid") sendAlert("raid-latest", username, "10 viewers");
});

/* ================= TWITCH API — FOLLOWERS + VIEWERS ================= */

async function fetchFollowerCount() {
    if (!TWITCH_CLIENT_ID || !TWITCH_OAUTH || !TWITCH_BROADCASTER_ID) return;

    try {
        const response = await fetch(
            `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${TWITCH_BROADCASTER_ID}&first=1`,
            { headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${TWITCH_OAUTH}` } }
        );
        if (!response.ok) return;
        const data = await response.json();
        const total = data.total || 0;
        if (state.subGoal.current !== total) {
            state.subGoal.current = total;
            io.emit("subGoal", state.subGoal);
        }
    } catch (e) {
        console.log("[TWITCH API] Erreur followers :", e.message);
    }
}

async function fetchViewerCount() {
    if (!TWITCH_CLIENT_ID || !TWITCH_OAUTH || !TWITCH_BROADCASTER_ID) return;

    try {
        const response = await fetch(
            `https://api.twitch.tv/helix/streams?user_id=${TWITCH_BROADCASTER_ID}`,
            { headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${TWITCH_OAUTH}` } }
        );
        if (!response.ok) return;
        const data = await response.json();
        if (data.data && data.data.length > 0) {
            const viewers = data.data[0].viewer_count || 0;
            state.stats.currentViewers = viewers;
            if (viewers > state.stats.peakViewers) state.stats.peakViewers = viewers;
            io.emit("viewerCount", { current: viewers, peak: state.stats.peakViewers });
        } else {
            state.stats.currentViewers = 0;
        }
    } catch (e) {
        console.log("[TWITCH API] Erreur viewers :", e.message);
    }
}

/* ================= START ================= */


/* ================= MODERATION BANNED WORDS API ================= */

app.post("/moderation/bannedWords", (req, res) => {
    normalizeModeration();
    const words = Array.isArray(req.body.words)
        ? req.body.words.map(w => String(w).trim()).filter(Boolean)
        : [];

    state.moderation.bannedWords = words;
    savePersistentState();
    io.emit("moderationUpdated", state.moderation);
    res.json({ success: true, bannedWords: words });
});



/* ================= TWITCH API — APP TOKEN ================= */

let _twitchAppToken = null;
let _twitchAppTokenExpiry = 0;

async function getTwitchAppToken() {
    if (_twitchAppToken && Date.now() < _twitchAppTokenExpiry) return _twitchAppToken;
    if (!TWITCH_CLIENT_ID || !config.twitchApi?.clientSecret) return null;
    try {
        const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${config.twitchApi.clientSecret}&grant_type=client_credentials`, { method: "POST" });
        const data = await r.json();
        if (data.access_token) {
            _twitchAppToken = data.access_token;
            _twitchAppTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
            return _twitchAppToken;
        }
    } catch(e) { console.log("[TWITCH] App token error:", e.message); }
    return null;
}

function getTwitchAuthHeaders() {
    // Utilise l'App Token si disponible, sinon le user token
    const appToken = config.twitchApi?.appToken;
    const oauth = TWITCH_OAUTH.replace(/^oauth:/i, "");
    const token = appToken || oauth;
    return { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}` };
}

/* ================= TWITCH API — CHANNEL INFO ================= */

app.get("/twitch/channel-info", requireModOrAdmin, async (req, res) => {
    if (!TWITCH_CLIENT_ID || !TWITCH_BROADCASTER_ID) return res.status(400).json({ error: "Twitch API non configurée (CLIENT_ID ou BROADCASTER_ID manquant)" });
    const oauth = TWITCH_OAUTH.replace(/^oauth:/i, "");
    try {
        const r = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${TWITCH_BROADCASTER_ID}`, {
            headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${oauth}` }
        });
        const data = await r.json();
        if (!r.ok) return res.status(400).json({ error: data.message || "Erreur Twitch" });
        res.json(data.data?.[0] || {});
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/twitch/search-game", requireModOrAdmin, async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ games: [] });
    if (!TWITCH_CLIENT_ID) return res.status(400).json({ error: "Twitch API non configurée" });
    const headers = getTwitchAuthHeaders();
    try {
        const r2 = await fetch(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(q)}&first=8`, { headers });
        const search = await r2.json();
        console.log("[TWITCH SEARCH] status:", r2.status, "data:", JSON.stringify(search).slice(0, 200));
        if (!r2.ok) return res.status(400).json({ error: search.message || "Token invalide ou expiré" });
        const games = (search.data || []).slice(0, 8);
        res.json({ games });
    } catch(e) {
        console.log("[TWITCH SEARCH] error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/twitch/update-channel", requireModOrAdmin, async (req, res) => {
    if (!TWITCH_CLIENT_ID || !TWITCH_BROADCASTER_ID) return res.status(400).json({ error: "Twitch API non configurée" });
    const { title, gameId, language } = req.body;
    if (!title) return res.status(400).json({ error: "Titre requis" });

    // Utilise le user token stocké (doit avoir channel:manage:broadcast)
    const userToken = config.twitchApi?.userToken || TWITCH_OAUTH.replace(/^oauth:/i, "");

    try {
        const body = { title: String(title).slice(0, 140) };
        if (gameId) body.game_id = String(gameId);
        if (language) body.broadcaster_language = String(language);
        const r = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${TWITCH_BROADCASTER_ID}`, {
            method: "PATCH",
            headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${userToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        if (r.status === 204) return res.json({ success: true });
        const data = await r.json().catch(() => ({}));
        console.log("[TWITCH UPDATE] status:", r.status, data);
        res.status(r.ok ? 200 : 400).json(r.ok ? { success: true } : { error: data.message || "Token sans scope channel:manage:broadcast" });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sauvegarde du user token Twitch (généré via OAuth)
app.post("/twitch/save-user-token", requireAdmin, (req, res) => {
    const token = String(req.body.token || "").trim().replace(/^oauth:/i, "");
    if (!token) return res.status(400).json({ error: "Token requis" });
    config.twitchApi.userToken = token;
    res.json({ success: true });
});

// Page de callback OAuth Twitch (implicit flow — le token est dans le hash)
app.get("/twitch/oauth-callback", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Twitch Auth</title></head><body>
    <script>
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const token = params.get('access_token');
      if (token) {
        fetch('/twitch/save-user-token', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})})
          .then(() => { document.body.innerHTML = '<h2 style="font-family:sans-serif;color:green;">✅ Twitch connecté ! Vous pouvez fermer cette fenêtre.</h2>'; setTimeout(() => window.close(), 2000); });
      } else {
        document.body.innerHTML = '<h2 style="font-family:sans-serif;color:red;">❌ Erreur — token non reçu</h2>';
      }
    </script>
    <p style="font-family:sans-serif;">Connexion en cours...</p>
    </body></html>`);
});

/* ================= OBS API — ADMIN ONLY ================= */

app.get("/obs/status", requireAdmin, async (req, res) => {
    try {
        if (config.obs?.enabled && !obsBridgeEnabled() && !obsState.connected && !obsState.connecting) {
            connectOBS();
        }

        let scenes = config.obs?.defaultScenes || [];

        if (obsState.connected) {
            try {
                const data = await safeOBSCall("GetSceneList");
                scenes = (data.scenes || []).map(s => s.sceneName);
            } catch (e) {}
        }

        res.json({
            enabled: !!config.obs?.enabled,
            connected: obsState.connected,
            connecting: obsState.connecting,
            error: obsState.lastError,
            lastConnect: obsState.lastConnect,
            lastDisconnect: obsState.lastDisconnect,
            reconnectCount: obsState.reconnectCount,
            url: config.obs?.url || "",
            micInputName: config.obs?.micInputName || "Mic/Aux",
            scenes
        });
    } catch (e) {
        res.json({
            enabled: !!config.obs?.enabled,
            connected: false,
            connecting: false,
            error: e.message,
            scenes: config.obs?.defaultScenes || []
        });
    }
});

app.post("/obs/reconnect", requireAdmin, async (req, res) => {
    try {
        obsState.connected = false;
        obsConnected = false;
        const connected = await connectOBS(true);
        res.json({ success: connected, connected });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/scene", requireAdmin, async (req, res) => {
    try {
        const sceneName = String(req.body.scene || "").trim();
        if (!sceneName) return res.status(400).json({ error: "scene_required" });

        await safeOBSCall("SetCurrentProgramScene", { sceneName });
        res.json({ success: true, scene: sceneName });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/mic", requireAdmin, async (req, res) => {
    try {
        const inputName = String(req.body.inputName || config.obs?.micInputName || "Mic/Aux");
        const inputMuted = !!req.body.muted;

        await safeOBSCall("SetInputMute", { inputName, inputMuted });
        res.json({ success: true, inputName, muted: inputMuted });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/mic/toggle", requireAdmin, async (req, res) => {
    try {
        const inputName = String(req.body.inputName || config.obs?.micInputName || "Mic/Aux");
        const current = await safeOBSCall("GetInputMute", { inputName });
        const inputMuted = !current.inputMuted;

        await safeOBSCall("SetInputMute", { inputName, inputMuted });
        res.json({ success: true, inputName, muted: inputMuted });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/obs/alert", requireAdmin, async (req, res) => {
    try {
        const alertType = String(req.body.alertType || "follower-latest");
        const name = String(req.body.name || "TEST ALERT");
        const extra = String(req.body.extra || "");

        sendAlert(alertType, name, extra);
        res.json({ success: true, alertType, name });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


server.listen(APP_PORT, APP_HOST, () => {
    console.log("═══════════════════════════════════════════");
    console.log(" BlueSky Overlay — NUI Edition v3.0");
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

