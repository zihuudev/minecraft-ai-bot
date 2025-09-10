// ================= Cyberland Ultra-Premium Bot (single-file) ==================
// Features:
// - Ultra-premium animated dashboard + secure 3-user login
// - GPT-style AI chat (context-aware, typing simulation) in one channel
// - Manual & Auto update flow (instant purge -> lock -> premium embed -> finish -> unlock)
// - Animated, glassmorphic dashboard with countdown & Minecraft status
// - Admin-only slash commands (deployed automatically; refresh from dashboard)
// - Autorole support, optimized for Railway/Render
// Developed by Zihuu (assembled for you)
// ============================================================================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const https = require("https");
const cron = require("node-cron");
const moment = require("moment-timezone");
const mcu = require("minecraft-server-util");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  REST,
  Routes,
} = require("discord.js");

// ------------------ CONFIG ------------------
const PORT = process.env.PORT || 3000;
const TZ = "Asia/Dhaka";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHANNEL_ID = process.env.CHANNEL_ID || ""; // AI chat channel id
const GUILD_ID = process.env.GUILD_ID || "";     // for guild-scoped slash commands (fast)
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// ------------------ CLIENT ------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ------------------ RUNTIME STATE ------------------
let autoUpdate = true;
let aiEnabled = true;
let autoroleId = null;
let updateTimer = null;
let updateState = { active:false, auto:false, reason:"", startedAt:0, endsAt:0, minutes:0 };

const userContexts = new Map(); // short term user contexts for AI
const MAX_TURNS = 6;
const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408,409,429,500,502,503,504]);

// ------------------ HELPERS ------------------
function isAdmin(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}
function nowTs(){ return Date.now(); }
function fmtTS(ts){ return moment(ts).tz(TZ).format("MMM D YYYY, h:mm A"); }

async function purgeChannel(channel){
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
      } catch {
        for (const [, m] of fetched) {
          try { await m.delete(); } catch(_) {}
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error("purgeChannel:", e?.message || e);
  }
}

async function lockChannel(channel, locked){
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: !locked ? true : false });
  } catch (e) {
    console.error("lockChannel:", e?.message || e);
  }
}

// ------------------ OPENAI AI (resilient) ------------------
async function chatOpenAI(messages, attempt = 1){
  if (!OPENAI_API_KEY) return "❌ OpenAI API key not configured.";
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: OPENAI_MODEL, messages, temperature: 0.65, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 70000, httpsAgent, validateStatus: ()=>true }
    );
    if (res.status >= 200 && res.status < 300) {
      return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    }
    if (res.status === 401) return "❌ Invalid OpenAI API Key.";
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r=>setTimeout(r, 800 * attempt));
      return chatOpenAI(messages, attempt+1);
    }
    return "⚠️ AI temporarily unavailable. Try again later.";
  } catch (e) {
    if (["ECONNABORTED","ETIMEDOUT","ECONNRESET"].includes(e?.code) && attempt < 3) {
      await new Promise(r=>setTimeout(r, 800 * attempt));
      return chatOpenAI(messages, attempt+1);
    }
    console.error("chatOpenAI error:", e?.message || e);
    return "⚠️ AI temporarily unavailable. Try again later.";
  }
}

