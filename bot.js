require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const https = require("https");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const util = require("minecraft-server-util");

// ====== ENV & CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// Safety: critical envs
if (!DISCORD_TOKEN || !OPENAI_API_KEY || !CHANNEL_ID) {
  console.warn("⚠️ Please set DISCORD_TOKEN, OPENAI_API_KEY, CHANNEL_ID in .env");
}

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ====== AI (robust) ======
const httpsAgent = new https.Agent({ keepAlive: true });
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
        validateStatus: () => true,
      }
    );
    if (res.status >= 200 && res.status < 300) {
      const msg = res.data?.choices?.[0]?.message?.content?.trim();
      if (msg) return msg;
      throw new Error("Empty response");
    }
    if (res.status === 401) throw new Error("INVALID_API_KEY");
    if (TRANSIENT_CODES.has(res.status)) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        return callOpenAI(payload, attempt + 1, modelIndex);
      }
      if (modelIndex + 1 < MODELS.length) return callOpenAI(payload, 1, modelIndex + 1);
    }
    if (modelIndex + 1 < MODELS.length) return callOpenAI(payload, 1, modelIndex + 1);
    throw new Error(`OpenAI ${res.status}: ${JSON.stringify(res.data)}`);
  } catch (err) {
    if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"].includes(err.code)) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        return callOpenAI(payload, attempt + 1, modelIndex);
      }
      if (modelIndex + 1 < MODELS.length) return callOpenAI(payload, 1, modelIndex + 1);
    }
    if (err.message === "INVALID_API_KEY") return "❌ Invalid OpenAI API Key। `.env` চেক করুন।";
    return "⚠️ AI সাড়া দিতে পারছে না। একটু পরে চেষ্টা করুন।";
  }
}
async function askOpenAI(prompt) {
  return callOpenAI({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 600,
  });
}

// ====== Helpers ======
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

function updatingEmbed(minutes, reason) {
  // Premium look, no images
  return new EmbedBuilder()
    .setColor("#f97316")
    .setTitle("🚀 Bot is Updating")
    .setDescription([
      "⚡ **System maintenance has started.**",
      reason ? `🛠️ **Reason:** ${reason}` : "🛠️ **Reason:** Routine maintenance",
      `⏳ **Estimated Duration:** ${minutes} minute(s)`,
      "",
      "Please wait while we upgrade and optimize the system.",
    ].join("\n"))
    .addFields(
      { name: "Developed By", value: "Zihuu", inline: true },
      { name: "Status", value: "Updating…", inline: true },
    )
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

function updatedEmbed() {
  return new EmbedBuilder()
    .setColor("#22c55e")
    .setTitle("✅ Bot Updated Successfully")
    .setDescription("🎉 All systems are online. Enjoy the improved experience!")
    .addFields(
      { name: "Developed By", value: "Zihuu", inline: true },
      { name: "Status", value: "Online", inline: true },
    )
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

// ====== Dashboard (HTML-in-code) ======
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: "cyberland-dashboard-secret", resave: false, saveUninitialized: true }));

