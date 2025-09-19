// ================================
// Cyberland Ultra Discord AI Bot
// ================================

require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment-timezone");
const { statusBedrock } = require("minecraft-server-util");

// ================================
// ENV
// ================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "supersecret";

// ================================
// Discord Client
// ================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ================================
// AI Chat
// ================================
async function askAI(prompt) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Cyberland AI — an expert Minecraft assistant. Always helpful, premium, and knowledgeable about play.cyberland.pro.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    return res.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ OpenAI Error:", err.response?.data || err.message);
    return "⚠️ Sorry, AI service error.";
  }
}

// ================================
// Minecraft Server Checker
// ================================
async function checkServer() {
  try {
    const res = await statusBedrock("play.cyberland.pro", 19132, {
      timeout: 5000,
    });
    return `✅ Online — ${res.players.online}/${res.players.max} players`;
  } catch {
    return "❌ Offline";
  }
}

// ================================
// Update Manager
// ================================
let updateState = { active: false, percent: 0 };

async function lockChannel(lock) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const everyone = channel.guild.roles.everyone;
  await channel.permissionOverwrites.edit(everyone, {
    SendMessages: lock ? false : true,
  });
}

async function purgeChannel() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  let fetched;
  do {
    fetched = await channel.messages.fetch({ limit: 100 });
    if (fetched.size === 0) break;
    await channel.bulkDelete(fetched).catch(() => {});
  } while (fetched.size >= 2);
}

async function sendEmbed(title, desc, color = 0x2b2d31) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color)
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

async function runUpdate(io) {
  updateState.active = true;
  updateState.percent = 0;
  io.emit("updateState", updateState);

  await purgeChannel();
  await lockChannel(true);
  await sendEmbed("🚧 Update Started", "Bot is updating, please wait...", 0xffa500);

  const interval = setInterval(async () => {
    if (updateState.percent >= 100) {
      clearInterval(interval);
      updateState.active = false;
      updateState.percent = 100;
      await sendEmbed("✅ Update Complete", "You can now chat again!", 0x00ff00);
      await lockChannel(false);
      io.emit("updateState", updateState);
      return;
    }
    updateState.percent += 20;
    io.emit("updateState", updateState);
  }, 3000);
}

// ================================
// Express + Dashboard
// ================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

// Demo users
const USERS = new Map([
  ["zihuu", "cyberlandai90x90x90"],
  ["shahin", "cyberlandai90x90x90"],
  ["mainuddin", "cyberlandai90x90x90"],
]);

// Middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

// Login
app.get("/login", (req, res) => {
  res.send(`
  <html><head><title>Login</title></head>
  <body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;">
    <form method="post" style="background:#222;padding:20px;border-radius:10px;">
      <h2>Cyberland Dashboard</h2>
      <input name="username" placeholder="Username" required /><br/><br/>
      <input name="password" type="password" placeholder="Password" required /><br/><br/>
      <button type="submit">Login</button>
    </form>
  </body></html>
  `);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (USERS.get(username) === password) {
    req.session.user = username;
    return res.redirect("/dashboard");
  }
  res.send("❌ Invalid credentials <a href='/login'>Try again</a>");
});

// Dashboard
app.get("/dashboard", requireLogin, (req, res) => {
  res.send(`
  <html>
  <head>
    <title>Dashboard</title>
    <script src="/socket.io/socket.io.js"></script>
  </head>
  <body style="background:#111;color:#fff;font-family:sans-serif;">
    <h1>Welcome, ${req.session.user}</h1>
    <div id="status">Status: ...</div>
    <button onclick="fetch('/update').then(()=>alert('Update started'))">Start Update</button>
    <button onclick="fetch('/send?msg=Hello+from+dashboard')">Send Test Message</button>
    <script>
      const socket = io();
      socket.on('updateState', s => {
        document.getElementById('status').innerText = s.active 
          ? "Updating... " + s.percent + "%" 
          : "Idle";
      });
    </script>
  </body>
  </html>
  `);
});

// Update trigger
app.get("/update", requireLogin, (req, res) => {
  runUpdate(io);
  res.send("Update started!");
});

// Send message
app.get("/send", requireLogin, async (req, res) => {
  const channel = await client.channels.fetch(CHANNEL_ID);
  await channel.send(req.query.msg || "Hello");
  res.send("Message sent.");
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Socket.io
io.on("connection", (socket) => {
  console.log("🌐 Dashboard connected");
  socket.emit("updateState", updateState);
});

// ================================
// Discord Events
// ================================
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// AI channel
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel.id !== CHANNEL_ID) return;

  await msg.channel.sendTyping();
  const reply = await askAI(msg.content);
  await msg.reply(reply);
});

// ================================
// CRON: Daily server status
// ================================
cron.schedule("0 * * * *", async () => {
  const status = await checkServer();
  await sendEmbed("🟢 Server Status", status, 0x0099ff);
});

// ================================
// Start servers
// ================================
server.listen(PORT, () => {
  console.log(`🚀 Dashboard running on http://localhost:${PORT}`);
});

client.login(DISCORD_TOKEN).catch((err) =>
  console.error("❌ Discord Login Failed:", err)
);
