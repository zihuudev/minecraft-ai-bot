/**
 * Cyberland Ultra-Premium All-in-One bot.js
 * - Single file: Discord bot + Premium Dashboard + Scheduler + AI + Premium embeds
 * - Railway-ready: reads secrets from process.env
 *
 * Required env variables:
 * DISCORD_TOKEN (required)
 * OPENAI_API_KEY (optional)
 * ADMINS (optional, comma-separated usernames; default: "zihuu,shahin,mainuddin")
 * ADMIN_PASS (optional, default: "cyberlandai90x90x90")
 * CHANNEL_ID (optional, default: "1419702204171813015")
 * PORT (optional, default: 3000)
 * SESSION_SECRET (optional)
 *
 * Install dependencies:
 * npm i discord.js express socket.io axios node-cron express-session body-parser moment-timezone
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');

const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes } = require('discord.js');

// ---------- CONFIG from env ----------
const PORT = Number(process.env.PORT || 3000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const ADMINS = (process.env.ADMINS || 'zihuu,shahin,mainuddin').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_PASS = process.env.ADMIN_PASS || 'cyberlandai90x90x90';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cyberland_session_secret';
const DEFAULT_CHANNEL = process.env.CHANNEL_ID || '1419702204171813015'; // your provided channel id
const TZ = 'Asia/Dhaka';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ---------- SIMPLE LOGGERS ----------
function logInfo(...args){ console.log(new Date().toISOString(),'[INFO]',...args); }
function logOk(...args){ console.log(new Date().toISOString(),'[OK]',...args); }
function logWarn(...args){ console.warn(new Date().toISOString(),'[WARN]',...args); }
function logErr(...args){ console.error(new Date().toISOString(),'[ERR]',...args); }

// ---------- SETTINGS persistence ----------
let settings = {
  channelId: DEFAULT_CHANNEL,
  aiEnabled: true,
  autoUpdate: true,
  updateGif: '',
  finishGif: ''
};

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}';
    const parsed = JSON.parse(raw);
    settings = { ...settings, ...parsed };
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  }
} catch (e) {
  logErr('Failed to load settings file:', e?.message || e);
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    logErr('Failed to save settings:', e?.message || e);
  }
}

// ---------- DISCORD client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [ Partials.Message, Partials.Channel, Partials.GuildMember ]
});

// ---------- OpenAI helper with retries ----------
async function callOpenAI(prompt, attempt = 1) {
  if (!OPENAI_KEY) throw new Error('OPENAI_KEY_MISSING');
  try {
    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are Cyberland assistant — helpful, concise, and friendly.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 700
    };
    const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 65000,
      validateStatus: () => true
    });
    if (res.status >= 200 && res.status < 300) {
      const txt = res.data?.choices?.[0]?.message?.content ?? res.data?.choices?.[0]?.text;
      if (!txt) throw new Error('NO_OPENAI_REPLY');
      return txt.trim();
    }
    // retry on rate limit / server errors
    if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < 3) {
      logWarn('OpenAI temporary status', res.status, 'retry', attempt);
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return callOpenAI(prompt, attempt + 1);
    }
    if (res.status === 401) throw new Error('OPENAI_KEY_INVALID');
    throw new Error('openai_error_status_' + res.status);
  } catch (e) {
    if (['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return callOpenAI(prompt, attempt + 1);
    }
    throw e;
  }
}

// ---------- Premium embed builder ----------
function premiumEmbed({ title = 'Status', reason = 'Not specified', duration = 'N/A' } = {}) {
  const guildName = client.guilds.cache.first()?.name || 'Unknown';
  const ping = client.ws?.ping ? `${client.ws.ping}ms` : 'N/A';
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x7C3AED)
    .setDescription(`**${title}** — ${reason}`)
    .addFields(
      { name: '⏳ Update Duration', value: String(duration), inline: true },
      { name: '📡 Bot Ping', value: String(ping), inline: true },
      { name: '🌍 Server', value: guildName, inline: true },
      { name: '📝 Reason', value: reason || '—', inline: false },
      { name: '👨‍💻 Developed By', value: 'ZIHUU', inline: false }
    )
    .setTimestamp();
}

// ---------- EXPRESS + DASHBOARD (single-file HTML) ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Generate premium login + dashboard HTML strings (safe quoting)
const LOGIN_HTML_PATH = path.join(__dirname, 'login.html');
const DASH_HTML_PATH = path.join(__dirname, 'dashboard.html');

const loginHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cyberland — Login</title>
  <style>
    body { background: linear-gradient(180deg,#04192a,#071426); color:#e6eef6; font-family:Inter,Arial; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .card { background:#072033; padding:28px; border-radius:12px; box-shadow: 0 10px 30px rgba(2,6,23,0.7); width:320px; }
    input { width:100%; padding:10px; margin:8px 0; border-radius:8px; border:1px solid #123; background:#041426; color:#e6eef6; }
    button { width:100%; padding:10px; margin-top:10px; border:none; border-radius:8px; background:linear-gradient(90deg,#7c3aed,#06b6d4); color:#fff; font-weight:600; cursor:pointer; }
    h2 { margin:0 0 8px 0; color:#fff; text-align:center; }
    .hint { font-size:12px; color:#9fb6c9; text-align:center; margin-top:8px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚀 Cyberland Dashboard</h2>
    <form method="POST" action="/login">
      <input name="username" placeholder="username" required />
      <input name="password" type="password" placeholder="password" required />
      <button type="submit">Sign in</button>
    </form>
    <div class="hint">Admins: ${ADMINS.join(', ')} — password set by ADMIN_PASS env</div>
  </div>
</body>
</html>`;

const dashHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cyberland — Dashboard</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root { --bg:#071426; --panel:#0b2331; --accent1:#7c3aed; --accent2:#06b6d4; --muted:#9fb6c9; }
    body{ background: linear-gradient(180deg,var(--bg),#02121a); color:#e6eef6; font-family:Inter,Arial; margin:0; padding:20px; }
    header{ display:flex; justify-content:space-between; align-items:center; gap:12px; }
    h1{ margin:0; color:var(--accent1); }
    .btn{ padding:10px 14px; border-radius:10px; border:none; cursor:pointer; color:#fff; font-weight:600; background:linear-gradient(90deg,var(--accent1),var(--accent2)); box-shadow:0 6px 18px rgba(124,58,237,0.12); }
    .controls{ margin-top:18px; display:flex; flex-wrap:wrap; gap:10px; }
    #log{ margin-top:16px; background:rgba(2,6,23,0.6); border-radius:12px; padding:12px; height:360px; overflow:auto; border:1px solid rgba(124,58,237,0.06); }
    .small{ font-size:13px; color:var(--muted); }
    .panel{ background:linear-gradient(180deg,#042233,#03202b); padding:12px; border-radius:12px; display:flex; gap:12px; align-items:center; }
    input.input { padding:8px 10px; border-radius:8px; border:1px solid rgba(124,58,237,0.12); background:#021418; color:#e6eef6; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🚀 Cyberland Premium</h1>
      <div class="small">Premium control panel — Developed by ZIHUU</div>
    </div>
    <div>
      <a href="/logout" style="color:#fb7185; text-decoration:none; font-weight:600;">Logout</a>
    </div>
  </header>

  <div class="controls">
    <button class="btn" onclick="setChannel()">Set Channel</button>
    <button class="btn" onclick="toggleAI()">Toggle AI</button>
    <button class="btn" onclick="startUpdate()">Start Update</button>
    <button class="btn" onclick="finishUpdate()">Finish Update</button>
    <button class="btn" onclick="announce()">Announce</button>
    <button class="btn" onclick="botInfo()">Bot Info</button>
  </div>

  <div id="log"></div>

  <script>
    const s = io();
    function addLog(m){ const l = document.getElementById('log'); const now = new Date().toLocaleString(); l.innerHTML = '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.02)">' + now + ' — ' + m + '</div>' + l.innerHTML; }
    s.on('msg', m => addLog(m));
    function setChannel(){ const id = prompt('Channel ID', '${settings.channelId || DEFAULT_CHANNEL}'); if(id) s.emit('setChannel', id); }
    function toggleAI(){ s.emit('toggleAI'); }
    function startUpdate(){ const reason = prompt('Reason (optional)', 'Manual update'); const minutes = prompt('Minutes', '5'); s.emit('startUpdate', { reason, minutes: Number(minutes || 5) }); }
    function finishUpdate(){ s.emit('finishUpdate'); }
    function announce(){ const title = prompt('Title'); const content = prompt('Content'); const reason = prompt('Reason (optional)'); if(title && content) s.emit('announce', { title, content, reason }); }
    function botInfo(){ s.emit('botInfo'); }
  </script>
</body>
</html>`;

// write HTML files if not present
try { if (!fs.existsSync(LOGIN_HTML_PATH)) fs.writeFileSync(LOGIN_HTML_PATH, loginHtml); } catch(e){ logErr('write login html', e); }
try { if (!fs.existsSync(DASH_HTML_PATH)) fs.writeFileSync(DASH_HTML_PATH, dashHtml); } catch(e){ logErr('write dash html', e); }

// ---------- Express routes ----------
app.get('/login', (req, res) => res.sendFile(LOGIN_HTML_PATH));
app.post('/login', (req, res) => {
  try {
    const u = (req.body.username || '').toString().trim().toLowerCase();
    const p = (req.body.password || '').toString();
    if (ADMINS.includes(u) && p === ADMIN_PASS) {
      req.session.user = u;
      logOk('Dashboard login:', u);
      return res.redirect('/');
    }
    logWarn('Failed dashboard login attempt:', u);
    return res.send('Invalid credentials. <a href="/login">Back</a>');
  } catch (e) {
    logErr('login route error', e.message || e);
    return res.send('Login error.');
  }
});
app.get('/logout', (req, res) => { req.session.destroy(()=>res.redirect('/login')); });
app.get('/', (req, res) => {
  if (!req.session?.user) return res.redirect('/login');
  return res.sendFile(DASH_HTML_PATH);
});
app.get('/api/state', (req, res) => {
  if (!req.session?.user) return res.status(403).json({ error: 'unauthorized' });
  return res.json({ settings, bot: client.user ? client.user.tag : null, ping: client.ws?.ping || null });
});

// ---------- Socket handlers (dashboard actions) ----------
io.on('connection', socket => {
  logInfo('Dashboard socket connected');
  socket.emit('msg', `Connected. Bot: ${client.user ? client.user.tag : 'offline'}`);

  socket.on('setChannel', async (channelId) => {
    settings.channelId = String(channelId);
    saveSettings();
    logOk('Default channel set ->', channelId);
    socket.emit('msg', `Default channel set to ${channelId}`);
  });

  socket.on('toggleAI', () => {
    settings.aiEnabled = !settings.aiEnabled;
    saveSettings();
    logInfo('AI toggled ->', settings.aiEnabled);
    socket.emit('msg', `AI ${settings.aiEnabled ? 'ENABLED' : 'DISABLED'}`);
  });

  socket.on('startUpdate', async ({ reason = 'Manual update', minutes = 5 } = {}) => {
    try {
      if (!settings.channelId) return socket.emit('msg', 'No default channel configured.');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg', 'Channel fetch failed or bot lacks access.');
      // send embed, lock, purge
      await ch.send({ embeds: [ premiumEmbed({ title: '⚡ Update Started', reason, duration: `${minutes}m` }) ], allowedMentions: { parse: [] } }).catch(()=>{});
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      const deleted = await purgeChannelSafe(ch, 300);
      logWarn('Manual update started:', reason, '| Deleted:', deleted);
      socket.emit('msg', `Update started (deleted ${deleted} messages).`);
    } catch (e) {
      logErr('startUpdate socket error', e.message || e);
      socket.emit('msg', `Failed to start update: ${e.message || e}`);
    }
  });

  socket.on('finishUpdate', async () => {
    try {
      if (!settings.channelId) return socket.emit('msg', 'No default channel configured.');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg', 'Channel fetch failed.');
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      await ch.send({ embeds: [ premiumEmbed({ title: '✅ Update Finished', reason: 'Manual finish', duration: '—' }) ], allowedMentions: { parse: [] } }).catch(()=>{});
      logOk('Manual update finished');
      socket.emit('msg', 'Update finished and channel unlocked.');
    } catch (e) {
      logErr('finishUpdate socket error', e.message || e);
      socket.emit('msg', `Failed to finish update: ${e.message || e}`);
    }
  });

  socket.on('announce', async (payload) => {
    try {
      if (!settings.channelId) return socket.emit('msg', 'No default channel configured.');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg', 'Channel fetch failed.');
      const emb = premiumEmbed({ title: payload.title || 'Announcement', reason: payload.reason || '—', duration: '—' }).setDescription(payload.content || '');
      await ch.send({ embeds: [emb], allowedMentions: { parse: [] } });
      logInfo('Announcement sent:', payload.title);
      socket.emit('msg', 'Announcement sent.');
    } catch (e) {
      logErr('announce error', e.message || e);
      socket.emit('msg', `Failed to announce: ${e.message || e}`);
    }
  });

  socket.on('botInfo', async () => {
    const info = `Bot: ${client.user?.tag || 'offline'}\nPing: ${client.ws?.ping || 'N/A'}\nGuilds: ${client.guilds.cache.size || 0}\nDefault channel: ${settings.channelId || 'not set'}`;
    logInfo('Bot info requested');
    socket.emit('msg', info);
  });
});

// ---------- Helper: purge channel safely ----------
async function purgeChannelSafe(channel, limit = 1000) {
  try {
    if (!channel || !channel.messages?.fetch) return 0;
    let remaining = limit;
    let total = 0;
    while (remaining > 0) {
      const fetched = await channel.messages.fetch({ limit: Math.min(100, remaining) });
      if (!fetched || fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
        total += fetched.size;
      } catch (e) {
        // fallback individual deletes
        for (const m of fetched.values()) {
          try { await m.delete(); total++; } catch (_) {}
        }
      }
      remaining -= fetched.size;
      if (fetched.size < 2) break;
    }
    return total;
  } catch (e) {
    logErr('purgeChannelSafe error', e.message || e);
    return 0;
  }
}

// ---------- Schedule auto updates (BDT windows) ----------
function scheduleAutoUpdates() {
  try {
    // start 11:00
    cron.schedule('0 11 * * *', async () => {
      if (!settings.autoUpdate) return;
      logInfo('Auto update start (11:00 BDT)');
      if (!settings.channelId) return logWarn('Auto update aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto update: channel fetch failed');
      await ch.send({ embeds: [ premiumEmbed({ title: '⚡ Auto Update Starting (11:00)', reason: 'Scheduled maintenance', duration: '5m' }) ], allowedMentions: { parse: [] } }).catch(()=>{});
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      await purgeChannelSafe(ch, 200);
    }, { timezone: TZ });

    // finish 11:05
    cron.schedule('5 11 * * *', async () => {
      if (!settings.autoUpdate) return;
      logInfo('Auto update finish (11:05 BDT)');
      if (!settings.channelId) return logWarn('Auto finish aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto finish: channel fetch failed');
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      await ch.send({ embeds: [ premiumEmbed({ title: '✅ Auto Update Finished (11:05)', reason: 'Scheduled done', duration: '5m' }) ], allowedMentions: { parse: [] } }).catch(()=>{});
    }, { timezone: TZ });

    // start 15:00
    cron.schedule('0 15 * * *', async () => {
      if (!settings.autoUpdate) return;
      logInfo('Auto update start (15:00 BDT)');
      if (!settings.channelId) return logWarn('Auto aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto: channel fetch failed');
      await ch.send({ embeds: [ premiumEmbed({ title: '⚡ Auto Update Starting (15:00)', reason: 'Scheduled maintenance', duration: '5m' }) ], allowedMentions: { parse: [] } }).catch(()=>{});
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      await purgeChannelSafe(ch, 200);
    }, { timezone: TZ });

    // finish 15:05
    cron.schedule('5 15 * * *', async () => {
      if (!settings.autoUpdate) return;
      logInfo('Auto update finish (15:05 BDT)');
      if (!settings.channelId) return logWarn('Auto finish aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto finish: channel fetch failed');
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      await ch.send({ embeds: [ premiumEmbed({ title: '✅ Auto Update Finished (15:05)', reason: 'Scheduled done', duration: '5m' }) ], allowedMentions: { parse: [] } }).catch(()=>{});
    }, { timezone: TZ });

    logInfo('Auto update scheduler registered (BDT windows: 11:00-11:05, 15:00-15:05)');
  } catch (e) {
    logErr('scheduleAutoUpdates error', e.message || e);
  }
}

// ---------- Slash command: /status ----------
async function registerSlash() {
  if (!DISCORD_TOKEN) return;
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const appId = client.application?.id || (await client.application.fetch()).id;
    if (!appId) return;
    await rest.put(Routes.applicationCommands(appId), { body: [
      { name: 'status', description: 'Show bot status' }
    ]});
    logInfo('Slash commands registered');
  } catch (e) {
    logWarn('registerSlash error', e.message || e);
  }
}

// ---------- Interaction handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'status') {
      const embed = premiumEmbed({ title: 'Bot Status', reason: 'Current status', duration: '—' });
      await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    }
  } catch (e) {
    logErr('interactionCreate error', e.message || e);
  }
});

// ---------- Message handling: AI auto-reply only in configured channel ----------
const channelLocks = new Map();
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!settings.aiEnabled) return;
    if (!settings.channelId) return;
    if (msg.channel?.id !== String(settings.channelId)) return; // only in configured channel

    // prevent concurrent AI calls per channel
    if (channelLocks.get(msg.channel.id)) return;
    channelLocks.set(msg.channel.id, true);

    let replyText = null;
    try {
      if (OPENAI_KEY) {
        replyText = await callOpenAI(msg.content);
      } else {
        replyText = `💤 AI not configured. You said: "${msg.content}"`;
      }
    } catch (err) {
      const code = (err.message || String(err)).replace(/\s+/g,' ');
      replyText = `⚠️ Sorry, AI is temporarily unavailable. (${code})`;
      logWarn('OpenAI call failed:', code);
    }

    if (replyText) {
      await msg.reply({ content: replyText, allowedMentions: { parse: [] } }).catch(e => logWarn('reply failed', e.message || e));
      logInfo('Replied to', msg.author.tag, 'in channel', msg.channel.id);
    }
  } catch (e) {
    logErr('messageCreate handler error', e.message || e);
  } finally {
    channelLocks.set(msg.channel.id, false);
  }
});

// ---------- Premium startup & login ----------
server.listen(PORT, () => logOk(`Dashboard running on port ${PORT}`));

if (!DISCORD_TOKEN) {
  logErr('DISCORD_TOKEN missing. Set DISCORD_TOKEN in Railway variables.');
} else {
  client.login(DISCORD_TOKEN)
    .then(() => {
      logOk('Discord login successful:', client.user.tag);
      // if settings.channelId was missing, set default to env/default
      if (!settings.channelId) {
        settings.channelId = DEFAULT_CHANNEL;
        saveSettings();
      }
      registerSlash().catch(()=>{});
      scheduleAutoUpdates();
    })
    .catch(err => {
      logErr('Discord login failed:', (err && (err.message || err)) || err);
    });
}

// unhandled rejections
process.on('unhandledRejection', (err) => {
  logErr('Unhandled Rejection:', err && (err.message || err));
});
