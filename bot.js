// bot.js - All-in-one fixed Cyberland premium bot + dashboard
// Single file. Requires Node 18+ recommended.

// -------------------- setup --------------------
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
const mcu = require('minecraft-server-util');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField
} = require('discord.js');

// -------------------- config --------------------
const PORT = Number(process.env.PORT || 3000);
const TZ = 'Asia/Dhaka';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'MTM5ODI5MjY0Nzk5ODY1MjUyOQ.Gt0kIl.SBpu7kSsAyjKbD7azkE4OZ2G0Bv8BBVHNB_4fE';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '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';
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

// Defaults (can be changed from dashboard)
const DEFAULT_SETTINGS = {
  channelId: process.env.CHANNEL_ID || '1404498262379200522',
  systemPrompt:
    'You are Cyberland AI — a friendly, concise Minecraft expert specialized on play.cyberland.pro. ' +
    'When asked, provide practical commands, plugin suggestions, troubleshooting steps, and short examples.',
  model: OPENAI_MODEL_DEFAULT,
  temperature: 0.2
};

// Admin users — per your request password: cyberlandai90x90x90 for all three
const USERS = new Map([
  ['zihuu', 'cyberlandai90x90x90'],
  ['shahin', 'cyberlandai90x90x90'],
  ['mainuddin', 'cyberlandai90x90x90']
]);

const SESSION_SECRET = process.env.SESSION_SECRET || 'cblaibot1x2x3x';
const MINECRAFT_IP = process.env.MC_IP || 'play.cyberland.top';
const MINECRAFT_PORT = Number(process.env.MC_PORT || 19132);

// Retryable statuses for OpenAI
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

// -------------------- persistence (settings.json) --------------------
let settings = { ...DEFAULT_SETTINGS };
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    settings = { ...settings, ...parsed };
    console.log('Loaded settings.json');
  } else {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('Created settings.json with defaults');
  }
} catch (e) {
  console.warn('Could not load or create settings.json, using defaults.', e?.message || e);
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('Saved settings.json');
  } catch (e) {
    console.error('Failed saving settings.json', e);
  }
}

// -------------------- util --------------------
function nowTs() { return Date.now(); }
function fmtTS(ts) { return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------------------- Discord client --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

client.on('ready', () => {
  console.log('Discord ready as', client.user.tag);
  // announce server state after ready
  io?.emit && io.emit('serverState', makeServerState());
});

client.on('error', (e) => console.error('Discord client error', e));

// -------------------- AI (OpenAI via REST for stability) --------------------
async function chatOpenAI(messages, attempt = 1) {
  if (!OPENAI_API_KEY) return '❌ OpenAI API key not configured.';
  const model = settings.model || OPENAI_MODEL_DEFAULT;
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model, messages, temperature: settings.temperature ?? 0.2, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 70000, validateStatus: () => true }
    );
    if (res.status >= 200 && res.status < 300) {
      return res.data?.choices?.[0]?.message?.content?.trim() || '';
    }
    if (res.status === 401) return '❌ Invalid OpenAI API key (401).';
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await delay(600 * attempt);
      return chatOpenAI(messages, attempt + 1);
    }
    console.error('OpenAI responded', res.status, res.data);
    return '⚠️ AI temporarily unavailable. Try again later.';
  } catch (err) {
    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.code) && attempt < 3) {
      await delay(600 * attempt);
      return chatOpenAI(messages, attempt + 1);
    }
    console.error('chatOpenAI err', err?.message || err);
    return '⚠️ AI temporarily unavailable. Try again later.';
  }
}

