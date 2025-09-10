// ================= Cyberland Ultra-Premium Bot (single file) ==================
// - Ultra animated dashboard (particles, morph gradients, floating cards)
// - 3 fixed admin users (zihuu, shahin, mainuddin) with shared password
// - AI chat (OpenAI) restricted to a single channel (CHANNEL_ID)
// - Robust manual & automatic update flow (purge -> lock -> premium embed -> finish -> unlock)
// - Minecraft Bedrock live status
// - Autorole optional
// - No slash commands by request
// - Use env vars for secrets (DO NOT commit them)
// ============================================================================

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

/////////////////////////// CONFIG ///////////////////////////
const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Dhaka';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CHANNEL_ID = process.env.CHANNEL_ID || ''; // required

// Minecraft (Bedrock)
const MINECRAFT_IP = 'play.cyberland.pro';
const MINECRAFT_PORT = 19132;

/////////////////////////// DISCORD CLIENT ///////////////////////////
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

let aiEnabled = true;
let autoUpdate = true;
let autoroleId = null;
let updateTimer = null;
let updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };

const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408,409,429,500,502,503,504]);

// per-user short-term context
const userContexts = new Map();
const MAX_TURNS = 6;

/////////////////////////// HELPERS ///////////////////////////
function nowTs(){ return Date.now(); }
function fmtTS(ts){ return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A'); }

async function purgeChannel(channel){
  try {
    if (!channel || !channel.isTextBased?.()) return;
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched || fetched.size === 0) break;
      try {
        // bulk delete most messages (will skip >14d)
        await channel.bulkDelete(fetched, true);
      } catch (bulkErr) {
        // fallback to individual deletes to maximize removal
        for (const [, msg] of fetched) {
          try { await msg.delete(); } catch(_) {}
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error('purgeChannel err:', e?.message || e);
  }
}

async function lockChannel(channel, lock){
  try {
    if (!channel || !channel.guild) return;
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: lock ? false : true });
  } catch (e) {
    console.error('lockChannel err:', e?.message || e);
  }
}

