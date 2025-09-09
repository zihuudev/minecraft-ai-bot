require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const util = require("minecraft-server-util");
const https = require("https");

// ====== ENV & CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// Safety: hard-stop if critical vars missing
if (!DISCORD_TOKEN || !OPENAI_API_KEY || !CHANNEL_ID) {
  console.error("❌ Missing REQUIRED env: DISCORD_TOKEN / OPENAI_API_KEY / CHANNEL_ID");
}

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ====== Global State ======
let autoUpdate = true;
let manualUpdateTimeout = null;
let echoMode = false; // 🔁 Echo Mode (say exactly what user says)
let aiBusy = Promise.resolve(); // simple queue: chain promises to serialize AI calls

// ====== HTTP Keep-Alive Agent for OpenAI ======
const httpsAgent = new https.Agent({ keepAlive: true });

// ====== Robust OpenAI Caller (Retry + Backoff + Fallback) ======
const MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo-0125"];
const TRANSIENT_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

async function callOpenAI(payload, attempt = 1, modelIndex = 0) {
  const model = MODELS[modelIndex] || MODELS[MODELS.length - 1];

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { ...payload, model },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        timeout: 75_000,
        httpsAgent,
        validateStatus: () => true, // let us handle non-2xx
      }
    );

    if (res.status >= 200 && res.status < 300) {
      const msg = res.data?.choices?.[0]?.message?.content?.trim();
      if (msg) return msg;
      throw new Error("Empty response from model");
    }

    // If invalid key → return immediately
    if (res.status === 401) {
      throw new Error("INVALID_API_KEY");
    }

    // Retry on transient errors
    if (TRANSIENT_CODES.has(res.status)) {
      if (attempt < 3) {
        const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        await new Promise(r => setTimeout(r, backoff));
        return callOpenAI(payload, attempt + 1, modelIndex);
      }
      // try next model if available
      if (modelIndex + 1 < MODELS.length) {
        return callOpenAI(payload, 1, modelIndex + 1);
      }
      throw new Error(`OpenAI transient error ${res.status}`);
    }

    // Non-transient error: try next model once
    if (modelIndex + 1 < MODELS.length) {
      return callOpenAI(payload, 1, modelIndex + 1);
    }
    throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(res.data)}`);
  } catch (err) {
    // Network / timeout
    const code = err.code || err.message;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
      if (attempt < 3) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
        return callOpenAI(payload, attempt + 1, modelIndex);
      }
      if (modelIndex + 1 < MODELS.length) {
        return callOpenAI(payload, 1, modelIndex + 1);
      }
    }
    if (err.message === "INVALID_API_KEY") {
      return "❌ Invalid OpenAI API Key। দয়া করে `.env` এ সঠিক key সেট করুন।";
    }
    // Final fallback message (never silent)
    return "⚠️ AI সাড়া দিতে পারছে না। একটু পর আবার চেষ্টা করুন।";
  }
}

async function askOpenAI(prompt) {
  const payload = {
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 600,
  };
  return callOpenAI(payload);
}

// ====== Helper: Purge Channel ======
async function purgeChannel(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size > 0) {
        // bulkDelete won't delete messages older than 14 days; just try best-effort
        await channel.bulkDelete(fetched, true).catch(() => {});
        // fallback delete individually if any left
        for (const [, msg] of fetched) {
          await msg.delete().catch(() => {});
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error("Purge error:", e.message);
  }
}

// ====== Premium Embeds (Update) ======
function premiumUpdatingEmbed(minutes) {
  return new EmbedBuilder()
    .setColor("#ff2d55")
    .setTitle("🚀 Cyberland Premium Update In Progress")
    .setDescription(
      [
        "⚡ **System Maintenance Started**",
        `⏳ Estimated Duration: **${minutes} minute(s)**`,
        "",
        "Please wait while we upgrade services and optimize performance.",
      ].join("\n")
    )
    .setImage("https://i.imgur.com/zAeQvOj.gif")
    .setThumbnail("https://i.imgur.com/3R4N3mP.png")
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

function premiumUpdatedEmbed() {
  return new EmbedBuilder()
    .setColor("#22c55e")
    .setTitle("✅ Cyberland Update Completed")
    .setDescription("🎉 All systems are online. Enjoy the improved experience!")
    .setImage("https://i.imgur.com/Ws5lTQ1.gif")
    .setThumbnail("https://i.imgur.com/3R4N3mP.png")
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

// ====== Express Dashboard ======
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "cyberland-dashboard-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// Simple login gate
app.get("/", (req, res) => {
  if (!req.session.loggedIn) {
    return res.send(
      `<form method='POST' action='/login' style="margin:40px;font-family:sans-serif">
        <input type='password' name='password' placeholder='Admin Password' style="padding:10px;border-radius:10px;">
        <button type='submit' style="padding:10px 16px;border-radius:10px;">Login</button>
      </form>`
    );
  }
  res.send(dashboardHTML());
});

app.post("/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect("/");
  } else {
    res.send("<h2 style='color:red;font-family:sans-serif;margin:30px;'>Invalid Password</h2>");
  }
});

// Dynamic dashboard (shows AI mode)
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Cyberland Bot Dashboard</title>
<style>
body{margin:0;background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;font-family:Poppins,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial,"Noto Sans","Apple Color Emoji","Segoe UI Emoji";text-align:center}
.container{max-width:1000px;margin:40px auto;padding:0 16px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;margin-bottom:16px;backdrop-filter: blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.25)}
h1{font-weight:800;letter-spacing:.3px}
.btn{margin:8px;padding:14px 18px;border:none;border-radius:12px;cursor:pointer;transition:transform .15s ease,filter .15s ease}
.btn:hover{transform:translateY(-1px);filter:brightness(1.1)}
.btn-green{background:#22c55e;color:#fff}
.btn-cyan{background:#06b6d4;color:#fff}
.btn-amber{background:#f59e0b;color:#111}
.input{padding:12px 14px;border-radius:12px;border:none;width:220px;margin-right:8px}
.kv{font-size:14px;opacity:.9}
.badge{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;margin-left:6px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2)}
.row{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
.col{flex:1;min-width:280px}
</style></head>
<body>
<div class="container">
  <h1>⚡ Cyberland Premium Bot Dashboard</h1>

  <div class="row">
    <div class="card col">
      <h3>Manual Update</h3>
      <input id="minutes" class="input" type="number" min="1" placeholder="Minutes">
      <button class="btn btn-green" onclick="startUpdate()">🚀 Start Update</button>
      <button class="btn btn-cyan" onclick="finishUpdate()">✅ Finish Update</button>
      <p class="kv">Channel lock + purge + premium embeds + @everyone</p>
    </div>

    <div class="card col">
      <h3>Auto Update</h3>
      <button class="btn btn-amber" onclick="toggleAuto()">🔄 Toggle Auto (${autoUpdate ? "ON" : "OFF"})</button>
      <p class="kv">Daily 3:00–3:05 PM (Asia/Dhaka)</p>
    </div>

    <div class="card col">
      <h3>AI Mode</h3>
      <p>Current: <span class="badge">${echoMode ? "ECHO (repeat everything)" : "SMART (AI chat)"}</span></p>
      <button class="btn btn-cyan" onclick="toggleAI()">🧠 Toggle AI Mode</button>
      <p class="kv">Echo Mode ON হলে বট আপনার বলা **হুবহু** লিখে দেবে।</p>
    </div>
  </div>

  <div class="card">
    <h3>Minecraft Live Status</h3>
    <div id="status">Checking server...</div>
  </div>
</div>

<script>
async function startUpdate(){
  const m = document.getElementById('minutes').value;
  if(!m) return alert('Enter minutes first');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:m})});
  alert('Manual update started for '+m+' min');
}
async function finishUpdate(){
  await fetch('/api/finish-update',{method:'POST'});
  alert('Update finished');
}
async function toggleAuto(){
  const r = await fetch('/api/toggle-auto',{method:'POST'});
  const j = await r.json();
  alert('Auto update is now '+(j.autoUpdate?'ON':'OFF'));
  location.reload();
}
async function toggleAI(){
  const r = await fetch('/api/toggle-ai',{method:'POST'});
  const j = await r.json();
  alert('AI Mode: '+(j.echoMode?'ECHO':'SMART'));
  location.reload();
}
async function pollStatus(){
  const r = await fetch('/api/server-status');
  const d = await r.json();
  document.getElementById('status').innerText = d.online ? ('🟢 Online — Players: '+d.players+' | Ping: '+d.ping+'ms') : '🔴 Offline';
}
pollStatus(); setInterval(pollStatus, 10000);
</script>
</body></html>`;
}

