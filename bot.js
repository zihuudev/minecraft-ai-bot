// =================== Cyberland Ultra-Premium Bot (single file) ===================
// Ultra-premium animated dashboard overhaul (login + dashboard UI)
// + AI chat in single channel + manual & auto update flow
// Keep env vars secret. Paste this as bot.js.
// ==================================================================================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const https = require("https");
const cron = require("node-cron");
const moment = require("moment-timezone");
const mcu = require("minecraft-server-util");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const TZ = "Asia/Dhaka";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHANNEL_ID = process.env.CHANNEL_ID || "";

const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// ---------------- Discord client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ---------------- State ----------------
let aiEnabled = true;
let autoUpdate = true;
let autoroleId = null;
let updateTimer = null;
let updateState = { active:false, auto:false, reason:"", startedAt:0, endsAt:0, minutes:0 };

const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408,409,429,500,502,503,504]);

const userContexts = new Map();
const MAX_TURNS = 6;

// ---------------- Helpers ----------------
function nowTs(){ return Date.now(); }
function fmtTS(ts){ return moment(ts).tz(TZ).format("MMM D, YYYY h:mm A"); }

async function purgeChannel(channel){
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched || fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
      } catch {
        for (const [, msg] of fetched) {
          try { await msg.delete(); } catch(_) {}
        }
      }
    } while (fetched.size >= 2);
  } catch (e) { console.error("purgeChannel:", e?.message || e); }
}

async function lockChannel(channel, lock){
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: lock ? false : true });
  } catch (e) { console.error("lockChannel:", e?.message || e); }
}

// ---------------- Embeds ----------------
function ultraEmbed(color, title, description){
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "Developed by Zihuu • Cyberland" })
    .setTimestamp();
}
function updatingEmbed({ minutes, reason, auto }){
  const e = ultraEmbed(0xF59E0B, auto ? "⚡ Automatic Update — In Progress" : "🚀 Manual Update — In Progress",
    "We are performing scheduled maintenance to keep the bot stable and fast.");
  e.addFields(
    { name: "Status", value: "Updating…", inline: true },
    { name: "Channel", value: "Locked", inline: true },
    { name: "Duration", value: `${minutes} minute(s)`, inline: true },
    { name: "Mode", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "Developer", value: "Zihuu", inline: true },
  );
  if (reason) e.addFields({ name: "Reason", value: reason });
  return e;
}
function updatedEmbed({ auto, completedAt }){
  const e = ultraEmbed(0x22C55E, auto ? "✅ Automatic Update — Completed" : "✅ Manual Update — Completed",
    "All systems are up to date. You can chat now.");
  e.addFields(
    { name: "Status", value: "Ready", inline: true },
    { name: "Channel", value: "Unlocked", inline: true },
    { name: "Mode", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "Developer", value: "Zihuu", inline: true },
  );
  if (completedAt) e.addFields({ name: "Completed At", value: completedAt });
  return e;
}

