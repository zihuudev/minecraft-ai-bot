// ================= Cyberland Ultra-Premium Bot (Single File) =================
// Features: Ultra-premium animated dashboard + login (3 users), resilient AI,
// manual & auto update with instant purge/lock/unlock + premium embeds, Minecraft
// Bedrock live status, autorole, admin-only slash commands, and command refresh.
// Timezone: Asia/Dhaka (Auto update 3:00–3:05 PM daily)
// Developed by Zihuu
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

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const TZ = "Asia/Dhaka";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHANNEL_ID = process.env.CHANNEL_ID || ""; // AI chat channel
const GUILD_ID = process.env.GUILD_ID || "";     // to deploy slash cmds instantly for one guild

// Minecraft (Bedrock)
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// ====== Discord client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ====== Runtime state ======
let autoUpdate = true;       // daily auto update ON
let aiEnabled = true;        // AI chat ON
let autoroleId = null;       // auto role on join
let updateTimer = null;
let updateState = { active:false, auto:false, reason:"", startedAt:0, endsAt:0, minutes:0 };

const userContexts = new Map(); // AI short-term memory per user
const MAX_TURNS = 6;            // keep last 6 exchanges per user
const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

// ====== Helpers ======
function isAdmin(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

async function purgeChannel(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;
      const deleted = await channel.bulkDelete(fetched, true).catch(() => null);
      if (!deleted) {
        for (const [, msg] of fetched) {
          await msg.delete().catch(() => {});
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error("Purge error:", e.message);
  }
}

async function lockChannel(channel, locked) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: locked ? false : true,
  });
}

// ====== AI (Upgraded, resilient) ======
async function chatOpenAI(messages, attempt = 1) {
  if (!OPENAI_API_KEY) return "❌ OpenAI key is missing on the server.";
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: OPENAI_MODEL, messages, temperature: 0.65, max_tokens: 800, presence_penalty: 0.05 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 60_000, httpsAgent, validateStatus: () => true }
    );
    if (res.status >= 200 && res.status < 300) {
      return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    }
    if (res.status === 401) return "❌ Invalid OpenAI API Key. Please check server config.";
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return "⚠️ AI is temporarily unavailable. Please try again.";
  } catch (e) {
    if (["ECONNABORTED","ETIMEDOUT","ECONNRESET"].includes(e.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return "⚠️ AI is temporarily unavailable. Please try again.";
  }
}

function buildContext(userId, username, userMsg) {
  const history = userContexts.get(userId) || [];
  const sys = {
    role: "system",
    content:
      "You are a friendly, helpful assistant for a Minecraft/Discord community named Cyberland. " +
      "Answer concisely and clearly. When asked about Minecraft, give useful commands, versions, ports, and tips. " +
      "Avoid long monologues unless the user asks. Be accurate and practical.",
  };
  const msgs = [sys];
  for (const turn of history.slice(-MAX_TURNS)) {
    msgs.push({ role: "user", content: `${username}: ${turn.q}` });
    msgs.push({ role: "assistant", content: turn.a });
  }
  msgs.push({ role: "user", content: `${username}: ${userMsg}` });
  return msgs;
}

function saveContext(userId, q, a) {
  const history = userContexts.get(userId) || [];
  history.push({ q, a });
  while (history.length > MAX_TURNS) history.shift();
  userContexts.set(userId, history);
}

// smooth typing simulation + chunking (keeps replies snappy)
async function typeAndReply(message, text) {
  const chunks = [];
  const words = text.split(/\s+/);
  let buf = "";
  for (const w of words) {
    const cand = (buf ? buf + " " : "") + w;
    if (cand.length >= 180) { chunks.push(buf); buf = w; } else { buf = cand; }
  }
  if (buf) chunks.push(buf);

  let first = true;
  for (const c of chunks) {
    await message.channel.sendTyping();
    if (first) { await message.reply(c); first = false; }
    else { await message.channel.send(c); }
    await new Promise(r => setTimeout(r, Math.min(900, Math.max(200, c.length * 5))));
  }
}

// ====== Premium Embeds ======
function ultraEmbed(colorHex, title, desc) {
  return new EmbedBuilder()
    .setColor(colorHex)
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: "Developed by Zihuu • Cyberland" })
    .setTimestamp();
}
function updatingEmbed({ minutes, reason, auto }) {
  const e = ultraEmbed(
    0xf59e0b,
    auto ? "⚡ Automatic Update Started" : "🚀 Manual Update Started",
    "We are performing maintenance to keep the bot ultra-fast, stable, and secure."
  );
  e.addFields(
    { name: "🎉 Status", value: "Updating in progress…", inline: true },
    { name: "🔒 Channel", value: "Locked", inline: true },
    { name: "⏰ Duration", value: `${minutes} minute(s)`, inline: true },
    { name: "🧠 Mode", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "👨‍💻 Developer", value: "Zihuu", inline: true },
  );
  if (reason) e.addFields({ name: "🛠️ Reason", value: reason });
  return e;
}
function updatedEmbed({ auto }) {
  const e = ultraEmbed(
    0x22c55e,
    auto ? "✅ Automatic Update Completed" : "✅ Manual Update Completed",
    "All systems are up to date. You can chat now!"
  );
  e.addFields(
    { name: "🎉 Status", value: "Ready", inline: true },
    { name: "🔓 Channel", value: "Unlocked", inline: true },
    { name: "🧠 Mode", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "👨‍💻 Developer", value: "Zihuu", inline: true },
  );
  return e;
}

