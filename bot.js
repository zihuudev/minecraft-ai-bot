// ===================== Cyberland Premium Bot — Single File =====================
// Ultra-premium login & dashboard, manual+auto updates, AI chat, slash cmds.
// Developed by Zihuu
// ==============================================================================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const https = require("https");
const cron = require("node-cron");
const moment = require("moment-timezone");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  REST,
  Routes,
} = require("discord.js");
const mcu = require("minecraft-server-util");

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHANNEL_ID = process.env.CHANNEL_ID || "";
const GUILD_ID = process.env.GUILD_ID || "";
const TZ = "Asia/Dhaka";

// Minecraft Bedrock target
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ====== Runtime State ======
let autoUpdate = true;        // daily 3:00–3:05 PM BD
let aiEnabled = true;         // AI chat toggle
let autoroleId = null;        // saved via slash/dashboard
let manualUpdateTimer = null; // setTimeout handle
let updateState = {           // dashboard countdown state
  active: false,
  auto: false,
  reason: "",
  startedAt: 0,
  endsAt: 0,
  minutes: 0,
};
const owoStats = new Map();

// ====== Helpers ======
function isAdmin(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}
async function purgeChannel(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size > 0) {
        await channel.bulkDelete(fetched, true).catch(() => {});
        for (const [, msg] of fetched) await msg.delete().catch(() => {});
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
function fmtMs(ms) {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ====== OpenAI (friendly resilient) ======
const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

async function chatOpenAI(messages, attempt = 1) {
  if (!OPENAI_API_KEY) return "❌ OpenAI key missing.";
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: OPENAI_MODEL, messages, temperature: 0.7, max_tokens: 700 },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        httpsAgent,
        timeout: 75_000,
        validateStatus: () => true,
      }
    );
    if (res.status >= 200 && res.status < 300) {
      return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    }
    if (res.status === 401) return "❌ Invalid OpenAI API Key. Check your environment.";
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return "⚠️ AI service temporarily unavailable. Please try again.";
  } catch (e) {
    if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"].includes(e.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 900 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return "⚠️ AI service temporarily unavailable. Please try again.";
  }
}
function askAI(user, text) {
  const sys = {
    role: "system",
    content:
      "You are a helpful, friendly assistant (ChatGPT style). Keep replies clear, accurate, and kind. If asked about Minecraft, provide useful commands, versions, and practical steps.",
  };
  return chatOpenAI([sys, { role: "user", content: `${user}: ${text}` }]);
}

// ====== Premium Embeds ======
function baseEmbed(hex, title) {
  return new EmbedBuilder()
    .setColor(hex)
    .setTitle(title)
    .setTimestamp();
}
function updatingEmbed({ minutes, reason, auto = false }) {
  const e = baseEmbed("#F59E0B", auto ? "⚡ Automatic Update Started" : "🚀 Update Started");
  e.setDescription(
    "Please wait while we perform maintenance to keep the bot lightning-fast and stable."
  );
  e.addFields(
    { name: "🎉 Status", value: "Bot is updating…", inline: true },
    { name: "🔒 Chat", value: "Locked", inline: true },
    { name: "⚡ Performance", value: "Optimizing", inline: true },
    { name: "⏰ Duration", value: `${minutes} minute(s)`, inline: true },
    { name: "🧠 Update System", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "👨‍💻 Developer", value: "Zihuu", inline: true },
  );
  if (reason) e.addFields({ name: "🛠️ Reason", value: reason });
  return e;
}
function updatedEmbed({ auto = false, completedAtText }) {
  const e = baseEmbed("#22C55E", auto ? "✅ Automatic Update Completed" : "✅ Update Completed");
  e.setDescription("Everything is up-to-date. You can use the bot now.");
  e.addFields(
    { name: "🎉 Status", value: "Ready to use", inline: true },
    { name: "🔓 Chat", value: "Unlocked", inline: true },
    { name: "⚡ Performance", value: "Fast", inline: true },
    { name: "🧠 Update System", value: auto ? "Automatic (daily)" : "Manual", inline: true },
    { name: "👨‍💻 Developer", value: "Zihuu", inline: true },
  );
  if (completedAtText) e.addFields({ name: "🕒 Completed", value: completedAtText, inline: true });
  return e;
}

// ====== Web (Ultra-premium login & dashboard) ======
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

// fixed 3-user login
const USERS = new Map([
  ["zihuu", "cyberlandai90x90x90"],
  ["shahin", "cyberlandai90x90x90"],
  ["mainuddin", "cyberlandai90x90x90"],
]);

