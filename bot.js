require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const https = require("https");
const moment = require("moment-timezone");
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, Routes, Partials, REST } = require("discord.js");
const mcu = require("minecraft-server-util");

// ==== ENV / CONFIG ====
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;       // AI chat + updates channel
const GUILD_ID = process.env.GUILD_ID || null;   // (optional) faster slash command register if set
const AI_ENABLED_DEFAULT = process.env.AI_ENABLED === "false" ? false : true;

const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132; // Bedrock

if (!DISCORD_TOKEN || !OPENAI_API_KEY || !CHANNEL_ID) {
  console.warn("⚠️ Please set DISCORD_TOKEN, OPENAI_API_KEY, CHANNEL_ID (and optionally GUILD_ID) in .env");
}

// ==== DISCORD CLIENT ====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
});

// ==== STATE (in-memory) ====
let autoUpdate = true;
let manualUpdateTimer = null;
let aiEnabled = AI_ENABLED_DEFAULT;
let autoroleId = null; // set via /autorole or dashboard
const owoStats = new Map(); // userId -> number

// ==== OPENAI (robust, retries, model fallback) ====
const httpsAgent = new https.Agent({ keepAlive: true });
const MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo-0125"];
const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504]);

async function callOpenAI(messages, attempt = 1, modelIndex = 0) {
  const model = MODELS[modelIndex] || MODELS[MODELS.length - 1];
  const payload = { model, messages, temperature: 0.7, max_tokens: 700 };
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      timeout: 75_000,
      httpsAgent,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
      throw new Error("Empty OpenAI response");
    }
    if (res.status === 401) throw new Error("INVALID_KEY");
    if (TRANSIENT.has(res.status)) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        return callOpenAI(messages, attempt + 1, modelIndex);
      }
      if (modelIndex + 1 < MODELS.length) return callOpenAI(messages, 1, modelIndex + 1);
    }
    if (modelIndex + 1 < MODELS.length) return callOpenAI(messages, 1, modelIndex + 1);
    throw new Error(`OpenAIError:${res.status}`);
  } catch (err) {
    if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"].includes(err.code)) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        return callOpenAI(messages, attempt + 1, modelIndex);
      }
      if (modelIndex + 1 < MODELS.length) return callOpenAI(messages, 1, modelIndex + 1);
    }
    if (err.message === "INVALID_KEY") return "❌ Invalid OpenAI API Key. Check .env.";
    return "⚠️ AI service is temporarily unavailable. Please try again later.";
  }
}

async function askAI(user, text) {
  const prompt = `${user}: ${text}`;
  return callOpenAI([{ role: "user", content: prompt }]);
}

// ==== EMBEDS (Ultra Premium, no images) ====
function updatingEmbed({ minutes, reason, auto = false }) {
  return new EmbedBuilder()
    .setColor("#F59E0B")
    .setTitle(auto ? "⚡ Auto Update — In Progress" : "🚀 Bot Updating — In Progress")
    .setDescription([
      "System maintenance has started.",
      reason ? `🛠️ **Reason:** ${reason}` : "🛠️ **Reason:** Routine maintenance",
      `⏳ **Estimated Duration:** ${minutes} minute(s)`,
      "🔒 Channel is temporarily locked.",
    ].join("\n"))
    .addFields(
      { name: "Developed By", value: "Zihuu", inline: true },
      { name: "Status", value: "Updating…", inline: true },
    )
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

function updatedEmbed({ auto = false }) {
  return new EmbedBuilder()
    .setColor("#22C55E")
    .setTitle(auto ? "✅ Auto Update — Completed" : "✅ Bot Updated Successfully")
    .setDescription([
      "All systems are online.",
      "Channel is unlocked. Enjoy the improved experience!",
    ].join("\n"))
    .addFields(
      { name: "Developed By", value: "Zihuu", inline: true },
      { name: "Status", value: "Online", inline: true },
    )
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

// ==== HELPERS ====
async function purgeChannel(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size > 0) {
        await channel.bulkDelete(fetched, true).catch(() => {});
        for (const [, msg] of fetched) { await msg.delete().catch(() => {}); }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error("Purge error:", e.message);
  }
}

async function lockChannel(channel, locked) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: !locked ? true : false });
}

// ==== DASHBOARD (single-file, glassmorphism, tabs) ====
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: "cyberland-dashboard-secret", resave: false, saveUninitialized: true }));

