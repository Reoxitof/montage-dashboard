/* ═══════════════════════════════════════════════════════════════
   BLUESKY OVERLAY — NUI SIGNATURE EDITION v3.0
   Script principal — Toutes fonctionnalités
   ═══════════════════════════════════════════════════════════════ */

/* ================= CONFIG DYNAMIQUE ================= */

let CONFIG = null;
let SERVER_NAME = "BlueSky Roleplay";
let FIVEM_ENDPOINT = "";
let lastServerName = "";
let lastPlayers = '<i class="fa-solid fa-users"></i> --/--';
let lastAlertId = 0;
let currentTheme = {};
let currentAlertMessages = {};

const alertConfigs = {
  "follower-latest": { title: "NOUVEAU FOLLOW", subtitle: "MERCI DE ME SUIVRE !", icon: "fa-solid fa-heart" },
  "subscriber-latest": { title: "NOUVEAU SUB", subtitle: "BIENVENUE DANS LA FAMILLE !", icon: "fa-solid fa-gem" },
  "tip-latest": { title: "NOUVEAU DON", subtitle: "MERCI POUR TA GÉNÉROSITÉ !", icon: "fa-solid fa-coins" },
  "cheer-latest": { title: "CHEER", subtitle: "MERCI POUR LES BITS !", icon: "fa-solid fa-bolt" },
  "raid-latest": { title: "RAID EN APPROCHE", subtitle: "BIENVENUE À TOUS !", icon: "fa-solid fa-triangle-exclamation" }
};

const alertSounds = {
  "follower-latest": "/sounds/follow.mp3",
  "subscriber-latest": "/sounds/sub.mp3",
  "tip-latest": "/sounds/tip.mp3",
  "cheer-latest": "/sounds/cheer.mp3",
  "raid-latest": "/sounds/raid.mp3"
};

/* ================= INIT ================= */

async function loadConfig() {
  try {
    const res = await fetch("/config", { cache: "no-store" });
    CONFIG = await res.json();

    SERVER_NAME = CONFIG.fivem.serverName || "BlueSky Roleplay";
    lastServerName = SERVER_NAME;

    FIVEM_ENDPOINT = CONFIG.fivem.corsProxy
      ? CONFIG.fivem.corsProxy + CONFIG.fivem.endpoint
      : CONFIG.fivem.endpoint;

    // Apply active profile if available
    if (CONFIG.activeProfileData) {
      applyOverlayProfile(CONFIG.activeProfileData);
    } else {
      if (CONFIG.overlay.rotatingTexts) {
        texts.length = 0;
        CONFIG.overlay.rotatingTexts.forEach(t => texts.push(t));
      }
      const info = document.getElementById("serverInfo");
      if (info && CONFIG.overlay.discordInvite) info.textContent = CONFIG.overlay.discordInvite;
    }

    if (CONFIG.subGoal) updateSubGoal(CONFIG.subGoal);
    if (CONFIG.theme) applyTheme(CONFIG.theme);
    if (CONFIG.alertMessages) currentAlertMessages = CONFIG.alertMessages;
    if (CONFIG.scene) applyScene(CONFIG.scene);
    if (CONFIG.brb) showBRB(CONFIG.brbMessage);
    if (CONFIG.screenOverlay && CONFIG.screenOverlay.active) showScreenOverlay(CONFIG.screenOverlay);

    console.log("[NUI] Config chargée");
  } catch (e) {
    console.log("[NUI] Erreur config :", e);
  }
}

/* ================= THEME ================= */