// conversation memory
const userContexts = new Map();
const MAX_TURNS = 10;
function buildContext(userId, username, userMsg) {
  const sys = { role: 'system', content: settings.systemPrompt };
  const out = [sys];
  const hist = userContexts.get(userId) || [];
  for (const t of hist.slice(-MAX_TURNS)) {
    out.push({ role: 'user', content: `${username}: ${t.q}` });
    out.push({ role: 'assistant', content: t.a });
  }
  out.push({ role: 'user', content: `${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a) {
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}

// chunk reply and send with typing simulation
async function typeAndReply(channel, message, fullText) {
  if (!fullText) { await channel.send('...'); return; }
  const words = fullText.split(/\s+/);
  const parts = []; let buf = '';
  for (const w of words) {
    const cand = (buf ? buf + ' ' : '') + w;
    if (cand.length > 180) { parts.push(buf); buf = w; } else buf = cand;
  }
  if (buf) parts.push(buf);
  let first = true;
  for (const p of parts) {
    try {
      await channel.sendTyping();
      if (first) { await message.reply(p); first = false; }
      else { await channel.send(p); }
      // wait a bit proportional to length
      await delay(Math.min(900, Math.max(80, p.length * 6)));
    } catch (e) {
      console.error('typeAndReply send error', e?.message || e);
    }
  }
}

// -------------------- channel utilities --------------------
async function purgeChannel(channel) {
  try {
    if (!channel || !channel.isTextBased?.()) return;
    while (true) {
      const fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched || fetched.size === 0) break;
      const now = Date.now();
      const deletable = [];
      const older = [];
      for (const [, msg] of fetched) {
        if (now - msg.createdTimestamp < 13.5 * 24 * 60 * 60 * 1000) deletable.push(msg);
        else older.push(msg);
      }
      if (deletable.length) {
        try {
          await channel.bulkDelete(deletable, true);
        } catch (bulkErr) {
          // fallback delete individually
          for (const m of deletable) {
            try { await m.delete(); } catch (_) { }
          }
        }
      }
      for (const m of older) {
        try { await m.delete(); } catch (_) { }
      }
      if (fetched.size < 100) break;
    }
    console.log('purgeChannel done');
  } catch (e) {
    console.error('purgeChannel error:', e?.message || e);
  }
}

async function lockChannelById(channelId, lock) {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.guild) throw new Error('Channel not found or not a guild channel');
    const everyone = ch.guild.roles.everyone;
    await ch.permissionOverwrites.edit(everyone, { SendMessages: lock ? false : null });
    return ch;
  } catch (e) {
    console.error('lockChannelById error', e?.message || e);
    throw e;
  }
}

// -------------------- embed helpers --------------------
function ultraEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'Cyberland AI • play.cyberland.pro' }).setTimestamp();
}
function nextUpdateWindowsString() {
  const now = moment().tz(TZ);
  const base = now.clone().startOf('day');
  const w1s = base.clone().add(11, 'hours').add(20, 'minutes');
  const w1e = base.clone().add(11, 'hours').add(25, 'minutes');
  const w2s = base.clone().add(15, 'hours').add(0, 'minutes');
  const w2e = base.clone().add(15, 'hours').add(5, 'minutes');
  if (now.isBefore(w1s)) return `${w1s.format('h:mm A')} - ${w1e.format('h:mm A')} & ${w2s.format('h:mm A')} - ${w2e.format('h:mm A')} (BDT)`;
  if (now.isBefore(w2s)) return `${w2s.format('h:mm A')} - ${w2e.format('h:mm A')} (today)`;
  const tm = base.clone().add(1, 'day');
  return `${tm.clone().add(11, 'hours').add(20, 'minutes').format('MMM D h:mm A')}`;
}
function createUpdatingEmbed({ minutes, reason, auto, progress = 0 }) {
  const title = auto ? '⚡ Automatic Update — In Progress' : '🚀 Manual Update — In Progress';
  const e = ultraEmbed(0xF59E0B, title, `Maintenance running — optimizing systems.\n\nProgress: **${Math.floor(progress)}%**`);
  e.addFields(
    { name: '🎉 Status', value: 'Updating…', inline: true },
    { name: '🔓 Chat', value: 'Locked', inline: true },
    { name: '⚡ Server Performance', value: 'Boosting', inline: true },
    { name: '⏰ Next update', value: nextUpdateWindowsString(), inline: false },
    { name: '🤖 Update system', value: auto ? 'Automatic' : 'Manual', inline: true },
    { name: '⚙️ Frequency', value: '11:20-11:25 & 15:00-15:05 (BDT)', inline: true }
  );
  if (reason) e.addFields({ name: '📝 Reason', value: reason, inline: false });
  return e;
}
function createUpdatedEmbed({ auto, completedAt }) {
  const e = ultraEmbed(0x22C55E, '✅ You can now use the bot!', 'Update finished — everything is ready and optimized.');
  e.addFields(
    { name: '🎉 Status', value: 'Completed', inline: true },
    { name: '🔓 Chat', value: 'Unlocked', inline: true },
    { name: '⚡ Server Performance', value: 'Optimized', inline: true },
    { name: '⏰ Next update', value: nextUpdateWindowsString(), inline: false },
    { name: '🤖 Update system', value: auto ? 'Automatic' : 'Manual', inline: true },
    { name: '⚙️ Frequency', value: '11:20-11:25 & 15:00-15:05 (BDT)', inline: true }
  );
  if (completedAt) e.addFields({ name: '✅ Completed At', value: completedAt, inline: false });
  return e;
}

// -------------------- update flow --------------------
let updateState = { active: false, auto: false, reason: '', startedAt: 0, endsAt: 0, minutes: 0, messageId: null };
let progressInterval = null;
let finishTimer = null;

async function startUpdateFlow({ minutes = 5, reason = '', auto = false, progressIntervalMs = 2000 }) {
  const channelId = settings.channelId;
  if (!channelId) throw new Error('CHANNEL_ID not set in settings.');
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel. Check channel id and bot permissions.');

  const now = nowTs();
  updateState = { active: true, auto, reason, startedAt: now, endsAt: now + minutes * 60000, minutes, messageId: null };

  // purge -> lock -> send initial embed and start progress editing
  await purgeChannel(ch);
  await lockChannelById(channelId, true);

  const initialMsg = await ch.send({ content: '', embeds: [createUpdatingEmbed({ minutes, reason, auto, progress: 0 })] });
  updateState.messageId = initialMsg.id;

  const totalMs = minutes * 60000;
  const startTs = Date.now();

  if (progressInterval) clearInterval(progressInterval);
  if (finishTimer) clearTimeout(finishTimer);

  progressInterval = setInterval(async () => {
    try {
      const elapsed = Date.now() - startTs;
      const progress = Math.min(100, (elapsed / totalMs) * 100);
      const e = createUpdatingEmbed({ minutes, reason, auto, progress });
      await initialMsg.edit({ content: '', embeds: [e] }).catch(() => {});
      io.emit('updateState', updateState);
    } catch (err) {
      console.error('progress edit err', err?.message || err);
    }
  }, progressIntervalMs);

  finishTimer = setTimeout(async () => {
    clearInterval(progressInterval);
    try {
      await finishUpdateFlow({ auto });
    } catch (e) {
      console.error('auto finish err', e?.message || e);
    }
  }, totalMs);

  io.emit('updateState', updateState);
}

async function finishUpdateFlow({ auto = false }) {
  const channelId = settings.channelId;
  if (!channelId) throw new Error('CHANNEL_ID not set in settings.');
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel.');

  // purge -> unlock -> send finished embed
  await purgeChannel(ch);
  await lockChannelById(channelId, false);

  const completedAt = fmtTS(Date.now());
  await ch.send({ content: '', embeds: [createUpdatedEmbed({ auto, completedAt })] }).catch(() => {});

  updateState = { active: false, auto: false, reason: '', startedAt: 0, endsAt: 0, minutes: 0, messageId: null };
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  io.emit('updateState', updateState);
}

// -------------------- auto update cron windows (BDT) --------------------
cron.schedule('20 11 * * *', async () => { if (!autoUpdate) return; try { await startUpdateFlow({ minutes: 5, reason: 'Auto window 11:20-11:25', auto: true }); } catch (e) { console.error('auto start1 err', e?.message || e); } }, { timezone: TZ });
cron.schedule('25 11 * * *', async () => { if (!autoUpdate) return; try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto finish1 err', e?.message || e); } }, { timezone: TZ });
cron.schedule('0 15 * * *', async () => { if (!autoUpdate) return; try { await startUpdateFlow({ minutes: 5, reason: 'Auto window 15:00-15:05', auto: true }); } catch (e) { console.error('auto start2 err', e?.message || e); } }, { timezone: TZ });
cron.schedule('5 15 * * *', async () => { if (!autoUpdate) return; try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto finish2 err', e?.message || e); } }, { timezone: TZ });

// -------------------- runtime flags --------------------
let aiEnabled = true;
let autoUpdate = true;
let autoroleId = null;
let prefix = '!';

// -------------------- express + socket.io dashboard --------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 24 * 60 * 60 * 1000 } }));

// minimal login page (animated + loader) and dashboard
const loginHTML = (err = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberland Admin Login</title>
<style>
:root{--a1:#7c3aed;--a2:#06b6d4}html,body{height:100%;margin:0;font-family:Inter,system-ui;background:linear-gradient(180deg,#020617,#071026);color:#EAF2FF} .center{display:grid;place-items:center;height:100vh} .card{width:96%;max-width:920px;padding:26px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);border:1px solid rgba(255,255,255,0.03)} input{width:100%;padding:12px;border-radius:10px;border:none;background:rgba(255,255,255,0.03);color:inherit;margin-top:10px} button{padding:12px;border-radius:10px;border:none;background:linear-gradient(90deg,var(--a1),var(--a2));color:#fff;margin-top:12px;cursor:pointer} .err{color:#ff8b8b;margin-top:10px}
.loader{display:flex;gap:8px;justify-content:center;margin-bottom:12px} .dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(90deg,var(--a1),var(--a2));animation:jump 1s infinite} @keyframes jump{0%{transform:translateY(0)}50%{transform:translateY(-8px)}100%{transform:translateY(0)}}
</style></head><body><div class="center"><div class="card"><div class="loader"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div><h2>Cyberland Admin Login</h2><form method="POST" action="/login"><input name="username" placeholder="Username" required /><input type="password" name="password" placeholder="Password" required /><button>Enter Dashboard</button></form><div class="err">${err}</div><p style="margin-top:14px;color:#9fb7d0">Users: zihuu, shahin, mainuddin • Password: cyberlandai90x90x90</p></div></div></body></html>`;

// dashboard HTML (simplified but full-featured)
function dashHTML(user) {
  const channelId = settings.channelId || '(not set)';
  const promptEsc = settings.systemPrompt.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberland Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--a1:#7c3aed;--a2:#06b6d4;--muted:rgba(255,255,255,0.04)}body{margin:0;font-family:Inter,system-ui;background:linear-gradient(180deg,#020617,#071026);color:#EAF2FF} header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,0.02)} .brand{font-weight:800} .container{max-width:1200px;margin:22px auto;padding:20px} .card{background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);padding:16px;border-radius:12px;border:1px solid var(--muted);margin-bottom:12px} button{padding:10px 12px;border-radius:8px;border:none;background:linear-gradient(90deg,var(--a1),var(--a2));color:white;cursor:pointer} input,textarea{width:100%;padding:10px;border-radius:8px;border:none;background:rgba(255,255,255,0.02);color:inherit;margin-top:8px} .small{color:#9fb7d0;font-size:13px} .row{display:flex;gap:12px} .col{flex:1}.right{width:360px}
</style></head><body>
<header><div class="brand">⚡ Cyberland AI Dashboard</div><div>Welcome, <b>${user}</b> • <a href="/logout" style="color:#93c5fd">Logout</a></div></header>
<div class="container">
  <div class="row">
    <div class="col">
      <div class="card">
        <h3>Update Controls</h3>
        <div class="small">Channel: <code id="channelId">${channelId}</code></div>
        <div style="margin-top:8px">
          <label class="small">Minutes</label>
          <input id="minutes" type="number" min="1" value="5" />
          <label class="small">Reason (optional)</label>
          <textarea id="reason" rows="2">${''}</textarea>
          <div style="margin-top:8px">
            <button onclick="startUpdate()">🚀 Start Update</button>
            <button onclick="finishUpdate()" style="background:linear-gradient(90deg,#10b981,#06b6d4)">✅ Finish</button>
            <button onclick="toggleAuto()" style="background:linear-gradient(90deg,#f59e0b,#f97316)">🔄 Toggle Auto</button>
          </div>
          <div style="margin-top:10px">Status: <span id="updateStatus">idle</span></div>
        </div>
      </div>

      <div class="card">
        <h3>AI System Prompt</h3>
        <textarea id="sysPrompt" rows="5">${promptEsc}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button onclick="savePrompt()">Save Prompt</button>
          <button onclick="setModel()">Set Model</button>
        </div>
        <div class="small" style="margin-top:8px">Current model: <span id="curModel">${settings.model}</span></div>
      </div>

      <div class="card">
        <h3>Send Message / Premium Embed</h3>
        <input id="targetChannel" placeholder="Channel ID (leave empty = default)" />
        <select id="kind" style="margin-top:8px;padding:10px;border-radius:8px">
          <option value="message">Normal Message</option>
          <option value="embed">Premium Embed</option>
        </select>
        <textarea id="messageContent" rows="4" placeholder="Message or embed description"></textarea>
        <input id="embedTitle" placeholder="Embed title (for embed)"/>
        <input id="embedGif" placeholder="Optional image/GIF URL"/>
        <div style="margin-top:8px"><button onclick="sendMessage()">Send</button></div>
      </div>
    </div>

    <div class="right">
      <div class="card">
        <h4>Server Status</h4>
        <div id="mcStatus" class="small">Checking...</div>
        <div style="margin-top:8px"><button onclick="checkMC()">Refresh</button></div>
      </div>

      <div class="card">
        <h4>Runtime</h4>
        <div class="small">AI enabled: <span id="aiEnabled">${aiEnabled}</span></div>
        <div class="small">Auto update: <span id="autoUpdate">${autoUpdate}</span></div>
        <div class="small">Prefix: <span id="prefix">${prefix}</span></div>
        <pre id="details" style="height:160px;overflow:auto;margin-top:8px;color:#cfeffe;background:rgba(0,0,0,0.25);padding:8px;border-radius:8px"></pre>
      </div>
    </div>
  </div>
</div>

<script>
  async function api(path, opts={}) {
    const r = await fetch(path, opts);
    try { return await r.json(); } catch(e){ return null; }
  }
  const socket = io();
  socket.on('serverState', s => { document.getElementById('details').innerText = JSON.stringify(s, null, 2); document.getElementById('channelId').innerText = s.channel || '(not set)'; });
  socket.on('updateState', u => { document.getElementById('updateStatus').innerText = u?.active ? (u.auto ? 'auto updating' : 'manual updating') : 'idle'; });

  async function startUpdate(){ const minutes = Number(document.getElementById('minutes').value||5); const reason = document.getElementById('reason').value||''; if(minutes<1) return alert('minutes >=1'); await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})}); alert('started'); }
  async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); alert('finish requested'); }
  async function toggleAuto(){ const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); alert('auto:'+r.autoUpdate); }
  async function savePrompt(){ const p=document.getElementById('sysPrompt').value; await fetch('/api/save-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p})}); alert('saved'); }
  async function setModel(){ const m = prompt('Model (e.g. gpt-4o or gpt-4o-mini):', '${settings.model}'); if(!m) return; await fetch('/api/set-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:m})}); document.getElementById('curModel').innerText = m; alert('model set'); }
  async function sendMessage(){ const channel=document.getElementById('targetChannel').value; const kind=document.getElementById('kind').value; const content=document.getElementById('messageContent').value; const title=document.getElementById('embedTitle').value; const gif=document.getElementById('embedGif').value; const r = await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel,target:channel,kind,content,title,gif})}); alert((await r.json()).success? 'sent':'error'); }
  async function checkMC(){ const s=await api('/api/server-status'); document.getElementById('mcStatus').innerText = s.online?('🟢 Online — players: '+s.players+' | ping: '+s.ping+'ms'):'🔴 Offline'; }
  async function refresh(){ const st = await api('/api/state'); document.getElementById('aiEnabled').innerText = st.aiEnabled; document.getElementById('autoUpdate').innerText = st.autoUpdate; document.getElementById('prefix').innerText = st.prefix; document.getElementById('details').innerText = JSON.stringify(st, null, 2); }
  checkMC(); refresh();