const dashboard = () => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Cyberland Premium Dashboard</title>
<style>
:root{--bg:#0b1220;--glass:rgba(255,255,255,.06);--border:rgba(255,255,255,.12);--text:#e5e7eb;--acc1:#7c3aed;--acc2:#06b6d4;--acc3:#22c55e;--acc4:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 800px at 10% 10%,#0f1f3a 0%,#0b1220 45%,#080c16 100%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
.container{max-width:1080px;margin:32px auto;padding:0 16px}
h1{font-weight:800;letter-spacing:.3px}
.tabs{display:flex;gap:8px;margin:18px 0}
.tab{padding:10px 14px;border-radius:12px;background:var(--glass);border:1px solid var(--border);cursor:pointer;user-select:none}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.35),rgba(6,182,212,.35));border-color:rgba(255,255,255,.22)}
.card{background:var(--glass);border:1px solid var(--border);border-radius:16px;padding:20px;backdrop-filter:blur(8px);margin-bottom:16px}
.row{display:flex;gap:16px;flex-wrap:wrap}
.col{flex:1;min-width:280px}
label{display:block;margin:8px 0 6px}
.input,textarea,select{width:100%;padding:12px 14px;border:none;border-radius:12px;background:rgba(255,255,255,.08);color:#fff;outline:none}
button{padding:12px 14px;border:none;border-radius:12px;color:#fff;cursor:pointer;transition:transform .12s,filter .12s}
button:hover{transform:translateY(-1px);filter:brightness(1.06)}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#06b6d4)}
.btn-green{background:#22c55e}.btn-amber{background:#f59e0b;color:#111}.btn-cyan{background:#06b6d4}.btn-danger{background:#ef4444}
.kv{opacity:.85;font-size:13px}
.badge{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);margin-left:8px}
.hidden{display:none}
hr{border:none;height:1px;background:var(--border);margin:16px 0}
</style>
</head>
<body>
<div class="container">
  <h1>⚡ Cyberland Premium Dashboard <span id="autoState" class="badge">Auto Update: ...</span> <span id="aiState" class="badge">AI: ...</span></h1>

  <div class="tabs">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="commands">Commands</div>
    <div class="tab" data-tab="settings">Settings</div>
  </div>

  <!-- Updates -->
  <div id="tab-updates" class="card">
    <div class="row">
      <div class="col">
        <label>Update Duration (minutes)</label>
        <input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5" />
      </div>
      <div class="col">
        <label>Reason for Update</label>
        <textarea id="reason" rows="3" placeholder="Bug fixes, performance, features..."></textarea>
      </div>
    </div>
    <div style="margin-top:8px">
      <button class="btn-primary" onclick="startUpdate()">🚀 Start Update</button>
      <button class="btn-green" onclick="finishUpdate()">✅ Finish Update</button>
      <button class="btn-amber" onclick="toggleAuto()">🔄 Toggle Auto Update</button>
    </div>
    <p class="kv">Start → Purge + Lock + @everyone + Premium Embed • Finish → Purge + Unlock + @everyone + Premium Embed • Daily Auto: 3:00–3:05 PM (Asia/Dhaka)</p>
  </div>

  <!-- Server -->
  <div id="tab-server" class="card hidden">
    <h3>Minecraft Bedrock Live Status</h3>
    <div id="mcStatus">Checking...</div>
    <hr/>
    <h3>Autorole</h3>
    <div class="row">
      <div class="col">
        <label>Role ID (to auto-assign on join)</label>
        <input id="roleId" class="input" placeholder="Enter Role ID"/>
      </div>
      <div class="col" style="display:flex;align-items:flex-end">
        <button class="btn-cyan" onclick="saveAutorole()">💾 Save Autorole</button>
      </div>
    </div>
  </div>

  <!-- Commands -->
  <div id="tab-commands" class="card hidden">
    <h3>Slash Commands</h3>
    <p class="kv">Available: <code>/kick</code>, <code>/ban</code>, <code>/timeout</code>, <code>/autorole</code>, <code>/owostats</code>, <code>/refresh</code></p>
    <button class="btn-amber" onclick="refreshCommands()">♻️ Refresh Slash Commands</button>
  </div>

  <!-- Settings -->
  <div id="tab-settings" class="card hidden">
    <h3>AI Settings</h3>
    <button class="btn-amber" onclick="toggleAI()">🔁 Toggle AI</button>
    <p class="kv">AI replies normally in the configured channel (no embed).</p>
  </div>
</div>

<script>
const tabs = document.querySelectorAll(".tab");
tabs.forEach(t => t.onclick = () => {
  tabs.forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  document.querySelectorAll(".card").forEach(c => c.classList.add("hidden"));
  document.getElementById("tab-" + t.dataset.tab).classList.remove("hidden");
});

async function loadBadges() {
  const s = await fetch('/api/state').then(r=>r.json());
  document.getElementById('autoState').innerText = 'Auto Update: ' + (s.autoUpdate ? 'ON' : 'OFF');
  document.getElementById('aiState').innerText = 'AI: ' + (s.aiEnabled ? 'ON' : 'OFF');
  document.getElementById('roleId').value = s.autoroleId || '';
}
async function startUpdate(){
  const minutes = Number(document.getElementById('minutes').value||0);
  const reason = document.getElementById('reason').value||"";
  if(!minutes || minutes<1) return alert('Enter minutes (>=1)');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});
  alert('Update started.');
}
async function finishUpdate(){
  await fetch('/api/finish-update',{method:'POST'});
  alert('Update finished.');
}
async function toggleAuto(){
  const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json());
  alert('Auto Update is now '+(r.autoUpdate?'ON':'OFF'));
  loadBadges();
}
async function toggleAI(){
  const r = await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json());
  alert('AI is now '+(r.aiEnabled?'ON':'OFF'));
  loadBadges();
}
async function refreshCommands(){
  await fetch('/api/refresh-commands',{method:'POST'});
  alert('Slash commands refresh requested.');
}
async function saveAutorole(){
  const roleId = document.getElementById('roleId').value.trim();
  const r = await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId})}).then(r=>r.json());
  alert(r.success ? 'Autorole saved.' : 'Failed to save autorole.');
}
async function pollStatus(){
  const d = await fetch('/api/server-status').then(r=>r.json());
  const el = document.getElementById('mcStatus');
  el.innerText = d.online ? ('🟢 Online — Players: '+d.players+' | Ping: '+d.ping+'ms') : '🔴 Offline';
}
loadBadges(); pollStatus(); setInterval(pollStatus, 10000);
</script>
</body></html>`;

// ==== AUTH + DASH ====
app.get("/", (req, res) => {
  if (!req.session.loggedIn) {
    return res.send(`<form method='POST' action='/login' style="margin:40px;font-family:sans-serif">
      <input type='password' name='password' placeholder='Admin Password' style="padding:10px;border-radius:10px;">
      <button type='submit' style="padding:10px 16px;border-radius:10px;">Login</button>
    </form>`);
  }
  res.send(dashboard());
});

app.post("/login", (req, res) => {
  if ((req.body.password || "") === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect("/");
  } else res.status(403).send("<h2 style='color:red;font-family:sans-serif;margin:30px;'>Invalid Password</h2>");
});

// ==== API ====
app.get("/api/state", (_req, res) => res.json({ autoUpdate, aiEnabled, autoroleId }));

app.post("/api/toggle-ai", (_req, res) => {
  aiEnabled = !aiEnabled;
  res.json({ aiEnabled });
});

app.post("/api/autorole", (req, res) => {
  autoroleId = (req.body.roleId || "").trim() || null;
  res.json({ success: true, autoroleId });
});

app.get("/api/server-status", async (_req, res) => {
  try {
    const status = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 3000 });
    res.json({ online: true, players: status.players.online, ping: status.roundTripLatency });
  } catch {
    res.json({ online: false });
  }
});

app.post("/api/start-update", async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || "").toString().slice(0, 1000);
    const channel = await client.channels.fetch(CHANNEL_ID);

    // Purge first, then lock, then embed IMMEDIATELY
    await purgeChannel(channel);
    await lockChannel(channel, true);
    await channel.send({ content: "@everyone", embeds: [updatingEmbed({ minutes, reason, auto:false })] });

    if (manualUpdateTimer) clearTimeout(manualUpdateTimer);
    manualUpdateTimer = setTimeout(async () => {
      await purgeChannel(channel);
      await lockChannel(channel, false);
      await channel.send({ content: "@everyone", embeds: [updatedEmbed({ auto:false })] });
    }, minutes * 60_000);

    res.json({ success: true });
  } catch (e) {
    console.error("start-update:", e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/finish-update", async (_req, res) => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await purgeChannel(channel);
    await lockChannel(channel, false);
    if (manualUpdateTimer) clearTimeout(manualUpdateTimer);
    await channel.send({ content: "@everyone", embeds: [updatedEmbed({ auto:false })] });
    res.json({ success: true });
  } catch (e) {
    console.error("finish-update:", e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/toggle-auto", (_req, res) => {
  autoUpdate = !autoUpdate;
  res.json({ autoUpdate });
});

app.post("/api/refresh-commands", async (_req, res) => {
  try {
    await registerSlashCommands();
    res.json({ success: true });
  } catch (e) {
    console.error("refresh-commands:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ==== AUTO UPDATE (3:00–3:05 PM Asia/Dhaka) ====
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await purgeChannel(channel);
    await lockChannel(channel, true);
    await channel.send({ content: "@everyone", embeds: [updatingEmbed({ minutes:5, reason:"Scheduled daily maintenance", auto:true })] });
  } catch (e) { console.error("auto-start:", e.message); }
}, { timezone: "Asia/Dhaka" });

cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await purgeChannel(channel);
    await lockChannel(channel, false);
    await channel.send({ content: "@everyone", embeds: [updatedEmbed({ auto:true })] });
  } catch (e) { console.error("auto-finish:", e.message); }
}, { timezone: "Asia/Dhaka" });

// ==== SLASH COMMANDS ====
const slashCommands = [
  {
    name: "kick",
    description: "Kick a member",
    options: [{ name: "user", description: "User to kick", type: 6, required: true }, { name: "reason", description: "Reason", type: 3, required: false }],
    default_member_permissions: PermissionsBitField.Flags.KickMembers.toString(),
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [{ name: "user", description: "User to ban", type: 6, required: true }, { name: "reason", description: "Reason", type: 3, required: false }],
    default_member_permissions: PermissionsBitField.Flags.BanMembers.toString(),
  },
  {
    name: "timeout",
    description: "Timeout a member (minutes)",
    options: [
      { name: "user", description: "User to timeout", type: 6, required: true },
      { name: "minutes", description: "Duration in minutes", type: 4, required: true },
      { name: "reason", description: "Reason", type: 3, required: false },
    ],
    default_member_permissions: PermissionsBitField.Flags.ModerateMembers.toString(),
  },
  {
    name: "autorole",
    description: "Set autorole ID (or 'off' to disable)",
    options: [{ name: "roleid", description: "Role ID or 'off'", type: 3, required: true }],
    default_member_permissions: PermissionsBitField.Flags.ManageRoles.toString(),
  },
  {
    name: "owostats",
    description: "Show your OwO-style message count",
  },
  {
    name: "refresh",
    description: "Refresh slash commands now",
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
  },
];

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: slashCommands });
    console.log("🔁 Slash commands registered (guild).");
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log("🔁 Slash commands registered (global).");
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "kick") {
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      await interaction.reply({ content: `👢 Kicked **${user.tag}** — ${reason}`, ephemeral: true });
    }

    if (interaction.commandName === "ban") {
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided";
      await interaction.guild.members.ban(user.id, { reason });
      await interaction.reply({ content: `🔨 Banned **${user.tag}** — ${reason}`, ephemeral: true });
    }

    if (interaction.commandName === "timeout") {
      const user = interaction.options.getUser("user", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(user.id);
      const ms = Math.max(1, minutes) * 60_000;
      await member.timeout(ms, reason);
      await interaction.reply({ content: `⏳ Timed out **${user.tag}** for **${minutes}** minute(s).`, ephemeral: true });
    }

    if (interaction.commandName === "autorole") {
      const roleStr = interaction.options.getString("roleid", true).trim();
      if (roleStr.toLowerCase() === "off") {
        autoroleId = null;
        return interaction.reply({ content: "✅ Autorole disabled.", ephemeral: true });
      }
      autoroleId = roleStr;
      await interaction.reply({ content: `✅ Autorole set to **${autoroleId}**.`, ephemeral: true });
    }

    if (interaction.commandName === "owostats") {
      const count = owoStats.get(interaction.user.id) || 0;
      await interaction.reply({ content: `🌟 **${interaction.user.username}**, your OwO score: **${count}**`, ephemeral: true });
    }

    if (interaction.commandName === "refresh") {
      await registerSlashCommands();
      await interaction.reply({ content: "♻️ Slash commands refreshed.", ephemeral: true });
    }
  } catch (e) {
    console.error("Slash error:", e.message);
    if (!interaction.replied) {
      await interaction.reply({ content: "❌ Error executing command.", ephemeral: true });
    }
  }
});

// Autorole on join
client.on("guildMemberAdd", async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(() => null);
    if (role) await member.roles.add(role).catch(() => {});
  } catch (e) { console.error("autorole:", e.message); }
});

// ==== AI CHAT (normal reply, no embeds) ====
let aiQueue = Promise.resolve();
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    // fun counter
    owoStats.set(message.author.id, (owoStats.get(message.author.id) || 0) + 1);

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const ans = await askAI(message.author.username, message.content);
      await message.reply(ans || "...");
    });
    await aiQueue;
  } catch (e) {
    console.error("AI error:", e.message);
  }
});

// ==== READY + REGISTER CMDS ====
client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerSlashCommands();
  } catch (e) {
    console.error("Register commands on ready:", e.message);
  }
});

client.login(DISCORD_TOKEN);

// ==== START EXPRESS SERVER ====
const server = express();
server.use((req, _res, next) => {
  // mount app under root
  return app(req, _res, next);
});
server.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
