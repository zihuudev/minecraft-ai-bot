// Cyberland Ultra-Premium All-in-One bot.js
// ==========================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const OpenAI = require("openai");

// ========= ENV VARIABLES =========
const TOKEN = process.env.TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ADMINS = ["zihuu", "shahin", "mainuddin"]; 
const ADMIN_PASS = "cyberlandai90x90x90"; // password ekhanei thakbe
const FIXED_CHANNEL_ID = "1419702204171813015";

// ========= DISCORD CLIENT =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
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
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.send(`
  <html><head><title>Cyberland Login</title></head>
  <body style="background:#0f0f0f;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
  <h1>🔐 Cyberland Bot Login</h1>
  <form method="POST" action="/login">
    <input style="padding:10px;margin:5px;border-radius:8px;" name="username" placeholder="Username" required><br>
    <input type="password" style="padding:10px;margin:5px;border-radius:8px;" name="password" placeholder="Password" required><br>
    <button style="padding:10px 20px;border:none;border-radius:8px;background:purple;color:#fff;font-weight:bold;">Login</button>
  </form></body></html>
  `);
});

// login post
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (ADMINS.includes(username) && password === ADMIN_PASS) {
    req.session.user = username;
    res.redirect("/dashboard");
  } else {
    res.send("<h2 style='color:red'>Invalid login!</h2><a href='/'>Back</a>");
  }
});

// dashboard
app.get("/dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.send(`
  <html><head><title>Cyberland Dashboard</title></head>
  <body style="background:#111;color:#fff;font-family:sans-serif;padding:30px;">
    <h1>⚡ Cyberland Dashboard ⚡</h1>
    <button onclick="toggleAI()">🤖 Toggle AI</button>
    <button onclick="announce()">📢 Announcement</button>
    <button onclick="clearChannel()">🧹 Clear Channel</button>
    <button onclick="botInfo()">📊 Bot Info</button>
    <div id="log" style="margin-top:20px;background:#000;padding:10px;height:250px;overflow:auto;border-radius:10px;"></div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      const s=io();
      s.on('msg',m=>{
        const l=document.getElementById('log');
        l.innerHTML+=\`<div>\${new Date().toLocaleTimeString()} - \${m}</div>\`;
        l.scrollTop=l.scrollHeight;
      });
      function toggleAI(){s.emit('toggleAI');}
      function announce(){const t=prompt("Title?");const c=prompt("Content?");const r=prompt("Reason?");s.emit("announce",{title:t,content:c,reason:r});}
      function clearChannel(){s.emit("clearChannel");}
      function botInfo(){s.emit("botInfo");}
      function update(){s.emit("update");}
    </script>
  </body></html>
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
        { name: "Developed By", value: "🔥 **ZIHUU** 🔥" }
      )
      .setColor("Purple").setTimestamp();
    channel.send({ embeds: [embed] });
    socket.emit("msg","✅ Announcement sent!");
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
        { name: "Developed By", value:"✨ **ZIHUU** ✨", inline:true }
      )
      .setColor("Gold").setTimestamp();
    channel.send({ embeds: [embed] });
    socket.emit("msg","🧹 Channel cleared & embed sent!");
  });

  socket.on("botInfo", () => {
    socket.emit("msg", `Bot Ping: ${client.ws.ping}ms`);
  });
});

// ========= DISCORD EVENTS =========
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

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
      msg.reply("⚠️ AI is busy (rate limit). Retrying...");
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

// ========= START =========
client.login(TOKEN);
server.listen(3000, ()=>console.log("🌐 Dashboard running on port 3000"));