function applyTheme(theme) {
  currentTheme = theme;
  console.log("[NUI] applyTheme appelé:", theme.primary);
  const root = document.documentElement;
  if (theme.primary) {
    root.style.setProperty("--gta-violet", theme.primary);
    root.style.setProperty("--nui-violet", theme.primary);
    // Mettre à jour les variables dérivées utilisées par l'overlay
    const r = parseInt(theme.primary.slice(1,3),16);
    const g = parseInt(theme.primary.slice(3,5),16);
    const b = parseInt(theme.primary.slice(5,7),16);
    root.style.setProperty("--glass-border", `rgba(${r},${g},${b},0.3)`);
    root.style.setProperty("--glow-violet", `0 0 20px rgba(${r},${g},${b},0.2),0 0 60px rgba(${r},${g},${b},0.06)`);
    root.style.setProperty("--neon-box", `0 0 6px rgba(${r},${g},${b},0.6),0 0 14px rgba(${r},${g},${b},0.4),0 0 30px rgba(${r},${g},${b},0.2),0 0 50px rgba(${r},${g},${b},0.1)`);
    // Injecter un style dynamique pour écraser les couleurs hardcodées
    console.log("[NUI] _injectThemeOverride appelé:", r, g, b);
    _injectThemeOverride(r, g, b);
  }
  if (theme.primaryDim) {
    root.style.setProperty("--gta-violet-dim", theme.primaryDim);
    root.style.setProperty("--nui-violet-dim", theme.primaryDim);
  }
  if (theme.primaryBright) {
    root.style.setProperty("--gta-violet-bright", theme.primaryBright);
    root.style.setProperty("--nui-violet-bright", theme.primaryBright);
  }
  if (theme.primaryGlow) {
    root.style.setProperty("--gta-violet-glow", theme.primaryGlow);
    root.style.setProperty("--nui-violet-glow", theme.primaryGlow);
  }
  if (theme.accent) {
    root.style.setProperty("--nui-accent", theme.accent);
  }
}

function _injectThemeOverride(r, g, b) {
  let el = document.getElementById("_themeOverride");
  if (!el) {
    el = document.createElement("style");
    el.id = "_themeOverride";
    document.head.appendChild(el);
  }
  console.log("[NUI] Style injecté pour rgb:", r, g, b);
  // Remplacer toutes les couleurs violet hardcodées par la nouvelle couleur
  el.textContent = `
    :root {
      --glass-border: rgba(${r},${g},${b},0.3) !important;
      --glow-violet: 0 0 20px rgba(${r},${g},${b},0.2),0 0 60px rgba(${r},${g},${b},0.06) !important;
      --neon-box: 0 0 6px rgba(${r},${g},${b},0.6),0 0 14px rgba(${r},${g},${b},0.4),0 0 30px rgba(${r},${g},${b},0.2),0 0 50px rgba(${r},${g},${b},0.1) !important;
      --gta-violet: rgb(${r},${g},${b}) !important;
      --gta-violet-dim: var(--nui-violet-dim) !important;
      --gta-violet-bright: var(--nui-violet-bright) !important;
      --gta-violet-glow: var(--nui-violet-glow) !important;
    }
    .sub-goal, .hud-banner, .twitch-alert .alert-content, .vote-panel-inner, .poll-inner, .highlight-inner {
      border-color: rgba(${r},${g},${b},0.3) !important;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(${r},${g},${b},0.2), 0 0 6px rgba(${r},${g},${b},0.6), 0 0 14px rgba(${r},${g},${b},0.4), 0 0 30px rgba(${r},${g},${b},0.2) !important;
    }
    .alert-icon-box {
      background: linear-gradient(145deg, rgb(${r},${g},${b}), rgba(${r},${g},${b},0.7)) !important;
      box-shadow: 4px 0 24px rgba(0,0,0,0.4), 0 0 6px rgba(${r},${g},${b},0.6), 0 0 14px rgba(${r},${g},${b},0.4) !important;
    }
    .sub-goal-fill, .vote-fill-jail {
      background: linear-gradient(90deg, rgba(${r},${g},${b},0.7), rgb(${r},${g},${b}), var(--nui-violet-bright)) !important;
      box-shadow: 0 0 12px rgba(${r},${g},${b},0.5) !important;
    }
    .live-dot {
      background: var(--nui-violet-bright) !important;
      box-shadow: 0 0 6px var(--nui-violet-bright), 0 0 18px rgba(${r},${g},${b},0.35) !important;
    }
    .hud-pill {
      color: var(--nui-violet-bright) !important;
      background: rgba(${r},${g},${b},0.15) !important;
      border-color: rgba(${r},${g},${b},0.25) !important;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3), 0 0 8px rgba(${r},${g},${b},0.3) !important;
    }
    .vote-header-icon, .poll-header-icon, .highlight-icon {
      background: linear-gradient(135deg, rgb(${r},${g},${b}), rgba(${r},${g},${b},0.7)) !important;
      box-shadow: 0 4px 16px rgba(${r},${g},${b},0.35) !important;
    }
  `;
}

