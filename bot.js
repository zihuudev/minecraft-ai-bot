// =================== Cyberland Ultra-Premium Bot (single file) ===================
// - Ultra-premium animated dashboard + 3-user login
// - AI chat (OpenAI) restricted to a single channel (CHANNEL_ID)
// - Robust manual update: purge -> lock -> send premium embed -> finish -> unlock
// - Auto update daily 3:00PM -> 3:05PM Asia/Dhaka
// - No slash commands (as requested)
// - Written to be resilient to common runtime issues
// ==================================================================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const axios = require('axios');
const https = require('https');
const cron = require('node-cron');
const moment = require('moment-timezone');
const mcu = require('minecraft-server-util');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

////////////////////////////////////////////////////////////////////////////////
// --------------------------- Configuration ---------------------------------
////////////////////////////////////////////////////////////////////////////////
const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Dhaka';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CHANNEL_ID = process.env.CHANNEL_ID || ''; // REQUIRED: where AI replies & updates go

// Minecraft Bedrock server (default provided by you)
const MINECRAFT_IP = 'play.cyberland.pro';
const MINECRAFT_PORT = 19132;

////////////////////////////////////////////////////////////////////////////////
// ----------------------------- Discord Client ------------------------------
////////////////////////////////////////////////////////////////////////////////
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [ Partials.Channel, Partials.Message, Partials.GuildMember ],
});

// runtime state
let aiEnabled = true;
let autoUpdate = true;
let autoroleId = null;
let updateTimer = null;
let updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };

const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408,409,429,500,502,503,504]);

// short-term contexts per user for better AI replies
const userContexts = new Map();
const MAX_TURNS = 6;

////////////////////////////////////////////////////////////////////////////////
// ------------------------------- Helpers -----------------------------------
////////////////////////////////////////////////////////////////////////////////
function nowTs(){ return Date.now(); }
function fmtTS(ts){ return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A'); }

// Robust purge: tries bulkDelete, falls back to individual deletes
async function purgeChannel(channel){
  try {
    if (!channel || !channel.isTextBased?.()) return;
    // loop until no messages left
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched || fetched.size === 0) break;
      // Bulk-delete; some messages older than 14 days won't be deleted via bulkDelete,
      // so fallback to single deletes on failure.
      try {
        await channel.bulkDelete(fetched, true);
      } catch (bulkError) {
        for (const [, msg] of fetched) {
          try { await msg.delete(); } catch (e) { /* ignore */ }
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error('purgeChannel error:', e?.message || e);
  }
}

async function lockChannel(channel, lock){
  try {
    if (!channel || !channel.guild) return;
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: lock ? false : true });
  } catch (e) {
    console.error('lockChannel error:', e?.message || e);
  }
}