</script>
</body></html>`;
}

// -------------------- auth routes --------------------
app.get('/login', (req, res) => res.send(loginHTML('')));
app.post('/login', (req, res) => {
  const u = (req.body.username || '').toString().trim().toLowerCase();
  const p = (req.body.password || '').toString();
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true;
    req.session.username = u;
    return res.redirect('/');
  }
  return res.send(loginHTML('Invalid credentials.'));
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// Root -> dashboard (auth required)
app.get('/', (req, res) => {
  if (!req.session?.loggedIn) return res.redirect('/login');
  return res.send(dashHTML(req.session.username || 'admin'));
});

// -------------------- dashboard APIs --------------------
function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

app.get('/api/state', requireAuth, (_req, res) => {
  res.json({ autoUpdate, aiEnabled, autoroleId, prefix, channelId: settings.channelId, model: settings.model });
});
app.get('/api/update-state', requireAuth, (_req, res) => res.json(updateState));
app.post('/api/toggle-auto', requireAuth, (_req, res) => { autoUpdate = !autoUpdate; io.emit('serverState', makeServerState()); res.json({ autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req, res) => { aiEnabled = !aiEnabled; io.emit('serverState', makeServerState()); res.json({ aiEnabled }); });
app.post('/api/autorole', requireAuth, (req, res) => { autoroleId = (req.body.roleId || '').toString().trim() || null; res.json({ success: true, autoroleId }); });

app.post('/api/start-update', requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 5));
    const reason = (req.body.reason || '').toString().slice(0, 1000);
    await startUpdateFlow({ minutes, reason, auto: false });
    io.emit('updateState', updateState);
    res.json({ success: true });
  } catch (e) {
    console.error('api start-update error', e?.message || e);
    res.json({ success: false, error: String(e) });
  }
});
app.post('/api/finish-update', requireAuth, async (_req, res) => {
  try {
    await finishUpdateFlow({ auto: false });
    io.emit('updateState', updateState);
    res.json({ success: true });
  } catch (e) {
    console.error('api finish-update error', e?.message || e);
    res.json({ success: false, error: String(e) });
  }
});

app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { channel, kind, content, title, gif } = req.body;
    const targetId = (channel && channel.trim()) ? channel.trim() : settings.channelId;
    if (!targetId) return res.json({ success: false, error: 'no-channel' });
    const ch = await client.channels.fetch(targetId).catch(() => null);
    if (!ch) return res.json({ success: false, error: 'channel-not-found' });

    if (kind === 'embed') {
      const e = ultraEmbed(0x7c3aed, title || 'Announcement', content || '');
      if (gif) try { e.setImage(String(gif)); } catch (_) {}
      await ch.send({ content: '', embeds: [e] });
      return res.json({ success: true });
    } else {
      await ch.send({ content: content || '' });
      return res.json({ success: true });
    }
  } catch (e) {
    console.error('api send err', e?.message || e);
    res.json({ success: false, error: String(e) });
  }
});

app.post('/api/set-channel', requireAuth, (req, res) => {
  const c = (req.body.channelId || '').toString().trim();
  if (!c) return res.json({ success: false, error: 'channelId required' });
  settings.channelId = c;
  saveSettings();
  io.emit('serverState', makeServerState());
  res.json({ success: true, channelId: c });
});

app.post('/api/clear', requireAuth, async (req, res) => {
  try {
    if (!settings.channelId) return res.json({ success: false, error: 'No default channel' });
    const ch = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    await purgeChannel(ch);
    res.json({ success: true });
  } catch (e) { console.error('api clear err', e?.message || e); res.json({ success: false, error: String(e) }); }
});

app.post('/api/set-prefix', requireAuth, (req, res) => {
  const p = (req.body.prefix || '').toString().trim();
  if (!p) return res.json({ success: false, error: 'prefix required' });
  prefix = p;
  res.json({ success: true, prefix });
});

app.post('/api/save-prompt', requireAuth, (req, res) => {
  const p = (req.body.prompt || '').toString();
  if (!p) return res.json({ success: false, error: 'prompt required' });
  settings.systemPrompt = p;
  saveSettings();
  res.json({ success: true });
});
app.post('/api/set-model', requireAuth, (req, res) => {
  const m = (req.body.model || '').toString().trim();
  if (!m) return res.json({ success: false, error: 'model required' });
  settings.model = m;
  saveSettings();
  res.json({ success: true, model: m });
});

app.get('/api/server-status', requireAuth, async (_req, res) => {
  try {
    const s = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online: true, players: s.players.online, ping: s.roundTripLatency });
  } catch (e) { res.json({ online: false }); }
});

app.get('/api/next-windows', requireAuth, (_req, res) => res.json({ text: nextUpdateWindowsString() }));

// -------------------- socket.io --------------------
function makeServerState() {
  return {
    bot: client?.user ? `Online (${client.user.tag})` : 'Disconnected',
    ai: aiEnabled ? 'Available' : 'Disabled',
    next: nextUpdateWindowsString(),
    channel: settings.channelId || null,
    model: settings.model || null
  };
}
io.on('connection', socket => {
  socket.emit('serverState', makeServerState());
  socket.emit('updateState', updateState);
});

// -------------------- AI message handler (single channel) --------------------
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!settings.channelId) return;
    if (message.channel.id !== settings.channelId) return;
    if (!aiEnabled) return;

    // allow simple prefix command to query status
    if (message.content.startsWith(prefix)) {
      const args = message.content.slice(prefix.length).trim().split(/\s+/);
      const cmd = args.shift()?.toLowerCase();
      if (cmd === 'status') {
        await message.reply(`Bot: ${client.user.tag}\nAI: ${aiEnabled ? 'Enabled' : 'Disabled'}\nPrefix: ${prefix}`);
        return;
      }
    }

    await message.channel.sendTyping();

    aiQueue = aiQueue.then(async () => {
      const ctx = buildContext(message.author.id, message.author.username, message.content);
      const ans = await chatOpenAI(ctx);
      saveContext(message.author.id, message.content, ans);
      await typeAndReply(message, ans || "Sorry, I couldn't generate a reply right now.");
    });
    await aiQueue;
  } catch (e) {
    console.error('AI handler error:', e?.message || e);
  }
});

// -------------------- autorole --------------------
client.on('guildMemberAdd', async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(() => null);
    if (role) await member.roles.add(role).catch(() => {});
  } catch (e) { console.error('autorole error:', e?.message || e); }
});

// -------------------- start-up --------------------
if (!DISCORD_TOKEN) {
  console.error('ERROR: DISCORD_TOKEN is required in .env');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY not set. AI will return an error message until configured.');
}

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err?.message || err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`🌐 Dashboard running on http://localhost:${PORT}`);
  io.emit && io.emit('serverState', makeServerState());
});