/* ================= OVERLAY PROFILE ================= */

function applyOverlayProfile(profile) {
  if (!profile) return;

  // Textes défilants
  if (profile.rotatingTexts && profile.rotatingTexts.length) {
    texts.length = 0;
    profile.rotatingTexts.forEach(t => texts.push(t));
    textIndex = 0;
  }

  // Discord
  const info = document.getElementById("serverInfo");
  if (info && profile.discordInvite) info.textContent = profile.discordInvite;

  // Logo gauche
  const logoLeft = document.getElementById("logoLeftImg");
  if (logoLeft && profile.logoLeft) logoLeft.src = profile.logoLeft;

  // Logo droit
  const logoRightWrap = document.getElementById("overlayLogoRight");
  const logoRight = document.getElementById("logoRightImg");
  if (logoRightWrap && logoRight) {
    if (profile.logoRight) {
      logoRight.src = profile.logoRight;
      logoRightWrap.style.display = "flex";
    } else {
      logoRightWrap.style.display = "none";
    }
  }

  // Couleur accent
  if (profile.accentColor) {
    const root = document.documentElement;
    const r = parseInt(profile.accentColor.slice(1,3),16);
    const g = parseInt(profile.accentColor.slice(3,5),16);
    const b = parseInt(profile.accentColor.slice(5,7),16);
    root.style.setProperty("--gta-violet", profile.accentColor);
    root.style.setProperty("--nui-violet", profile.accentColor);
    root.style.setProperty("--glass-border", hexToRgba(profile.accentColor, 0.3));
    root.style.setProperty("--glow-violet", `0 0 20px ${hexToRgba(profile.accentColor, 0.2)}, 0 0 60px ${hexToRgba(profile.accentColor, 0.06)}`);
    // Appliquer aussi le style override complet
    _injectThemeOverride(r, g, b);
  }

  console.log("[NUI] Profil appliqué :", profile.name || "?");
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ================= SCENES ================= */

function applyScene(scene) {
  document.body.classList.remove("scene-gaming", "scene-justchatting", "scene-brb");
  document.body.classList.add("scene-" + scene);
}

/* ================= SCREEN OVERLAY (start/pause/fin) ================= */

function generateRainDrops(count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const left = Math.random() * 100;
    const size = 3 + Math.random() * 8;
    const duration = 4 + Math.random() * 8;
    const delay = Math.random() * 6;
    const opacity = 0.15 + Math.random() * 0.5;
    const drift = -30 + Math.random() * 60;
    const blur = size > 7 ? 1 : 0;
    html += `<div class="rain-drop" style="left:${left}%;--snow-size:${size}px;--rain-duration:${duration}s;--rain-delay:${delay}s;--rain-opacity:${opacity};--snow-drift:${drift}px;--snow-blur:${blur}px;"></div>`;
  }
  return html;
}

function showScreenOverlay(data) {
  let el = document.getElementById("screenOverlayEl");
  if (!el) {
    el = document.createElement("div");
    el.id = "screenOverlayEl";
    el.className = "screen-overlay";
    document.body.appendChild(el);
  }
  if (data.active && data.type) {
    el.innerHTML = `
      <div class="screen-overlay-content">
        <div class="screen-overlay-flash"></div>
        <img src="/image/${data.type}.png" alt="${data.type}" class="screen-overlay-img" />
        <div class="screen-rain">${generateRainDrops(120)}</div>
      </div>`;
    el.classList.add("screen-overlay-visible");
  } else {
    el.classList.remove("screen-overlay-visible");
  }
}

