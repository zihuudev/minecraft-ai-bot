// Cyberland Ultra Premium Discord Bot
// Features: Dashboard login, AI chat, lock/unlock, purge, announcement
// Author: Zihad

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require("discord.js");
const axios = require("axios");

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_USERS = ["zihuu", "shahin", "mainuddin"];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cyberlandai90x90x90";
const SESSION_SECRET = process.env.SESSION_SECRET || "cyberland_secret";
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

// ---------------- SETTINGS ----------------
const SETTINGS_FILE = path.join(__dirname, "settings.json");
let settings = { channelId: null, aiEnabled: true };
if (fs.existsSync(SETTINGS_FILE)) {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE)) };
  } catch {}
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ---------------- DISCORD BOT ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// AI function
async function askAI(question) {
  if (!OPENAI_KEY) return `AI disabled (no API key). You said: "${question}"`;
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: "You are a helpful AI assistant." },
          { role: "user", content: question },
        ],
      },
      { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
    );
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    return `AI error: ${err.response?.status || err.message}`;
  }
}

// Lock/unlock
async function lockChannel(channel, locked) {
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: !locked,
    });
    return true;
  } catch {
    return false;
  }
}

// Purge messages
async function purgeChannel(channel, limit = 50) {
  try {
    const msgs = await channel.messages.fetch({ limit });
    await channel.bulkDelete(msgs, true);
    return msgs.size;
  } catch {
    return 0;
  }
}

// ---------------- EXPRESS DASHBOARD ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));

// login page
app.get("/login", (req, res) => {
  res.send(`
  <html><body style="background:#0f172a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
  <form method="POST" action="/login" style="background:#1e293b;padding:20px;border-radius:12px">
    <h2>Cyberland Dashboard</h2>
    <input name="username" placeholder="Username" style="margin:5px;padding:5px" /><br>
    <input type="password" name="password" placeholder="Password" style="margin:5px;padding:5px" /><br>
    <button type="submit">Login</button>
  </form></body></html>`);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (ADMIN_USERS.includes((username || "").toLowerCase()) && password === ADMIN_PASSWORD) {
    req.session.user = username;
    res.redirect("/");
  } else res.send("Invalid login. <a href='/login'>Try again</a>");
});

function auth(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login");
}

app.get("/", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// dashboard.html auto create
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");
if (!fs.existsSync(DASHBOARD_HTML)) {
  fs.writeFileSync(
    DASHBOARD_HTML,
    `<!doctype html><html><head><title>Dashboard</title><script src="/socket.io/socket.io.js"></script></head>
    <body style="background:#111;color:white;font-family:sans-serif;padding:20px">
    <h1>Cyberland Dashboard</h1>
    <a href="/logout">Logout</a><br><br>
    <button onclick="setChannel()">Set Channel</button>
    <button onclick="toggleAI()">Toggle AI</button>
    <button onclick="lock()">Lock</button>
    <button onclick="unlock()">Unlock</button>
    <button onclick="purge()">Purge</button>
    <button onclick="announce()">Announce</button>
    <pre id="log"></pre>
    <script>
      const s = io();
      s.on("msg",m=>{document.getElementById("log").innerText+=m+"\\n"});
      function setChannel(){s.emit("setChannel",prompt("Channel ID"))}
      function toggleAI(){s.emit("toggleAI")}
      function lock(){s.emit("lock")}
      function unlock(){s.emit("unlock")}
      function purge(){s.emit("purge")}
      function announce(){s.emit("announce",{t:prompt("Title"),c:prompt("Content")})}
    </script></body></html>`
  );
}

// ---------------- SOCKET EVENTS ----------------
io.on("connection", (socket) => {
  socket.emit("msg", "Connected to dashboard");
  socket.on("setChannel", (id) => {
    settings.channelId = id;
    saveSettings();
    socket.emit("msg", `Channel set: ${id}`);
  });
  socket.on("toggleAI", () => {
    settings.aiEnabled = !settings.aiEnabled;
    saveSettings();
    socket.emit("msg", `AI: ${settings.aiEnabled}`);
  });
  socket.on("lock", async () => {
    if (!settings.channelId) return;
    const ch = await client.channels.fetch(settings.channelId);
    await lockChannel(ch, true);
    socket.emit("msg", "Channel locked");
  });
  socket.on("unlock", async () => {
    if (!settings.channelId) return;
    const ch = await client.channels.fetch(settings.channelId);
    await lockChannel(ch, false);
    socket.emit("msg", "Channel unlocked");
  });
  socket.on("purge", async () => {
    if (!settings.channelId) return;
    const ch = await client.channels.fetch(settings.channelId);
    const n = await purgeChannel(ch);
    socket.emit("msg", `Purged ${n} messages`);
  });
  socket.on("announce", async (d) => {
    if (!settings.channelId) return;
    const ch = await client.channels.fetch(settings.channelId);
    const e = new EmbedBuilder().setTitle(d.t).setDescription(d.c).setTimestamp();
    await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
    socket.emit("msg", "Announcement sent");
  });
});

// ---------------- DISCORD EVENTS ----------------
client.on("ready", () => console.log("Bot ready:", client.user.tag));

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!settings.aiEnabled) return;
  if (!settings.channelId || msg.channel.id !== settings.channelId) return;
  const reply = await askAI(msg.content);
  msg.reply({ content: reply, allowedMentions: { parse: [] } });
});

// ---------------- START ----------------
server.listen(PORT, () => console.log("Dashboard running on port", PORT));
if (DISCORD_TOKEN) client.login(DISCORD_TOKEN);