/////////////////////////// OPENAI ///////////////////////////
async function chatOpenAI(messages, attempt = 1){
  if (!OPENAI_API_KEY) return '❌ OpenAI API key not configured.';
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, messages, temperature: 0.7, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 70000, httpsAgent, validateStatus: () => true }
    );
    if (res.status >= 200 && res.status < 300) {
      return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    }
    if (res.status === 401) return '❌ Invalid OpenAI API Key.';
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return '⚠️ AI temporarily unavailable. Try again later.';
  } catch (e) {
    if (['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    console.error('chatOpenAI err:', e?.message || e);
    return '⚠️ AI temporarily unavailable. Try again later.';
  }
}

function buildContext(userId, username, userMsg){
  const sys = {
    role: 'system',
    content: "You are the Cyberland community assistant. Be helpful, concise, and provide Minecraft-specific guidance when appropriate. Use friendly tone."
  };
  const out = [sys];
  const hist = userContexts.get(userId) || [];
  for (const t of hist.slice(-MAX_TURNS)) {
    out.push({ role:'user', content: `${username}: ${t.q}` });
    out.push({ role:'assistant', content: t.a });
  }
  out.push({ role:'user', content: `${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a){
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}

// chunked typing reply to feel snappy
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
      await new Promise(r => setTimeout(r, Math.min(900, Math.max(120, c.length * 5))));
    } catch (e) {
      console.error('typeAndReply send err:', e?.message || e);
    }
  }
}

/////////////////////////// EMBEDS ///////////////////////////
function ultraEmbed(color, title, description){
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setFooter({ text: 'Developed by Zihuu • Cyberland' }).setTimestamp();
}
function updatingEmbed({ minutes, reason, auto }){
  const e = ultraEmbed(0xF59E0B, auto ? '⚡ Auto Update — In Progress' : '🚀 Manual Update — In Progress',
    'Maintenance is ongoing to keep the bot stable and fast.');
  e.addFields(
    { name: 'Status', value: 'Updating…', inline: true },
    { name: 'Channel', value: 'Locked', inline: true },
    { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
    { name: 'Mode', value: auto ? 'Automatic (daily)' : 'Manual', inline: true },
    { name: 'Developer', value: 'Zihuu', inline: true }
  );
  if (reason) e.addFields({ name: 'Reason', value: reason });
  return e;
}
function updatedEmbed({ auto, completedAt }){
  const e = ultraEmbed(0x22C55E, auto ? '✅ Auto Update — Completed' : '✅ Manual Update — Completed',
    'All systems are up to date. You can use the bot now.');
  e.addFields(
    { name: 'Status', value: 'Ready', inline: true },
    { name: 'Channel', value: 'Unlocked', inline: true },
    { name: 'Mode', value: auto ? 'Automatic (daily)' : 'Manual', inline: true },
    { name: 'Developer', value: 'Zihuu', inline: true }
  );
  if (completedAt) e.addFields({ name: 'Completed At', value: completedAt });
  return e;
}

/////////////////////////// UPDATE FLOW ///////////////////////////
async function startUpdateFlow({ minutes, reason, auto=false }){
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  const now = nowTs();
  updateState = { active:true, auto, reason, startedAt: now, endsAt: now + minutes * 60000, minutes };

  // purge first to avoid removing the update embed: we purge -> lock -> send embed
  await purgeChannel(ch);
  await lockChannel(ch, true);
  await ch.send({ content: '@everyone', embeds: [ updatingEmbed({ minutes, reason, auto }) ] });

  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try { await finishUpdateFlow({ auto }); } catch (e) { console.error('auto finish err', e); }
  }, minutes * 60000);
}

async function finishUpdateFlow({ auto=false }){
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  // purge to clean up any leftover messages, then unlock, then send completed embed so it remains
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ content: '@everyone', embeds: [ updatedEmbed({ auto, completedAt }) ] });

  updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
}

/////////////////////////// AUTO UPDATE CRON ///////////////////////////
// BD timezone 15:00 -> 15:05 daily (3:00PM - 3:05PM)
cron.schedule('0 15 * * *', async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes:5, reason: 'Scheduled daily maintenance', auto: true }); } catch (e) { console.error('auto-start', e); }
}, { timezone: TZ });

cron.schedule('5 15 * * *', async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto-finish', e); }
}, { timezone: TZ });

/////////////////////////// DASHBOARD (ULTRA PREMIUM UI) ///////////////////////////
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: 'cyberland-ultra-premium-secret', resave: false, saveUninitialized: true }));

const USERS = new Map([
  ['zihuu','cyberlandai90x90x90'],
  ['shahin','cyberlandai90x90x90'],
  ['mainuddin','cyberlandai90x90x90'],
]);

// Login page with particle background & morph gradient
const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyberland • Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg1:#021124;--bg2:#04132a;--accent1:#7c3aed;--accent2:#06b6d4;
  --glass: rgba(255,255,255,0.03);--muted:rgba(255,255,255,0.08)
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;font-family:Inter,system-ui;background:radial-gradient(800px 600px at 12% 12%,#0b2a46 0%,#021124 40%,#010417 100%);color:#eaf2ff;overflow:hidden}
.canvas{position:fixed;inset:0;z-index:0}
.container{position:relative;z-index:2;display:grid;place-items:center;height:100vh}
.card{width:94%;max-width:980px;padding:28px;border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);border:1px solid var(--muted);backdrop-filter:blur(12px);box-shadow:0 30px 80px rgba(0,0,0,.6);display:flex;gap:18px}
.left{flex:1}
.right{width:420px}
.logo{font-weight:800;font-size:20px;letter-spacing:.6px}
.hero{font-size:28px;margin-top:6px}
.input{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,0.03);color:#fff;margin-top:12px;outline:none}
.btn{width:100%;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;margin-top:14px;cursor:pointer;font-weight:700;box-shadow:0 18px 44px rgba(124,58,237,.12)}
.btn:hover{transform:translateY(-3px);transition:all .12s}
.small{opacity:.85;margin-top:10px}
.err{color:#ff8989;margin-top:8px}
.footer{margin-top:10px;font-size:12px;opacity:.75}
@media(max-width:900px){ .card{flex-direction:column;padding:18px} .left{display:none} }
</style>
</head><body>
<canvas id="particles" class="canvas"></canvas>
<div class="container">
  <form class="card" method="POST" action="/login" id="loginForm">
    <div class="left">
      <div class="logo">CYBERLAND</div>
      <div class="hero">Admin Dashboard — Ultra Premium</div>
      <div class="small">Secure admin panel with animated UI. Authorized users: <b>zihuu</b>, <b>shahin</b>, <b>mainuddin</b></div>
    </div>
    <div class="right">
      <div style="font-weight:700">🔐 Login</div>
      <input class="input" name="username" placeholder="Username" required />
      <input class="input" type="password" name="password" placeholder="Password" required />
      <button class="btn" type="submit">Enter Dashboard</button>
      <div class="err">{{ERR}}</div>
      <div class="footer">Developed by Zihuu • Cyberland</div>
    </div>
  </form>
</div>

<script>
// lightweight particle effect (canvas)
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
let W = canvas.width = innerWidth, H = canvas.height = innerHeight;
window.addEventListener('resize', ()=>{ W = canvas.width = innerWidth; H = canvas.height = innerHeight; });
const particles = [];
for (let i=0;i<28;i++){
  particles.push({ x: Math.random()*W, y: Math.random()*H, r: 20+Math.random()*120, a: Math.random()*Math.PI*2, s: 0.0006 + Math.random()*0.0018 });
}
function draw(){
  ctx.clearRect(0,0,W,H);
  for (const p of particles){
    p.a += p.s;
    const gx = p.x + Math.cos(p.a)*40;
    const gy = p.y + Math.sin(p.a)*40;
    const g = ctx.createRadialGradient(gx,gy,p.r*0.05,gx,gy,p.r);
    g.addColorStop(0, 'rgba(124,58,237,0.18)');
    g.addColorStop(0.5, 'rgba(6,182,212,0.12)');
    g.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.beginPath();
    ctx.fillStyle = g;
    ctx.arc(gx,gy,p.r,0,Math.PI*2);
    ctx.fill();
  }
  requestAnimationFrame(draw);
}
draw();
</script>
</body></html>`;

// dashboard HTML: highly animated, gradient morph, progress animation
const dashHTML = (user) => `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyberland • Ultra Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{
  --accent1:#7c3aed;--accent2:#06b6d4;--glass:rgba(255,255,255,0.03);--muted:rgba(255,255,255,0.05);
  --bg1:#02102a;--bg2:#071a34;
}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui;background:linear-gradient(180deg,var(--bg1),#020617);color:#EAF2FF;min-height:100vh}
.header{display:flex;justify-content:space-between;align-items:center;padding:22px 32px;border-bottom:1px solid rgba(255,255,255,0.02)}
.brand{font-weight:800}
.controls{display:flex;gap:12px;align-items:center}
.badge{padding:8px 14px;border-radius:999px;background:linear-gradient(180deg,transparent,rgba(255,255,255,0.01));border:1px solid var(--muted)}
.container{max-width:1200px;margin:28px auto;padding:20px}
.grid{display:grid;grid-template-columns:1fr 420px;gap:18px;margin-top:18px}
.card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));border-radius:14px;padding:18px;border:1px solid var(--muted);backdrop-filter:blur(8px);box-shadow:0 20px 60px rgba(2,6,23,.6);position:relative;overflow:hidden;transition:transform .18s}
.card:hover{transform:translateY(-8px)}
.tabs{display:flex;gap:8px;margin-top:20px}
.tab{padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid var(--muted);cursor:pointer}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(6,182,212,.12));transform:translateY(-3px)}
.input,textarea{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;outline:none}
.btn{padding:10px 14px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer}
.btn:hover{transform:translateY(-3px)}
.small{font-size:13px;opacity:.9}
.pulse{animation:pulse 1.4s infinite ease-in-out}@keyframes pulse{0%{opacity:.7}50%{opacity:1}100%{opacity:.7}}
.footer{margin-top:16px;opacity:.85}

/* gradient morphing top bar */
.morph {
  height:6px; width:100%; border-radius:999px; margin-top:12px;
  background:linear-gradient(90deg,#7c3aed,#06b6d4,#22c55e,#f59e0b);
  background-size: 300% 100%;
  animation: morph 8s linear infinite;
}
@keyframes morph { 0%{background-position:0%}50%{background-position:100%}100%{background-position:0%} }

/* animated progress radial (for update progress) */
.progressWrap { display:flex;align-items:center;gap:12px }
.progressCircle { width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#7c3aed var(--p,0%), rgba(255,255,255,0.06) 0%);box-shadow:0 8px 24px rgba(124,58,237,.08) }
.progressText{font-weight:700}
@media(max-width:980px){ .grid{grid-template-columns:1fr} .controls{display:none} }
</style>
</head><body>
<div class="header">
  <div class="brand">⚡ Cyberland Ultra Dashboard</div>
  <div class="controls">
    <div id="autoBadge" class="badge">Auto: …</div>
    <div id="aiBadge" class="badge">AI: …</div>
    <div id="updBadge" class="badge">Update: idle</div>
    <a href="/logout" style="color:#93c5fd">Logout</a>
  </div>
</div>

<div class="container">
  <div class="morph"></div>
  <div class="tabs" style="margin-top:18px">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="about">About</div>
  </div>

  <div class="grid">
    <div>
      <div id="tab-updates" class="card">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="flex:1">
            <label class="small">Duration (minutes)</label>
            <input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5" />
          </div>
          <div style="width:360px">
            <label class="small">Reason</label>
            <textarea id="reason" class="input" rows="3" placeholder="Why update? (optional)"></textarea>
          </div>
        </div>

        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="startUpdate()">🚀 Start Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#16a34a,#06b6d4)" onclick="finishUpdate()">✅ Finish</button>
          <button class="btn" style="background:linear-gradient(135deg,#f59e0b,#f97316)" onclick="toggleAuto()">🔄 Auto</button>
          <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="toggleAI()">🤖 AI</button>
          <button class="btn" style="background:linear-gradient(135deg,#ef4444,#7c3aed)" onclick="refreshStatus()">🔁 Refresh</button>
        </div>

        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
          <div>Countdown: <b id="countdown" class="small pulse">—</b></div>
          <div class="small">Developer: <b>Zihuu</b></div>
        </div>
      </div>

      <div id="tab-server" class="card" style="margin-top:18px;display:none">
        <h3>Minecraft Bedrock Status</h3>
        <div id="mcStatus" class="small pulse">Checking…</div>
        <hr/>
        <label class="small">Autorole ID (optional)</label>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input id="roleId" class="input" placeholder="Role ID" />
          <button class="btn" onclick="saveAutorole()">Save</button>
        </div>
      </div>

      <div id="tab-about" class="card" style="margin-top:18px;display:none">
        <h3>About</h3>
        <p class="small">Ultra-premium animated dashboard. AI replies only in the configured channel. Developed by <b>Zihuu</b>.</p>
      </div>
    </div>

    <div>
      <div class="card">
        <h3>Live</h3>
        <div class="small">Bot: <span id="botStatus">Loading...</span></div>
        <div class="small">Last update: <span id="lastUpdate">—</span></div>
        <div style="margin-top:12px"><button class="btn" onclick="startQuick5()">Quick 5m</button></div>
      </div>

      <div class="card" style="margin-top:18px">
        <h3>Details</h3>
        <pre id="details" class="small">loading…</pre>
      </div>
    </div>
  </div>

  <div class="footer" style="margin-top:18px">Dashboard time: <span id="dsTime"></span></div>
</div>

<script>
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach(t => t.onclick = () => {
  tabs.forEach(x => x.classList.remove('active')); t.classList.add('active');
  document.getElementById('tab-updates').style.display = 'none';
  document.getElementById('tab-server').style.display = 'none';
  document.getElementById('tab-about').style.display = 'none';
  document.getElementById('tab-'+t.dataset.tab).style.display = 'block';
});

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  return r.json().catch(()=>({}));
}
async function badges(){
  const s = await api('/api/state');
  document.getElementById('autoBadge').innerText = 'Auto: ' + (s.autoUpdate ? 'ON' : 'OFF');
  document.getElementById('aiBadge').innerText = 'AI: ' + (s.aiEnabled ? 'ON' : 'OFF');
  document.getElementById('roleId').value = s.autoroleId || '';
}
async function startUpdate(){
  const minutes = Number(document.getElementById('minutes').value || 0);
  const reason = document.getElementById('reason').value || '';
  if (!minutes || minutes < 1) return alert('Enter minutes >= 1');
  await fetch('/api/start-update', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ minutes, reason }) });
  alert('Update started');
}
async function startQuick5(){ await fetch('/api/start-update', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ minutes:5, reason:'Quick 5m' }) }); alert('Quick 5m started'); }
async function finishUpdate(){ await fetch('/api/finish-update', { method:'POST' }); alert('Finish requested'); }
async function toggleAuto(){ const r = await fetch('/api/toggle-auto', { method:'POST' }).then(r=>r.json()); badges(); alert('Auto: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r = await fetch('/api/toggle-ai', { method:'POST' }).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const v=document.getElementById('roleId').value.trim(); await fetch('/api/autorole', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ roleId: v }) }); alert('Saved'); }
async function refreshStatus(){ badges(); pollStatus(); tick(); loadDetails(); }
async function loadDetails(){ const d = await api('/api/details'); document.getElementById('details').innerText = JSON.stringify(d,null,2).slice(0,1200); }
async function pollStatus(){ const s = await api('/api/server-status'); document.getElementById('mcStatus').innerText = s.online?('🟢 Online — Players: '+s.players+' | Ping: '+s.ping+'ms') : '🔴 Offline'; document.getElementById('botStatus').innerText = (await api('/api/bot-status')).status; }
async function tick(){ const s = await api('/api/update-state'); const cd = document.getElementById('countdown'); const ub = document.getElementById('updBadge'); if(!s.active){ cd.innerText='—'; ub.innerText='Update: idle'; document.getElementById('lastUpdate').innerText='—'; return } const left = s.endsAt - Date.now(); cd.innerText = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…'; ub.innerText='Update: '+(s.auto?'auto':'manual'); document.getElementById('lastUpdate').innerText = new Date(s.startedAt).toLocaleString(); }
function dsTime(){ document.getElementById('dsTime').innerText = new Date().toLocaleString(); }

badges(); pollStatus(); loadDetails(); tick(); dsTime();
setInterval(pollStatus,10000); setInterval(tick,1000); setInterval(dsTime,1000);
</script>
</body></html>`;

/////////////////////////// DASHBOARD ROUTES ///////////////////////////
function requireAuth(req,res,next){
  if (req.session?.loggedIn) return next();
  return res.redirect('/login');
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

// API endpoints
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

/////////////////////////// AI MESSAGE HANDLER ///////////////////////////
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!CHANNEL_ID) return;
    if (message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const ctx = buildContext(message.author.id, message.author.username, message.content);
      const reply = await chatOpenAI(ctx);
      saveContext(message.author.id, message.content, reply);
      await typeAndReply(message, reply || "Sorry, I couldn't generate a reply right now.");
    });
    await aiQueue;
  } catch (e) {
    console.error('AI handler err:', e?.message || e);
  }
});

/////////////////////////// AUTOROLE ///////////////////////////
client.on('guildMemberAdd', async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(()=>null);
    if (role) await member.roles.add(role).catch(()=>{});
  } catch (e) {
    console.error('autorole err:', e?.message || e);
  }
});

/////////////////////////// START & LOGIN ///////////////////////////
client.on('ready', () => {
  console.log('✅ Discord client ready as', client.user?.tag || 'unknown');
  if (!CHANNEL_ID) console.warn('⚠️ CHANNEL_ID not set — AI and update features will not work until set.');
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err?.message || err);
  // keep server up for dashboard to inspect env variables
});

app.listen(PORT, () => {
  console.log(`🌐  Dashboard running on port ${PORT}`);
});

/////////////////////////// END ///////////////////////////