/* ================= BRB MODE ================= */

let _brbOverlayInterval = null;

function showBRB(message) {
  const brb = document.getElementById("brbOverlay");
  if (!brb) return;
  const msgEl = document.getElementById("brbMessage");
  const subEl = document.getElementById("brbSub");
  const timerEl = document.getElementById("brbOverlayTimer");
  if (msgEl) msgEl.textContent = message || "BE RIGHT BACK";

  // Extraire durée du message ex: "BRB — Retour dans 10 min"
  const match = message && message.match(/(\d+)\s*min/i);
  if (match && timerEl) {
    let secs = parseInt(match[1]) * 60;
    timerEl.style.display = "block";
    clearInterval(_brbOverlayInterval);
    function tick() {
      const m = Math.floor(secs / 60).toString().padStart(2, "0");
      const s = (secs % 60).toString().padStart(2, "0");
      timerEl.textContent = m + ":" + s;
      if (secs <= 0) { clearInterval(_brbOverlayInterval); }
      secs--;
    }
    tick();
    _brbOverlayInterval = setInterval(tick, 1000);
  } else if (timerEl) {
    timerEl.style.display = "none";
    clearInterval(_brbOverlayInterval);
  }
  brb.classList.add("brb-visible");
}

function hideBRB() {
  const brb = document.getElementById("brbOverlay");
  if (brb) brb.classList.remove("brb-visible");
  clearInterval(_brbOverlayInterval);
  const timerEl = document.getElementById("brbOverlayTimer");
  if (timerEl) timerEl.style.display = "none";
}

/* ================= ALERTES ================= */

function showAlert(type, name, extra = "") {
  // Sub → Particules Twitch 3D
  if (type === "subscriber-latest") {
    spawnTwitchParticles(name, extra);
    playAlertSound(type);
    return;
  }

  const box = document.getElementById("twitchAlert");
  const titleEl = document.getElementById("alertTitle");
  const nameEl = document.getElementById("alertName");
  const subtitleEl = document.getElementById("alertSubtitle");
  const iconInner = document.getElementById("alertIconInner");
  if (!box || !titleEl || !nameEl) return;

  // Use custom alert messages if available
  const customMsg = currentAlertMessages[type];
  const config = alertConfigs[type] || { title: "ALERTE", subtitle: "MERCI !", icon: "fa-solid fa-bell" };

  if (iconInner) iconInner.className = config.icon;
  titleEl.textContent = customMsg?.title || config.title;
  nameEl.textContent = extra ? `${name} — ${extra}` : name;
  if (subtitleEl) subtitleEl.textContent = customMsg?.subtitle || config.subtitle;

  box.className = "twitch-alert";
  box.classList.add("show-alert", type);

  playAlertSound(type);

  const duration = (CONFIG && CONFIG.overlay && CONFIG.overlay.alertDuration) ? CONFIG.overlay.alertDuration : 6000;
  console.log("[ALERT] Affichage, disparition dans", duration, "ms");
  setTimeout(() => {
    console.log("[ALERT] setTimeout déclenché, masquage...");
    box.classList.remove("show-alert");
    box.classList.add("hide-alert");
    setTimeout(() => { box.className = "twitch-alert"; }, 600);
  }, duration);
}

function playAlertSound(type) {
  const soundUrl = alertSounds[type];
  if (!soundUrl) return;
  const audio = new Audio(soundUrl);
  const raidVol = (CONFIG && CONFIG.overlay && CONFIG.overlay.raidVolume) ? CONFIG.overlay.raidVolume : 0.85;
  const defaultVol = (CONFIG && CONFIG.overlay && CONFIG.overlay.alertVolume) ? CONFIG.overlay.alertVolume : 0.65;
  audio.volume = type === "raid-latest" ? raidVol : defaultVol;
  audio.play().catch(err => console.log("Erreur audio :", err));
}