// ---------------- OpenAI ----------------
async function chatOpenAI(messages, attempt = 1){
  if (!OPENAI_API_KEY) return "❌ OpenAI API key is not configured.";
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: OPENAI_MODEL, messages, temperature: 0.65, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 70000, httpsAgent, validateStatus: ()=>true }
    );
    if (res.status >=200 && res.status < 300) return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    if (res.status === 401) return "❌ Invalid OpenAI API Key.";
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r=>setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt+1);
    }
    return "⚠️ AI temporarily unavailable. Try again later.";
  } catch (e) {
    if (["ECONNABORTED","ETIMEDOUT","ECONNRESET"].includes(e?.code) && attempt < 3) {
      await new Promise(r=>setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt+1);
    }
    console.error("chatOpenAI error:", e?.message || e);
    return "⚠️ AI temporarily unavailable. Try again later.";
  }
}
function buildContext(userId, username, userMsg){
  const sys = { role:"system", content: "You are a friendly assistant for Cyberland. Give concise, practical Minecraft help." };
  const out = [sys];
  const hist = userContexts.get(userId) || [];
  for (const t of hist.slice(-MAX_TURNS)) {
    out.push({ role:"user", content:`${username}: ${t.q}` });
    out.push({ role:"assistant", content: t.a });
  }
  out.push({ role:"user", content: `${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a){
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}
async function typeAndReply(message, fullText){
  if (!fullText) { await message.reply("..."); return; }
  const words = fullText.split(/\s+/);
  const chunks = []; let buf = "";
  for (const w of words) {
    const cand = (buf ? buf+" " : "") + w;
    if (cand.length > 180) { chunks.push(buf); buf = w; } else buf = cand;
  }
  if (buf) chunks.push(buf);
  let first = true;
  for (const c of chunks) {
    try {
      await message.channel.sendTyping();
      if (first) { await message.reply(c); first = false; } else { await message.channel.send(c); }
      await new Promise(r=>setTimeout(r, Math.min(900, Math.max(150, c.length * 6))));
    } catch (e) { console.error("typeAndReply error:", e?.message || e); }
  }
}

// ---------------- WEB (ULTRA PREMIUM UI) ----------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: "cyberland-ultra-session-2", resave: false, saveUninitialized: true }));

const USERS = new Map([
  ["zihuu", "cyberlandai90x90x90"],
  ["shahin", "cyberlandai90x90x90"],
  ["mainuddin", "cyberlandai90x90x90"],
]);

// --- Login page: now ultra animated (particles + glass + 3D tilt) ---
const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland • Admin Login</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg1:#010417;--bg2:#021224;--glass:rgba(255,255,255,0.03);--accent1:#7c3aed;--accent2:#06b6d4}
*{box-sizing:border-box}
html,body{height:100%;margin:0;font-family:Inter,system-ui;background:
radial-gradient(900px 700px at 10% 10%,#071836 0%,#020617 45%,#010417 100%);color:#EAF2FF;overflow:hidden}
.scene{position:fixed;inset:0;pointer-events:none}
.blob{position:absolute;width:520px;height:520px;border-radius:50%;filter:blur(88px);opacity:.6;mix-blend-mode:screen}
.blob.a{left:-200px;top:-220px;background:conic-gradient(from 120deg,rgba(124,58,237,.5),rgba(6,182,212,.35))}
.blob.b{right:-180px;bottom:-200px;background:linear-gradient(135deg,rgba(6,182,212,.36),rgba(124,58,237,.28))}
.center{position:relative;min-height:100vh;display:grid;place-items:center}
.card{width:92%;max-width:860px;background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));border-radius:18px;padding:28px;border:1px solid rgba(255,255,255,0.04);backdrop-filter:blur(12px);box-shadow:0 30px 80px rgba(0,0,0,.7);display:flex;gap:18px;align-items:center;transform-style:preserve-3d;transition:transform .18s cubic-bezier(.2,.9,.2,1)}
.left{flex:1;padding:10px}
.logo{font-weight:800;font-size:20px;letter-spacing:.6px}
.h{font-size:28px;margin:6px 0}
.sub{opacity:.85;margin-bottom:12px}
.panel{flex:1;max-width:420px;padding:20px;border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);border:1px solid rgba(255,255,255,0.03)}
.input{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;margin-top:12px;outline:none}
.btn{width:100%;margin-top:14px;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer;font-weight:600;box-shadow:0 16px 36px rgba(124,58,237,0.14);transition:transform .12s}
.btn:hover{transform:translateY(-4px)}
.small{opacity:.8;margin-top:10px;font-size:13px}
.footer{margin-top:10px;font-size:12px;color:rgba(255,255,255,.6)}
.err{color:#ff7b7b;margin-top:10px}
.floating{transform:translateZ(40px) translateY(-6px)}
.card:hover{transform:translateY(-8px) rotateX(3deg)}
@media(max-width:880px){ .card{flex-direction:column;padding:18px} .left{display:none} }
</style>
</head><body>
<div class="scene"><div class="blob a"></div><div class="blob b"></div></div>
<div class="center">
  <div class="card" id="card">
    <div class="left">
      <div class="logo">CYBERLAND</div>
      <div class="h">Admin Access</div>
      <div class="sub">Ultra premium dashboard — enter your credentials.</div>
      <div class="small">Authorized users: <b>zihuu</b>, <b>shahin</b>, <b>mainuddin</b></div>
    </div>
    <form class="panel floating" method="POST" action="/login" style="transform-style:preserve-3d">
      <div style="font-weight:700">🔐 Dashboard Login</div>
      <input class="input" name="username" placeholder="Username" autocomplete="username" required />
      <input class="input" type="password" name="password" placeholder="Password" autocomplete="current-password" required />
      <button class="btn" type="submit">Enter Dashboard</button>
      <div class="err">{{ERR}}</div>
      <div class="footer">Developed by Zihuu • Cyberland</div>
    </form>
  </div>
</div>

<script>
// subtle 3D tilt effect
const card = document.getElementById('card');
document.addEventListener('mousemove', (e)=>{
  const w = window.innerWidth, h = window.innerHeight;
  const rx = (e.clientY - h/2) / (h/2);
  const ry = (e.clientX - w/2) / (w/2);
  card.style.transform = `perspective(1000px) rotateX(${rx * 4}deg) rotateY(${ry * -6}deg)`;
});
document.addEventListener('mouseleave', ()=>{ card.style.transform='none'; });
</script>
</body></html>`;

// --- Dashboard: upgraded ultra-premium animated UI ---
const dashHTML = (user) => `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland • Ultra Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg1:#02061a;--bg2:#071836;--glass:rgba(255,255,255,.03);--b:rgba(255,255,255,.04);
  --accent1:#7c3aed;--accent2:#06b6d4;--green:#22c55e;--amber:#f59e0b;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:Inter,system-ui;background:
radial-gradient(1000px 600px at 8% 10%,#062b4a 0%,#02102a 35%,#010417 100%);color:#EAF2FF;overflow-x:hidden}
.container{max-width:1200px;margin:28px auto;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;gap:14px}
.brand{font-weight:800}
.controls{display:flex;gap:12px;align-items:center}
.badge{padding:8px 14px;border-radius:999px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.01));border:1px solid var(--b);display:inline-flex;gap:10px;align-items:center}
.grid{display:grid;grid-template-columns:1fr 400px;gap:18px;margin-top:18px}
.card{background:var(--glass);padding:18px;border-radius:14px;border:1px solid var(--b);backdrop-filter:blur(12px);box-shadow:0 18px 56px rgba(2,6,23,.6);position:relative;overflow:hidden;transition:transform .18s}
.card:hover{transform:translateY(-8px)}
.tabs{display:flex;gap:8px;margin-top:12px}
.tab{padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.02);border:1px solid var(--b);cursor:pointer;transition:all .12s}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.18),rgba(6,182,212,.12));transform:translateY(-3px)}
.input,textarea{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;outline:none}
.btn{padding:10px 14px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer;box-shadow:0 14px 36px rgba(124,58,237,.12);transition:transform .12s}
.btn:hover{transform:translateY(-3px)}
.small{font-size:13px;opacity:.9}
.pulse{animation:pulse 1.4s infinite ease-in-out}@keyframes pulse{0%{opacity:.7}50%{opacity:1}100%{opacity:.7}}
.footer{margin-top:12px;opacity:.8;font-size:13px}

/* animated glowing border */
.card::after { content:""; position:absolute; inset:-2px; background:linear-gradient(90deg, rgba(124,58,237,.14), rgba(6,182,212,.14)); filter:blur(20px); opacity:0; transition:opacity .5s; z-index:-1; }
.card:hover::after{opacity:1}

/* floating decorative shapes */
.shape{position:absolute;border-radius:12px;mix-blend-mode:screen;filter:blur(36px);opacity:.45}
.shape.a{width:220px;height:220px;left:-40px;top:-80px;background:radial-gradient(circle at 30% 30%, rgba(124,58,237,.28), transparent 40%)}
.shape.b{width:160px;height:160px;right:-60px;bottom:-80px;background:radial-gradient(circle at 70% 70%, rgba(6,182,212,.22), transparent 40%)}

/* fancy countdown */
.countdown{font-size:18px;font-weight:700;background:linear-gradient(90deg,#0b1230,rgba(255,255,255,.02));padding:8px 12px;border-radius:10px;display:inline-block}

/* responsive */
@media(max-width:980px){ .grid{grid-template-columns:1fr} .controls{display:none} .card{margin-bottom:12px} }
</style>
</head><body>
<div class="container">
  <div class="header">
    <div>
      <div class="brand">⚡ Cyberland Ultra Dashboard</div>
      <div class="small">Welcome, <b>${user}</b> — Animated premium controls</div>
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
    <div style="position:relative">
      <div class="shape a"></div>
      <div class="shape b"></div>

      <div id="tab-updates" class="card">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="flex:1">
            <label class="small">Duration (minutes)</label>
            <input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5" />
          </div>
          <div style="width:360px">
            <label class="small">Reason</label>
            <textarea id="reason" class="input" rows="3" placeholder="Describe the update (optional)"></textarea>
          </div>
        </div>

        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="startUpdate()">🚀 Start Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#16a34a,#06b6d4)" onclick="finishUpdate()">✅ Finish Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#f59e0b,#f97316)" onclick="toggleAuto()">🔄 Toggle Auto</button>
          <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="toggleAI()">🤖 Toggle AI</button>
          <button class="btn" style="background:linear-gradient(135deg,#ef4444,#7c3aed)" onclick="refreshStatus()">🔁 Refresh</button>
        </div>

        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
          <div>Countdown: <span id="countdown" class="countdown pulse">—</span></div>
          <div class="small">Developer: <b>Zihuu</b></div>
        </div>
      </div>

      <div id="tab-server" class="card" style="margin-top:18px;display:none">
        <h3>Minecraft Bedrock Live Status</h3>
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

  <div class="footer">Dashboard time: <span id="dsTime"></span></div>
</div>

<script>
// tabs
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach(t=>t.onclick=()=>{
  tabs.forEach(x=>x.classList.remove('active')); t.classList.add('active');
  document.getElementById('tab-updates').style.display='none';
  document.getElementById('tab-server').style.display='none';
  document.getElementById('tab-about').style.display='none';
  document.getElementById('tab-'+t.dataset.tab).style.display='block';
});

async function api(path, opts={}) {
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
  const minutes = Number(document.getElementById('minutes').value||0);
  const reason = document.getElementById('reason').value||'';
  if (!minutes || minutes < 1) return alert('Enter minutes >= 1');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});
  alert('Update started');
}
async function startQuick5(){ await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:5,reason:'Quick 5m'})}); alert('Quick 5m started'); }
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); alert('Finish requested'); }
async function toggleAuto(){ const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); badges(); alert('Auto: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r = await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const v=document.getElementById('roleId').value.trim(); await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId:v})}); alert('Saved'); }
async function refreshStatus(){ badges(); pollStatus(); tick(); loadDetails(); }
async function loadDetails(){ const d=await api('/api/details'); document.getElementById('details').innerText = JSON.stringify(d,null,2).slice(0,1200); }
async function pollStatus(){ const s = await api('/api/server-status'); document.getElementById('mcStatus').innerText = s.online ? ('🟢 Online — Players: '+s.players+' | Ping: '+s.ping+'ms') : '🔴 Offline'; document.getElementById('botStatus').innerText = (await api('/api/bot-status')).status; }
async function tick(){ const s = await api('/api/update-state'); const cd=document.getElementById('countdown'); const ub=document.getElementById('updBadge'); if(!s.active){ cd.innerText='—'; ub.innerText='Update: idle'; document.getElementById('lastUpdate').innerText='—'; return;} const left=s.endsAt - Date.now(); cd.innerText = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…'; ub.innerText='Update: '+(s.auto?'auto':'manual'); document.getElementById('lastUpdate').innerText = new Date(s.startedAt).toLocaleString(); }
function dsTime(){ document.getElementById('dsTime').innerText = new Date().toLocaleString(); }

badges(); pollStatus(); loadDetails(); tick(); dsTime();
setInterval(pollStatus,10000); setInterval(tick,1000); setInterval(dsTime,1000);
</script>
</body></html>`;

// ---------- Auth & routes ----------
function requireAuth(req,res,next){
  if (req.session?.loggedIn) return next();
  return res.redirect('/login');
}

app.get('/login',(req,res)=>res.send(loginHTML.replace('{{ERR}}','')));
app.post('/login',(req,res)=>{
  const u = (req.body.username||'').toString().trim().toLowerCase();
  const p = (req.body.password||'').toString();
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true; req.session.username = u; return res.redirect('/');
  }
  res.send(loginHTML.replace('{{ERR}}','Invalid credentials.'));
});
app.get('/logout',(req,res)=>{ req.session.destroy(()=>{}); res.redirect('/login'); });
app.get('/', requireAuth, (req,res)=>res.send(dashHTML(req.session.username || 'admin')));

// API endpoints
app.get('/api/state', requireAuth, (_req,res)=>res.json({ autoUpdate, aiEnabled, autoroleId }));
app.get('/api/update-state', requireAuth, (_req,res)=>res.json(updateState));
app.post('/api/toggle-auto', requireAuth, (_req,res)=>{ autoUpdate = !autoUpdate; res.json({ autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req,res)=>{ aiEnabled = !aiEnabled; res.json({ aiEnabled }); });
app.post('/api/autorole', requireAuth, (req,res)=>{ autoroleId = (req.body.roleId||'').toString().trim() || null; res.json({ success:true, autoroleId }); });

app.get('/api/bot-status', requireAuth, (_req,res)=>{
  const status = client?.user ? `Logged in as ${client.user.tag}` : 'Disconnected';
  res.json({ status });
});
app.get('/api/details', requireAuth, (_req,res)=>res.json({
  updateState, aiEnabled, autoUpdate, channelId: CHANNEL_ID || null, openaiConfigured: !!OPENAI_API_KEY, discordConnected: !!client?.user
}));
app.get('/api/server-status', requireAuth, async (_req,res)=>{
  try {
    const s = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online:true, players: s.players.online, ping: s.roundTripLatency });
  } catch { res.json({ online:false }); }
});

// ---------------- Update flow ----------------
async function startUpdateFlow({ minutes, reason, auto=false }){
  if (!CHANNEL_ID) throw new Error("CHANNEL_ID not set.");
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch) throw new Error("Channel fetch failed.");
  const now = nowTs();
  updateState = { active:true, auto, reason, startedAt: now, endsAt: now + minutes*60000, minutes };

  await purgeChannel(ch);
  await lockChannel(ch, true);
  await ch.send({ content: "@everyone", embeds: [ updatingEmbed({ minutes, reason, auto }) ] });

  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(async ()=>{ try { await finishUpdateFlow({ auto }); } catch(e){ console.error('auto finish err', e); } }, minutes*60000);
}
async function finishUpdateFlow({ auto=false }){
  if (!CHANNEL_ID) throw new Error("CHANNEL_ID not set.");
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch) throw new Error("Channel fetch failed.");
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ content: "@everyone", embeds: [ updatedEmbed({ auto, completedAt }) ] });
  updateState = { active:false, auto:false, reason:"", startedAt:0, endsAt:0, minutes:0 };
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
}