const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland • Admin Login</title>
<style>
:root{--bg1:#070b16;--bg2:#0c1326;--text:#e5e7eb;--glass:rgba(255,255,255,.06);--border:rgba(255,255,255,.12);--vio:#7c3aed;--cyan:#06b6d4;--red:#ef4444}
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:
radial-gradient(900px 600px at 10% 10%,#101a39 0%,#0b1220 55%,#070b16 100%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui}
.card{width:95%;max-width:440px;background:var(--glass);border:1px solid var(--border);border-radius:18px;padding:26px;backdrop-filter:blur(10px);box-shadow:0 12px 48px rgba(0,0,0,.45);animation:float 9s ease-in-out infinite}
@keyframes float{0%{transform:translateY(0)}50%{transform:translateY(-7px)}100%{transform:translateY(0)}}
h1{margin:0 0 14px;font-size:22px}
.input{width:100%;padding:12px;border:none;border-radius:12px;background:rgba(255,255,255,.08);color:#fff;outline:none;margin-top:10px}
.btn{width:100%;margin-top:14px;padding:12px 14px;border:none;border-radius:12px;color:#fff;cursor:pointer;background:linear-gradient(135deg,var(--vio),var(--cyan))}
.small{opacity:.8;font-size:12px;margin-top:10px}
.err{color:var(--red);margin-top:10px}
</style></head><body>
  <form class="card" method="POST" action="/login">
    <h1>🔐 Cyberland Admin</h1>
    <input class="input" type="text" name="username" placeholder="Username" required/>
    <input class="input" type="password" name="password" placeholder="Password" required/>
    <button class="btn" type="submit">Login</button>
    <div class="small">Authorized access only • 3 users: zihuu, shahin, mainuddin</div>
    <div class="err">{{ERR}}</div>
  </form>
</body></html>`;

const dashHTML = (username) => `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cyberland Premium Dashboard</title>
<style>
:root{--bg:#0b1220;--glass:rgba(255,255,255,.06);--border:rgba(255,255,255,.12);--text:#e5e7eb;--vio:#7c3aed;--cyan:#06b6d4;--green:#22c55e;--amber:#f59e0b;--red:#ef4444}
*{box-sizing:border-box}body{margin:0;background:
radial-gradient(1200px 800px at 10% 10%,#0f1f3a 0%,#0b1220 45%,#080c16 100%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui}
.container{max-width:1180px;margin:28px auto;padding:0 16px}
h1{font-weight:800;letter-spacing:.3px}
.tabs{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.tab{padding:10px 14px;border-radius:12px;background:var(--glass);border:1px solid var(--border);cursor:pointer;user-select:none}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.35),rgba(6,182,212,.35));border-color:rgba(255,255,255,.22)}
.card{background:var(--glass);border:1px solid var(--border);border-radius:16px;padding:20px;backdrop-filter:blur(10px);margin-bottom:16px;box-shadow:0 10px 36px rgba(0,0,0,.35)}
.row{display:flex;gap:16px;flex-wrap:wrap}.col{flex:1;min-width:280px}
label{display:block;margin:8px 0 6px}
.input,textarea,select{width:100%;padding:12px 14px;border:none;border-radius:12px;background:rgba(255,255,255,.08);color:#fff;outline:none}
button{padding:12px 14px;border:none;border-radius:12px;color:#fff;cursor:pointer;transition:transform .12s,filter .12s}
button:hover{transform:translateY(-1px);filter:brightness(1.06)}
.btn-prim{background:linear-gradient(135deg,var(--vio),var(--cyan))}
.btn-green{background:var(--green)}.btn-amber{background:var(--amber);color:#111}.btn-cyan{background:var(--cyan)}.btn-red{background:var(--red)}
.badge{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);margin-left:8px}
.hidden{display:none}hr{border:none;height:1px;background:var(--border);margin:16px 0}
#countdown{font-weight:700}
pre{background:rgba(255,255,255,.06);padding:12px;border-radius:12px;overflow:auto;max-height:260px}
.topbar{display:flex;align-items:center;justify-content:space-between}
</style></head>
<body>
<div class="container">
  <div class="topbar">
    <h1>⚡ Cyberland Premium Dashboard
      <span id="autoState" class="badge">Auto: ...</span>
      <span id="aiState" class="badge">AI: ...</span>
      <span id="updState" class="badge">Update: idle</span>
    </h1>
    <div>Logged in as <b>${username}</b> • <a href="/logout" style="color:#93c5fd">Logout</a></div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="commands">Commands</div>
    <div class="tab" data-tab="settings">Settings</div>
  </div>

  <div id="tab-updates" class="card">
    <div class="row">
      <div class="col"><label>Update Duration (minutes)</label><input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5"/></div>
      <div class="col"><label>Reason for Update</label><textarea id="reason" rows="3" placeholder="Bug fixes, performance, features..."></textarea></div>
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-prim" onclick="startUpdate()">🚀 Start Update</button>
      <button class="btn-green" onclick="finishUpdate()">✅ Finish Update</button>
      <button class="btn-amber" onclick="toggleAuto()">🔄 Toggle Auto Update</button>
      <button class="btn-cyan" onclick="toggleAI()">🤖 Toggle AI</button>
      <button class="btn-red" onclick="refreshCommands()">♻️ Refresh Slash Commands</button>
    </div>
    <p style="opacity:.85;margin-top:10px">Live countdown: <b id="countdown">—</b></p>
  </div>

  <div id="tab-server" class="card hidden">
    <h3>Minecraft Bedrock Live Status</h3>
    <div id="mcStatus">Checking...</div><hr/>
    <h3>Autorole</h3>
    <div class="row">
      <div class="col"><label>Role ID</label><input id="roleId" class="input" placeholder="Enter Role ID"/></div>
      <div class="col" style="display:flex;align-items:flex-end"><button class="btn-cyan" onclick="saveAutorole()">💾 Save Autorole</button></div>
    </div>
  </div>

  <div id="tab-commands" class="card hidden">
    <h3>Slash Commands</h3>
    <p class="kv">/kick /ban /timeout /autorole /owostats /refresh (Admins only)</p>
    <pre id="cmdList">Loading...</pre>
  </div>

  <div id="tab-settings" class="card hidden">
    <h3>AI Settings</h3>
    <p>AI replies in <code>CHANNEL_ID</code> as normal messages (no embeds).</p>
  </div>
</div>

<script>
const tabs=[...document.querySelectorAll(".tab")];
tabs.forEach(t=>t.onclick=()=>{
  tabs.forEach(x=>x.classList.remove("active")); t.classList.add("active");
  document.querySelectorAll(".card").forEach(c=>c.classList.add("hidden"));
  document.getElementById("tab-"+t.dataset.tab).classList.remove("hidden");
});
async function badges(){
  const s = await fetch('/api/state').then(r=>r.json());
  document.getElementById('autoState').innerText='Auto: '+(s.autoUpdate?'ON':'OFF');
  document.getElementById('aiState').innerText='AI: '+(s.aiEnabled?'ON':'OFF');
  document.getElementById('roleId').value=s.autoroleId||'';
}
async function startUpdate(){
  const minutes=Number(document.getElementById('minutes').value||0);
  const reason=document.getElementById('reason').value||"";
  if(!minutes||minutes<1) return alert('Enter minutes (>=1)');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});
}
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); }
async function toggleAuto(){ const r=await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); alert('Auto Update is now '+(r.autoUpdate?'ON':'OFF')); badges(); }
async function toggleAI(){ const r=await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); alert('AI is now '+(r.aiEnabled?'ON':'OFF')); badges(); }
async function saveAutorole(){ const roleId=document.getElementById('roleId').value.trim(); const r=await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId})}).then(r=>r.json()); alert(r.success?'Autorole saved.':'Failed to save.'); }
async function pollStatus(){ const d=await fetch('/api/server-status').then(r=>r.json()); document.getElementById('mcStatus').innerText=d.online?('🟢 Online — Players: '+d.players+' | Ping: '+d.ping+'ms'):'🔴 Offline'; }
async function refreshCommands(){ await fetch('/api/refresh-commands',{method:'POST'}); alert('Slash commands refresh requested.'); loadCmds(); }
async function loadCmds(){ const data=await fetch('/api/commands').then(r=>r.json()).catch(()=>({error:'Fetch failed'})); document.getElementById('cmdList').textContent=JSON.stringify(data,null,2); }
badges(); pollStatus(); loadCmds(); setInterval(pollStatus,10000);

