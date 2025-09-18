// bot.js - Premium Discord AI Bot + Dashboard (All-in-One)

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const session = require("express-session");
const { Server } = require("socket.io");
const http = require("http");
const OpenAI = require("openai");
const { statusBedrock } = require("minecraft-server-util");

// ========= ENV VARS =========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || "cblai112211";
const AI_CHANNEL_ID = process.env.CHANNEL_ID || "1404498262379200522";
const MINECRAFT_IP = process.env.MC_IP || "play.cyberland.top";
const MINECRAFT_PORT = parseInt(process.env.MC_PORT || "19132"); // Bedrock default
const PORT = process.env.PORT || 3000;

// ========= DISCORD CLIENT =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ========= OPENAI =========
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========= EXPRESS + SOCKET =========
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

// ========= LOGIN HTML =========
const loginHTML = `
<html>
<head>
  <title>Cyberland AI Login</title>
  <style>
    body { font-family: Arial; background:#0f172a; color:white; text-align:center; padding:50px; }
    .box { background:#1e293b; padding:20px; border-radius:12px; display:inline-block; }
    input { padding:10px; border-radius:6px; border:none; margin:5px; }
    button { padding:10px 20px; border:none; border-radius:6px; background:#38bdf8; color:#000; font-weight:bold; cursor:pointer; }
    button:hover { background:#0ea5e9; color:white; }
    .err { color:red; margin:10px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Cyberland AI Dashboard</h1>
    <form method="post" action="/login">
      <input type="password" name="pass" placeholder="Admin Password"/><br/>
      <button type="submit">Login</button>
    </form>
    <div class="err">{{ERR}}</div>
  </div>
</body>
</html>
`;

// ========= DASHBOARD HTML =========
function dashHTML(user, state) {
  return `
<html>
<head>
  <title>Dashboard</title>
  <style>
    body { font-family: Arial; background:#0f172a; color:white; text-align:center; padding:40px; }
    .btn { padding:15px 25px; border:none; border-radius:8px; margin:10px; font-size:18px; cursor:pointer; }
    .lock { background:#facc15; color:black; }
    .unlock { background:#4ade80; color:black; }
  </style>
</head>
<body>
  <h1>⚡ Cyberland AI Control</h1>
  <p>User: ${user}</p>
  <p>Status: ${state.isUpdating ? "⏳ Updating..." : "✅ Online"}</p>
  <p>Minecraft: ${state.mcStatus}</p>
  <form method="post" action="/start"><button class="btn lock">Start Update</button></form>
  <form method="post" action="/stop"><button class="btn unlock">Finish Update</button></form>
  <form method="get" action="/logout"><button class="btn">Logout</button></form>
</body>
</html>
`;
}

// ========= AUTH MIDDLEWARE =========
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

// ========= ROUTES =========
app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => {
  res.send(loginHTML.replace("{{ERR}}", ""));
});

app.post("/login", (req, res) => {
  if (req.body.pass === process.env.ADMIN_PASS) {
    req.session.user = "admin";
    return res.redirect("/dashboard");
  }
  res.send(loginHTML.replace("{{ERR}}", "❌ Wrong Password"));
});

app.get("/dashboard", requireLogin, async (req, res) => {
  const mcStatus = await checkBedrock();
  res.send(dashHTML(req.session.user, { isUpdating, mcStatus }));
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.post("/start", requireLogin, async (req, res) => {
  await lockChannel(true);
  res.redirect("/dashboard");
});

app.post("/stop", requireLogin, async (req, res) => {
  await lockChannel(false);
  res.redirect("/dashboard");
});

// ========= BOT UPDATE SYSTEM =========
let isUpdating = false;

async function lockChannel(lock) {
  try {
    const channel = await client.channels.fetch(AI_CHANNEL_ID);
    if (!channel) return;

    const everyoneRole = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyoneRole, {
      SendMessages: lock ? false : true,
    });

    isUpdating = lock;

    const embed = new EmbedBuilder()
      .setTitle(lock ? "🚧 Bot Updating..." : "✅ Update Completed")
      .setDescription(
        lock
          ? "The AI is being updated. Chat is temporarily locked."
          : "Bot update finished successfully. Chat is unlocked."
      )
      .setColor(lock ? "Orange" : "Green")
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Channel lock error:", err);
  }
}

// ========= MINECRAFT STATUS =========
async function checkBedrock() {
  try {
    const res = await statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, {
      timeout: 5000,
    });
    return `✅ Online — ${res.players.online}/${res.players.max} players`;
  } catch {
    return "❌ Offline";
  }
}

// ========= AI CHAT =========
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== AI_CHANNEL_ID) return;
  if (isUpdating) return message.reply("⏳ Bot is updating, please wait...");

  try {
    await message.channel.sendTyping();

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast & smart
      messages: [
        {
          role: "system",
          content:
            "You are Cyberland Minecraft Expert AI. You know everything about the server play.cyberland.pro and Minecraft gameplay, plugins, mods, survival, PvP.",
        },
        { role: "user", content: message.content },
      ],
    });

    const reply = response.choices[0].message.content;
    if (reply) message.reply(reply);
  } catch (err) {
    console.error("AI Error:", err);
    message.reply("⚠️ Error getting AI response.");
  }
});

// ========= START =========
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  server.listen(PORT, () =>
    console.log(`🌍 Dashboard running at http://localhost:${PORT}`)
  );
});

client.login(DISCORD_TOKEN);