// dashboard control endpoints
app.post('/api/start-update', requireAuth, async (req,res)=>{
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || '').toString().slice(0,1000);
    await startUpdateFlow({ minutes, reason, auto:false });
    res.json({ success:true });
  } catch (e) { console.error('api start-update', e); res.json({ success:false, error: e?.message || e }); }
});
app.post('/api/finish-update', requireAuth, async (_req,res)=>{
  try { await finishUpdateFlow({ auto:false }); res.json({ success:true }); }
  catch (e) { console.error('api finish-update', e); res.json({ success:false, error: e?.message || e }); }
});

// ---------------- Auto update cron (3:00-3:05 PM BD) ----------------
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes:5, reason:"Scheduled daily maintenance", auto:true }); } catch (e) { console.error('auto-start', e); }
}, { timezone: TZ });
cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto:true }); } catch (e) { console.error('auto-finish', e); }
}, { timezone: TZ });

// ---------------- Autorole ----------------
client.on("guildMemberAdd", async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(()=>null);
    if (role) await member.roles.add(role).catch(()=>{});
  } catch (e) { console.error('autorole', e); }
});

// ---------------- AI handler (single channel) ----------------
let aiQueue = Promise.resolve();
client.on("messageCreate", async (message) => {
  try {
    if (message.author?.bot) return;
    if (!CHANNEL_ID || message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const ctx = buildContext(message.author.id, message.author.username, message.content);
      const reply = await chatOpenAI(ctx);
      saveContext(message.author.id, message.content, reply);
      await typeAndReply(message, reply || "Sorry, I couldn't generate a reply right now.");
    });
    await aiQueue;
  } catch (e) { console.error('AI handler', e); }
});

// ---------------- Start ----------------
client.login(DISCORD_TOKEN).catch(err => console.error("Discord login failed:", err?.message || err));
app.listen(PORT, () => console.log(`🌐 Ultra Dashboard running on port ${PORT}`));