function buildContext(userId, username, userMsg){
  const systemMsg = {
    role: "system",
    content: "You are a friendly, helpful assistant for a Minecraft/Discord community called Cyberland. Answer concisely. Provide Minecraft commands and practical tips when relevant.",
  };
  const out = [systemMsg];
  const history = userContexts.get(userId) || [];
  for (const turn of history.slice(-MAX_TURNS)) {
    out.push({ role:"user", content:`${username}: ${turn.q}` });
    out.push({ role:"assistant", content: turn.a });
  }
  out.push({ role:"user", content:`${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a){
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}

async function typeAndReply(message, text){
  if (!text) { await message.reply("..."); return; }
  // chunk by length for snappy feel
  const words = text.split(/\s+/);
  const chunks = [];
  let buf = "";
  for (const w of words) {
    const cand = (buf ? buf + " " : "") + w;
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
      console.error("typeAndReply send error:", e?.message || e);
    }
  }
}

// ------------------ ULTRA-PREMIUM EMBEDS ------------------
function ultraEmbed(color, title, description){
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setFooter({ text: "Developed by Zihuu • Cyberland" }).setTimestamp();
}
function updatingEmbed({ minutes, reason, auto }){
  const e = ultraEmbed(0xF59E0B, auto ? "⚡ Automatic Update Started" : "🚀 Manual Update Started",
    "Maintenance in progress — keeping the bot fast & stable.");
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
  const e = ultraEmbed(0x22C55E, auto ? "✅ Automatic Update Completed" : "✅ Manual Update Completed",
    "All systems are up to date. You can chat now!");
  e.addFields(
    { name: "Status", value: "Ready", inline: true },
    { name: "Channel", value: "Unlocked", inline: true },
    { name: "Mode", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "Developer", value: "Zihuu", inline: true },
  );
  if (completedAt) e.addFields({ name: "Completed At", value: completedAt });
  return e;
}

// ------------------ WEB DASHBOARD (ultra-premium animated) ------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: "cyberland-ultra-session", resave: false, saveUninitialized: true }));

// fixed 3-user login credentials
const USERS = new Map([
  ["zihuu", "cyberlandai90x90x90"],
  ["shahin", "cyberlandai90x90x90"],
  ["mainuddin", "cyberlandai90x90x90"],
]);

const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland Admin Login</title>
<style>
:root{--bg:#071027;--glass:rgba(255,255,255,.04);--b:rgba(255,255,255,.06);--accent1:#7c3aed;--accent2:#06b6d4}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui;background:
radial-gradient(800px 600px at 10% 10%,#0f1f3a, #071027);color:#e6eef8}form{width:96%;max-width:460px;padding:28px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.02),transparent);border:1px solid var(--b);backdrop-filter:blur(8px);box-shadow:0 20px 60px rgba(2,6,23,.6)}
h1{margin:0 0 12px}input{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;margin-top:10px}button{width:100%;padding:12px;margin-top:12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer}
small{opacity:.85}
.err{color:#ff6b6b;margin-top:10px}
.brand{position:absolute;right:-60px;top:-60px;width:160px;height:160px;border-radius:50%;background:radial-gradient(circle at 30% 30%,rgba(124,58,237,.25),transparent 40%),radial-gradient(circle at 70% 70%,rgba(6,182,212,.25),transparent 40%);filter:blur(28px)}
</style></head><body>
<form method="POST" action="/login">
  <div class="brand"></div>
  <h1>🔐 Cyberland Admin</h1>
  <input name="username" placeholder="Username" required />
  <input name="password" type="password" placeholder="Password" required />
  <button type="submit">Enter Dashboard</button>
  <div class="err">{{ERR}}</div>
  <small>Authorized: zihuu, shahin, mainuddin — password: cyberlandai90x90x90</small>
</form>
</body></html>`;

const dashHTML = (u) => `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland Dashboard</title>
<style>
:root{--bg:#071027;--glass:rgba(255,255,255,.04);--b:rgba(255,255,255,.06);--accent1:#7c3aed;--accent2:#06b6d4;--green:#22c55e;--amber:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1000px 700px at 10% 10%,#0f1f3a,#071027);color:#e6eef8;font-family:Inter,system-ui}
.container{max-width:1200px;margin:24px auto;padding:20px}
.top{display:flex;justify-content:space-between;align-items:center}
.brand{font-weight:800}
.controls{display:flex;gap:8px;align-items:center}
.badge{padding:8px 12px;border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.02),transparent);border:1px solid var(--b);display:flex;gap:8px;align-items:center}
.grid{display:grid;grid-template-columns:1fr 360px;gap:18px;margin-top:18px}
.card{background:var(--glass);padding:16px;border-radius:12px;border:1px solid var(--b);backdrop-filter:blur(8px)}
.tabs{display:flex;gap:8px;margin-top:12px}
.tab{padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.02);border:1px solid var(--b);cursor:pointer}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(6,182,212,.12));transform:translateY(-4px)}
.input,textarea{width:100%;padding:10px;border-radius:10px;border:none;background:rgba(255,255,255,.03);color:#fff}
.btn{padding:10px 12px;border-radius:10px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer}
.small{font-size:13px;opacity:.9}
.pulse{animation:pulse 1.4s infinite ease-in-out}@keyframes pulse{0%{opacity:.7}50%{opacity:1}100%{opacity:.7}}
.footer{margin-top:10px;opacity:.8}
</style></head><body>
<div class="container">
  <div class="top">
    <div class="brand">⚡ Cyberland Premium Dashboard<br/><small class="small">Welcome, <b>${u}</b></small></div>
    <div class="controls">
      <div id="autoBadge" class="badge">Auto: …</div>
      <div id="aiBadge" class="badge">AI: …</div>
      <div id="updBadge" class="badge">Update: idle</div>
      <a href="/logout" style="color:#93c5fd;margin-left:8px">Logout</a>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="admin">Admin</div>
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
          <div style="width:320px">
            <label class="small">Reason</label>
            <textarea id="reason" class="input" rows="3" placeholder="Bug fix / deploy / maintenance"></textarea>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" onclick="startUpdate()">🚀 Start Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#16a34a,#06b6d4)" onclick="finishUpdate()">✅ Finish</button>
          <button class="btn" style="background:linear-gradient(135deg,#f59e0b,#f97316)" onclick="toggleAuto()">🔄 Auto</button>
          <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="toggleAI()">🤖 AI</button>
          <button class="btn" style="background:linear-gradient(135deg,#ef4444,#7c3aed)" onclick="refreshCmds()">🔁 Refresh</button>
        </div>
        <p style="margin-top:12px">Countdown: <b id="countdown" class="pulse">—</b></p>
      </div>

      <div id="tab-server" class="card" style="margin-top:12px;display:none">
        <h3>Minecraft Bedrock Status</h3>
        <div id="mcStatus" class="small pulse">Checking…</div>
        <hr/>
        <label class="small">Autorole ID</label>
        <div style="display:flex;gap:8px">
          <input id="roleId" class="input" placeholder="Enter Role ID or leave blank" />
          <button class="btn" onclick="saveAutorole()">Save</button>
        </div>
      </div>

      <div id="tab-admin" class="card" style="margin-top:12px;display:none">
        <h3>Admin Commands</h3>
        <pre class="small">/kick /ban /unban /timeout /clear /lock /unlock /announce /say /serverinfo /userinfo /setautorole /botinfo /ping /uptime /minecraft</pre>
      </div>

      <div id="tab-about" class="card" style="margin-top:12px;display:none">
        <h3>About</h3>
        <p class="small">Developed by <b>Zihuu</b>. Ultra-premium animated dashboard + AI + update system.</p>
      </div>
    </div>

    <div>
      <div class="card">
        <h3>Live</h3>
        <div class="small">Bot: <span id="botStatus">Loading...</span></div>
        <div class="small">Last update: <span id="lastUpdate">—</span></div>
        <div style="margin-top:12px"><button class="btn" onclick="startQuick5()">Quick 5m Update</button></div>
      </div>

      <div class="card" style="margin-top:12px">
        <h3>Commands</h3>
        <pre id="cmdList" class="small">loading…</pre>
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
  document.getElementById('tab-admin').style.display='none';
  document.getElementById('tab-about').style.display='none';
  document.getElementById('tab-'+t.dataset.tab).style.display='block';
});

async function api(path, opts={}) {
  const r = await fetch(path, opts);
  return r.json();
}

async function badges(){
  try {
    const s = await api('/api/state');
    document.getElementById('autoBadge').innerText = 'Auto: '+(s.autoUpdate?'ON':'OFF');
    document.getElementById('aiBadge').innerText = 'AI: '+(s.aiEnabled?'ON':'OFF');
    document.getElementById('roleId').value = s.autoroleId || '';
  } catch(e){}
}

async function startUpdate(){
  const minutes = Number(document.getElementById('minutes').value||0);
  const reason = document.getElementById('reason').value||'';
  if (!minutes || minutes < 1) return alert('Enter minutes >= 1');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});
  alert('Update started');
}
async function startQuick5(){ await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:5,reason:'Quick 5m update'})}); alert('Quick 5m started'); }
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); alert('Finish requested'); }
async function toggleAuto(){ const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); badges(); alert('Auto: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r = await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const v=document.getElementById('roleId').value.trim(); await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId:v})}); alert('Saved'); }
async function refreshCmds(){ const r = await fetch('/api/refresh-commands',{method:'POST'}).then(r=>r.json()); alert(r.ok ? 'Commands refreshed' : 'Failed'); loadCmds(); }

async function pollStatus(){ try { const s = await fetch('/api/server-status').then(r=>r.json()); document.getElementById('mcStatus').innerText = s.online?('🟢 Online — Players: '+s.players+' | Ping: '+s.ping+'ms'):'🔴 Offline'; } catch(e){} }
async function loadCmds(){ try { const data = await fetch('/api/commands').then(r=>r.json()); document.getElementById('cmdList').innerText = JSON.stringify(data,null,2).slice(0,1000); } catch(e){} }
async function tick(){ try { const s = await fetch('/api/update-state').then(r=>r.json()); const cd=document.getElementById('countdown'); const ub=document.getElementById('updBadge'); if(!s.active){ cd.innerText='—'; ub.innerText='Update: idle'; document.getElementById('lastUpdate').innerText='—'; return;} const left = s.endsAt - Date.now(); cd.innerText = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…'; ub.innerText='Update: '+(s.auto?'auto':'manual'); document.getElementById('lastUpdate').innerText = new Date(s.startedAt).toLocaleString(); } catch(e){} }
function dsTime(){ document.getElementById('dsTime').innerText = new Date().toLocaleString(); }
badges(); pollStatus(); loadCmds(); tick(); dsTime();
setInterval(pollStatus,10000); setInterval(tick,1000); setInterval(dsTime,1000);
</script>
</body></html>`;

// auth
function requireAuth(req,res,next){
  if (req.session?.loggedIn) return next();
  res.redirect('/login');
}
app.get('/login',(req,res)=>res.send(loginHTML.replace('{{ERR}}','')));
app.post('/login',(req,res)=>{
  const u = (req.body.username||'').toString().trim().toLowerCase();
  const p = (req.body.password||'').toString();
  if (USERS.has(u) && USERS.get(u) === p) { req.session.loggedIn = true; req.session.username = u; return res.redirect('/'); }
  res.send(loginHTML.replace('{{ERR}}','Invalid credentials.'));
});
app.get('/logout',(req,res)=>{ req.session.destroy(()=>{}); res.redirect('/login'); });
app.get('/', requireAuth, (req,res)=>res.send(dashHTML(req.session.username||'admin')));

// dashboard APIs
app.get('/api/state', requireAuth, (_req,res)=>res.json({ autoUpdate, aiEnabled, autoroleId }));
app.get('/api/update-state', requireAuth, (_req,res)=>res.json(updateState));
app.post('/api/toggle-auto', requireAuth, (_req,res)=>{ autoUpdate = !autoUpdate; res.json({ autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req,res)=>{ aiEnabled = !aiEnabled; res.json({ aiEnabled }); });
app.post('/api/autorole', requireAuth, (req,res)=>{ autoroleId = (req.body.roleId||'').toString().trim() || null; res.json({ success:true, autoroleId }); });
app.get('/api/server-status', requireAuth, async (_req,res)=>{
  try {
    const st = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online:true, players: st.players.online, ping: st.roundTripLatency });
  } catch { res.json({ online:false }); }
});

// ------------------ UPDATE FLOW ------------------
async function startUpdateFlow({ minutes, reason, auto=false }){
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    if (!ch) throw new Error("Channel not found or CHANNEL_ID not set.");
    const now = nowTs();
    updateState = { active:true, auto, reason, startedAt: now, endsAt: now + minutes*60000, minutes };
    // purge -> lock -> embed
    await purgeChannel(ch);
    await lockChannel(ch, true);
    await ch.send({ content: "@everyone", embeds: [ updatingEmbed({ minutes, reason, auto }) ] });
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(async ()=>{ try { await finishUpdateFlow({ auto }); } catch(e){ console.error('finishUpdateFlow:', e?.message||e); } }, minutes*60000);
  } catch (e) {
    console.error('startUpdateFlow err:', e?.message || e);
    throw e;
  }
}
async function finishUpdateFlow({ auto=false }){
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    if (!ch) throw new Error("Channel not found or CHANNEL_ID not set.");
    await purgeChannel(ch);
    await lockChannel(ch, false);
    const completedAt = fmtTS(Date.now());
    await ch.send({ content: "@everyone", embeds: [ updatedEmbed({ auto, completedAt }) ] });
    updateState = { active:false, auto:false, reason:"", startedAt:0, endsAt:0, minutes:0 };
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  } catch (e) {
    console.error('finishUpdateFlow err:', e?.message || e);
    throw e;
  }
}

// dashboard endpoints controlling update
app.post('/api/start-update', requireAuth, async (req,res)=>{
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || '').toString().slice(0,1000);
    await startUpdateFlow({ minutes, reason, auto:false });
    res.json({ success:true });
  } catch (e) { console.error('api start-update:', e?.message||e); res.json({ success:false, error: e?.message || e }); }
});
app.post('/api/finish-update', requireAuth, async (_req,res)=>{
  try { await finishUpdateFlow({ auto:false }); res.json({ success:true }); }
  catch (e) { console.error('api finish-update:', e?.message||e); res.json({ success:false, error: e?.message || e }); }
});

