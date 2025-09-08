/**
 * bot.js - All-in-one Premium Cyberland Bot
 * - Discord AI (OpenAI optional)
 * - Minecraft status (play.cyberland.pro:19132)
 * - Premium embeds
 * - Dashboard with login, Start/Finish Update, Toggle Auto
 * - Auto update schedule: 15:00 start, 15:05 finish (Asia/Dhaka)
 *
 * IMPORTANT:
 * - Put secrets in a .env file (DO NOT commit).
 * - Install dependencies listed above before running.
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

// ----------------- Config from ENV -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_PREFIX = process.env.BOT_PREFIX || '!';
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || 'play.cyberland.pro';
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT || '19132', 10);
const TZ = process.env.TIMEZONE || 'Asia/Dhaka';

// Basic checks
if (!DISCORD_TOKEN) {
  console.error('ERROR: DISCORD_TOKEN missing in environment. Set it in .env');
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error('ERROR: CHANNEL_ID missing in environment. Set it in .env');
  process.exit(1);
}

// ----------------- App & Socket -----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Session (MemoryStore) - ok for single instance (Render). For scale, use Redis/Mongo store.
app.use(session({
  secret: process.env.SESSION_SECRET || 'cyberland-secret',
  resave: false,
  saveUninitialized: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------- Bot State -----------------
const state = {
  update: {
    active: false,
    startMsgId: null,
    finishMsgId: null,
    style: 'classic' // 'classic' or 'premium'
  },
  autoUpdateEnabled: true
};

// Helper to broadcast logs to console + dashboard clients
function emitLog(...parts) {
  const msg = parts.join(' ');
  try { console.log(msg); } catch(e) {}
  try { io.emit('update-log', msg); } catch(e) {}
}

// ----------------- Discord Client -----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// Premium embed builder (classic screenshot-like and premium modern)
function buildEmbed({ title, description, fields = [], imageUrl = null, style = 'premium', color = 0x7c3aed, footerText = 'Cyberland Bot' }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ text: footerText });

  embed.setColor(color);

  if (fields.length) embed.addFields(...fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })));
  if (imageUrl) embed.setImage(imageUrl);

  // Author / Thumbnail differences by style
  if (style === 'classic') {
    embed.setAuthor({ name: '⚡ Cyberland Bot • Premium', iconURL: client.user?.displayAvatarURL?.() || null });
    // classic look uses green-ish color
  } else {
    embed.setAuthor({ name: '🚀 Cyberland • Premium Update', iconURL: client.user?.displayAvatarURL?.() || null });
    embed.setColor(0x8b5cf6);
  }
  return embed;
}

async function sendPremium(channel, title, description, fields = [], imageUrl = null, style = 'premium', color) {
  const embed = buildEmbed({ title, description, fields, imageUrl, style, color });
  try {
    return await channel.send({ content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } });
  } catch (err) {
    emitLog('Failed to send premium embed:', err.message || err);
    return null;
  }
}

// ----------------- Channel Lock/Unlock & Cleanup -----------------
async function lockChannel(channel) {
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone.id, { SendMessages: false });
    emitLog('Channel locked (SendMessages=false for @everyone).');
  } catch (err) {
    emitLog('Error locking channel:', err.message || err);
  }
}
async function unlockChannel(channel) {
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone.id, { SendMessages: null });
    emitLog('Channel unlocked (SendMessages reset for @everyone).');
  } catch (err) {
    emitLog('Error unlocking channel:', err.message || err);
  }
}

// Delete all messages while preserving update embeds (and pinned)
async function cleanupChannelMessages(channel) {
  emitLog('Cleaning channel messages (preserving update embeds)...');
  const keep = [state.update.startMsgId, state.update.finishMsgId].filter(Boolean);

  try {
    let before = null;
    while (true) {
      const options = { limit: 100 };
      if (before) options.before = before;
      const batch = await channel.messages.fetch(options);
      if (!batch || batch.size === 0) break;

      const toDelete = batch.filter(m => !keep.includes(m.id) && !m.pinned);
      if (toDelete.size === 0) {
        if (batch.size < 100) break;
        before = batch.last().id;
        continue;
      }

      // Split into recent (<14 days) vs older
      const now = Date.now();
      const recent = toDelete.filter(m => now - m.createdTimestamp < 14 * 24 * 3600 * 1000);
      const old = toDelete.filter(m => now - m.createdTimestamp >= 14 * 24 * 3600 * 1000);

      if (recent.size > 0) {
        try {
          await channel.bulkDelete(recent, true);
          emitLog(`Bulk deleted ${recent.size} recent messages.`);
        } catch (e) {
          // fallback
          for (const m of recent.values()) {
            await m.delete().catch(()=>{});
          }
          emitLog(`Fallback deleted ${recent.size} recent messages.`);
        }
      }

      for (const m of old.values()) {
        await m.delete().catch(()=>{});
      }

      if (batch.size < 100) break;
      before = batch.last().id;
    }
    emitLog('Channel cleanup finished.');
  } catch (err) {
    emitLog('Error during cleanup:', err.message || err);
  }
}

// ----------------- Minecraft Status -----------------
async function getMinecraftStatus() {
  try {
    let s = null;
    try {
      s = await statusBedrock(MINECRAFT_HOST, MINECRAFT_PORT, { timeout: 2000 });
    } catch (e) {
      try {
        s = await status(MINECRAFT_HOST, { port: MINECRAFT_PORT, timeout: 2000 });
      } catch (e2) {
        s = null;
      }
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

// ----------------- OpenAI helper (optional) -----------------
async function queryOpenAI(prompt) {
  if (!OPENAI_API_KEY) return 'OpenAI not configured.';
  try {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are a Minecraft expert assistant. Server: ${MINECRAFT_HOST}:${MINECRAFT_PORT}. Provide safe, short, actionable answers.` },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400,
      temperature: 0.6
    };
    const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    return res.data?.choices?.[0]?.message?.content || 'No response.';
  } catch (err) {
    emitLog('OpenAI error:', err?.response?.data || err.message || err);
    return 'Error contacting OpenAI.';
  }
}

// ----------------- Update flows -----------------
async function startUpdateFlow(initiator='dashboard') {
  if (state.update.active) {
    emitLog('Start requested but update already active.');
    return { ok: false, error: 'Already active' };
  }
  const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!channel) {
    emitLog('StartUpdate: Channel not found.');
    return { ok: false, error: 'Channel not found' };
  }

  state.update.active = true;
  emitLog(`Update started by ${initiator}. Locking channel and sending embed...`);

  await lockChannel(channel);
  const mc = await getMinecraftStatus();
  const fields = [
    { name: 'Status', value: '🔧 Updating', inline: true },
    { name: 'Chat', value: '🔒 Locked', inline: true },
    { name: 'Server', value: mc.online ? `${mc.motd || 'Online'}` : 'Offline', inline: false }
  ];
  const startMsg = await sendPremium(channel, '🔄 Bot Update — Starting', `Initiated by **${initiator}**. Channel locked; cleaning messages...`, fields, null, state.update.style, 0x00b894);
  if (startMsg) state.update.startMsgId = startMsg.id;

  await cleanupChannelMessages(channel);

  emitLog('Start update flow complete (waiting for finish).');
  return { ok: true };
}

async function finishUpdateFlow(initiator='dashboard') {
  if (!state.update.active) {
    emitLog('Finish requested but no active update.');
    return { ok: false, error: 'No active update' };
  }
  const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!channel) {
    emitLog('FinishUpdate: Channel not found.');
    return { ok: false, error: 'Channel not found' };
  }

  const mc = await getMinecraftStatus();
  const fields = [
    { name: 'Status', value: '✅ Completed', inline: true },
    { name: 'Chat', value: '🔓 Unlocked', inline: true },
    { name: 'Server', value: mc.online ? `${mc.motd || 'Online'}` : 'Offline', inline: false }
  ];
  const finishMsg = await sendPremium(channel, '✅ Bot Update — Completed', `Finished by **${initiator}**. Channel unlocked.`, fields, null, state.update.style, 0x2ecc71);
  if (finishMsg) state.update.finishMsgId = finishMsg.id;

  await unlockChannel(channel);
  state.update.active = false;
  emitLog('Finish update flow complete. Channel unlocked.');
  return { ok: true };
}

// ----------------- Cron auto-update (BD time 15:00 start / 15:05 finish) -----------------
cron.schedule('0 15 * * *', async () => {
  if (!state.autoUpdateEnabled) { emitLog('Auto update disabled; skipping start.'); return; }
  emitLog('[CRON] Auto-start (BD 15:00) triggered.');
  await startUpdateFlow('auto-cron');
}, { timezone: TZ });

cron.schedule('5 15 * * *', async () => {
  if (!state.autoUpdateEnabled) { emitLog('Auto update disabled; skipping finish.'); return; }
  emitLog('[CRON] Auto-finish (BD 15:05) triggered.');
  await finishUpdateFlow('auto-cron');
}, { timezone: TZ });

// ----------------- Discord message handling -----------------
client.on('ready', () => {
  emitLog(`Discord connected as ${client.user.tag}`);
  try { client.user.setActivity('Cyberland • Premium', { type: ActivityType.Playing }); } catch(e){}
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.channelId !== CHANNEL_ID) return;

    // During update: delete any non-bot messages
    if (state.update.active) {
      if (!message.author.bot) await message.delete().catch(()=>{});
      return;
    }

    // Commands
    if (message.content.startsWith(BOT_PREFIX)) {
      const [cmd, ...args] = message.content.slice(BOT_PREFIX.length).trim().split(/\s+/);
      const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) || message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

      if (cmd === 'status') {
        const mc = await getMinecraftStatus();
        const embed = buildEmbed({
          title: 'Minecraft Server Status',
          description: `Host: ${MINECRAFT_HOST}:${MINECRAFT_PORT}`,
          fields: [
            { name: 'Online', value: mc.online ? '✅' : '❌', inline: true },
            { name: 'Players', value: mc.online ? `${mc.players}` : 'N/A', inline: true },
            { name: 'Ping', value: mc.online ? `${mc.ping ?? 'N/A'} ms` : 'N/A', inline: true }
          ],
          style: 'premium'
        });
        return message.reply({ embeds: [embed] }).catch(()=>{});
      }

      if (cmd === 'update') {
        if (!isAdmin) return message.reply('You must be admin to run update commands.');
        const sub = args[0] || 'start';
        if (sub === 'start') {
          await message.reply('Starting update...').catch(()=>{});
          await startUpdateFlow(`command:${message.author.tag}`);
        } else if (sub === 'finish') {
          await message.reply('Finishing update...').catch(()=>{});
          await finishUpdateFlow(`command:${message.author.tag}`);
        } else {
          await message.reply('Usage: !update start|finish').catch(()=>{});
        }
        return;
      }

      if (cmd === 'ping') {
        const sent = await message.reply('Pinging...').catch(()=>null);
        if (sent) sent.edit(`Pong! Latency: ${sent.createdTimestamp - message.createdTimestamp}ms`).catch(()=>{});
        return;
      }
    }

    // Default: AI reply (OpenAI optional)
    await message.channel.sendTyping();
    const reply = await queryOpenAI(`${message.author.username}: ${message.content}`);
    await message.reply(reply).catch(()=>{});
  } catch (err) {
    emitLog('messageCreate handler error:', err?.message || err);
  }
});

// ----------------- Dashboard (embedded HTML/CSS/JS served by routes) -----------------
// Simple auth via session
function requireAuth(req, res, next) {
  if (req.session && req.session.isAuthenticated) return next();
  return res.redirect('/login');
}

// Inline CSS served
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
    .logs{height:320px;overflow:auto;background:rgba(255,255,255,0.02);padding:12px;border-radius:8px;font-family:monospace;color:#bfe0ff}
    input[type=password]{padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit;width:100%}
    form{display:flex;gap:8px}
  `);
});

// Login page (inline)
app.get('/login', (req, res) => {
  res.type('html').send(`
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login - Cyberland</title>
    <link rel="stylesheet" href="/style.css"></head><body>
    <div class="center">
      <div class="card" style="max-width:420px;margin:0 auto;text-align:center">
        <div class="logo" style="margin:0 auto 12px">CB</div>
        <h2 style="margin:0 0 6px">Cyberland Bot Dashboard</h2>
        <p style="color:#9fb0d5;margin:0 0 12px">Enter admin password to continue</p>
        <form method="POST" action="/login">
          <input name="password" type="password" placeholder="Admin password" required />
          <button class="btn" style="width:100%;margin-top:10px">Sign in</button>
        </form>
      </div>
    </div></body></html>
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

// Dashboard page (inline)
app.get('/', requireAuth, (req, res) => {
  res.type('html').send(`
  <!doctype html>
  <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberland Dashboard</title>
  <link rel="stylesheet" href="/style.css"></head><body>
  <div class="center">
    <div class="header">
      <div style="display:flex;gap:12px;align-items:center">
        <div class="logo">CB</div>
        <div><div style="font-weight:800">Cyberland Bot</div><div style="font-size:13px;color:#9fb0d5">Admin Dashboard</div></div>
      </div>
      <div>
        <button id="btnAuto" class="btn">Toggle Auto Update</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 360px;gap:18px;margin-top:14px">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><h3 style="margin:0">Update Controls</h3><div style="color:#9fb0d5">Start / finish updates manually</div></div>
          <div style="display:flex;gap:8px">
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
        <div class="small" style="color:#9fb0d5">Minecraft & Bot Metrics</div>
        <div style="margin-top:8px"><strong>MC:</strong> <span id="mcStatus">—</span></div>
        <div style="margin-top:6px"><strong>Players:</strong> <span id="mcPlayers">—</span></div>
        <div style="margin-top:6px"><strong>Ping:</strong> <span id="mcPing">—</span></div>
        <div style="margin-top:6px"><strong>Bot Uptime:</strong> <span id="botUptime">—</span></div>
        <div style="margin-top:6px"><strong>Update Active:</strong> <span id="updateActive">No</span></div>
        <div style="margin-top:6px"><strong>Auto Update:</strong> <span id="autoActive">Yes</span></div>
      </div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const logsEl = document.getElementById('logs');
    const appendLog = (m) => { const d=document.createElement('div'); d.textContent='['+new Date().toLocaleTimeString()+'] '+m; logsEl.prepend(d); };

    socket.on('connect', ()=> appendLog('Connected to server'));
    socket.on('update-log', (m)=> appendLog(m));

    socket.on('status', (s) => {
      document.getElementById('mcStatus').innerText = s.mc.online ? (s.mc.motd || 'Online') : 'Offline';
      document.getElementById('mcPlayers').innerText = s.mc.players ?? '-';
      document.getElementById('mcPing').innerText = s.mc.ping ?? '-';
      document.getElementById('botUptime').innerText = s.bot.uptime;
      document.getElementById('updateActive').innerText = s.update.active ? 'Yes' : 'No';
      document.getElementById('autoActive').innerText = s.auto ? 'Yes' : 'No';
    });

    document.getElementById('startBtn').onclick = async () => {
      appendLog('Requesting Start Update...');
      const r = await fetch('/api/start', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) appendLog('Start failed: ' + (j.error || 'unknown')); else appendLog('Start OK');
    };
    document.getElementById('finishBtn').onclick = async () => {
      appendLog('Requesting Finish Update...');
      const r = await fetch('/api/finish', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) appendLog('Finish failed: ' + (j.error || 'unknown')); else appendLog('Finish OK');
    };
    document.getElementById('btnAuto').onclick = async () => {
      const r = await fetch('/api/toggle-auto', { method: 'POST' });
      const j = await r.json();
      appendLog('Auto update now: ' + (j.enabled ? 'ENABLED' : 'DISABLED'));
    };

    // request status immediately and every 7 seconds
    socket.emit('request-status');
    setInterval(()=> socket.emit('request-status'), 7000);
  </script>
  </body></html>
  `);
});

// ----------------- Dashboard API -----------------
app.post('/api/start', requireAuth, async (req, res) => {
  try {
    const result = await startUpdateFlow('dashboard');
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
  emitLog('Auto update toggled. Now:', state.autoUpdateEnabled ? 'ENABLED' : 'DISABLED');
  res.json({ ok: true, enabled: state.autoUpdateEnabled });
});

// ----------------- Socket.IO connections -----------------
io.on('connection', (socket) => {
  emitLog('Socket connected', socket.id);
  socket.on('request-status', async () => {
    const mc = await getMinecraftStatus();
    const uptimeMin = ((process.uptime() || 0) / 60).toFixed(1) + 'm';
    const ping = client.ws?.ping ?? 0;
    socket.emit('status', {
      mc,
      bot: { uptime: uptimeMin, ping },
      update: { active: state.update.active },
      auto: state.autoUpdateEnabled
    });
  });
  socket.emit('update-log', 'Welcome to Cyberland dashboard.');
});

// ----------------- Start server & login -----------------
server.listen(PORT, () => emitLog(`🌐 Dashboard running at http://localhost:${PORT} (or your host URL)`));

// Login to Discord safely
(async () => {
  try {
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    emitLog('Discord login failed. Check your DISCORD_TOKEN in environment variables.');
    // do not log token or other secrets
    process.exit(1);
  }
})();