/* ================= TWITCH PARTICLES — 3D Snow Effect ================= */

const TWITCH_SVG = `<svg viewBox="0 0 256 268" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid">
  <path d="M17.458 0L0 46.556v185.81h63.983V268h46.554l35.768-35.634h53.655L256 176.81V0H17.458zm23.259 23.263H232.73v141.476l-40.97 40.97h-63.982l-35.77 35.636v-35.637H40.717V23.263zm69.56 105.476h23.263V70.187h-23.262v58.552zm63.983 0h23.262V70.187h-23.262v58.552z" fill="currentColor"/>
</svg>`;

function spawnTwitchParticles(name, extra) {
  const PARTICLE_COUNT = 55;
  const DURATION = 6000;
  const container = document.createElement("div");
  container.className = "twitch-particles-container";
  document.body.appendChild(container);

  const centerText = document.createElement("div");
  centerText.className = "twitch-particles-text";
  const customMsg = currentAlertMessages["subscriber-latest"] || {};
  centerText.innerHTML = `
    <div class="tp-title">${customMsg.title || "NOUVEAU SUB"}</div>
    <div class="tp-name">${extra ? name + " — " + extra : name}</div>
    <div class="tp-subtitle">${customMsg.subtitle || "BIENVENUE DANS LA FAMILLE !"}</div>`;
  container.appendChild(centerText);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const particle = document.createElement("div");
    particle.className = "twitch-particle";
    particle.innerHTML = TWITCH_SVG;
    const startX = Math.random() * 100;
    const size = 18 + Math.random() * 28;
    const delay = Math.random() * 2500;
    const fallDuration = 3000 + Math.random() * 3000;
    const rotX = Math.random() * 360;
    const rotY = Math.random() * 360;
    const rotZ = Math.random() * 360;
    const spinSpeed = 1 + Math.random() * 3;
    const drift = -40 + Math.random() * 80;
    const opacity = 0.4 + Math.random() * 0.6;
    particle.style.cssText = `left:${startX}%;width:${size}px;height:${size}px;opacity:0;animation-delay:${delay}ms;--fall-duration:${fallDuration}ms;--rot-x:${rotX}deg;--rot-y:${rotY}deg;--rot-z:${rotZ}deg;--spin-speed:${spinSpeed};--drift:${drift}px;--particle-opacity:${opacity};`;
    particle.style.animation = `particleFall ${fallDuration}ms cubic-bezier(0.25,0.1,0.25,1) ${delay}ms forwards, particleSpin ${1200/spinSpeed}ms linear ${delay}ms infinite`;
    container.appendChild(particle);
  }

  setTimeout(() => {
    container.style.transition = "opacity 0.8s ease";
    container.style.opacity = "0";
    setTimeout(() => container.remove(), 800);
  }, DURATION);
}

/* ================= SUB GOAL ================= */

function updateSubGoal(data) {
  const fill = document.getElementById("subGoalFill");
  const count = document.getElementById("subGoalCount");
  const label = document.getElementById("subGoalLabel");
  const box = document.getElementById("subGoal");
  if (!fill || !count || !box) return;
  const current = data.current || 0;
  const target = data.target || 50;
  const percent = Math.min(100, Math.round((current / target) * 100));
  fill.style.width = percent + "%";
  count.textContent = `${current} / ${target}`;
  if (label && data.label) label.textContent = data.label;
  if (current >= target) box.classList.add("complete");
  else box.classList.remove("complete");
}

/* ================= HIGHLIGHT MESSAGE ================= */