////////////////////////////////////////////////////////////////////////////////
// ----------------------------- OpenAI / AI ---------------------------------
////////////////////////////////////////////////////////////////////////////////
async function chatOpenAI(messages, attempt = 1){
  if (!OPENAI_API_KEY) return '❌ OpenAI API key not configured.';
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, messages, temperature: 0.65, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 70000, httpsAgent, validateStatus: ()=>true }
    );
    if (res.status >= 200 && res.status < 300) {
      return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    }
    if (res.status === 401) return '❌ Invalid OpenAI API Key.';
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 700 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return '⚠️ AI temporarily unavailable. Try again later.';
  } catch (e) {
    if (['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 700 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    console.error('chatOpenAI error:', e?.message || e);
    return '⚠️ AI temporarily unavailable. Try again later.';
  }
}

function buildContext(userId, username, userMsg){
  const sys = {
    role: 'system',
    content: 'You are a friendly, helpful assistant for the Cyberland Minecraft community. Give concise, practical answers and Minecraft tips when relevant.',
  };
  const out = [sys];
  const history = userContexts.get(userId) || [];
  for (const turn of history.slice(-MAX_TURNS)) {
    out.push({ role: 'user', content: `${username}: ${turn.q}` });
    out.push({ role: 'assistant', content: turn.a });
  }
  out.push({ role: 'user', content: `${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a){
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}

// Type-simulated chunked replies (faster feel, avoids single huge messages)
async function typeAndReply(message, fullText){
  if (!fullText) { await message.reply('...'); return; }
  const words = fullText.split(/\s+/);
  const chunks = [];
  let buf = '';
  for (const w of words) {
    const cand = (buf ? buf + ' ' : '') + w;
    if (cand.length > 180) { chunks.push(buf); buf = w; } else buf = cand;
  }
  if (buf) chunks.push(buf);
  let first = true;
  for (const c of chunks) {
    try {
      await message.channel.sendTyping();
      if (first) { await message.reply(c); first = false; }
      else { await message.channel.send(c); }
      await new Promise(r => setTimeout(r, Math.min(900, Math.max(150, c.length * 6))));
    } catch (e) {
      console.error('typeAndReply send error:', e?.message || e);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// ---------------------------- Premium Embeds -------------------------------
////////////////////////////////////////////////////////////////////////////////
function ultraEmbed(color, title, description){
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'Developed by Zihuu • Cyberland' })
    .setTimestamp();
}
function updatingEmbed({ minutes, reason, auto }){
  const e = ultraEmbed(0xF59E0B, auto ? '⚡ Automatic Update — In Progress' : '🚀 Manual Update — In Progress',
    'Maintenance is running to keep the bot fast and stable.');
  e.addFields(
    { name: 'Status', value: 'Updating…', inline: true },
    { name: 'Channel', value: 'Locked', inline: true },
    { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
    { name: 'Mode', value: auto ? 'Automatic (daily)' : 'Manual', inline: true },
    { name: 'Developer', value: 'Zihuu', inline: true },
  );
  if (reason) e.addFields({ name: 'Reason', value: reason });
  return e;
}
function updatedEmbed({ auto, completedAt }){
  const e = ultraEmbed(0x22C55E, auto ? '✅ Automatic Update — Completed' : '✅ Manual Update — Completed',
    'All systems are up to date. You can use the bot now.');
  e.addFields(
    { name: 'Status', value: 'Ready', inline: true },
    { name: 'Channel', value: 'Unlocked', inline: true },
    { name: 'Mode', value: auto ? 'Automatic (daily)' : 'Manual', inline: true },
    { name: 'Developer', value: 'Zihuu', inline: true },
  );
  if (completedAt) e.addFields({ name: 'Completed At', value: completedAt });
  return e;
}

////////////////////////////////////////////////////////////////////////////////
// --------------------------- Update Flow -----------------------------------
////////////////////////////////////////////////////////////////////////////////
// Ensure embed remains visible: purge existing chat first, then lock, then send embed.
// When finishing: purge again (to remove any leftover messages), unlock, send finished embed.
async function startUpdateFlow({ minutes, reason, auto=false }){
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID is not set in env.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  const now = nowTs();
  updateState = { active:true, auto, reason, startedAt: now, endsAt: now + minutes * 60000, minutes };

  // purge -> lock -> send embed (embed is sent AFTER purge so it's not deleted)
  await purgeChannel(ch);
  await lockChannel(ch, true);
  await ch.send({ content: '@everyone', embeds: [ updatingEmbed({ minutes, reason, auto }) ] });

  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try { await finishUpdateFlow({ auto }); } catch (e) { console.error('auto finish err', e); }
  }, minutes * 60000);
}

async function finishUpdateFlow({ auto=false }){
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID is not set in env.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  // purge old messages, unlock, send finished embed
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ content: '@everyone', embeds: [ updatedEmbed({ auto, completedAt }) ] });

  updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
}

////////////////////////////////////////////////////////////////////////////////
// ---------------------------- Auto Update Cron -----------------------------
////////////////////////////////////////////////////////////////////////////////
// Daily BD-time 15:00 -> 15:05 (3:00PM -> 3:05PM)
cron.schedule('0 15 * * *', async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes: 5, reason: 'Scheduled daily maintenance', auto: true }); }
  catch (e) { console.error('auto-start err:', e?.message || e); }
}, { timezone: TZ });

cron.schedule('5 15 * * *', async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto: true }); }
  catch (e) { console.error('auto-finish err:', e?.message || e); }
}, { timezone: TZ });

////////////////////////////////////////////////////////////////////////////////
// --------------------------- Web Dashboard ---------------------------------
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: 'cyberland-ultra-session-final', resave: false, saveUninitialized: true }));

// fixed 3-user login (as requested)
const USERS = new Map([
  ['zihuu', 'cyberlandai90x90x90'],
  ['shahin', 'cyberlandai90x90x90'],
  ['mainuddin', 'cyberlandai90x90x90'],
]);

// ultra-premium animated login HTML
const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyberland Admin Login</title>
<style>
:root{--accent1:#7c3aed;--accent2:#06b6d4;--bg:#02061a}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 600px at 10% 10%,#073048,#020618);font-family:Inter,system-ui;color:#EAF2FF}
.card{width:94%;max-width:880px;padding:28px;border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);border:1px solid rgba(255,255,255,0.03);backdrop-filter:blur(10px);box-shadow:0 30px 80px rgba(0,0,0,.6);display:flex;gap:18px;align-items:center}
.left{flex:1}
.right{width:420px}
.logo{font-weight:800;font-size:20px}
.h{font-size:24px;margin-top:6px}
.input{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,0.03);color:#fff;margin-top:12px;outline:none}
.btn{width:100%;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;margin-top:14px;cursor:pointer;box-shadow:0 16px 36px rgba(124,58,237,.12);font-weight:700}
.small{opacity:.85;margin-top:10px}
.err{color:#ff7b7b;margin-top:8px}
@media(max-width:900px){ .card{flex-direction:column} .right{width:100%} }
</style></head><body>
<form class="card" method="POST" action="/login">
  <div class="left">
    <div class="logo">CYBERLAND</div>
    <div class="h">Admin Dashboard</div>
    <div class="small">Ultra Premium animated dashboard — enter credentials.</div>
    <div class="small">Authorized: <b>zihuu</b>, <b>shahin</b>, <b>mainuddin</b></div>
  </div>
  <div class="right">
    <div style="font-weight:700">🔐 Login</div>
    <input class="input" name="username" placeholder="Username" required />
    <input class="input" name="password" placeholder="Password" type="password" required />
    <button class="btn" type="submit">Enter Dashboard</button>
    <div class="err">{{ERR}}</div>
    <div class="small" style="margin-top:8px">Developed by Zihuu • Cyberland</div>
  </div>
</form>
</body></html>`;

// ultra-premium dashboard HTML (animated, gradient, countdown)
const dashHTML = (user) => `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyberland Ultra Dashboard</title>
<style>
:root{--accent1:#7c3aed;--accent2:#06b6d4;--glass:rgba(255,255,255,0.03);--b:rgba(255,255,255,0.04)}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui;background:radial-gradient(1000px 700px at 8% 10%,#062b4a,#02102a);color:#EAF2FF}
.container{max-width:1200px;margin:28px auto;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center}
.brand{font-weight:800}
.controls{display:flex;gap:12px;align-items:center}
.badge{padding:8px 12px;border-radius:999px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.01));border:1px solid var(--b)}
.grid{display:grid;grid-template-columns:1fr 380px;gap:18px;margin-top:18px}
.card{background:var(--glass);padding:18px;border-radius:14px;border:1px solid var(--b);backdrop-filter:blur(10px);box-shadow:0 18px 56px rgba(2,6,23,.6);transition:transform .18s}
.card:hover{transform:translateY(-6px)}
.tabs{display:flex;gap:8px;margin-top:12px}
.tab{padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.02);border:1px solid var(--b);cursor:pointer}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.18),rgba(6,182,212,.12));transform:translateY(-3px)}
.input,textarea{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;outline:none}
.btn{padding:10px 12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer}
.btn:hover{transform:translateY(-3px)}
.small{font-size:13px;opacity:.9}
.pulse{animation:pulse 1.4s infinite ease-in-out}@keyframes pulse{0%{opacity:.7}50%{opacity:1}100%{opacity:.7}}
.count{font-variant-numeric:tabular-nums}
.footer{margin-top:12px;opacity:.8}
</style></head><body>
<div class="container">
  <div class="header">
    <div>
      <div class="brand">⚡ Cyberland Ultra Dashboard</div>
      <div class="small">Welcome, <b>${user}</b></div>
    </div>
    <div class="controls">
      <div id="autoBadge" class="badge">Auto: …</div>
      <div id="aiBadge" class="badge">AI: …</div>
      <div id="updBadge" class="badge">Update: idle</div>
      <a href="/logout" style="color:#93c5fd">Logout</a>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="about">About</div>
  </div>

  <div class="grid">
    <div>
      <div id="tab-updates" class="card">
        <div style="display:flex;gap:12px">
          <div style="flex:1">
            <label class="small">Duration (minutes)</label>
            <input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5" />
          </div>
          <div style="width:360px">
            <label class="small">Reason</label>
            <textarea id="reason" class="input" rows="3" placeholder="Describe the update (optional)"></textarea>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" onclick="startUpdate()">🚀 Start Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#16a34a,#06b6d4)" onclick="finishUpdate()">✅ Finish Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#f59e0b,#f97316)" onclick="toggleAuto()">🔄 Toggle Auto</button>
          <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="toggleAI()">🤖 Toggle AI</button>
          <button class="btn" style="background:linear-gradient(135deg,#ef4444,#7c3aed)" onclick="refreshStatus()">🔁 Refresh</button>
        </div>
        <p style="margin-top:12px">Countdown: <b id="countdown" class="count pulse">—</b></p>
      </div>

      <div id="tab-server" class="card" style="margin-top:12px;display:none">
        <h3>Minecraft Bedrock Status</h3>
        <div id="mcStatus" class="small pulse">Checking…</div>
        <hr/>
        <label class="small">Autorole ID (optional)</label>
        <div style="display:flex;gap:8px">
          <input id="roleId" class="input" placeholder="Role ID" />
          <button class="btn" onclick="saveAutorole()">Save</button>
        </div>
      </div>

      <div id="tab-about" class="card" style="margin-top:12px;display:none">
        <h3>About</h3>
        <p class="small">Developed by <b>Zihuu</b>. Ultra-premium animated dashboard. AI replies only in the configured channel.</p>
      </div>
    </div>

    <div>
      <div class="card">
        <h3>Live</h3>
        <div class="small">Bot: <span id="botStatus">Loading...</span></div>
        <div class="small">Last update: <span id="lastUpdate">—</span></div>
        <div style="margin-top:12px"><button class="btn" onclick="startQuick5()">Quick 5m</button></div>
      </div>

      <div class="card" style="margin-top:12px">
        <h3>Details</h3>
        <pre id="details" class="small">loading…</pre>
      </div>
    </div>
  </div>

  <div class="footer">Dashboard time: <span id="dsTime"></span></div>
</div>

<script>
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach(t=>t.onclick=()=>{
  tabs.forEach(x=>x.classList.remove('active')); t.classList.add('active');
  document.getElementById('tab-updates').style.display='none';
  document.getElementById('tab-server').style.display='none';
  document.getElementById('tab-about').style.display='none';
  document.getElementById('tab-'+t.dataset.tab).style.display='block';
});

async function api(path, opts={}){ const r = await fetch(path, opts); return r.json().catch(()=>({})); }
async function badges(){ const s = await api('/api/state'); document.getElementById('autoBadge').innerText='Auto: '+(s.autoUpdate?'ON':'OFF'); document.getElementById('aiBadge').innerText='AI: '+(s.aiEnabled?'ON':'OFF'); document.getElementById('roleId').value = s.autoroleId||''; }
async function startUpdate(){ const minutes = Number(document.getElementById('minutes').value||0); const reason = document.getElementById('reason').value||''; if(!minutes||minutes<1) return alert('Enter minutes >= 1'); await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})}); alert('Update started'); }
async function startQuick5(){ await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:5,reason:'Quick 5m'})}); alert('Quick 5m started'); }
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); alert('Finish requested'); }
async function toggleAuto(){ const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); badges(); alert('Auto: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r = await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const v=document.getElementById('roleId').value.trim(); await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId:v})}); alert('Saved'); }
async function refreshStatus(){ badges(); pollStatus(); tick(); loadDetails(); }
async function loadDetails(){ const d = await api('/api/details'); document.getElementById('details').innerText = JSON.stringify(d,null,2).slice(0,1200); }
async function pollStatus(){ const s = await api('/api/server-status'); document.getElementById('mcStatus').innerText = s.online?('🟢 Online — Players: '+s.players+' | Ping: '+s.ping+'ms'):'🔴 Offline'; document.getElementById('botStatus').innerText = (await api('/api/bot-status')).status; }
async function tick(){ const s = await api('/api/update-state'); const cd=document.getElementById('countdown'); const ub=document.getElementById('updBadge'); if(!s.active){ cd.innerText='—'; ub.innerText='Update: idle'; document.getElementById('lastUpdate').innerText='—'; return } const left = s.endsAt - Date.now(); cd.innerText = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…'; ub.innerText = 'Update: ' + (s.auto ? 'auto' : 'manual'); document.getElementById('lastUpdate').innerText = new Date(s.startedAt).toLocaleString(); }
function dsTime(){ document.getElementById('dsTime').innerText = new Date().toLocaleString(); }

badges(); pollStatus(); loadDetails(); tick(); dsTime();
setInterval(pollStatus,10000); setInterval(tick,1000); setInterval(dsTime,1000);
</script>
</body></html>`;

// ---------- Auth & routes ----------
function requireAuth(req,res,next){
  if (req.session?.loggedIn) return next();
  res.redirect('/login');
}
app.get('/login', (req,res) => res.send(loginHTML.replace('{{ERR}}','')));
app.post('/login', (req,res) => {
  const u = (req.body.username||'').toString().trim().toLowerCase();
  const p = (req.body.password||'').toString();
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true;
    req.session.username = u;
    return res.redirect('/');
  }
  return res.send(loginHTML.replace('{{ERR}}','Invalid credentials.'));
});
app.get('/logout', (req,res) => { req.session.destroy(()=>{}); res.redirect('/login'); });
app.get('/', requireAuth, (req,res) => res.send(dashHTML(req.session.username || 'admin')));

// dashboard APIs
app.get('/api/state', requireAuth, (_req,res) => res.json({ autoUpdate, aiEnabled, autoroleId }));
app.get('/api/update-state', requireAuth, (_req,res) => res.json(updateState));
app.post('/api/toggle-auto', requireAuth, (_req,res) => { autoUpdate = !autoUpdate; res.json({ autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req,res) => { aiEnabled = !aiEnabled; res.json({ aiEnabled }); });
app.post('/api/autorole', requireAuth, (req,res) => { autoroleId = (req.body.roleId||'').toString().trim() || null; res.json({ success:true, autoroleId }); });

app.get('/api/bot-status', requireAuth, (_req,res) => {
  const status = client?.user ? `Logged in as ${client.user.tag}` : 'Disconnected';
  res.json({ status });
});
app.get('/api/details', requireAuth, (_req,res) => res.json({
  updateState, aiEnabled, autoUpdate, channelId: CHANNEL_ID || null, openaiConfigured: !!OPENAI_API_KEY, discordConnected: !!client?.user
}));
app.get('/api/server-status', requireAuth, async (_req,res) => {
  try {
    const s = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online:true, players: s.players.online, ping: s.roundTripLatency });
  } catch (e) {
    res.json({ online:false });
  }
});

////////////////////////////////////////////////////////////////////////////////
// --------------------------- AI message handler ----------------------------
////////////////////////////////////////////////////////////////////////////////
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!CHANNEL_ID) return;
    if (message.channel.id !== CHANNEL_ID) return; // strictly single channel
    if (!aiEnabled) return;

    // queue responses to ensure order & avoid overlapping calls
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

////////////////////////////////////////////////////////////////////////////////
// ----------------------------- Autorole -----------------------------------
////////////////////////////////////////////////////////////////////////////////
client.on('guildMemberAdd', async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(()=>null);
    if (role) await member.roles.add(role).catch(()=>{});
  } catch (e) {
    console.error('autorole error:', e?.message || e);
  }
});

////////////////////////////////////////////////////////////////////////////////
// ------------------------------- Start ------------------------------------
////////////////////////////////////////////////////////////////////////////////
client.on('ready', () => {
  console.log('✅ Discord client ready as', client.user?.tag || 'unknown');
  if (!CHANNEL_ID) console.warn('⚠️ WARNING: CHANNEL_ID not set — AI and update features will not work until set.');
});

// graceful login handling
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err?.message || err);
  // do not exit so dashboard remains available to view env issues
});

// start dashboard
app.listen(PORT, () => {
  console.log(`🌐 Dashboard running on port ${PORT} — open your host URL to access it`);
});

////////////////////////////////////////////////////////////////////////////////
// End of file
////////////////////////////////////////////////////////////////////////////////
