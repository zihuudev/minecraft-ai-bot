/**
 * bot.js - Final fixed single-file bot
 * - Premium embeds
 * - AI (OpenAI optional)
 * - Minecraft status
 * - Dashboard (login) with manual update duration and countdown
 * - Auto daily update (15:00 start, 15:05 finish BD time)
 *
 * Put secrets in .env (DO NOT commit).
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');
const { statusBedrock, status } = require('minecraft-server-util');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ActivityType
} = require('discord.js');

// ---------- CONFIG ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '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';
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_PREFIX = process.env.BOT_PREFIX || '!';
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || 'play.cyberland.pro';
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT || '19132', 10);
const TZ = process.env.TIMEZONE || 'Asia/Dhaka';

// sanity
if (!DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN in env'); process.exit(1); }
if (!CHANNEL_ID) { console.error('Missing CHANNEL_ID in env'); process.exit(1); }

// ---------- APP & SOCKET ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// sessions (MemoryStore ok for single-process hosting)
app.use(session({
  secret: process.env.SESSION_SECRET || 'cyberland-session',
  resave: false,
  saveUninitialized: true
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- BOT STATE ----------
const state = {
  update: {
    active: false,
    startMsgId: null,
    finishMsgId: null,
    startedAt: null,
    durationMinutes: 0,
    timer: null,          // Node timeout for auto-finish
  },
  autoUpdateEnabled: true
};

// emit logs to console + dashboard
function emitLog(...parts) {
  const s = parts.join(' ');
  try { console.log(s); } catch(e){}
  try { io.emit('update-log', s); } catch(e){}
}

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// ---------- PREMIUM EMBEDDING ----------
function buildPremiumEmbed({ title, description, fields = [], imageUrl = null, style = 'premium', color = 0x8b5cf6, footer = 'Cyberland Bot' }) {
  const e = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: footer });

  if (style === 'classic') {
    e.setAuthor({ name: '🔧 Cyberland Update (Classic)' });
  } else {
    e.setAuthor({ name: '🚀 Cyberland Premium Update' });
  }
  if (fields.length) e.addFields(...fields);
  if (imageUrl) e.setImage(imageUrl);
  return e;
}

async function sendPremiumEveryone(channel, opts) {
  const emb = buildPremiumEmbed(opts);
  try {
    return await channel.send({ content: '@everyone', embeds: [emb], allowedMentions: { parse: ['everyone'] } });
  } catch (err) {
    emitLog('sendPremiumEveryone error:', err.message || err);
    return null;
  }
}

// ---------- MINECRAFT STATUS ----------
async function getMinecraftStatus() {
  try {
    let s = null;
    try { s = await statusBedrock(MINECRAFT_HOST, MINECRAFT_PORT, { timeout: 2000 }); }
    catch (e) {
      try { s = await status(MINECRAFT_HOST, { port: MINECRAFT_PORT, timeout: 2000 }); } catch (e2) { s = null; }
    }
    if (!s) return { online: false };
    const players = s.players ? (s.players.online ?? s.players) : 'N/A';
    const ping = s.latency ?? s.ping ?? null;
    const motd = (s.motd?.clean || s.motd || s.version?.name || '') + '';
    return { online: true, players, ping, motd };
  } catch (err) {
    return { online: false };
  }
}

// ---------- OPENAI (optional) ----------
async function queryOpenAI(prompt) {
  if (!OPENAI_API_KEY) return 'OpenAI not configured.';
  try {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are a Minecraft assistant for ${MINECRAFT_HOST}:${MINECRAFT_PORT}. Keep answers short and safe.` },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400,
      temperature: 0.6
    };
    const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000
    });
    return res.data?.choices?.[0]?.message?.content || 'No response from AI.';
  } catch (err) {
    emitLog('OpenAI request failed:', (err.response && err.response.data) ? JSON.stringify(err.response.data) : (err.message || err));
    return 'Error contacting OpenAI.';
  }
}

// ---------- UPDATE FLOW (safe preserve of update embeds) ----------
async function startUpdateFlow(initiator = 'dashboard', durationMinutes = 0) {
  if (state.update.active) { emitLog('startUpdateFlow: already active'); return { ok: false, error: 'Already active' }; }
  const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!channel) { emitLog('startUpdateFlow: channel not found'); return { ok: false, error: 'Channel not found' }; }

  // mark active
  state.update.active = true;
  state.update.startedAt = Date.now();
  state.update.durationMinutes = Number(durationMinutes) || 0;

  emitLog(`Update started by ${initiator}. Duration: ${state.update.durationMinutes} min`);

  // lock channel
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone.id, { SendMessages: false });
    emitLog('Channel locked.');
  } catch (err) { emitLog('Error locking channel:', err.message || err); }

  // send start embed & preserve its id before cleanup
  const mc = await getMinecraftStatus();
  const fields = [
    { name: 'Status', value: '🔧 Updating', inline: true },
    { name: 'Chat', value: '🔒 Locked', inline: true },
    { name: 'Estimated duration', value: state.update.durationMinutes ? `${state.update.durationMinutes} minutes` : 'Manual (no auto finish)', inline: true },
    { name: 'Server', value: mc.online ? (mc.motd || 'Online') : 'Offline', inline: false }
  ];
  const startMsg = await sendPremiumEveryone(channel, { title: 'Automatic Update — Started', description: `Initiated by **${initiator}**.`, fields, style: 'premium', color: 0x00b894, footer: 'Cyberland Bot' });
  if (startMsg) state.update.startMsgId = startMsg.id;

  // cleanup messages but preserve startMsgId and any pinned messages
  await cleanupPreserve(channel, [state.update.startMsgId]);

  // if duration set, schedule auto-finish
  if (state.update.durationMinutes && state.update.durationMinutes > 0) {
    // clear existing timer if any
    if (state.update.timer) clearTimeout(state.update.timer);
    const ms = state.update.durationMinutes * 60 * 1000;
    state.update.timer = setTimeout(async () => {
      emitLog('Auto-finish timer fired.');
      await finishUpdateFlow('auto-timer');
    }, ms);
    emitLog(`Auto-finish scheduled in ${state.update.durationMinutes} minutes.`);
  }

  // start countdown emitter
  startCountdownEmitter();

  return { ok: true };
}

// finish - ensures finish embed preserved and unlocks
async function finishUpdateFlow(initiator = 'dashboard') {
  if (!state.update.active) { emitLog('finishUpdateFlow: no active update'); return { ok: false, error: 'No active update' }; }
  const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!channel) { emitLog('finishUpdateFlow: channel not found'); return { ok: false, error: 'Channel not found' }; }

  // cancel timer if exists
  if (state.update.timer) { clearTimeout(state.update.timer); state.update.timer = null; }

  const mc = await getMinecraftStatus();
  const fields = [
    { name: 'Status', value: '✅ Completed', inline: true },
    { name: 'Chat', value: '🔓 Unlocked', inline: true },
    { name: 'Server', value: mc.online ? (mc.motd || 'Online') : 'Offline', inline: false }
  ];
  const finishMsg = await sendPremiumEveryone(channel, { title: 'Automatic Update — Completed', description: `Finished by **${initiator}**.`, fields, style: 'premium', color: 0x2ecc71, footer: 'Cyberland Bot' });
  if (finishMsg) state.update.finishMsgId = finishMsg.id;

  // unlock channel
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone.id, { SendMessages: null });
    emitLog('Channel unlocked.');
  } catch (err) { emitLog('Error unlocking channel:', err.message || err); }

  // reset update state after short delay (so embeds remain)
  state.update.active = false;
  state.update.startMsgId = null;
  state.update.startedAt = null;
  state.update.durationMinutes = 0;
  state.update.timer = null;

  // stop countdown emitter
  stopCountdownEmitter();

  return { ok: true };
}

// helper to cleanup messages while preserving a list of message ids and pinned messages
async function cleanupPreserve(channel, preserveIds = []) {
  emitLog('Cleaning messages while preserving ids:', preserveIds.join(', '));
  try {
    let before = null;
    while (true) {
      const options = { limit: 100 };
      if (before) options.before = before;
      const batch = await channel.messages.fetch(options);
      if (!batch || batch.size === 0) break;

      const toDelete = batch.filter(m => {
        if (m.pinned) return false;
        if (preserveIds.includes(m.id)) return false;
        // also preserve our embeds that have title starting with 'Automatic Update' (safety net)
        const emb = (m.embeds && m.embeds[0]);
        if (emb && emb.title && emb.title.toLowerCase().includes('update')) return false;
        return true;
      });

      if (toDelete.size > 0) {
        // split by 14-day
        const now = Date.now();
        const recent = toDelete.filter(m => now - m.createdTimestamp < 14 * 24 * 3600 * 1000);
        const old = toDelete.filter(m => now - m.createdTimestamp >= 14 * 24 * 3600 * 1000);

        if (recent.size > 0) {
          try {
            await channel.bulkDelete(recent, true);
            emitLog(`Bulk deleted ${recent.size} messages.`);
          } catch (e) {
            for (const m of recent.values()) await m.delete().catch(()=>{});
            emitLog(`Fallback deleted ${recent.size} recent messages.`);
          }
        }
        for (const m of old.values()) await m.delete().catch(()=>{});
      }

      if (batch.size < 100) break;
      before = batch.last().id;
    }
    emitLog('CleanupPreserve finished.');
  } catch (err) {
    emitLog('cleanupPreserve error:', err.message || err);
  }
}

// ----------------- Countdown emitter -----------------
let countdownInterval = null;
function startCountdownEmitter() {
  if (countdownInterval) return;
  countdownInterval = setInterval(() => {
    if (!state.update.active || !state.update.startedAt) {
      io.emit('update-countdown', null);
      return;
    }
    const started = state.update.startedAt;
    const durationMs = (state.update.durationMinutes || 0) * 60000;
    if (!durationMs) {
      io.emit('update-countdown', { remainingMs: null });
      return;
    }
    const elapsed = Date.now() - started;
    let remaining = durationMs - elapsed;
    if (remaining < 0) remaining = 0;
    io.emit('update-countdown', { remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) });
  }, 1000);
}
function stopCountdownEmitter() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; io.emit('update-countdown', null); }
}

// ----------------- CRON automatic daily update (BD time 15:00 / 15:05) -----------------
cron.schedule('0 15 * * *', async () => {
  if (!state.autoUpdateEnabled) { emitLog('Auto update disabled; skipping scheduled start.'); return; }
  emitLog('[CRON] Auto-start (15:00 BD)');
  await startUpdateFlow('auto-cron', 5); // if desired, auto-start can set duration default; here we set 5 min by passing 5
}, { timezone: TZ });

cron.schedule('5 15 * * *', async () => {
  if (!state.autoUpdateEnabled) { emitLog('Auto update disabled; skipping scheduled finish.'); return; }
  emitLog('[CRON] Auto-finish (15:05 BD)');
  await finishUpdateFlow('auto-cron');
}, { timezone: TZ });

// ----------------- DISCORD message handling -----------------
client.on('ready', () => {
  emitLog(`Discord logged in as ${client.user.tag}`);
  try { client.user.setActivity('Cyberland • Premium', { type: ActivityType.Playing }); } catch(e){}
});

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    if (msg.channelId !== CHANNEL_ID) return;

    // If update active: delete user's messages immediately (but DO NOT delete our update embeds)
    if (state.update.active) {
      // delete user message
      if (!msg.author.bot) {
        await msg.delete().catch(()=>{});
      }
      return;
    }

    // Commands
    if (msg.content.startsWith(BOT_PREFIX)) {
      const [cmd, ...args] = msg.content.slice(BOT_PREFIX.length).trim().split(/\s+/);
      const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) || msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

      if (cmd === 'status') {
        const mc = await getMinecraftStatus();
        const embed = buildPremiumEmbed({
          title: 'Minecraft Status',
          description: `Host: ${MINECRAFT_HOST}:${MINECRAFT_PORT}`,
          fields: [
            { name: 'Online', value: mc.online ? '✅' : '❌', inline: true },
            { name: 'Players', value: mc.online ? `${mc.players}` : 'N/A', inline: true },
            { name: 'Ping', value: mc.online ? `${mc.ping ?? 'N/A'} ms` : 'N/A', inline: true }
          ],
          style: 'premium'
        });
        return msg.reply({ embeds: [embed] }).catch(()=>{});
      }

      if (cmd === 'update') {
        if (!isAdmin) return msg.reply('You must be an admin to run update commands.');
        const sub = (args[0] || 'start').toLowerCase();
        if (sub === 'start') {
          // optional minutes: !update start 5
          const minutes = Number(args[1]) || 0;
          await msg.reply(`Starting update (duration ${minutes ? minutes+' min' : 'manual'})...`).catch(()=>{});
          await startUpdateFlow(`command:${msg.author.tag}`, minutes);
          return;
        } else if (sub === 'finish') {
          await msg.reply('Finishing update...').catch(()=>{});
          await finishUpdateFlow(`command:${msg.author.tag}`);
          return;
        }
      }

      if (cmd === 'ping') return msg.reply('Pong!').catch(()=>{});
    }

    // Otherwise: AI reply (only when OpenAI configured)
    if (OPENAI_API_KEY) {
      await msg.channel.sendTyping();
      const reply = await queryOpenAI(`${msg.author.username}: ${msg.content}`);
      await msg.reply(reply).catch(()=>{});
    } else {
      // No AI key: optionally ignore or send short fallback
      // we'll not spam the channel — do nothing
    }
  } catch (err) {
    emitLog('messageCreate error:', err.message || err);
  }
});

// ----------------- DASHBOARD (embedded pages) -----------------
function requireAuth(req, res, next) {
  if (req.session && req.session.isAuthenticated) return next();
  return res.redirect('/login');
}

app.get('/style.css', (req, res) => {
  res.type('text/css').send(`
:root{--bg:#071827;--card:#0f1724;--accent1:#8b5cf6;--accent2:#06b6d4}
html,body{height:100%;margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial}
body{background:linear-gradient(180deg,var(--bg),#061427);color:#e6f0ff}
.center{max-width:980px;margin:28px auto;padding:20px}
.card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));padding:18px;border-radius:12px;box-shadow:0 10px 30px rgba(2,6,23,0.6)}
.header{display:flex;justify-content:space-between;align-items:center}
.logo{width:56px;height:56px;border-radius:12px;background:linear-gradient(90deg,var(--accent1),var(--accent2));display:flex;align-items:center;justify-content:center;font-weight:800;color:white}
.btn{padding:10px 14px;border-radius:10px;border:none;cursor:pointer;background:linear-gradient(90deg,var(--accent1),var(--accent2));color:white;font-weight:800}
.btn.warn{background:linear-gradient(90deg,#f97316,#f43f5e)}
.logs{height:240px;overflow:auto;background:rgba(255,255,255,0.02);padding:12px;border-radius:8px;font-family:monospace;color:#bfe0ff}
.input{padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit}
.small{color:#9fb0d5;font-size:13px}
  `);
});

app.get('/login', (req, res) => {
  res.type('html').send(`
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login - Cyberland</title><link rel="stylesheet" href="/style.css"></head><body>
<div class="center"><div class="card" style="max-width:420px;margin:0 auto;text-align:center"><div class="logo" style="margin:0 auto 12px">CB</div><h2 style="margin:0 0 6px">Cyberland Bot Dashboard</h2><p class="small" style="margin-bottom:12px">Enter admin password to continue</p><form method="POST" action="/login"><input name="password" type="password" placeholder="Admin password" class="input" required/><button class="btn" style="width:100%;margin-top:10px">Sign in</button></form></div></div></body></html>
  `);
});

app.post('/login', (req, res) => {
  const pass = req.body.password;
  if (pass === ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    return res.redirect('/');
  }
  return res.status(401).send('<h3>Invalid password — <a href="/login">try again</a></h3>');
});

app.get('/', requireAuth, (req, res) => {
  res.type('html').send(`
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberland Dashboard</title><link rel="stylesheet" href="/style.css"></head><body>
<div class="center">
  <div class="header">
    <div style="display:flex;gap:12px;align-items:center">
      <div class="logo">CB</div>
      <div><div style="font-weight:800">Cyberland Bot</div><div class="small">Admin Dashboard</div></div>
    </div>
    <div>
      <button id="toggleAuto" class="btn">Toggle Auto Update</button>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 360px;gap:18px;margin-top:14px">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><h3 style="margin:0">Update Controls</h3><div class="small">Start / finish updates manually</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="duration" class="input" placeholder="Duration (minutes) e.g. 5" style="width:140px" />
          <button id="startBtn" class="btn">⚡ Start Update</button>
          <button id="finishBtn" class="btn warn">✅ Finish Update</button>
        </div>
      </div>

      <div style="margin-top:12px">
        <h4 style="margin:0 0 6px 0">Live Logs</h4>
        <div id="logs" class="logs"></div>
      </div>
    </div>

    <div class="card">
      <h4 style="margin-top:0">Live Status</h4>
      <div class="small">Minecraft & Bot Metrics</div>
      <div style="margin-top:8px"><strong>MC:</strong> <span id="mcStatus">—</span></div>
      <div style="margin-top:6px"><strong>Players:</strong> <span id="mcPlayers">—</span></div>
      <div style="margin-top:6px"><strong>Ping:</strong> <span id="mcPing">—</span></div>
      <div style="margin-top:6px"><strong>Bot Uptime:</strong> <span id="botUptime">—</span></div>
      <div style="margin-top:6px"><strong>Update Active:</strong> <span id="updateActive">No</span></div>
      <div style="margin-top:6px"><strong>Remaining:</strong> <span id="remaining">—</span></div>
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const logs = document.getElementById('logs');
  function appendLog(s){ const d=document.createElement('div'); d.textContent='['+new Date().toLocaleTimeString()+'] '+s; logs.prepend(d); }
  socket.on('connect', ()=> appendLog('Connected to server'));
  socket.on('update-log', (m)=> appendLog(m));

  socket.on('status', (s)=> {
    document.getElementById('mcStatus').innerText = s.mc.online ? (s.mc.motd || 'Online') : 'Offline';
    document.getElementById('mcPlayers').innerText = s.mc.players ?? '-';
    document.getElementById('mcPing').innerText = s.mc.ping ?? '-';
    document.getElementById('botUptime').innerText = s.bot.uptime;
    document.getElementById('updateActive').innerText = s.update.active ? 'Yes' : 'No';
  });

  socket.on('update-countdown', (d) => {
    if (!d) { document.getElementById('remaining').innerText = '-'; return; }
    if (d.remainingMs === null) { document.getElementById('remaining').innerText = 'Indefinite'; return; }
    const s = Math.ceil(d.remainingMs/1000);
    document.getElementById('remaining').innerText = s + 's';
  });

  document.getElementById('startBtn').onclick = async () => {
    const mins = Number(document.getElementById('duration').value) || 0;
    appendLog('Requesting start update for ' + (mins ? mins + ' min' : 'manual'));
    const res = await fetch('/api/start', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ minutes: mins })});
    const j = await res.json();
    appendLog('Start: ' + (j.ok ? 'OK' : ('ERR: '+(j.error||'unknown'))));
  };
  document.getElementById('finishBtn').onclick = async () => {
    appendLog('Requesting finish update...');
    const res = await fetch('/api/finish', { method: 'POST' });
    const j = await res.json();
    appendLog('Finish: ' + (j.ok ? 'OK' : ('ERR: '+(j.error||'unknown'))));
  };
  document.getElementById('toggleAuto').onclick = async () => {
    const res = await fetch('/api/toggle-auto',{method:'POST'});
    const j = await res.json();
    appendLog('Auto update now: ' + (j.enabled ? 'ENABLED' : 'DISABLED'));
  };

  // request status every 7s
  setInterval(()=> socket.emit('request-status'), 7000);
  socket.emit('request-status');
</script>
</body></html>
  `);
});

// ----------------- Dashboard API routes -----------------
app.post('/api/start', requireAuth, async (req, res) => {
  try {
    const minutes = Number(req.body.minutes) || 0;
    const result = await startUpdateFlow('dashboard', minutes);
    res.json(result);
  } catch (err) { res.json({ ok: false, error: err.message || String(err) }); }
});
app.post('/api/finish', requireAuth, async (req, res) => {
  try {
    const result = await finishUpdateFlow('dashboard');
    res.json(result);
  } catch (err) { res.json({ ok: false, error: err.message || String(err) }); }
});
app.post('/api/toggle-auto', requireAuth, (req, res) => {
  state.autoUpdateEnabled = !state.autoUpdateEnabled;
  emitLog('Auto update toggled ->', state.autoUpdateEnabled ? 'ENABLED' : 'DISABLED');
  res.json({ ok: true, enabled: state.autoUpdateEnabled });
});

// ----------------- Socket handlers -----------------
io.on('connection', (socket) => {
  emitLog('Socket connected', socket.id);
  socket.on('request-status', async () => {
    const mc = await getMinecraftStatus();
    const uptime = ((process.uptime()||0)/60).toFixed(1) + 'm';
    socket.emit('status', {
      mc,
      bot: { uptime, ping: client.ws?.ping ?? 0 },
      update: { active: state.update.active }
    });
  });
  socket.emit('update-log', 'Welcome to Cyberland dashboard.');
});

// ----------------- Start server & login -----------------
server.listen(PORT, () => emitLog(`Dashboard running at http://localhost:${PORT} (or your host URL)`));

(async () => {
  try {
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    emitLog('Discord login failed. Check DISCORD_TOKEN in env. Error:', err.message || err);
    process.exit(1);
  }
})();