// ====== Web (Ultra-premium login + dashboard) ======
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "cyberland-ultra-session",
    resave: false,
    saveUninitialized: true,
  })
);

// Fixed 3-user login
const USERS = new Map([
  ["zihuu", "cyberlandai90x90x90"],
  ["shahin", "cyberlandai90x90x90"],
  ["mainuddin", "cyberlandai90x90x90"],
]);

const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland Admin Login</title>
<style>
:root{--bg1:#070b16;--bg2:#0b1220;--text:#e5e7eb;--glass:rgba(255,255,255,.06);--b:rgba(255,255,255,.14);--vio:#7c3aed;--c:#06b6d4;--r:#ef4444}
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:
radial-gradient(1000px 800px at 20% 10%,#111a39 0%,#0b1220 45%,#070b16 100%);color:var(--text);font-family:Inter,ui-sans-serif;overflow:hidden}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:24px 24px;mask-image:radial-gradient(ellipse at center, black 30%, transparent 70%);}
.card{width:94%;max-width:460px;background:var(--glass);border:1px solid var(--b);border-radius:18px;padding:28px;backdrop-filter:blur(12px);box-shadow:0 16px 60px rgba(0,0,0,.55);position:relative;overflow:hidden;animation:pop .5s ease both}
.card:before{content:"";position:absolute;inset:-2px;filter:blur(22px);background:
conic-gradient(from 220deg at 50% 50%,rgba(124,58,237,.35),rgba(6,182,212,.35),transparent);z-index:-1}
@keyframes pop{from{transform:translateY(8px);opacity:.0}to{transform:none;opacity:1}}
h1{margin:0 0 14px;font-size:22px;letter-spacing:.4px}
.input{width:100%;padding:12px;border:none;border-radius:12px;background:rgba(255,255,255,.08);color:#fff;outline:none;margin-top:10px}
.btn{width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;color:#fff;cursor:pointer;background:linear-gradient(135deg,var(--vio),var(--c));box-shadow:0 10px 24px rgba(124,58,237,.25);transition:transform .12s,filter .12s}
.btn:hover{transform:translateY(-1px);filter:brightness(1.06)}
.small{opacity:.85;font-size:12px;margin-top:10px}
.err{color:var(--r);margin-top:10px}
.brand{position:absolute;top:-60px;right:-60px;width:180px;height:180px;background:radial-gradient(circle at 30% 30%,rgba(124,58,237,.45),transparent 60%),radial-gradient(circle at 70% 70%,rgba(6,182,212,.45),transparent 60%);filter:blur(30px)}
</style></head><body>
<div class="grid"></div>
<form class="card" method="POST" action="/login">
  <div class="brand"></div>
  <h1>🔐 Cyberland Admin</h1>
  <input class="input" name="username" placeholder="Username" required/>
  <input class="input" type="password" name="password" placeholder="Password" required/>
  <button class="btn" type="submit">Login</button>
  <div class="small">Authorized users: <b>zihuu</b>, <b>shahin</b>, <b>mainuddin</b></div>
  <div class="err">{{ERR}}</div>
</form></body></html>`;

const dashHTML = (u) => `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland Premium Dashboard</title>
<style>
:root{
  --bg:#0b1220;--glass:rgba(255,255,255,.06);--b:rgba(255,255,255,.12);
  --txt:#e5e7eb;--vio:#7c3aed;--c:#06b6d4;--g:#22c55e;--a:#f59e0b;--r:#ef4444;
  --glow1: rgba(124,58,237,.35); --glow2: rgba(6,182,212,.35);
}
*{box-sizing:border-box}
body{
  margin:0;background:
  radial-gradient(1200px 800px at 10% 10%,#0f1f3a 0%,#0b1220 45%,#080c16 100%);
  color:var(--txt);font-family:Inter,ui-sans-serif;overflow-x:hidden
}
.container{max-width:1200px;margin:28px auto;padding:0 16px;animation:fade .35s ease both}
@keyframes fade{from{opacity:.0;transform:translateY(8px)}to{opacity:1;transform:none}}
.top{display:flex;justify-content:space-between;align-items:center}
.card{background:var(--glass);border:1px solid var(--b);border-radius:16px;padding:20px;backdrop-filter:blur(10px);margin-bottom:16px;box-shadow:0 10px 36px rgba(0,0,0,.35);position:relative;overflow:hidden}
.card:before{content:"";position:absolute;inset:-1px;background:
conic-gradient(from 200deg at 50% 50%,var(--glow1),var(--glow2),transparent);filter:blur(28px);z-index:-1;opacity:.6}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
.tab{padding:10px 14px;border-radius:12px;background:var(--glass);border:1px solid var(--b);cursor:pointer;transition:transform .12s}
.tab:hover{transform:translateY(-1px)}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.35),rgba(6,182,212,.35));border-color:rgba(255,255,255,.24)}
.row{display:flex;gap:16px;flex-wrap:wrap}.col{flex:1;min-width:280px}
label{display:block;margin:6px 0}
.input,textarea{width:100%;padding:12px;border:none;border-radius:12px;background:rgba(255,255,255,.08);color:#fff;outline:none}
button{padding:12px;border:none;border-radius:12px;color:#fff;cursor:pointer;transition:transform .12s,filter .12s,box-shadow .12s}
button:hover{transform:translateY(-1px);filter:brightness(1.06)}
.btn-prim{background:linear-gradient(135deg,var(--vio),var(--c));box-shadow:0 10px 24px rgba(124,58,237,.25)}
.btn-green{background:var(--g)}.btn-amber{background:var(--a);color:#111}.btn-cyan{background:var(--c)}.btn-red{background:var(--r)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);margin-left:8px}
.badge > .dot{width:8px;height:8px;border-radius:999px;background:#888;box-shadow:0 0 12px currentColor}
.hidden{display:none}hr{border:none;height:1px;background:var(--b);margin:16px 0}
pre{background:rgba(255,255,255,.06);padding:12px;border-radius:12px;overflow:auto;max-height:260px}
.count{font-variant-numeric:tabular-nums}
.pulse{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}
</style></head><body>
<div class="container">
  <div class="top">
    <h2 style="display:flex;align-items:center;gap:10px">
      ⚡ Cyberland Premium Dashboard
      <span id="autoBadge" class="badge"><span class="dot"></span>Auto: …</span>
      <span id="aiBadge" class="badge"><span class="dot"></span>AI: …</span>
      <span id="updBadge" class="badge"><span class="dot"></span>Update: idle</span>
    </h2>
    <div>Logged in as <b>${u}</b> • <a href="/logout" style="color:#93c5fd">Logout</a></div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="admin">Admin</div>
    <div class="tab" data-tab="about">About</div>
  </div>

  <div id="tab-updates" class="card">
    <div class="row">
      <div class="col"><label>Update Duration (minutes)</label><input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5"></div>
      <div class="col"><label>Reason</label><textarea id="reason" rows="3" placeholder="Bug fixes, performance tweaks, new features…"></textarea></div>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-prim" onclick="startUpdate()">🚀 Start Update</button>
      <button class="btn-green" onclick="finishUpdate()">✅ Finish Update</button>
      <button class="btn-amber" onclick="toggleAuto()">🔄 Toggle Auto Update</button>
      <button class="btn-cyan" onclick="toggleAI()">🤖 Toggle AI</button>
      <button class="btn-red" onclick="refreshCmds()">🔁 Refresh Slash Commands</button>
    </div>
    <p style="opacity:.9;margin-top:10px">Countdown: <b id="countdown" class="count pulse">—</b></p>
  </div>

  <div id="tab-server" class="card hidden">
    <h3>Minecraft Bedrock Live Status</h3>
    <div id="mcStatus" class="pulse">Checking…</div><hr/>
    <h3>Autorole</h3>
    <div class="row">
      <div class="col"><label>Role ID</label><input id="roleId" class="input" placeholder="Enter role ID"></div>
      <div class="col" style="display:flex;align-items:flex-end"><button class="btn-cyan" onclick="saveAutorole()">💾 Save Autorole</button></div>
    </div>
  </div>

  <div id="tab-admin" class="card hidden">
    <h3>Admin Slash Commands</h3>
    <pre>/kick /ban /unban /timeout /clear /announce /serverinfo /userinfo /setautorole /lock /unlock /say /botinfo /ping /uptime /minecraft</pre>
  </div>

  <div id="tab-about" class="card hidden">
    <h3>About</h3>
    <p>Developed by <b>Zihuu</b>. Ultra-premium embeds, dashboard, automation and AI.</p>
  </div>
</div>

<script>
const tabs=[...document.querySelectorAll(".tab")];
tabs.forEach(t=>t.onclick=()=>{
  tabs.forEach(x=>x.classList.remove("active")); t.classList.add("active");
  document.querySelectorAll(".card").forEach((c,i)=>{ if(i===0) return; c.classList.add("hidden"); });
  document.getElementById("tab-"+t.dataset.tab).classList.remove("hidden");
});
function setBadge(el,id,on){el.textContent=id+": "+(on?"ON":"OFF"); el.previousElementSibling.style.background=on?"#22c55e":"#ef4444"; el.style.borderColor=on?"rgba(34,197,94,.5)":"rgba(239,68,68,.5)";}
async function badges(){
  const s = await fetch('/api/state').then(r=>r.json());
  setBadge(document.getElementById('autoBadge'),"Auto",s.autoUpdate);
  setBadge(document.getElementById('aiBadge'),"AI",s.aiEnabled);
  document.getElementById('roleId').value=s.autoroleId||'';
}
async function startUpdate(){
  const minutes=Number(document.getElementById('minutes').value||0);
  const reason=document.getElementById('reason').value||"";
  if(!minutes||minutes<1) return alert('Enter minutes (>=1)');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});
}
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); }
async function toggleAuto(){ const r=await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); badges(); alert('Auto Update: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r=await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const roleId=document.getElementById('roleId').value.trim(); const r=await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId})}).then(r=>r.json()); alert(r.success?'Saved.':'Failed.'); }
async function refreshCmds(){ const r=await fetch('/api/refresh-commands',{method:'POST'}).then(r=>r.json()); alert(r.ok?'Commands refreshed.':'Failed.'); }
async function pollStatus(){ const d=await fetch('/api/server-status').then(r=>r.json()); const el=document.getElementById('mcStatus'); el.classList.remove('pulse'); el.textContent=d.online?('🟢 Online — Players: '+d.players+' | Ping: '+d.ping+'ms'):'🔴 Offline'; }
async function tick(){
  const s = await fetch('/api/update-state').then(r=>r.json());
  const cd = document.getElementById('countdown'); const ub = document.getElementById('updBadge'); const dot=ub.previousElementSibling;
  if(!s.active){ cd.textContent='—'; ub.textContent='Update: idle'; dot.style.background="#888"; return; }
  const left = s.endsAt - Date.now();
  cd.textContent = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…';
  ub.textContent = 'Update: '+(s.auto?'auto':'manual');
  dot.style.background="#f59e0b";
}
badges(); pollStatus(); setInterval(pollStatus,10000); setInterval(tick,1000); setTimeout(tick,200);
</script></body></html>`;

// auth middleware
function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  res.redirect("/login");
}

// routes
app.get("/login", (req, res) => res.send(loginHTML.replace("{{ERR}}","")));
app.post("/login", (req, res) => {
  const u = (req.body.username||"").trim().toLowerCase();
  const p = req.body.password||"";
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true; req.session.username = u; return res.redirect("/");
  }
  res.send(loginHTML.replace("{{ERR}}","Invalid credentials."));
});
app.get("/logout", (req, res) => { req.session.destroy(()=>{}); res.redirect("/login"); });
app.get("/", requireAuth, (req, res) => res.send(dashHTML(req.session.username||"admin")));

app.get("/api/state", requireAuth, (_req,res)=>res.json({autoUpdate, aiEnabled, autoroleId}));
app.get("/api/update-state", requireAuth, (_req,res)=>res.json(updateState));
app.post("/api/toggle-auto", requireAuth, (_req,res)=>{ autoUpdate=!autoUpdate; res.json({autoUpdate}); });
app.post("/api/toggle-ai", requireAuth, (_req,res)=>{ aiEnabled=!aiEnabled; res.json({aiEnabled}); });
app.post("/api/autorole", requireAuth, (req,res)=>{ autoroleId=(req.body.roleId||"").trim()||null; res.json({success:true, autoroleId}); });

app.get("/api/server-status", requireAuth, async (_req,res)=>{
  try {
    const st = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online:true, players: st.players.online, ping: st.roundTripLatency });
  } catch {
    res.json({ online:false });
  }
});

// ====== Update flow ======
async function startUpdateFlow({ minutes, reason, auto }) {
  const ch = await client.channels.fetch(CHANNEL_ID);

  // set state ASAP for dashboard
  const now = Date.now();
  updateState = { active:true, auto, reason, startedAt:now, endsAt: now + minutes*60_000, minutes };

  // instant purge + lock + embed (no delay)
  await purgeChannel(ch);
  await lockChannel(ch, true);
  await ch.send({ content: "@everyone", embeds: [updatingEmbed({ minutes, reason, auto })] });

  // schedule finish
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => finishUpdateFlow({ auto }).catch(()=>{}), minutes*60_000);
}

async function finishUpdateFlow({ auto }) {
  const ch = await client.channels.fetch(CHANNEL_ID);
  await purgeChannel(ch);
  await lockChannel(ch, false);
  await ch.send({ content: "@everyone", embeds: [updatedEmbed({ auto })] });
  updateState = { active:false, auto:false, reason:"", startedAt:0, endsAt:0, minutes:0 };
  if (updateTimer) clearTimeout(updateTimer);
}

// manual routes
app.post("/api/start-update", requireAuth, async (req,res)=>{
  try {
    const minutes = Math.max(1, Number(req.body.minutes||1));
    const reason = (req.body.reason||"").toString().slice(0, 1000);
    await startUpdateFlow({ minutes, reason, auto:false });
    res.json({ success:true });
  } catch (e) { console.error("start-update:", e.message); res.json({ success:false, error:e.message }); }
});
app.post("/api/finish-update", requireAuth, async (_req,res)=>{
  try { await finishUpdateFlow({ auto:false }); res.json({ success:true }); }
  catch (e) { console.error("finish-update:", e.message); res.json({ success:false, error:e.message }); }
});

// ====== Auto Update (daily 3:00–3:05 PM Asia/Dhaka) ======
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes: 5, reason: "Scheduled daily maintenance", auto: true }); }
  catch(e){ console.error("auto-start:", e.message); }
}, { timezone: TZ });

cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto: true }); }
  catch(e){ console.error("auto-finish:", e.message); }
}, { timezone: TZ });

// ====== Slash Commands (Admins only) ======
const slashCommands = [
  // moderation
  {
    name: "kick", description: "Kick a member",
    options: [
      { name: "user", description: "User to kick", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "ban", description: "Ban a member",
    options: [
      { name: "user", description: "User to ban", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "unban", description: "Unban by user ID",
    options: [{ name: "userid", description: "User ID", type: 3, required: true }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "timeout", description: "Timeout a member (minutes)",
    options: [
      { name: "user", description: "User", type: 6, required: true },
      { name: "minutes", description: "Duration in minutes", type: 4, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "clear", description: "Clear N messages (max 100)",
    options: [{ name: "amount", description: "1-100", type: 4, required: true }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "lock", description: "Lock current channel",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "unlock", description: "Unlock current channel",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },

  // utility
  {
    name: "announce", description: "Send an announcement (embed) to current channel",
    options: [{ name: "message", description: "Text", type: 3, required: true }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "say", description: "Make the bot say something",
    options: [{ name: "message", description: "Text", type: 3, required: true }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "serverinfo", description: "Show server info",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "userinfo", description: "Show user info",
    options: [{ name: "user", description: "User", type: 6, required: false }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "setautorole", description: "Set autorole by ID or 'off'",
    options: [{ name: "roleid", description: "Role ID or 'off'", type: 3, required: true }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  {
    name: "botinfo", description: "Bot information",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
  { name: "ping", description: "Ping", default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false },
  { name: "uptime", description: "Uptime", default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false },

  // minecraft
  {
    name: "minecraft", description: "Show Minecraft server status",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), dm_permission: false,
  },
];

async function deployCommands(attempt = 1) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const appId = client?.user?.id;
  if (!appId) throw new Error("ClientNotReady");
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: slashCommands });
      console.log(`🔁 Slash commands deployed to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
      console.log("🌐 Slash commands deployed globally (may take time).");
    }
  } catch (e) {
    console.error("Deploy error:", e.message);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return deployCommands(attempt + 1);
    }
    throw e;
  }
}

