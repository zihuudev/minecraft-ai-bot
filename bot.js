// =============================================
// CYBERLAND ULTRA ALL-IN-ONE BOT + DASHBOARD 🚀
// =============================================

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require("discord.js");
const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

// === CONFIG ===
let config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// === Initialize Discord Client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// =============================================
// 🔹 LOCK / UNLOCK CHANNEL SYSTEM
// =============================================
async function lockChannel(channel, lock) {
  try {
    if (!channel || !channel.guild) return;

    const botPingRole = channel.guild.roles.cache.get(config.botPingRoleId);
    if (!botPingRole) {
      console.error("❌ Bot Ping role not found! Update it in the dashboard.");
      return;
    }

    await channel.permissionOverwrites.edit(botPingRole, {
      SendMessages: lock ? false : true,
    });

    console.log(
      `✅ ${lock ? "Locked" : "Unlocked"} #${channel.name} for Bot Ping role`
    );
  } catch (e) {
    console.error("⚠️ lockChannel error:", e?.message || e);
  }
}

// =============================================
// 🔹 DISCORD COMMANDS
// =============================================
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  if (message.content.toLowerCase() === "!lock") {
    await lockChannel(message.channel, true);
    await message.reply("🔒 Channel locked for **Bot Ping** role!");
  }

  if (message.content.toLowerCase() === "!unlock") {
    await lockChannel(message.channel, false);
    await message.reply("🔓 Channel unlocked for **Bot Ping** role!");
  }

  // AI Chat Command
  if (message.content.startsWith("!ai")) {
    const query = message.content.replace("!ai", "").trim();
    if (!query) return message.reply("⚠️ Please ask me something!");
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: query }],
        }),
      });
      const data = await response.json();
      message.reply(data.choices?.[0]?.message?.content || "⚠️ No response.");
    } catch (e) {
      message.reply("⚠️ AI request failed. Check your OpenAI API key.");
    }
  }
});

// =============================================
// 🔹 DASHBOARD SERVER
// =============================================
const app = express();
const PORT = 3000;
const ADMINS = ["zihuu", "shahin", "mainuddin"];
const PASSWORD = "1234"; // Change this!

app.use(bodyParser.urlencoded({ extended: true }));

// Middleware for admin authentication
app.use((req, res, next) => {
  if (req.path === "/login" || req.path === "/auth") return next();
  if (!req.query.user || !req.query.pass)
    return res.redirect("/login");
  if (!ADMINS.includes(req.query.user) || req.query.pass !== PASSWORD)
    return res.redirect("/login");
  next();
});

// Login page
app.get("/login", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Login - Cyberland Dashboard</title>
        <style>
          body { font-family: Poppins, sans-serif; background:#0f172a; color:white; display:flex; justify-content:center; align-items:center; height:100vh; }
          form { background:#1e293b; padding:30px; border-radius:20px; box-shadow:0 0 20px #00f2ff; text-align:center; }
          input { padding:10px; border-radius:10px; border:none; margin:10px; width:90%; background:#0f172a; color:white; }
          button { background:#00f2ff; padding:12px 20px; border:none; border-radius:10px; cursor:pointer; font-weight:bold; }
          button:hover { background:#00c8d1; }
        </style>
      </head>
      <body>
        <form action="/auth" method="GET">
          <h1>Cyberland Login</h1>
          <input name="user" placeholder="Username" required /><br/>
          <input name="pass" type="password" placeholder="Password" required /><br/>
          <button type="submit">Login</button>
        </form>
      </body>
    </html>
  `);
});

// Auth redirect
app.get("/auth", (req, res) => {
  if (ADMINS.includes(req.query.user) && req.query.pass === PASSWORD)
    return res.redirect(`/?user=${req.query.user}&pass=${req.query.pass}`);
  res.redirect("/login");
});

// Dashboard main page
app.get("/", async (req, res) => {
  // Minecraft server status (demo)
  let mcStatus = "Checking...";
  try {
    const mcRes = await fetch(`https://api.mcstatus.io/v2/status/java/${config.minecraftServer}`);
    const mcData = await mcRes.json();
    mcStatus = mcData?.online ? `🟢 Online - ${mcData.players.online} players` : "🔴 Offline";
  } catch {
    mcStatus = "⚠️ Unable to fetch";
  }

  res.send(`
    <html>
      <head>
        <title>Cyberland Dashboard</title>
        <style>
          body { margin:0; padding:0; font-family:Poppins,sans-serif; background:#0f172a; color:white; display:flex; justify-content:center; align-items:center; height:100vh; }
          .loader { position:fixed; top:0; left:0; width:100%; height:100%; background:#0f172a; display:flex; justify-content:center; align-items:center; z-index:9999; animation:fadeOut 1s forwards; animation-delay:10s; }
          .loader h1 { color:#00f2ff; animation:pulse 1.5s infinite; }
          @keyframes fadeOut { to {opacity:0; visibility:hidden;} }
          @keyframes pulse { 0%{opacity:0.5;}50%{opacity:1;}100%{opacity:0.5;} }
          .container { max-width:700px; padding:30px; border-radius:20px; background:#1e293b; box-shadow:0 0 20px #00f2ff; text-align:center; animation:fadeIn 1s; }
          @keyframes fadeIn { from{opacity:0;transform:translateY(-30px);} to{opacity:1;transform:translateY(0);} }
          input,button { padding:10px; margin:10px; border-radius:10px; border:none; }
          input { width:80%; background:#0f172a; color:white; }
          button { background:#00f2ff; font-weight:bold; cursor:pointer; }
          button:hover { background:#00c8d1; }
        </style>
      </head>
      <body>
        <div class="loader"><h1>🚀 Loading Cyberland Dashboard...</h1></div>
        <div class="container">
          <h1>⚡ Cyberland Ultra Dashboard ⚡</h1>
          <h3>Minecraft Server Status: ${mcStatus}</h3>
          <form action="/update-role" method="POST">
            <label>Bot Ping Role ID</label><br/>
            <input type="text" name="botPingRoleId" value="${config.botPingRoleId}" required />
            <button type="submit">Update Role</button>
          </form>
          <form action="/send-message" method="POST">
            <label>Send a Message</label><br/>
            <input type="text" name="channelId" placeholder="Channel ID" required /><br/>
            <input type="text" name="message" placeholder="Your Message" required />
            <button type="submit">Send</button>
          </form>
        </div>
        <script>setTimeout(()=>{document.querySelector('.loader').style.display='none';},10000)</script>
      </body>
    </html>
  `);
});

// Update Bot Ping Role
app.post("/update-role", bodyParser.urlencoded({ extended: true }), (req, res) => {
  config.botPingRoleId = req.body.botPingRoleId;
  fs.writeFileSync("./config.json", JSON.stringify(config, null, 2));
  res.redirect(`/?user=${req.query.user}&pass=${req.query.pass}`);
});

// Send message from dashboard
app.post("/send-message", bodyParser.urlencoded({ extended: true }), async (req, res) => {
  const { channelId, message } = req.body;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(message);
    res.redirect(`/?user=${req.query.user}&pass=${req.query.pass}`);
  } catch {
    res.send("⚠️ Failed to send message.");
  }
});

// =============================================
// 🔹 START BOT + DASHBOARD
// =============================================
app.listen(PORT, () =>
  console.log(`🌐 Dashboard running at http://localhost:${PORT}`)
);
client.login(config.token);