// ------------------ AUTO UPDATE (daily 3:00 - 3:05 PM BD) ------------------
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes:5, reason:"Scheduled daily maintenance", auto:true }); } catch (e) { console.error('auto-start:', e?.message||e); }
}, { timezone: TZ });
cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto:true }); } catch (e) { console.error('auto-finish:', e?.message||e); }
}, { timezone: TZ });

// ------------------ SLASH COMMANDS ------------------
const slashCommands = [
  { name:'kick', description:'Kick a member', options:[{name:'user',type:6,required:true},{name:'reason',type:3,required:false}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'ban', description:'Ban a member', options:[{name:'user',type:6,required:true},{name:'reason',type:3,required:false}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'unban', description:'Unban by ID', options:[{name:'userid',type:3,required:true}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'timeout', description:'Timeout a member (minutes)', options:[{name:'user',type:6,required:true},{name:'minutes',type:4,required:true},{name:'reason',type:3,required:false}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'clear', description:'Clear messages (1-100)', options:[{name:'amount',type:4,required:true}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'lock', description:'Lock channel', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'unlock', description:'Unlock channel', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'announce', description:'Send announcement (embed)', options:[{name:'message',type:3,required:true}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'say', description:'Bot says message', options:[{name:'message',type:3,required:true}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'serverinfo', description:'Show server info', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'userinfo', description:'Show user info', options:[{name:'user',type:6,required:false}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'setautorole', description:'Set autorole ID or off', options:[{name:'roleid',type:3,required:true}], default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'botinfo', description:'Bot info', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'ping', description:'Ping', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'uptime', description:'Uptime', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
  { name:'minecraft', description:'Minecraft status', default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission:false },
];

// deploy functions
async function deployCommands(attempt = 1){
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const appId = client?.user?.id;
  if (!appId) throw new Error("ClientNotReady");
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: slashCommands });
      console.log(`Slash commands deployed to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
      console.log('Global slash commands deployed (may take up to 1 hour)');
    }
  } catch (e) {
    console.error('deployCommands err:', e?.message || e);
    if (attempt < 3) { await new Promise(r=>setTimeout(r, 1200 * attempt)); return deployCommands(attempt+1); }
    throw e;
  }
}

// dashboard endpoint to refresh commands
app.post('/api/refresh-commands', requireAuth, async (_req,res) => {
  try { await deployCommands(); res.json({ ok:true }); } catch (e) { res.json({ ok:false, error: e?.message || e }); }
});
app.get('/api/commands', requireAuth, async (_req,res) => {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const appId = client?.user?.id;
    if (!appId) return res.json({ error: "Client not ready" });
    const route = GUILD_ID ? Routes.applicationGuildCommands(appId, GUILD_ID) : Routes.applicationCommands(appId);
    const data = await rest.get(route);
    return res.json(data);
  } catch (e) { return res.json({ error: e?.message || e }); }
});

// ------------------ INTERACTIONS ------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const n = interaction.commandName;
    if (n === 'kick') {
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'No reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      return interaction.reply({ content: `👢 Kicked ${user.tag} — ${reason}`, ephemeral:true });
    }
    if (n === 'ban') {
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'No reason';
      await interaction.guild.members.ban(user.id, { reason });
      return interaction.reply({ content: `🔨 Banned ${user.tag}`, ephemeral:true });
    }
    if (n === 'unban') {
      const id = interaction.options.getString('userid', true);
      await interaction.guild.bans.remove(id).catch(()=>{});
      return interaction.reply({ content: `♻️ Unbanned ${id}`, ephemeral:true });
    }
    if (n === 'timeout') {
      const user = interaction.options.getUser('user', true);
      const minutes = Math.max(1, interaction.options.getInteger('minutes', true));
      const reason = interaction.options.getString('reason') || 'No reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(minutes * 60000, reason);
      return interaction.reply({ content: `⏳ Timed out ${user.tag} for ${minutes}m`, ephemeral:true });
    }
    if (n === 'clear') {
      const amount = Math.max(1, Math.min(100, interaction.options.getInteger('amount', true)));
      const deleted = await interaction.channel.bulkDelete(amount, true).catch(()=>null);
      if (!deleted) return interaction.reply({ content: '⚠️ Could not bulk delete (maybe messages too old).', ephemeral:true });
      return interaction.reply({ content: `🧹 Deleted ${deleted.size} messages`, ephemeral:true });
    }
    if (n === 'lock') {
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
      return interaction.reply({ content: '🔒 Channel locked', ephemeral:true });
    }
    if (n === 'unlock') {
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: true });
      return interaction.reply({ content: '🔓 Channel unlocked', ephemeral:true });
    }
    if (n === 'announce') {
      const msg = interaction.options.getString('message', true);
      const e = ultraEmbed(0x7C3AED, '📣 Announcement', msg);
      await interaction.channel.send({ content: '@everyone', embeds: [e] });
      return interaction.reply({ content: '✅ Announcement sent', ephemeral:true });
    }
    if (n === 'say') {
      const msg = interaction.options.getString('message', true);
      await interaction.channel.send(msg);
      return interaction.reply({ content: '✅ Sent', ephemeral:true });
    }
    if (n === 'serverinfo') {
      const g = interaction.guild;
      const e = ultraEmbed(0x06B6D4, '🛡️ Server Info', `**Name:** ${g.name}\n**Members:** ${g.memberCount}\n**ID:** ${g.id}`);
      return interaction.reply({ embeds: [e], ephemeral:true });
    }
    if (n === 'userinfo') {
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id);
      const e = ultraEmbed(0x06B6D4, '👤 User Info', `**User:** ${user.tag}\n**ID:** ${user.id}\n**Joined:** ${member.joinedAt}`);
      return interaction.reply({ embeds: [e], ephemeral:true });
    }
    if (n === 'setautorole') {
      const v = interaction.options.getString('roleid', true).trim();
      if (v.toLowerCase() === 'off') { autoroleId = null; return interaction.reply({ content: '✅ Autorole disabled', ephemeral:true }); }
      autoroleId = v; return interaction.reply({ content: `✅ Autorole set to ${autoroleId}`, ephemeral:true });
    }
    if (n === 'botinfo') {
      const up = process.uptime(); const h = Math.floor(up/3600), m = Math.floor((up%3600)/60), s = Math.floor(up%60);
      const e = ultraEmbed(0x7C3AED, '🤖 Bot Info', `Uptime: ${h}h ${m}m ${s}s`);
      return interaction.reply({ embeds: [e], ephemeral:true });
    }
    if (n === 'ping') return interaction.reply({ content: `🏓 ${Math.round(client.ws.ping)}ms`, ephemeral:true });
    if (n === 'uptime') {
      const up = process.uptime(); const h = Math.floor(up/3600), m = Math.floor((up%3600)/60), s = Math.floor(up%60);
      return interaction.reply({ content:`⏱️ Uptime: ${h}h ${m}m ${s}s`, ephemeral:true });
    }
    if (n === 'minecraft') {
      try {
        const st = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
        const e = ultraEmbed(0x22C55E, '🎮 Minecraft Status', `🟢 Online\nPlayers: ${st.players.online}\nPing: ${st.roundTripLatency}ms`);
        return interaction.reply({ embeds: [e], ephemeral:true });
      } catch {
        const e = ultraEmbed(0xEF4444, '🎮 Minecraft Status', '🔴 Offline');
        return interaction.reply({ embeds: [e], ephemeral:true });
      }
    }
  } catch (e) {
    console.error('interaction error:', e?.message || e);
    if (!interaction.replied) interaction.reply({ content: '❌ Error executing command', ephemeral: true });
  }
});

// ------------------ AUTOROLE ------------------
client.on('guildMemberAdd', async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(()=>null);
    if (role) await member.roles.add(role).catch(()=>{});
  } catch (e) { console.error('autorole error:', e?.message || e); }
});

// ------------------ AI MESSAGE HANDLER ------------------
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!CHANNEL_ID || message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

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

// ------------------ DEPLOY SLASH COMMANDS ON READY ------------------
client.on('ready', async () => {
  console.log('✅ Logged in as', client.user.tag);
  try { await deployCommands(); } catch (e) { console.error('deployCommands failed:', e?.message || e); }
});

// ------------------ START SERVER & LOGIN ------------------
client.login(DISCORD_TOKEN).catch(err => { console.error('Discord login failed:', err?.message || err); });
app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));
