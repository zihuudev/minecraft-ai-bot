// ================================================================
// Cyberland Ultra-Premium Bot + Dashboard
// Features:
// - Dashboard login (3 users, 1 password)
// - AI auto-reply (no prefix)
// - Channel lock/unlock + clear messages
// - Premium embed updates
// - Railway-ready
// ================================================================

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require("discord.js");

// ---------------- CONFIG ----------------
const ADMINS = ["zihuu", "shahin", "mainuddin"];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cyberlandai90x90x90";
const PORT = process.env.PORT || 3000;

let settings = {
  channelId: process.env.CHANNEL_ID || null,
  aiEnabled: true,
  updateRunning: false,
};
const settingsPath = path.join(__dirname, "settings.json");
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath));
  } catch (e) {
    console.error("⚠️ Settings file broken, using defaults");
  }
}

// ---------------- DISCORD CLIENT ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ---------------- EXPRESS + DASHBOARD ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "cyberlandSecret",
    resave: false,
    saveUninitialized: true,
  })
);

// ---------------- LOGIN & DASHBOARD ----------------
app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (ADMINS.includes(username.toLowerCase()) && password === ADMIN_PASSWORD) {
    req.session.user = username;
    return res.redirect("/");
  }
  res.send("❌ Invalid login. <a href='/login'>Try again</a>");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  console.log("✅ Dashboard Connected");

  socket.emit("msg", "Welcome to Cyberland Control Panel");

  socket.on("setChannel", (id) => {
    settings.channelId = id;
    saveSettings();
    socket.emit("msg", "Channel set to: " + id);
  });

  socket.on("toggleAI", () => {
    settings.aiEnabled = !settings.aiEnabled;
    saveSettings();
    socket.emit("msg", "AI is now: " + (settings.aiEnabled ? "✅ Enabled" : "❌ Disabled"));
  });

  socket.on("startUpdate", async () => {
    if (!settings.channelId) return socket.emit("msg", "⚠️ No channel set!");
    try {
      settings.updateRunning = true;
      saveSettings();
      const ch = await client.channels.fetch(settings.channelId);

      // Lock channel
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false });

      // Clear messages
      const msgs = await ch.messages.fetch({ limit: 50 });
      await ch.bulkDelete(msgs, true);

      // Send embed
      const embed = new EmbedBuilder()
        .setTitle("🚀 Cyberland Bot Update Running...")
        .setDescription("All messages cleared. Bot is updating...")
        .addFields({ name: "Ping", value: `${client.ws.ping}ms` })
        .setColor("Aqua")
        .setTimestamp();
      await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });

      socket.emit("msg", "✅ Update started");
    } catch (err) {
      socket.emit("msg", "❌ Error: " + err.message);
    }
  });

  socket.on("finishUpdate", async () => {
    if (!settings.channelId) return socket.emit("msg", "⚠️ No channel set!");
    try {
      settings.updateRunning = false;
      saveSettings();
      const ch = await client.channels.fetch(settings.channelId);

      // Unlock channel
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true });

      const embed = new EmbedBuilder()
        .setTitle("✅ Cyberland Bot Update Finished")
        .setDescription("Channel unlocked. Bot is online.")
        .setColor("Green")
        .setTimestamp();
      await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });

      socket.emit("msg", "Update finished");
    } catch (err) {
      socket.emit("msg", "❌ Error: " + err.message);
    }
  });
});

// ---------------- DISCORD EVENTS ----------------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// ---------------- AI AUTO-REPLY ----------------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!settings.aiEnabled) return;

  if (!settings.channelId || msg.channel.id !== settings.channelId) return;

  try {
    // OpenAI Auto-reply if key present
    if (process.env.OPENAI_API_KEY) {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: msg.content }],
          max_tokens: 300,
          temperature: 0.7,
        },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
      );
      const answer = res.data.choices[0].message.content;
      msg.reply(answer);
    } else {
      // Fallback simple echo AI
      msg.reply(`💬 You said: ${msg.content}`);
    }
  } catch (err) {
    msg.reply("⚠️ AI error or unavailable");
  }
});

// ---------------- STATIC HTML ----------------
const loginHTML = `
<!DOCTYPE html>
<html><head><title>Login</title>
<style>
body {background:#0f172a;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;}
form {background:#1e293b;padding:30px;border-radius:12px;}
input,button {margin:8px 0;padding:10px;border:none;border-radius:6px;}
button {background:#38bdf8;color:white;cursor:pointer;}
</style></head>
<body>
<form method="POST" action="/login">
<h2>Cyberland Login</h2>
<input type="text" name="username" placeholder="Username" required/>
<input type="password" name="password" placeholder="Password" required/>
<button type="submit">Login</button>
</form>
</body></html>`;
fs.writeFileSync(path.join(__dirname, "login.html"), loginHTML);

const dashHTML = `
<!DOCTYPE html>
<html><head><title>Dashboard</title>
<script src="/socket.io/socket.io.js"></script>
<style>
body{background:#0f172a;color:white;font-family:sans-serif;padding:20px;}
button{margin:5px;padding:10px;border:none;border-radius:6px;background:#38bdf8;color:white;cursor:pointer;}
#log{margin-top:20px;background:#1e293b;padding:10px;border-radius:6px;height:200px;overflow:auto;}
</style></head>
<body>
<h1>Cyberland Dashboard</h1><a href="/logout">Logout</a><br/>
<button onclick="setChannel()">Set Channel</button>
<button onclick="toggleAI()">Toggle AI</button>
<button onclick="startUpdate()">Start Update</button>
<button onclick="finishUpdate()">Finish Update</button>
<div id="log"></div>
<script>
const socket=io();
socket.on("msg",m=>{let log=document.getElementById("log");log.innerHTML+="<div>"+m+"</div>";log.scrollTop=log.scrollHeight;});
function setChannel(){let id=prompt("Channel ID:");socket.emit("setChannel",id);}
function toggleAI(){socket.emit("toggleAI");}
function startUpdate(){socket.emit("startUpdate");}
function finishUpdate(){socket.emit("finishUpdate");}
</script>
</body></html>`;
fs.writeFileSync(path.join(__dirname, "dashboard.html"), dashHTML);

// ---------------- SAVE SETTINGS ----------------
function saveSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ---------------- START SERVER ----------------
server.listen(PORT, () =>
  console.log(`🌐 Dashboard running on http://localhost:${PORT}`)
);
client.login(process.env.DISCORD_TOKEN);