// Live countdown (no refresh)
async function tick(){
  const s = await fetch('/api/update-state').then(r=>r.json());
  const cd = document.getElementById('countdown');
  const badge = document.getElementById('updState');
  if(!s.active){ cd.textContent='—'; badge.textContent='Update: idle'; return; }
  const left = s.endsAt - Date.now();
  cd.textContent = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…';
  badge.textContent = 'Update: '+(s.auto?'auto':'manual');
}
setInterval(tick, 1000); setTimeout(tick, 200);
</script>
</body></html>`;

// middleware
function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  res.redirect("/login");
}

app.get("/login", (req, res) => {
  res.send(loginHTML.replace("{{ERR}}", ""));
});
app.post("/login", (req, res) => {
  const u = (req.body.username || "").trim().toLowerCase();
  const p = req.body.password || "";
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true;
    req.session.username = u;
    return res.redirect("/");
  }
  res.send(loginHTML.replace("{{ERR}}", "Invalid credentials."));
});
app.get("/logout", (req, res) => {
  req.session.destroy(()=>{});
  res.redirect("/login");
});

app.get("/", requireAuth, (req, res) => {
  res.send(dashHTML(req.session.username || "admin"));
});

// state
app.get("/api/state", requireAuth, (_req, res) => res.json({ autoUpdate, aiEnabled, autoroleId }));
app.get("/api/update-state", requireAuth, (_req, res) => res.json(updateState));
app.post("/api/toggle-ai", requireAuth, (_req, res) => { aiEnabled = !aiEnabled; res.json({ aiEnabled }); });
app.post("/api/toggle-auto", requireAuth, (_req, res) => { autoUpdate = !autoUpdate; res.json({ autoUpdate }); });
app.post("/api/autorole", requireAuth, (req, res) => { autoroleId = (req.body.roleId || "").trim() || null; res.json({ success: true, autoroleId }); });

// mc status
app.get("/api/server-status", requireAuth, async (_req, res) => {
  try {
    const st = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online: true, players: st.players.online, ping: st.roundTripLatency });
  } catch {
    res.json({ online: false });
  }
});

// ====== Manual Update Flow ======
async function startUpdateFlow({ minutes, reason, auto }) {
  const ch = await client.channels.fetch(CHANNEL_ID);

  // set state immediately for dashboard (so countdown starts at once)
  const now = Date.now();
  updateState = {
    active: true, auto, reason,
    startedAt: now,
    endsAt: now + minutes * 60_000,
    minutes
  };

  // instant purge + lock + premium embed
  await purgeChannel(ch);
  await lockChannel(ch, true);
  await ch.send({ content: "@everyone", embeds: [updatingEmbed({ minutes, reason, auto })] });

  // schedule finish
  if (manualUpdateTimer) clearTimeout(manualUpdateTimer);
  manualUpdateTimer = setTimeout(async () => {
    await finishUpdateFlow({ auto });
  }, minutes * 60_000);
}

async function finishUpdateFlow({ auto }) {
  const ch = await client.channels.fetch(CHANNEL_ID);
  // purge then unlock then premium "completed"
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const timeText = moment().tz(TZ).format("MMM D, h:mm A");
  await ch.send({ content: "@everyone", embeds: [updatedEmbed({ auto, completedAtText: timeText })] });
  updateState = { active: false, auto: false, reason: "", startedAt: 0, endsAt: 0, minutes: 0 };
  if (manualUpdateTimer) clearTimeout(manualUpdateTimer);
}

// routes for manual control
app.post("/api/start-update", requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || "").toString().slice(0, 1000);
    await startUpdateFlow({ minutes, reason, auto: false });
    res.json({ success: true });
  } catch (e) { console.error("start-update:", e.message); res.json({ success: false, error: e.message }); }
});

app.post("/api/finish-update", requireAuth, async (_req, res) => {
  try {
    await finishUpdateFlow({ auto: false });
    res.json({ success: true });
  } catch (e) { console.error("finish-update:", e.message); res.json({ success: false, error: e.message }); }
});

// ====== Slash Commands (Admins only) ======
const slashCommands = [
  {
    name: "kick",
    description: "Kick a member",
    options: [
      { name: "user", description: "User to kick", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      { name: "user", description: "User to ban", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
  },
  {
    name: "timeout",
    description: "Timeout a member (minutes)",
    options: [
      { name: "user", description: "User to timeout", type: 6, required: true },
      { name: "minutes", description: "Duration in minutes", type: 4, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
  },
  {
    name: "autorole",
    description: "Set autorole ID (or 'off' to disable)",
    options: [{ name: "roleid", description: "Role ID or 'off'", type: 3, required: true }],
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
  },
  {
    name: "owostats",
    description: "Show your OwO-style message count",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
  },
  {
    name: "refresh",
    description: "Refresh slash commands now",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
  },
];

async function deployCommands({ guildId = "" } = {}, attempt = 1) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    const appId = client?.user?.id;
    if (!appId) throw new Error("ClientNotReady");
    if (guildId || GUILD_ID) {
      const gid = guildId || GUILD_ID;
      await rest.put(Routes.applicationGuildCommands(appId, gid), { body: slashCommands });
      console.log(`🔁 Slash commands deployed to guild ${gid}`);
      return { scope: "guild", guildId: gid };
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
      console.log("🌐 Slash commands deployed globally (can take time).");
      return { scope: "global" };
    }
  } catch (e) {
    console.error("Deploy error:", e.message);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return deployCommands({ guildId }, attempt + 1);
    }
    throw e;
  }
}

app.post("/api/refresh-commands", requireAuth, async (_req, res) => {
  try {
    const out = await deployCommands({ guildId: GUILD_ID || "" });
    res.json({ success: true, ...out });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
app.get("/api/commands", requireAuth, async (_req, res) => {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const appId = client?.user?.id;
    if (!appId) return res.json({ error: "Client not ready" });
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(appId, GUILD_ID)
      : Routes.applicationCommands(appId);
    const data = await rest.get(route);
    res.json(data);
  } catch (e) { res.json({ error: e.message }); }
});

// ====== Auto Update (3:00–3:05 PM Asia/Dhaka) ======
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    await startUpdateFlow({ minutes: 5, reason: "Scheduled daily maintenance", auto: true });
  } catch (e) { console.error("auto-start:", e.message); }
}, { timezone: TZ });

cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    await finishUpdateFlow({ auto: true });
  } catch (e) { console.error("auto-finish:", e.message); }
}, { timezone: TZ });

// ====== Interactions ======
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
  }
  try {
    if (interaction.commandName === "kick") {
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      await interaction.reply({ content: `👢 Kicked **${user.tag}** — ${reason}`, ephemeral: true });
    } else if (interaction.commandName === "ban") {
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided";
      await interaction.guild.members.ban(user.id, { reason });
      await interaction.reply({ content: `🔨 Banned **${user.tag}** — ${reason}`, ephemeral: true });
    } else if (interaction.commandName === "timeout") {
      const user = interaction.options.getUser("user", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(Math.max(1, minutes) * 60_000, reason);
      await interaction.reply({ content: `⏳ Timed out **${user.tag}** for **${minutes}** minute(s).`, ephemeral: true });
    } else if (interaction.commandName === "autorole") {
      const roleStr = interaction.options.getString("roleid", true).trim();
      if (roleStr.toLowerCase() === "off") {
        autoroleId = null;
        return interaction.reply({ content: "✅ Autorole disabled.", ephemeral: true });
      }
      autoroleId = roleStr;
      await interaction.reply({ content: `✅ Autorole set to **${autoroleId}**.`, ephemeral: true });
    } else if (interaction.commandName === "owostats") {
      const count = owoStats.get(interaction.user.id) || 0;
      await interaction.reply({ content: `🌟 **${interaction.user.username}**, your OwO score: **${count}**`, ephemeral: true });
    } else if (interaction.commandName === "refresh") {
      const gid = GUILD_ID || interaction.guildId;
      await deployCommands({ guildId: gid });
      await interaction.reply({ content: "♻️ Slash commands refreshed.", ephemeral: true });
    }
  } catch (e) {
    console.error("Slash error:", e.message);
    if (!interaction.replied) {
      await interaction.reply({ content: "❌ Error executing command.", ephemeral: true });
    }
  }
});

// ====== Autorole on join ======
client.on("guildMemberAdd", async (member) => {
  try {
    if (!autoroleId) return;
    const role =
      member.guild.roles.cache.get(autoroleId) ||
      (await member.guild.roles.fetch(autoroleId).catch(() => null));
    if (role) await member.roles.add(role).catch(() => {});
  } catch (e) { console.error("autorole:", e.message); }
});

// ====== AI Chat (normal replies) ======
let aiQueue = Promise.resolve();
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    owoStats.set(message.author.id, (owoStats.get(message.author.id) || 0) + 1);

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const ans = await askAI(message.author.username, message.content);
      await message.reply(ans || "...");
    });
    await aiQueue;
  } catch (e) { console.error("AI error:", e.message); }
});

// ====== Ready: deploy slash commands ======
client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await deployCommands({ guildId: GUILD_ID || "" }); // guild = instant
  } catch (e) { console.error("Register commands failed:", e.message); }
});

// ====== Bootstrap ======
client.login(DISCORD_TOKEN);
const server = express();
server.use((req, res, next) => app(req, res, next));
server.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
