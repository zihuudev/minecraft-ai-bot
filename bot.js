// Cyberland Ultra-Premium All-in-One bot.js
// ==========================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const OpenAI = require("openai");
const cron = require("node-cron");

// ========= ENV VARIABLES =========
const TOKEN = process.env.TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ADMINS = ["zihuu", "shahin", "mainuddin"];
const ADMIN_PASS = "cyberlandai90x90x90"; // fixed password
const FIXED_CHANNEL_ID = "1419702204171813015";

// ========= DISCORD CLIENT =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: OPENAI_KEY });
let aiEnabled = true;

// ========= EXPRESS DASHBOARD =========
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: "cyberland_secret", resave: false, saveUninitialized: true }));

// login
// LOGIN PAGE
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.send(`
  <html>
  <head>
    <title>Cyberland Login</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
      body {
        margin: 0;
        padding: 0;
        font-family: 'Poppins', sans-serif;
        background: linear-gradient(135deg,#1f1c2c,#928dab);
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        color: #fff;
      }
      .login-container {
        background: rgba(0,0,0,0.85);
        padding: 40px;
        border-radius: 20px;
        box-shadow: 0 0 30px rgba(0,0,0,0.5);
        text-align: center;
        width: 350px;
        animation: fadeIn 1s ease-in-out;
      }
      h1 { margin-bottom: 30px; color:#ff2a68; }
      input {
        width: 80%;
        padding: 12px;
        margin: 10px 0;
        border-radius: 10px;
        border: none;
        outline: none;
      }
      button {
        width: 85%;
        padding: 12px;
        border: none;
        border-radius: 10px;
        background: #ff2a68;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      button:hover { background: #ff497f; }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-20px); }
        to { opacity: 1; transform: translateY(0); }
      }
    </style>
  </head>
  <body>
    <div class="login-container">
      <h1>🔐 Cyberland Login</h1>
      <form method="POST" action="/login">
        <input name="username" placeholder="Username" required><br>
        <input type="password" name="password" placeholder="Password" required><br>
        <button>Login</button>
      </form>
    </div>
  </body>
  </html>
  `);
});

