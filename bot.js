require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const https = require("https");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const util = require("minecraft-server-util");

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== OpenAI Config =====
const httpsAgent = new https.Agent({ keepAlive: true });
async function askOpenAI(prompt) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 75000,
        httpsAgent,
      }
    );
    return res.data?.choices?.[0]?.message?.content?.trim() || "⚠️ AI কোনো উত্তর দিতে পারছে না।";
  } catch {
    return "⚠️ AI সার্ভার বর্তমানে অনুপলব্ধ। পরে আবার চেষ্টা করুন।";
  }
}

// ===== Premium Embeds =====
function updatingEmbed(minutes, reason) {
  return new EmbedBuilder()
    .setColor("#f97316")
    .setTitle("🚀 Bot is Updating")
    .setDescription(
      [
        `⚡ **System maintenance has started!**`,
        reason ? `🛠️ **Reason:** ${reason}` : "🛠️ **Reason:** Routine Maintenance",
        `⏳ **Estimated Duration:** ${minutes} minute(s)`,
        "",
        "Please wait while we upgrade and optimize the system.",
      ].join("\n")
    )
    .addFields({ name: "Developed By", value: "Zihuu", inline: true })
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

function updatedEmbed() {
  return new EmbedBuilder()
    .setColor("#22c55e")
    .setTitle("✅ Bot Updated Successfully")
    .setDescription("🎉 All systems are online. Enjoy the improved experience!")
    .addFields({ name: "Developed By", value: "Zihuu", inline: true })
    .setFooter({ text: "Cyberland • Premium Bot" })
    .setTimestamp();
}

// ===== Purge Function =====
async function purgeChannel(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size > 0) {
        await channel.bulkDelete(fetched, true).catch(() => {});
        for (const [, msg] of fetched) {
          await msg.delete().catch(() => {});
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error("Purge error:", e.message);
  }
}

// ===== Dashboard HTML =====
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
</script>
</body></html>`;
}

// ===== Routes =====
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

// ====== Start Update ======
app.post("/api/start-update", async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || "").toString().slice(0, 1000);
    const channel = await client.channels.fetch(CHANNEL_ID);

    await purgeChannel(channel);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });

    // send immediately
    await channel.send({ content: "@everyone", embeds: [updatingEmbed(minutes, reason)] });

    if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
    manualUpdateTimeout = setTimeout(async () => {
      await purgeChannel(channel);
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
      await channel.send({ content: "@everyone", embeds: [updatedEmbed()] });
    }, minutes * 60_000);

    res.json({ success: true });
  } catch (e) {
    console.error("start-update error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ====== Finish Update ======
app.post("/api/finish-update", async (_req, res) => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await purgeChannel(channel);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
    await channel.send({ content: "@everyone", embeds: [updatedEmbed()] });
    res.json({ success: true });
  } catch (e) {
    console.error("finish-update error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ===== AI Chat =====
client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channel.id !== CHANNEL_ID) return;
  await message.channel.sendTyping();
  const answer = await askOpenAI(`${message.author.username}: ${message.content}`);
  await message.reply(answer);
});

// ===== Start Bot =====
client.on("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);

// Express listen
app.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