// refresh via dashboard
app.post("/api/refresh-commands", requireAuth, async (_req,res)=>{
  try { await deployCommands(); return res.json({ ok:true }); }
  catch(e){ console.error("refresh-commands:", e.message); return res.json({ ok:false, error:e.message }); }
});

// interactions
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  if (!isAdmin(i.member)) return i.reply({ content: "❌ Admins only.", ephemeral: true });

  try {
    if (i.commandName === "kick") {
      const user = i.options.getUser("user", true); const reason = i.options.getString("reason") || "No reason";
      const member = await i.guild.members.fetch(user.id);
      await member.kick(reason); await i.reply({ content:`👢 Kicked **${user.tag}** — ${reason}`, ephemeral:true });

    } else if (i.commandName === "ban") {
      const user = i.options.getUser("user", true); const reason = i.options.getString("reason") || "No reason";
      await i.guild.members.ban(user.id, { reason }); await i.reply({ content:`🔨 Banned **${user.tag}** — ${reason}`, ephemeral:true });

    } else if (i.commandName === "unban") {
      const userId = i.options.getString("userid", true);
      await i.guild.bans.remove(userId).catch(()=>{});
      await i.reply({ content:`♻️ Unbanned **${userId}**`, ephemeral:true });

    } else if (i.commandName === "timeout") {
      const user = i.options.getUser("user", true);
      const minutes = Math.max(1, i.options.getInteger("minutes", true));
      const reason = i.options.getString("reason") || "No reason";
      const member = await i.guild.members.fetch(user.id);
      await member.timeout(minutes*60_000, reason);
      await i.reply({ content:`⏳ Timed out **${user.tag}** for **${minutes}m**.`, ephemeral:true });

    } else if (i.commandName === "clear") {
      const amount = Math.max(1, Math.min(100, i.options.getInteger("amount", true)));
      const deleted = await i.channel.bulkDelete(amount, true).catch(()=>null);
      if (!deleted) return i.reply({ content:"⚠️ Could not bulk delete (maybe messages are too old).", ephemeral:true });
      await i.reply({ content:`🧹 Deleted **${deleted.size}** messages.`, ephemeral:true });

    } else if (i.commandName === "lock") {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false });
      await i.reply({ content:"🔒 Channel locked.", ephemeral:true });

    } else if (i.commandName === "unlock") {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: true });
      await i.reply({ content:"🔓 Channel unlocked.", ephemeral:true });

    } else if (i.commandName === "announce") {
      const msg = i.options.getString("message", true);
      const e = ultraEmbed(0x7c3aed, "📣 Announcement", msg);
      await i.channel.send({ content:"@everyone", embeds:[e] });
      await i.reply({ content:"✅ Announcement sent.", ephemeral:true });

    } else if (i.commandName === "say") {
      const msg = i.options.getString("message", true);
      await i.channel.send(msg);
      await i.reply({ content:"✅ Sent.", ephemeral:true });

    } else if (i.commandName === "serverinfo") {
      const g = i.guild;
      const e = ultraEmbed(0x06b6d4, "🛡️ Server Info",
        `**Name:** ${g.name}\n**Members:** ${g.memberCount}\n**ID:** ${g.id}`);
      await i.reply({ embeds:[e], ephemeral:true });

    } else if (i.commandName === "userinfo") {
      const user = i.options.getUser("user") || i.user;
      const m = await i.guild.members.fetch(user.id);
      const e = ultraEmbed(0x06b6d4, "👤 User Info",
        `**User:** ${user.tag}\n**ID:** ${user.id}\n**Joined:** ${m.joinedAt}`);
      await i.reply({ embeds:[e], ephemeral:true });

    } else if (i.commandName === "setautorole") {
      const v = i.options.getString("roleid", true).trim();
      if (v.toLowerCase() === "off") { autoroleId = null; await i.reply({ content:"✅ Autorole disabled.", ephemeral:true }); }
      else { autoroleId = v; await i.reply({ content:`✅ Autorole set to **${autoroleId}**.`, ephemeral:true }); }

    } else if (i.commandName === "botinfo") {
      const up = process.uptime(); const m = Math.floor(up/60), s = Math.floor(up%60);
      const e = ultraEmbed(0x7c3aed, "🤖 Bot Info", `**Uptime:** ${m}m ${s}s`);
      await i.reply({ embeds:[e], ephemeral:true });

    } else if (i.commandName === "ping") {
      await i.reply({ content:`🏓 ${Math.round(client.ws.ping)}ms`, ephemeral:true });

    } else if (i.commandName === "uptime") {
      const up = process.uptime(); const h=Math.floor(up/3600), m=Math.floor((up%3600)/60), s=Math.floor(up%60);
      await i.reply({ content:`⏱️ Uptime: ${h}h ${m}m ${s}s`, ephemeral:true });

    } else if (i.commandName === "minecraft") {
      try {
        const st = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
        const e = ultraEmbed(0x22c55e, "🎮 Minecraft Status", `🟢 Online\nPlayers: ${st.players.online}\nPing: ${st.roundTripLatency}ms`);
        await i.reply({ embeds:[e], ephemeral:true });
      } catch {
        const e = ultraEmbed(0xef4444, "🎮 Minecraft Status", "🔴 Offline");
        await i.reply({ embeds:[e], ephemeral:true });
      }
    }
  } catch (e) {
    console.error("Slash error:", e.message);
    if (!i.replied) await i.reply({ content:"❌ Error executing command.", ephemeral:true });
  }
});

