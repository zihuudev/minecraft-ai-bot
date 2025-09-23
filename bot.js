// ================================================================
// Cyberland Ultra-Premium All-in-One bot.js (Fixed Version)
// Developer: ZIHUU
// ================================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const Discord = require("discord.js");
const { Client, GatewayIntentBits, EmbedBuilder } = Discord;
const OpenAI = require("openai");

// ================================================================
// Config
// ================================================================
const TOKEN = process.env.TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ADMINS = ["zihuu", "shahin", "mainuddin"];
const ADMIN_PASS = "cyberlandai90x90x90";

const PORT = 3000;
const LOG_FILE = "console.log";
const HTML_DASH = path.join(__dirname, "dashboard.html");

// ================================================================
// Init
// ================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ai = new OpenAI({ apiKey: OPENAI_KEY });
let aiEnabled = true;
let aiChannel = null;

// ================================================================
// Express + Socket.IO
// ================================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let session = {};

app.get("/", (req, res) => {
  if (session.login) {
    res.sendFile(HTML_DASH);
  } else {
    res.send(`<form method="post" style="margin:50px">
      <h2>Cyberland Login</h2>
      <input name="user" placeholder="Username"><br><br>
      <input type="password" name="pass" placeholder="Password"><br><br>
      <button type="submit">Login</button>
    </form>`);
  }
});

app.post("/", (req, res) => {
  const { user, pass } = req.body;
  if (ADMINS.includes(user) && pass === ADMIN_PASS) {
    session.login = true;
    res.redirect("/");
  } else {
    res.send("Invalid login!");
  }
});

app.get("/logout", (req, res) => {
  session = {};
  res.redirect("/");
});

// ================================================================
// Dashboard HTML (auto-generate if missing)
// ================================================================
if (!fs.existsSync(HTML_DASH)) {
  fs.writeFileSync(
    HTML_DASH,
    `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title><script src="/socket.io/socket.io.js"></script>
    <style>body{background:#071426;color:#e6eef6;font-family:Arial;padding:20px}button{margin:6px;padding:10px;border-radius:8px;border:none;background:linear-gradient(90deg,#7c3aed,#06b6d4);color:white;cursor:pointer}#log{background:#041827;padding:12px;border-radius:8px;height:320px;overflow:auto;margin-top:12px}</style>
    </head><body><h1>⚡ Cyberland Premium Dashboard</h1><a href="/logout" style="color:#fb7185">Logout</a><div style="margin-top:12px">
    <button onclick="setChannel()">Set Channel</button>
    <button onclick="toggleAI()">Toggle AI</button>
    <button onclick="startUpdate()">Start Update</button>
    <button onclick="finishUpdate()">Finish Update</button>
    <button onclick="announce()">Announce</button>
    <button onclick="botInfo()">Bot Info</button>
    </div><div id="log"></div>
    <script>
      const s = io();
      s.on('msg', m => {
        const l = document.getElementById('log');
        l.innerHTML += "<div>" + new Date().toLocaleTimeString() + " - " + m + "</div>";
        l.scrollTop = l.scrollHeight;
      });
      function setChannel(){ const id=prompt("Channel ID"); if(id) s.emit("setChannel",id); }
      function toggleAI(){ s.emit("toggleAI"); }
      function startUpdate(){ const r=prompt("Reason?"); const m=prompt("Minutes?","5"); s.emit("startUpdate",{reason:r,minutes:Number(m)}); }
      function finishUpdate(){ s.emit("finishUpdate"); }
      function announce(){ const t=prompt("Title"); const c=prompt("Content"); const r=prompt("Reason"); s.emit("announce",{title:t,content:c,reason:r}); }
      function botInfo(){ s.emit("botInfo"); }
    </script></body></html>`
  );
}

// ================================================================
// Socket.IO Actions
// ================================================================
io.on("connection", (socket) => {
  socket.emit("msg", "Connected to Cyberland Dashboard ✅");

  socket.on("setChannel", (id) => {
    aiChannel = id;
    socket.emit("msg", `AI channel set to ${id}`);
  });

  socket.on("toggleAI", () => {
    aiEnabled = !aiEnabled;
    socket.emit("msg", `AI is now ${aiEnabled ? "ENABLED ✅" : "DISABLED ❌"}`);
  });

  socket.on("startUpdate", (d) => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const embed = new EmbedBuilder()
      .setTitle("⚡ Bot Update Started")
      .setDescription(`⏱ Duration: **${d.minutes}m**\n📌 Reason: ${d.reason}`)
      .setFooter({ text: "DEVELOPED BY ZIHUU" })
      .setColor("Yellow")
      .setTimestamp();
    guild.systemChannel?.send({ embeds: [embed] });
    socket.emit("msg", "Update started!");
  });

  socket.on("finishUpdate", () => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const embed = new EmbedBuilder()
      .setTitle("✅ Bot Update Finished")
      .setDescription("All systems online!")
      .setFooter({ text: "DEVELOPED BY ZIHUU" })
      .setColor("Green")
      .setTimestamp();
    guild.systemChannel?.send({ embeds: [embed] });
    socket.emit("msg", "Update finished!");
  });

  socket.on("announce", (d) => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const embed = new EmbedBuilder()
      .setTitle("📢 " + d.title)
      .setDescription(d.content)
      .addFields({ name: "Reason", value: d.reason })
      .setFooter({ text: "DEVELOPED BY ZIHUU" })
      .setColor("Blue")
      .setTimestamp();
    guild.systemChannel?.send({ embeds: [embed] });
    socket.emit("msg", "Announcement sent!");
  });

  socket.on("botInfo", () => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const embed = new EmbedBuilder()
      .setTitle("🤖 Bot Info")
      .addFields(
        { name: "Ping", value: `${client.ws.ping}ms` },
        { name: "Server", value: guild.name },
        { name: "AI", value: aiEnabled ? "✅ Enabled" : "❌ Disabled" }
      )
      .setFooter({ text: "DEVELOPED BY ZIHUU" })
      .setColor("Aqua")
      .setTimestamp();
    guild.systemChannel?.send({ embeds: [embed] });
    socket.emit("msg", "Bot info sent!");
  });
});

// ================================================================
// Discord Bot Events
// ================================================================
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (aiEnabled && aiChannel && msg.channel.id === aiChannel) {
    try {
      const res = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: msg.content }],
      });
      msg.reply(res.choices[0].message.content);
    } catch (err) {
      msg.reply("⚠️ Sorry, AI is temporarily unavailable.");
      console.error("AI Error:", err.message);
    }
  }
});

// ================================================================
// Auto Daily Update (BD Time) [11:00–11:05 & 15:00–15:05]
// ================================================================
setInterval(() => {
  const bd = new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
  const time = new Date(bd);
  const h = time.getHours();
  const m = time.getMinutes();
  const guild = client.guilds.cache.first();
  if (!guild) return;

  if ((h === 11 && m >= 0 && m <= 5) || (h === 15 && m >= 0 && m <= 5)) {
    const embed = new EmbedBuilder()
      .setTitle("⚡ Auto Update Running")
      .setDescription("Daily scheduled maintenance update is running...")
      .setFooter({ text: "DEVELOPED BY ZIHUU" })
      .setColor("Orange")
      .setTimestamp();
    guild.systemChannel?.send({ embeds: [embed] });
    io.emit("msg", "Auto Update Triggered!");
  }
}, 60000);

// ================================================================
// Start Server
// ================================================================
server.listen(PORT, () => console.log("Dashboard running on http://localhost:" + PORT));
client.login(TOKEN);