// DASHBOARD PAGE
app.get("/dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.send(`
  <html>
  <head>
    <title>Cyberland Dashboard</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
      body {
        margin: 0;
        font-family: 'Poppins', sans-serif;
        background: linear-gradient(135deg,#0f0c29,#302b63,#24243e);
        color: #fff;
      }
      header {
        background: rgba(0,0,0,0.7);
        padding: 20px;
        text-align: center;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 1px;
        color: #ff2a68;
        box-shadow: 0 2px 15px rgba(0,0,0,0.5);
      }
      .btn-container {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        margin: 20px 0;
        gap: 15px;
      }
      button {
        padding: 15px 25px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(90deg,#ff2a68,#ff497f);
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 5px 15px rgba(0,0,0,0.3);
      }
      button:hover {
        transform: translateY(-3px);
        box-shadow: 0 8px 20px rgba(0,0,0,0.5);
      }
      #log {
        margin: 20px auto;
        background: rgba(0,0,0,0.6);
        width: 90%;
        max-width: 1200px;
        height: 300px;
        padding: 15px;
        border-radius: 15px;
        overflow-y: auto;
        font-family: monospace;
        font-size: 14px;
        box-shadow: 0 0 20px rgba(0,0,0,0.5);
      }
    </style>
  </head>
  <body>
    <header>⚡ Cyberland Premium Dashboard ⚡</header>
    <div class="btn-container">
      <button onclick="toggleAI()">🤖 Toggle AI</button>
      <button onclick="announce()">📢 Announcement</button>
      <button onclick="clearChannel()">🧹 Clear Channel</button>
      <button onclick="startUpdate()">⏳ Start Update</button>
      <button onclick="finishUpdate()">✅ Finish Update</button>
      <button onclick="botInfo()">📊 Bot Info</button>
    </div>
    <div id="log"></div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      const s = io();
      s.on('msg', m => {
        const l = document.getElementById('log');
        l.innerHTML += '<div>' + new Date().toLocaleTimeString() + ' - ' + m + '</div>';
        l.scrollTop = l.scrollHeight;
      });
      function toggleAI(){s.emit('toggleAI');}
      function announce(){const t=prompt("Title?"); const c=prompt("Content?"); const r=prompt("Reason?"); s.emit("announce",{title:t,content:c,reason:r});}
      function clearChannel(){s.emit("clearChannel");}
      function startUpdate(){const r=prompt("Reason?"); const m=prompt("Minutes?","5"); s.emit("startUpdate",{reason:r,minutes:Number(m)});}
      function finishUpdate(){s.emit("finishUpdate");}
      function botInfo(){s.emit("botInfo");}
    </script>
  </body>
  </html>
  `);
});


// ========= SOCKET.IO =========
io.on("connection", (socket) => {
  socket.on("toggleAI", () => {
    aiEnabled = !aiEnabled;
    socket.emit("msg", `AI is now ${aiEnabled ? "enabled ✅" : "disabled ❌"}`);
  });

  socket.on("announce", async (data) => {
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle(`📢 ${data.title}`)
      .setDescription(data.content)
      .addFields(
        { name: "Reason", value: data.reason || "No reason" },
        { name: "Developed By", value: "🔥 ZIHUU 🔥" }
      )
      .setColor("Purple")
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    socket.emit("msg", "✅ Announcement sent!");
  });

  socket.on("clearChannel", async () => {
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if (!channel) return;
    const msgs = await channel.messages.fetch({ limit: 100 });
    await channel.bulkDelete(msgs);
    const embed = new EmbedBuilder()
      .setTitle("⚡ Channel Cleared ⚡")
      .setDescription("All messages have been removed.")
      .addFields(
        { name: "Ping", value: client.ws.ping+"ms", inline:true },
        { name: "Server", value: channel.guild.name, inline:true },
        { name: "Developed By", value:"✨ ZIHUU ✨", inline:true }
      )
      .setColor("Gold")
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    socket.emit("msg", "🧹 Channel cleared & embed sent!");
  });

  socket.on("startUpdate", async (data) => {
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if (!channel) return;

    // Delete all messages first
    const msgs = await channel.messages.fetch({ limit: 100 });
    await channel.bulkDelete(msgs);

    const embed = new EmbedBuilder()
      .setTitle("⏳ Bot Update Started ⏳")
      .setDescription(`Bot update in progress...`)
      .addFields(
        { name: "Reason", value: data.reason || "No reason" },
        { name: "Duration", value: data.minutes+" min", inline:true },
        { name: "Bot Ping", value: client.ws.ping+"ms", inline:true },
        { name: "Developed By", value:"✨ ZIHUU ✨", inline:true }
      )
      .setColor("Blue")
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    socket.emit("msg", `⏳ Update started for ${data.minutes} minutes!`);
  });

  socket.on("finishUpdate", async () => {
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle("✅ Bot Update Finished ✅")
      .setDescription(`Bot update completed successfully!`)
      .addFields(
        { name: "Ping", value: client.ws.ping+"ms", inline:true },
        { name: "Server", value: channel.guild.name, inline:true },
        { name: "Developed By", value:"✨ ZIHUU ✨", inline:true }
      )
      .setColor("Green")
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    socket.emit("msg", "✅ Update finished & embed sent!");
  });

  socket.on("botInfo", () => {
    socket.emit("msg", `Bot Ping: ${client.ws.ping}ms`);
  });
});

// ========= DISCORD EVENTS =========
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// AI reply
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel.id !== FIXED_CHANNEL_ID) return;

  if (aiEnabled) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: msg.content }],
        max_tokens: 150
      });
      if (res.choices[0]?.message?.content) {
        msg.reply(res.choices[0].message.content);
      } else {
        msg.reply("⚠️ AI could not generate a response.");
      }
    } catch (err) {
      console.error("AI Error:", err.message);
      msg.reply("⚠️ AI is temporarily unavailable. Retrying...");
      setTimeout(async ()=>{
        try {
          const retry = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role:"user", content: msg.content }],
            max_tokens: 150
          });
          msg.reply(retry.choices[0].message.content);
        } catch(e){
          msg.reply("❌ AI failed again. Try later.");
        }
      },3000);
    }
  }
});

// ========= DAILY AUTO UPDATE =========
cron.schedule("0 11 * * *", async () => { // 11:00 BD time
  io.emit("msg", "🌐 Daily auto update triggered (11:00)");
  const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
  if (!channel) return;
  const msgs = await channel.messages.fetch({ limit: 100 });
  await channel.bulkDelete(msgs);
  const embed = new EmbedBuilder()
    .setTitle("⏳ Daily Bot Update ⏳")
    .setDescription("Automatic daily update in progress...")
    .addFields(
      { name: "Duration", value: "5 min", inline:true },
      { name: "Bot Ping", value: client.ws.ping+"ms", inline:true },
      { name: "Developed By", value:"✨ ZIHUU ✨", inline:true }
    )
    .setColor("Blue")
    .setTimestamp();
  await channel.send({ embeds: [embed] });
});

cron.schedule("0 15 * * *", async () => { // 15:00 BD time
  io.emit("msg", "🌐 Daily auto update triggered (15:00)");
  const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
  if (!channel) return;
  const msgs = await channel.messages.fetch({ limit: 100 });
  await channel.bulkDelete(msgs);
  const embed = new EmbedBuilder()
    .setTitle("⏳ Daily Bot Update ⏳")
    .setDescription("Automatic daily update in progress...")
    .addFields(
      { name: "Duration", value: "5 min", inline:true },
      { name: "Bot Ping", value: client.ws.ping+"ms", inline:true },
      { name: "Developed By", value:"✨ ZIHUU ✨", inline:true }
    )
    .setColor("Blue")
    .setTimestamp();
  await channel.send({ embeds: [embed] });
});

// ========= START =========
client.login(TOKEN);
server.listen(3000, ()=>console.log("🌐 Dashboard running on port 3000"));