// autorole on join
client.on("guildMemberAdd", async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(()=>null);
    if (role) await member.roles.add(role).catch(()=>{});
  } catch(e){ console.error("autorole:", e.message); }
});

// AI chat (normal text replies) in CHANNEL_ID — context + typing simulation
let aiQueue = Promise.resolve();
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const msgs = buildContext(message.author.id, message.author.username, message.content);
      const ans = await chatOpenAI(msgs);
      saveContext(message.author.id, message.content, ans);
      await typeAndReply(message, ans || "...");
    });
    await aiQueue;
  } catch (e) { console.error("AI error:", e.message); }
});

// ====== Slash deploy on ready ======
async function deployCommandsOnce(attempt = 1) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const appId = client?.user?.id;
  if (!appId) throw new Error("ClientNotReady");
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: slashCommands });
      console.log(`🔁 Slash commands deployed to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
      console.log("🌐 Slash commands deployed globally (may take time).");
    }
  } catch (e) {
    console.error("Deploy error:", e.message);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return deployCommandsOnce(attempt + 1);
    }
    throw e;
  }
}

// alias used by dashboard refresh endpoint
async function deployCommands(){ return deployCommandsOnce(); }

client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await deployCommands(); } catch(e){ console.error("Register cmds failed:", e.message); }
});

// login + web server
client.login(DISCORD_TOKEN);
const server = express();
server.use((req,res,next)=>app(req,res,next));
server.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