// ====== API Routes ======
app.post("/api/start-update", async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const channel = await client.channels.fetch(CHANNEL_ID);

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    await purgeChannel(channel);

    await channel.send({ content: "@everyone", embeds: [premiumUpdatingEmbed(minutes)] });

    if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
    manualUpdateTimeout = setTimeout(async () => {
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
      await purgeChannel(channel);
      await channel.send({ content: "@everyone", embeds: [premiumUpdatedEmbed()] });
    }, minutes * 60_000);

    res.json({ success: true });
  } catch (e) {
    console.error("start-update error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/finish-update", async (_req, res) => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    await purgeChannel(channel);
    await channel.send({ content: "@everyone", embeds: [premiumUpdatedEmbed()] });
    if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
    res.json({ success: true });
  } catch (e) {
    console.error("finish-update error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/toggle-auto", (_req, res) => {
  autoUpdate = !autoUpdate;
  res.json({ autoUpdate });
});

app.post("/api/toggle-ai", (_req, res) => {
  echoMode = !echoMode;
  res.json({ echoMode });
});

app.get("/api/server-status", async (_req, res) => {
  try {
    const status = await util.status(MINECRAFT_IP, MINECRAFT_PORT);
    res.json({ online: true, players: status.players.online, ping: status.roundTripLatency });
  } catch {
    res.json({ online: false });
  }
});

// ====== Auto Update (3:00–3:05 PM Asia/Dhaka) ======
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    await purgeChannel(channel);
    await channel.send({ content: "@everyone", embeds: [premiumUpdatingEmbed(5)] });
  } catch (e) { console.error("auto start error:", e.message); }
}, { timezone: "Asia/Dhaka" });

cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    await purgeChannel(channel);
    await channel.send({ content: "@everyone", embeds: [premiumUpdatedEmbed()] });
  } catch (e) { console.error("auto finish error:", e.message); }
}, { timezone: "Asia/Dhaka" });

// ====== Discord Message Handler ======
client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channel.id !== CHANNEL_ID) return;

  // Commands (prefix !)
  if (message.content.startsWith("!")) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    const argText = rest.join(" ");

    if (cmd === "echo-on") { echoMode = true; return void message.reply("🔁 Echo Mode **ON**"); }
    if (cmd === "echo-off") { echoMode = false; return void message.reply("🧠 Echo Mode **OFF** (Smart AI)"); }
    if (cmd === "say" && argText) { return void message.reply(argText); }
    if (cmd === "mc") {
      try {
        const s = await util.status(MINECRAFT_IP, MINECRAFT_PORT);
        return void message.reply(`🟢 **${MINECRAFT_IP}:${MINECRAFT_PORT}** — Players: ${s.players.online}, Ping: ${s.roundTripLatency}ms`);
      } catch { return void message.reply(`🔴 **${MINECRAFT_IP}:${MINECRAFT_PORT}** is offline.`); }
    }
    // help
    if (cmd === "help") {
      return void message.reply([
        "**Commands:**",
        "`!echo-on` / `!echo-off` – Toggle Echo Mode",
        "`!say <text>` – Say exactly what you type",
        "`!mc` – Minecraft live status",
        "`!help` – Show this help",
      ].join("\n"));
    }
  }

  // Echo Mode → say exactly what user said
  if (echoMode) {
    return void message.reply(message.content);
  }

  // Smart AI mode (queued to avoid overload)
  await message.channel.sendTyping();
  aiBusy = aiBusy.then(async () => {
    const reply = await askOpenAI(`${message.author.username}: ${message.content}`);
    await message.reply(reply || "⚠️ AI এখন উত্তর দিতে পারছে না।");
  });
  await aiBusy;
});

// ====== Discord Ready ======
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ====== Start ======
client.login(DISCORD_TOKEN);
const appServer = express();
appServer.use(app);
appServer.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