function dashboardHTML(autoUpdate) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Cyberland Bot Dashboard</title>
<style>
body{margin:0;background:#0f172a;color:#fff;font-family:Poppins,system-ui,Segoe UI,Roboto,Arial;text-align:center}
.container{max-width:900px;margin:40px auto;padding:0 16px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:22px;margin-bottom:16px;backdrop-filter:blur(8px)}
h1{font-weight:800}
label{display:block;margin:6px 0 4px;text-align:left}
.input,textarea{width:100%;padding:12px 14px;border:none;border-radius:12px;background:rgba(255,255,255,.08);color:#fff}
.row{display:flex;gap:16px;flex-wrap:wrap}
.col{flex:1;min-width:280px}
.btn{margin:8px;padding:14px;border:none;border-radius:12px;cursor:pointer;transition:transform .15s,filter .15s}
.btn:hover{transform:translateY(-1px);filter:brightness(1.08)}
.btn-green{background:#22c55e;color:#fff}
.btn-cyan{background:#06b6d4;color:#fff}
.btn-amber{background:#f59e0b;color:#111}
.kv{opacity:.9;font-size:13px}
.badge{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2)}
</style></head>
<body>
  <div class="container">
    <h1>⚡ Cyberland Premium Bot Dashboard</h1>

    <div class="card">
      <div class="row">
        <div class="col">
          <label for="minutes">Update Duration (minutes)</label>
          <input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5">
        </div>
        <div class="col">
          <label for="reason">Reason for Update</label>
          <textarea id="reason" rows="3" placeholder="Bug fixes, performance improvements, new features..."></textarea>
        </div>
      </div>
      <button class="btn btn-green" onclick="startUpdate()">🚀 Start Update</button>
      <button class="btn btn-cyan" onclick="finishUpdate()">✅ Finish Update</button>
      <p class="kv">Start দিলে: Lock + Purge + @everyone + Premium Embed • Finish দিলে: Unlock + Purge + @everyone + Premium Embed</p>
    </div>

    <div class="row">
      <div class="card col">
        <h3>Auto Update</h3>
        <p>Daily window: 3:00–3:05 PM (Asia/Dhaka)</p>
        <button class="btn btn-amber" onclick="toggleAuto()">🔄 Toggle Auto (${autoUpdate ? "ON" : "OFF"})</button>
      </div>
      <div class="card col">
        <h3>Minecraft Live Status</h3>
        <div id="status">Checking server…</div>
      </div>
    </div>
  </div>

<script>
async function startUpdate(){
  const minutes = Number(document.getElementById('minutes').value||0);
  const reason = document.getElementById('reason').value||"";
  if(!minutes || minutes<1) return alert('Enter minutes (>=1)');
  await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});
  alert('Manual update started for '+minutes+' min');
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
async function pollStatus(){
  const r = await fetch('/api/server-status');
  const d = await r.json();
  document.getElementById('status').innerText = d.online ? ('🟢 Online — Players: '+d.players+' | Ping: '+d.ping+'ms') : '🔴 Offline';
}
pollStatus(); setInterval(pollStatus, 10_000);
</script>
</body></html>`;
}

app.get("/", (req, res) => {
  if (!req.session.loggedIn) {
    return res.send(
      `<form method='POST' action='/login' style="margin:40px;font-family:sans-serif">
        <input type='password' name='password' placeholder='Admin Password' style="padding:10px;border-radius:10px;">
        <button type='submit' style="padding:10px 16px;border-radius:10px;">Login</button>
      </form>`
    );
  }
  res.send(dashboardHTML(autoUpdate));
});

app.post("/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect("/");
  } else res.send("<h2 style='color:red;font-family:sans-serif;margin:30px;'>Invalid Password</h2>");
});

// ====== State ======
let autoUpdate = true;
let manualUpdateTimeout = null;

// ====== API: Start Update (lock + purge + embed) ======
app.post("/api/start-update", async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || "").toString().slice(0, 1000);
    const channel = await client.channels.fetch(CHANNEL_ID);

    // lock + purge
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    await purgeChannel(channel);

    // premium embed (no images), with @everyone
    await channel.send({ content: "@everyone", embeds: [updatingEmbed(minutes, reason)] });

    // schedule auto-finish
    if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
    manualUpdateTimeout = setTimeout(async () => {
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
      await purgeChannel(channel);
      await channel.send({ content: "@everyone", embeds: [updatedEmbed()] });
    }, minutes * 60_000);

    res.json({ success: true });
  } catch (e) {
    console.error("start-update error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ====== API: Finish Update (unlock + purge + embed) ======
app.post("/api/finish-update", async (_req, res) => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    await purgeChannel(channel);
    if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
    await channel.send({ content: "@everyone", embeds: [updatedEmbed()] });
    res.json({ success: true });
  } catch (e) {
    console.error("finish-update error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ====== API: Toggle Auto Update ======
app.post("/api/toggle-auto", (_req, res) => {
  autoUpdate = !autoUpdate;
  res.json({ autoUpdate });
});

// ====== API: Minecraft Status ======
app.get("/api/server-status", async (_req, res) => {
  try {
    const status = await util.status(MINECRAFT_IP, MINECRAFT_PORT);
    res.json({ online: true, players: status.players.online, ping: status.roundTripLatency });
  } catch {
    res.json({ online: false });
  }
});

// ====== Auto Update Window (3:00–3:05 PM) ======
cron.schedule("0 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    await purgeChannel(channel);
    await channel.send({ content: "@everyone", embeds: [updatingEmbed(5, "Scheduled daily maintenance")] });
  } catch (e) { console.error("auto-start error:", e.message); }
}, { timezone: "Asia/Dhaka" });

cron.schedule("5 15 * * *", async () => {
  if (!autoUpdate) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    await purgeChannel(channel);
    await channel.send({ content: "@everyone", embeds: [updatedEmbed()] });
  } catch (e) { console.error("auto-finish error:", e.message); }
}, { timezone: "Asia/Dhaka" });

// ====== Discord: AI chat (normal reply, no embed) ======
let aiQueue = Promise.resolve(); // serialize requests
client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channel.id !== CHANNEL_ID) return;

  // Commands (optional):
  if (message.content === "!help") {
    return void message.reply("Commands: `!help` • Normal chat here for AI reply.");
  }

  await message.channel.sendTyping();
  aiQueue = aiQueue.then(async () => {
    const answer = await askOpenAI(`${message.author.username}: ${message.content}`);
    await message.reply(answer || "⚠️ AI CAN'T GIVE ANSWER RIGHT NOW");
  });
  await aiQueue;
});

// ====== Start ======
client.on("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);

// Express listen (for Railway/Render)
const server = express();
server.use(app);
server.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
