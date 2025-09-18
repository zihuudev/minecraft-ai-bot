// ==========================
// Premium Minecraft AI Bot + Dashboard
// ==========================

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { statusBedrock } = require("minecraft-server-util");
const { Configuration, OpenAIApi } = require("openai");

// ==========================
// Config
// ==========================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID || "1404498262379200522";
const SESSION_SECRET = process.env.SESSION_SECRET || "supersecret";
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

const USERS = new Map([
  ["zihuu", "zihuu123"],
  ["shahin", "shahin123"],
  ["mainuddin", "main123"]
]);

// ==========================
// Discord Bot
// ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// OpenAI
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_KEY }));

async function askAI(prompt) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Minecraft expert AI for CyberLand server." },
        { role: "user", content: prompt }
      ]
    });
    return res.choices[0].message.content;
  } catch (err) {
    console.error("AI Error:", err.message);
    return "⚠️ AI service unavailable.";
  }
}

// Handle chat
client.on("messageCreate", async msg => {
  if (msg.author.bot) return;
  if (msg.channel.id !== CHANNEL_ID) return;

  try {
    msg.channel.sendTyping();
    const reply = await askAI(msg.content);
    await msg.reply({ content: reply });
  } catch (e) {
    console.error("Reply error:", e.message);
  }
});

// ==========================
// Express Dashboard
// ==========================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

// ==========================
// HTML TEMPLATES
// ==========================
const loginHTML = `
<!DOCTYPE html>
<html>
<head>
<title>Login - Minecraft AI Bot</title>
<style>
  body { margin:0; font-family:Poppins,sans-serif; background:#0f172a; color:#fff; display:flex; justify-content:center; align-items:center; height:100vh; overflow:hidden; }
  .box { background:#1e293b; padding:30px; border-radius:20px; text-align:center; box-shadow:0 0 20px rgba(0,0,0,0.5); opacity:0; animation:fadeIn 2s forwards 2s; }
  input { width:100%; padding:12px; margin:10px 0; border:none; border-radius:10px; }
  button { padding:12px; background:#3b82f6; border:none; border-radius:10px; color:#fff; cursor:pointer; width:100%; }
  .err { color:#f87171; margin-top:10px; }
  .loader { position:absolute; top:0; left:0; right:0; bottom:0; background:#0f172a; display:flex; justify-content:center; align-items:center; z-index:10; animation:fadeOut 1s forwards 4s; }
  .dot { width:15px; height:15px; margin:0 5px; background:#3b82f6; border-radius:50%; animation:bounce 1s infinite alternate; }
  .dot:nth-child(2){animation-delay:0.3s;}
  .dot:nth-child(3){animation-delay:0.6s;}
  @keyframes bounce { to{ transform:translateY(-15px);} }
  @keyframes fadeOut { to{ opacity:0; visibility:hidden;} }
  @keyframes fadeIn { to{ opacity:1;} }
</style>
</head>
<body>
<div class="loader"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
<div class="box">
  <h2>🔐 Dashboard Login</h2>
  <form method="post" action="/login">
    <input type="text" name="username" placeholder="Username" required><br>
    <input type="password" name="password" placeholder="Password" required><br>
    <button type="submit">Login</button>
    <div class="err">{{ERR}}</div>
  </form>
</div>
</body>
</html>
`;

function dashHTML(user) {
  return `
<!DOCTYPE html>
<html>
<head>
<title>Dashboard</title>
<style>
  body { margin:0; font-family:Poppins,sans-serif; background:#0f172a; color:#fff; }
  nav { background:#1e293b; padding:15px; display:flex; justify-content:space-between; }
  nav a { color:#fff; margin:0 10px; text-decoration:none; }
  .content { padding:20px; }
  button { padding:10px; margin:5px; border:none; border-radius:8px; background:#3b82f6; color:#fff; cursor:pointer; }
  .card { background:#1e293b; padding:20px; border-radius:15px; margin:10px 0; }
</style>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  socket.on("updateState", state => {
    document.getElementById("updatestatus").innerText = state.inProgress ? "⏳ Updating..." : "✅ Idle";
  });
</script>
</head>
<body>
<nav>
  <div>⚡ Minecraft AI Dashboard</div>
  <div>Welcome, ${user} | <a href="/logout">Logout</a></div>
</nav>
<div class="content">
  <div class="card">
    <h3>Update Control</h3>
    <div>Status: <span id="updatestatus">✅ Idle</span></div>
    <form action="/update" method="post"><button type="submit">Start Update</button></form>
  </div>
  <div class="card">
    <h3>Server Control</h3>
    <form action="/send" method="post">
      <input type="text" name="message" placeholder="Message to Discord" required>
      <button type="submit">Send</button>
    </form>
  </div>
</div>
</body>
</html>
  `;
}

// ==========================
// Routes
// ==========================
app.get("/login", (req, res) => res.send(loginHTML.replace("{{ERR}}", "")));

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (USERS.get(username) === password) {
    req.session.user = username;
    return res.redirect("/dashboard");
  }
  res.send(loginHTML.replace("{{ERR}}", "❌ Invalid credentials"));
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

app.get("/dashboard", requireLogin, (req, res) => res.send(dashHTML(req.session.user)));

// ==========================
// Update System
// ==========================
let updateState = { inProgress: false };

async function lockChannel(channel, lock) {
  const everyone = channel.guild.roles.everyone;
  await channel.permissionOverwrites.edit(everyone, { SendMessages: !lock });
}

async function purgeChannel(channel) {
  let fetched;
  do {
    fetched = await channel.messages.fetch({ limit: 100 });
    if (fetched.size === 0) break;
    await channel.bulkDelete(fetched).catch(() => {});
  } while (fetched.size >= 2);
}

app.post("/update", requireLogin, async (req, res) => {
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) return res.send("❌ Channel not found.");

  updateState.inProgress = true;
  io.emit("updateState", updateState);

  await purgeChannel(channel);
  await lockChannel(channel, true);

  const embed = new EmbedBuilder()
    .setTitle("⏳ Bot Updating...")
    .setDescription("The bot is under maintenance. Please wait...")
    .setColor(0xfbbf24);

  await channel.send({ embeds: [embed] });

  // Simulate update
  setTimeout(async () => {
    await lockChannel(channel, false);
    updateState.inProgress = false;
    io.emit("updateState", updateState);

    const done = new EmbedBuilder()
      .setTitle("✅ Update Complete")
      .setDescription("Bot update finished. You can chat now!")
      .setColor(0x22c55e);

    await channel.send({ embeds: [done] });
  }, 10000);

  res.redirect("/dashboard");
});

// ==========================
// Send Message to Discord
// ==========================
app.post("/send", requireLogin, async (req, res) => {
  const { message } = req.body;
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (channel) {
    await channel.send({
      embeds: [new EmbedBuilder().setDescription(message).setColor(0x3b82f6)]
    });
  }
  res.redirect("/dashboard");
});

// ==========================
// Minecraft Status API
// ==========================
app.get("/serverstatus", async (req, res) => {
  try {
    const status = await statusBedrock(MINECRAFT_IP, MINECRAFT_PORT);
    res.json({ online: true, players: status.players.online, max: status.players.max });
  } catch {
    res.json({ online: false });
  }
});

// ==========================
// Start Servers
// ==========================
client.login(DISCORD_TOKEN);
server.listen(3000, () => console.log("🌐 Dashboard running on http://localhost:3000"));