function showHighlight(data) {
  let hl = document.getElementById("highlightOverlay");
  if (!hl) {
    hl = document.createElement("div");
    hl.id = "highlightOverlay";
    hl.className = "highlight-overlay";
    document.body.appendChild(hl);
  }
  if (data.visible) {
    hl.innerHTML = `
      <div class="highlight-inner">
        <div class="highlight-icon"><i class="fa-solid fa-message"></i></div>
        <div class="highlight-body">
          <div class="highlight-user" style="color:${data.color}">${escapeHTML(data.username)}</div>
          <div class="highlight-msg">${escapeHTML(data.message)}</div>
        </div>
      </div>`;
    hl.classList.add("highlight-visible");
  } else {
    hl.classList.remove("highlight-visible");
  }
}

/* ================= POLL OVERLAY ================= */

function updatePollOverlay(data) {
  let poll = document.getElementById("pollOverlay");
  if (!poll) {
    poll = document.createElement("div");
    poll.id = "pollOverlay";
    poll.className = "poll-overlay";
    document.body.appendChild(poll);
  }

  if (!data.visible) {
    poll.classList.remove("poll-visible");
    return;
  }

  const totalVotes = Object.values(data.votes || {}).reduce((a, b) => a + b, 0);
  let optionsHTML = "";
  (data.options || []).forEach((opt, i) => {
    const count = (data.votes && data.votes[opt]) || 0;
    const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
    optionsHTML += `
      <div class="poll-option">
        <div class="poll-option-header">
          <span class="poll-option-label">!${i + 1} ${escapeHTML(opt)}</span>
          <span class="poll-option-count">${count}</span>
        </div>
        <div class="poll-bar-track">
          <div class="poll-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
  });

  let footerText = "EN ATTENTE";
  if (data.active) footerText = "⏱ " + (data.timeLeft || 0) + "s";
  else if (data.finished) footerText = "TERMINÉ";

  poll.innerHTML = `
    <div class="poll-inner">
      <div class="poll-header">
        <div class="poll-header-icon"><i class="fa-solid fa-chart-bar"></i></div>
        <div>
          <div class="poll-title">SONDAGE</div>
          <div class="poll-question">${escapeHTML(data.question || "")}</div>
        </div>
      </div>
      <div class="poll-separator"></div>
      ${optionsHTML}
      <div class="poll-separator"></div>
      <div class="poll-footer">${footerText}</div>
    </div>`;
  poll.classList.add("poll-visible");
}

/* ================= VIEWER COUNT ================= */

function updateViewerCount(data) {
  const el = document.getElementById("viewerCount");
  if (el) {
    el.innerHTML = `<i class="fa-solid fa-eye"></i> ${data.current || 0}`;
    el.title = `Pic : ${data.peak || 0}`;
  }
}

/* ================= STATE POLLING ================= */

async function checkServerState() {
  try {
    const res = await fetch("/state", { cache: "no-store" });
    const data = await res.json();
    // Les alertes passent uniquement par Socket.IO — pas de redéclenchement via polling
    if (data.subGoal) updateSubGoal(data.subGoal);
  } catch (e) { /* silent */ }
}

/* ================= TEXTE ROTATIF ================= */

const texts = ["BLUESKY ROLEPLAY", "RECRUTEMENT STAFF", "SERVEUR UNIQUE"];
let textIndex = 0;
const rotatingEl = document.getElementById("rotatingText");

function rotateText() {
  if (!rotatingEl) return;
  rotatingEl.style.transition = "opacity 0.4s ease, transform 0.4s ease";
  rotatingEl.style.opacity = "0";
  rotatingEl.style.transform = "translateY(-6px)";
  setTimeout(() => {
    rotatingEl.textContent = texts[textIndex % texts.length];
    textIndex++;
    rotatingEl.style.transform = "translateY(6px)";
    requestAnimationFrame(() => {
      rotatingEl.style.opacity = "1";
      rotatingEl.style.transform = "translateY(0)";
    });
  }, 400);
}
setInterval(rotateText, 3500);

/* ================= FIVEM STATUS ================= */

async function updateServer() {
  const status = document.getElementById("serverStatus");
  const players = document.getElementById("playersCount");
  if (!status || !players) return;
  try {
    // Proxy serveur — pas de CORS, toujours fiable
    const res = await fetch("/fivem/status", { cache: "no-store" });
    const data = await res.json();
    if (data.success) {
      lastPlayers = `<i class="fa-solid fa-users"></i> ${data.clients}/${data.maxClients}`;
      status.textContent = "SERVEUR ONLINE";
    } else if (FIVEM_ENDPOINT) {
      // Fallback direct si proxy échoue
      const r2 = await fetch(FIVEM_ENDPOINT, { cache: "no-store" });
      let raw = await r2.json();
      let d = (raw && typeof raw.contents === "string") ? JSON.parse(raw.contents) : raw;
      lastPlayers = `<i class="fa-solid fa-users"></i> ${d.clients ?? 0}/${d.sv_maxclients ?? 0}`;
      status.textContent = "SERVEUR ONLINE";
    }
    players.innerHTML = lastPlayers;
  } catch {
    status.textContent = "SERVEUR ONLINE";
    players.innerHTML = lastPlayers;
  }
}

/* ================= CHAT OVERLAY ================= */

const CHAT_MSG_LIFETIME = 15000;
const CHAT_MAX_MESSAGES = 12;
const chatContainer = document.getElementById("chatOverlay");

function addChatMessage(username, message, color, badges) {
  if (!chatContainer) return;
  const msg = document.createElement("div");
  msg.className = "chat-msg";
  let badgeHTML = "";
  if (badges) {
    if (badges.broadcaster) badgeHTML += '<i class="fa-solid fa-star chat-msg-badge badge-broadcaster"></i>';
    else if (badges.moderator) badgeHTML += '<i class="fa-solid fa-shield-halved chat-msg-badge badge-moderator"></i>';
    if (badges.vip) badgeHTML += '<i class="fa-solid fa-gem chat-msg-badge badge-vip"></i>';
    if (badges.subscriber) badgeHTML += '<i class="fa-solid fa-heart chat-msg-badge badge-subscriber"></i>';
  }
  const userColor = color || "#c39bd3";
  msg.innerHTML =
    '<span class="chat-msg-user" style="color:' + userColor + ';">' + badgeHTML + escapeHTML(username) + '</span>' +
    '<span class="chat-msg-colon">:</span>' +
    '<span class="chat-msg-text">' + escapeHTML(message) + '</span>';
  chatContainer.prepend(msg);
  requestAnimationFrame(() => { requestAnimationFrame(() => { msg.classList.add("chat-enter"); }); });
  while (chatContainer.children.length > CHAT_MAX_MESSAGES) {
    const old = chatContainer.lastChild;
    old.classList.remove("chat-enter"); old.classList.add("chat-exit");
    setTimeout(() => old.remove(), 600);
  }
  setTimeout(() => {
    msg.classList.remove("chat-enter"); msg.classList.add("chat-exit");
    setTimeout(() => msg.remove(), 600);
  }, CHAT_MSG_LIFETIME);
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ================= VOTE INTÉGRÉ ================= */

const votePanel = document.getElementById("votePanel");
const voteJailCount = document.getElementById("voteJailCount");
const voteBanCount = document.getElementById("voteBanCount");
const voteFreeCount = document.getElementById("voteFreeCount");
const voteJailBar = document.getElementById("voteJailBar");
const voteBanBar = document.getElementById("voteBanBar");
const voteFreeBar = document.getElementById("voteFreeBar");
const voteTimer = document.getElementById("voteTimer");
const voteResult = document.getElementById("voteResult");
const voteTargetDisplay = document.getElementById("voteTargetDisplay");
let lastVoteVisible = false;

async function checkVoteState() {
  try {
    const res = await fetch("/vote/state", { cache: "no-store" });
    const data = await res.json();
    if (data.visible && !lastVoteVisible) votePanel.classList.add("vote-visible");
    else if (!data.visible && lastVoteVisible) votePanel.classList.remove("vote-visible");
    lastVoteVisible = data.visible;
    if (!data.visible) return;
    const jail = data.jailVotes || 0, ban = data.banVotes || 0, free = data.freeVotes || 0;
    const total = jail + ban + free;
    voteJailCount.textContent = jail;
    voteBanCount.textContent = ban;
    voteFreeCount.textContent = free;
    voteJailBar.style.width = (total ? (jail / total) * 100 : 0) + "%";
    voteBanBar.style.width = (total ? (ban / total) * 100 : 0) + "%";
    voteFreeBar.style.width = (total ? (free / total) * 100 : 0) + "%";
    if (voteTargetDisplay) voteTargetDisplay.textContent = data.target || "—";
    if (data.active) {
      voteTimer.textContent = "⏱ " + (data.timeLeft || 0) + "s";
      voteResult.textContent = ""; voteResult.className = "vote-result";
    } else if (data.finished) {
      voteTimer.textContent = "TERMINÉ";
      const max = Math.max(jail, ban, free);
      const winners = [jail === max && "JAIL", ban === max && "BAN", free === max && "FREE"].filter(Boolean);
      if (winners.length > 1) { voteResult.textContent = "⚖ ÉGALITÉ"; voteResult.className = "vote-result result-tie"; }
      else if (winners[0] === "JAIL") { voteResult.textContent = "⚖ JAIL"; voteResult.className = "vote-result result-jail"; }
      else if (winners[0] === "BAN") { voteResult.textContent = "⚖ BAN"; voteResult.className = "vote-result result-ban"; }
      else if (winners[0] === "FREE") { voteResult.textContent = "⚖ FREE"; voteResult.className = "vote-result result-free"; }
    } else {
      voteTimer.textContent = "EN ATTENTE"; voteResult.textContent = ""; voteResult.className = "vote-result";
    }
  } catch (e) { /* silent */ }
}

/* ================= POLL POLLING ================= */

async function checkPollState() {
  try {
    const res = await fetch("/poll/state", { cache: "no-store" });
    const data = await res.json();
    updatePollOverlay(data);
  } catch (e) { /* silent */ }
}

/* ================= SOCKET.IO INIT ================= */

function initSocket() {
  const script = document.createElement("script");
  script.src = "/socket.io/socket.io.js";
  script.onload = () => {
    const socket = io();
    socket.on("connect", () => console.log("[NUI] Socket connecté"));

    socket.on("chatMessage", (data) => {
      addChatMessage(data.username, data.message, data.color, data.badges);
    });

    socket.on("alert", (data) => {
      showAlert(data.alertType, data.name, data.extra);
    });

    socket.on("subGoal", (data) => updateSubGoal(data));
    socket.on("themeUpdate", (theme) => {
      console.log("[NUI] themeUpdate reçu via socket:", theme.primary);
      applyTheme(theme);
    });
    socket.on("sceneChange", (scene) => applyScene(scene));
    socket.on("highlight", (data) => showHighlight(data));
    socket.on("pollUpdate", (data) => updatePollOverlay(data));
    socket.on("viewerCount", (data) => updateViewerCount(data));

    socket.on("brbUpdate", (data) => {
      if (data.brb) showBRB(data.message);
      else hideBRB();
    });

    socket.on("screenOverlay", (data) => {
      showScreenOverlay(data);
    });

    socket.on("alertMessagesUpdate", (msgs) => {
      currentAlertMessages = msgs;
    });

    socket.on("profileChange", (data) => {
      if (data && data.profile) applyOverlayProfile(data.profile);
    });
  };
  document.head.appendChild(script);
}

/* ================= DÉMARRAGE ================= */

(async function init() {
  await loadConfig();
  checkServerState();
  setInterval(checkServerState, 500);
  updateServer();
  setInterval(updateServer, 20000);
  checkVoteState();
  setInterval(checkVoteState, 500);
  checkPollState();
  setInterval(checkPollState, 1000);
  initSocket();
})();
