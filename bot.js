/**
 * bot.js  —  All-in-one: Discord AI Bot + Minecraft status + Premium Dashboard + Auto-update
 *
 * IMPORTANT:
 * - Put secrets in .env (DO NOT commit). Example .env shown above in instructions.
 * - Install these packages:
 *   npm i discord.js express express-session socket.io dotenv axios minecraft-server-util node-cron moment-timezone
 *
 * - This file is intentionally self-contained and serves the dashboard HTML/CSS/JS from memory.
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

// ---------- Environment & config ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_PREFIX = process.env.BOT_PREFIX || '!';
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || 'play.cyberland.pro';
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT || '19132', 10);
const TZ = process.env.TIMEZONE || 'Asia/Dhaka';

// Basic env checks
if (!DISCORD_TOKEN) {
  console.error('ERROR: DISCORD_TOKEN is missing. Set it in .env and restart.');
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error('ERROR: CHANNEL_ID is missing. Set it in .env and restart.');
  process.exit(1);
}

// ---------- Bot state ----------
const state = {
  update: {
    active: false,
    startMsgId: null,
    finishMsgId: null,
    style: 'classic', // classic or premium
  },
  autoUpdateEnabled: true,
};

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Utility: safe logging to both console and dashboard clients
let io = null;
function emitLog(...args) {
  const msg = args.join(' ');
  try { console.log(msg); } catch(e) {}
  try { io && io.emit('update-log', msg); } catch(e) {}
}

// ---------- Premium embed builder ----------
function buildPremiumEmbed(title, description, extraFields = [], imageUrl = null, color = 0x7c3aed) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: '⚡ Cyberland AI Bot' })
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ text: 'Cyberland — Premium' });

  if (extraFields && extraFields.length) e.addFields(...extraFields);
  if (imageUrl) e.setImage(imageUrl);
  return e;
}

// send premium @everyone embed (content uses allowedMentions to avoid leaking token)
async function sendPremiumEmbedToChannel(channel, title, description, extraFields = [], imageUrl = null, color = 0x7c3aed) {
  const emb = buildPremiumEmbed(title, description, extraFields, imageUrl, color);
  try {
    return await channel.send({ content: '@everyone', embeds: [emb], allowedMentions: { parse: ['everyone'] }});
  } catch (err) {
    emitLog('Failed to send premium embed to channel:', err.message || err.toString());
    return null;
  }
}

// ---------- Channel lock/unlock ----------
async function lockChannel(channel) {
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone.id, { SendMessages: false });
    emitLog('Channel locked for everyone.');
  } catch (err) {
    emitLog('Error locking channel:', err.message || err);
  }
}
async function unlockChannel(channel) {
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone.id, { SendMessages: null });
    emitLog('Channel unlocked for everyone.');
  } catch (err) {
    emitLog('Error unlocking channel:', err.message || err);
  }
}

// ---------- Delete messages but preserve update embeds ----------
async function deleteAllMessagesExceptReserved(channel) {
  emitLog('Cleaning channel messages (preserving update embeds)...');
  const keep = [state.update.startMsgId, state.update.finishMsgId].filter(Boolean);

  try {
    let lastId = null;
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const fetched = await channel.messages.fetch(options);
      if (!fetched || fetched.size === 0) break;

      // messages to delete (exclude ones in keep & pinned)
      const toDelete = fetched.filter(m => !keep.includes(m.id) && !m.pinned);

      // separate recent (<14 days) vs old
      const now = Date.now();
      const recent = toDelete.filter(m => (now - m.createdTimestamp) < 14 * 24 * 3600 * 1000);
      const old = toDelete.filter(m => (now - m.createdTimestamp) >= 14 * 24 * 3600 * 1000);

      if (recent.size > 0) {
        try {
          await channel.bulkDelete(recent, true);
          emitLog(`Bulk deleted ${recent.size} recent messages.`);
        } catch (err) {
          // fallback to individual deletion
          for (const m of recent.values()) {
            await m.delete().catch(()=>{});
          }
          emitLog(`Fallback-deleted ${recent.size} recent messages.`);
        }
      }

      for (const m of old.values()) {
        await m.delete().catch(()=>{});
      }

      if (fetched.size < 100) break;
      lastId = fetched.last().id;
    }
    emitLog('Messages cleanup finished.');
  } catch (err) {
    emitLog('Error cleaning messages:', err.message || err);
  }
}

// ---------- OpenAI helper (optional) ----------
async function queryOpenAI(prompt) {
  if (!OPENAI_API_KEY) return "OpenAI not configured on server.";
  try {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are a helpful Minecraft assistant for ${MINECRAFT_HOST}:${MINECRAFT_PORT}. Provide safe, short, actionable answers.` },
        { role: 'user', content: prompt },
      ],
      max_tokens: 400,
      temperature: 0.6,
    };
    const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    const text = res.data?.choices?.[0]?.message?.content;
    return text || 'No response from OpenAI.';
  } catch (err) {
    emitLog('OpenAI error:', (err.response && err.response.data) ? JSON.stringify(err.response.data) : (err.message || err));
    return 'Error contacting OpenAI.';
  }
}

// ---------- Minecraft status helper ----------
async function getMinecraftStatus() {
  try {
    let s = null;
    try { s = await statusBedrock(MINECRAFT_HOST, MINECRAFT_PORT, { timeout: 2000 }); }
    catch(e) {
      // try Java fallback
      try { s = await status(MINECRAFT_HOST, { port: MINECRAFT_PORT, timeout: 2000 }); } catch(e2) { s = null; }
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

// ---------- Update flow (start & finish) ----------
async function startUpdateFlow(initiator='dashboard') {
  if (state.update.active) {
    emitLog('Update already active — start ignored.');
    return { ok: false, error: 'Already active' };
  }
  const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!channel) {
    emitLog('Start update: channel not found.');
    return { ok: false, error: 'Channel not found' };
  }

  state.update.active = true;
  emitLog(`Update started by ${initiator}. Locking channel and sending embed...`);

  await lockChannel(channel);
  const mc = await getMinecraftStatus();
  const fields = [
    { name: 'Status', value: '🔧 Updating', inline: true },
    { name: 'Chat', value: '🔒 Locked', inline: true },
    { name: 'Server Performance', value: mc.online ? `${mc.ping ?? 'N/A'} ms` : 'Offline', inline: true },
  ];
  const startMsg = await sendPremiumEmbedToChannel(channel, 'Automatic Update Started', `The bot is updating now — initiated by **${initiator}**.\nChannel will be locked during the update.`, fields, null, 0x00B894);
  if (startMsg) state.update.startMsgId = startMsg.id;

  await deleteAllMessagesExceptReserved(channel);

  emitLog('Update started and channel cleaned. Waiting for finish action.');
  return { ok: true };
}

async function finishUpdateFlow(initiator='dashboard') {
  if (!state.update.active) {
    emitLog('Finish update called but no update active.');
    return { ok: false, error: 'No update active' };
  }
  const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!channel) {
    emitLog('Finish update: channel not found.');
    return { ok: false, error: 'Channel not found' };
  }

  const mc = await getMinecraftStatus();
  const fields = [
    { name: 'Status', value: '✅ Completed', inline: true },
    { name: 'Chat', value: '🔓 Unlocked', inline: true },
    { name: 'Server Performance', value: mc.online ? `${mc.ping ?? 'N/A'} ms` : 'Offline', inline: true },
  ];

  const finishMsg = await sendPremiumEmbedToChannel(channel, 'Automatic Update Completed', `Update finished successfully — initiated by **${initiator}**.`, fields, null, 0x2ecc71);
  if (finishMsg) state.update.finishMsgId = finishMsg.id;

  await unlockChannel(channel);
  state.update.active = false;
  emitLog('Update finished and channel unlocked.');
  return { ok: true };
}

// ---------- Auto-schedule (BD time: 15:00 start, 15:05 finish) ----------
cron.schedule('0 15 * * *', async () => {
  if (!state.autoUpdateEnabled) { emitLog('Auto-update disabled; skipping scheduled start.'); return; }
  emitLog('[CRON] Auto-start scheduled (BD 15:00)');
  await startUpdateFlow('auto-cron');
}, { timezone: TZ });

cron.schedule('5 15 * * *', async () => {
  if (!state.autoUpdateEnabled) { emitLog('Auto-update disabled; skipping scheduled finish.'); return; }
  emitLog('[CRON] Auto-finish scheduled (BD 15:05)');
  await finishUpdateFlow('auto-cron');
}, { timezone: TZ });

// ---------- Discord message handler ----------
client.on('ready', () => {
  emitLog(`Discord ready as ${client.user.tag}.`);
  client.user.setActivity('Cyberland | Premium', { type: ActivityType.Playing }).catch(()=>{});
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.channelId !== CHANNEL_ID) return;

    // If update active: delete any messages (preserve embeds)
    if (state.update.active) {
      // non-bot messages get deleted
      if (!message.author.bot) {
        await message.delete().catch(()=>{});
      }
      return;
    }

    // Commands
    if (message.content.startsWith(BOT_PREFIX)) {
      const [cmd, ...rest] = message.content.slice(BOT_PREFIX.length).trim().split(/\s+/);
      const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) || message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

      if (cmd === 'status') {
        const mc = await getMinecraftStatus();
        const embed = buildPremiumEmbed('Minecraft Status', `Host: ${MINECRAFT_HOST}:${MINECRAFT_PORT}`, [
          { name: 'Online', value: mc.online ? '✅' : '❌', inline: true },
          { name: 'Players', value: mc.online ? `${mc.players}` : 'N/A', inline: true },
          { name: 'Ping', value: mc.online ? `${mc.ping ?? 'N/A'} ms` : 'N/A', inline: true },
        ]);
        return message.reply({ embeds: [embed] }).catch(()=>{});
      }

      if (cmd === 'update') {
        if (!isAdmin) return message.reply('You need Manage Server permission to run update.');
        const sub = rest[0] || 'start';
        if (sub === 'start') {
          await message.reply('Triggering update (start)...').catch(()=>{});
          await startUpdateFlow(`command:${message.author.tag}`);
        } else if (sub === 'finish') {
          await message.reply('Finishing update...').catch(()=>{});
          await finishUpdateFlow(`command:${message.author.tag}`);
        }
        return;
      }

      if (cmd === 'ping') {
        return message.reply('Pong!').catch(()=>{});
      }
    }

    // Otherwise forward to OpenAI (if configured), else ignore
    await message.channel.sendTyping();
    const reply = await queryOpenAI(`${message.author.username}: ${message.content}`);
    await message.reply(reply).catch(()=>{});
  } catch (err) {
    emitLog('messageCreate error:', err?.message || err);
  }
});

// ---------- Express + Dashboard (all-in-one single file pages) ----------
const app = express();
const server = http.createServer(app);
io = new Server(server);

// Basic session (MemoryStore fine for single-process; note warning in logs)
app.use(session({
  secret: process.env.SESSION_SECRET || 'cyberland-session-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve small assets (in-memory) — you can expand if needed
app.get('/style.css', (req, res) => {
  res.type('text/css').send(`
    :root{--bg:#071827;--card:#0f1724;--accent1:#8b5cf6;--accent2:#06b6d4;color-scheme:dark}
    html,body{height:100%;margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial}
    body{background:linear-gradient(180deg,var(--bg),#061427);color:#e6f0ff}
    .center{max-width:980px;margin:28px auto;padding:20px}
    .card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));padding:18px;border-radius:12px;box-shadow:0 10px 30px rgba(2,6,23,0.6)}
    .header{display:flex;justify-content:space-between;align-items:center}
    .logo{width:56px;height:56px;border-radius:12px;background:linear-gradient(90deg,var(--accent1),var(--accent2));display:flex;align-items:center;justify-content:center;font-weight:800;color:white}
    .btn{padding:10px 14px;border-radius:10px;border:none;cursor:pointer;background:linear-gradient(90deg,var(--accent1),var(--accent2));color:white;font-weight:800}
    .btn.warn{background:linear-gradient(90deg,#f97316,#f43f5e)}
    .logs{height:320px;overflow:auto;background:rgba(255,255,255,0.02);padding:12px;border-radius:8px;font-family:monospace;color:#bfe0ff}
    .stat{display:flex;gap:8px;align-items:center;margin-top:8px}
    input[type=password]{padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit;width:100%}
    form{display:flex;gap:8px}
  `);
});

// login page
app.get('/login', (req, res) => {
  // simple HTML served inline
  res.type('html').send(`
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login - Cyberland</title><link rel="stylesheet" href="/style.css"></head>
      <body>
        <div class="center">
          <div class="card" style="max-width:420px;margin:0 auto;text-align:center">
            <div class="logo" style="margin:0 auto 12px">CB</div>
            <h2 style="margin:0 0 6px">Cyberland Bot Dashboard</h2>
            <p style="color:#9fb0d5;margin:0 0 12px">Enter admin password to continue</p>
            <form id="loginForm" method="POST" action="/login">
              <input name="password" type="password" placeholder="Admin password" required />
              <button class="btn" style="width:100%;margin-top:10px">Sign in</button>
            </form>
          </div>
        </div>
      </body>
    </html>
  `);
});

// login handler
app.post('/login', (req, res) => {
  const pass = req.body.password;
  if (pass === ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    return res.redirect('/');
  }
  return res.status(401).send('<h3>Invalid password — <a href="/login">try again</a></h3>');
});

// protect middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.isAuthenticated) return next();
  return res.redirect('/login');
}

// dashboard page (single-file)
app.get('/', requireAuth, (req, res) => {
  res.type('html').send(`
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Cyberland Dashboard</title>
      <link rel="stylesheet" href="/style.css">
    </head>
    <body>
      <div class="center">
        <div class="header">
          <div style="display:flex;gap:12px;align-items:center">
            <div class="logo">CB</div>
            <div>
              <div style="font-weight:800">Cyberland Bot</div>
              <div style="font-size:13px;color:#9fb0d5">Admin Dashboard</div>
            </div>
          </div>
          <div>
            <button id="btnAuto" class="btn">Toggle Auto Update</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 360px;gap:18px;margin-top:14px">
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <h3 style="margin:0">Update Controls</h3>
                <div style="color:#9fb0d5">Start / finish updates manually</div>
              </div>
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
            <div class="stat"><strong>MC:</strong> <span id="mcStatus">—</span></div>
            <div class="stat"><strong>Players:</strong> <span id="mcPlayers">—</span></div>
            <div class="stat"><strong>Ping:</strong> <span id="mcPing">—</span></div>
            <div class="stat"><strong>Bot Uptime:</strong> <span id="botUptime">—</span></div>
            <div class="stat"><strong>Update Active:</strong> <span id="updateActive">No</span></div>
            <div class="stat"><strong>Auto Update:</strong> <span id="autoActive">Yes</span></div>
          </div>
        </div>
      </div>

      <script src="/socket.io/socket.io.js"></script>
      <script>
        const socket = io();
        const logsEl = document.getElementById('logs');
        function appendLog(msg){ const d=document.createElement('div'); d.textContent='['+new Date().toLocaleTimeString()+'] '+msg; logsEl.prepend(d); }
        socket.on('connect', ()=> appendLog('Connected to server'));
        socket.on('update-log', (m) => appendLog(m));
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
          if (!j.ok) appendLog('Start failed: ' + (j.error || 'unknown'));
        };
        document.getElementById('finishBtn').onclick = async () => {
          appendLog('Requesting Finish Update...');
          const r = await fetch('/api/finish', { method: 'POST' });
          const j = await r.json();
          if (!j.ok) appendLog('Finish failed: ' + (j.error || 'unknown'));
        };
        document.getElementById('btnAuto').onclick = async () => {
          const r = await fetch('/api/toggle-auto', { method: 'POST' });
          const j = await r.json();
          appendLog('Auto update: ' + (j.enabled ? 'Enabled' : 'Disabled'));
        };

        // request status immediately and every 7s
        socket.emit('request-status');
        setInterval(()=> socket.emit('request-status'), 7000);
      </script>
    </body>
  </html>
  `);
});

// ---------- API endpoints protected by session ----------
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

// socket handlers
io.on('connection', (socket) => {
  emitLog('Dashboard socket connected:', socket.id);

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

  // send initial logs
  socket.emit('update-log', 'Welcome to Cyberland dashboard.');
});

// start server and login bot
server.listen(PORT, () => {
  emitLog(`🌐 Dashboard running: http://localhost:${PORT} (or your host URL)`);
});

// login to Discord safely
(async () => {
  try {
    // attempt login
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    // avoid printing token; show friendly message and exit
    emitLog('Discord login failed — invalid token or banned. Check DISCORD_TOKEN in environment.');
    // do not attempt to send embed as bot isn't logged in
    process.exit(1);
  }
})();
