// =======================
// Cyberland Ultra-Premium Bot.js
// =======================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const session = require("express-session");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");
const OpenAI = require("openai");

// ========= ENV VARIABLES =========
const TOKEN = process.env.TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ADMINS = process.env.ADMINS ? process.env.ADMINS.split(",") : [];
const ADMIN_PASS = process.env.ADMIN_PASS;
const FIXED_CHANNEL_ID = "1419702204171813015"; // all bot work in this channel

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
app.use(session({
  secret: "cyberland_secret",
  resave: false,
  saveUninitialized: true
}));

// login page
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "login.html"));
});

// login post
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (ADMINS.includes(username) && password === ADMIN_PASS) {
    req.session.user = username;
    res.redirect("/dashboard");
  } else {
    res.send("<h2>Invalid login!</h2><a href='/'>Back</a>");
  }
});

// dashboard
app.get("/dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ========= SOCKET.IO =========
io.on("connection", (socket) => {
  socket.on("toggleAI", () => {
    aiEnabled = !aiEnabled;
    socket.emit("msg", `🤖 AI system is now ${aiEnabled ? "enabled ✅" : "disabled ❌"}`);
  });

  socket.on("announce", async (data) => {
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle(`📢 ${data.title}`)
      .setDescription(data.content)
      .addFields(
        { name: "Reason", value: data.reason || "No reason provided" },
        { name: "Developed By", value: "🔥 **ZIHUU** 🔥" }
      )
      .setColor("Purple")
      .setTimestamp();
    channel.send({ embeds: [embed] });
    socket.emit("msg", "✅ Announcement sent!");
  });

  socket.on("clearChannel", async () => {
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 100 });
    await channel.bulkDelete(messages);

    // premium embed after clear
    const embed = new EmbedBuilder()
      .setTitle("⚡ Channel Cleared Successfully ⚡")
      .setDescription("All messages have been removed by the system.")
      .addFields(
        { name: "Ping", value: `${client.ws.ping}ms`, inline: true },
        { name: "Server", value: channel.guild.name, inline: true },
        { name: "Developed By", value: "✨ **ZIHUU** ✨", inline: true }
      )
      .setColor("Gold")
      .setFooter({ text: "Cyberland Auto System" })
      .setTimestamp();
    channel.send({ embeds: [embed] });
    socket.emit("msg", "🧹 Channel cleared & embed sent!");
  });
});

// ========= DISCORD EVENTS =========
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel.id !== FIXED_CHANNEL_ID) return; // only work in fixed channel

  if (aiEnabled) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: msg.content }],
        max_tokens: 150
      });
      msg.reply(response.choices[0].message.content);
    } catch (err) {
      console.error("AI Error:", err.message);
      msg.reply("⚠️ AI is temporarily unavailable. Retrying in 3s...");
      // retry once after 3s
      setTimeout(async () => {
        try {
          const retryRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: msg.content }],
            max_tokens: 150
          });
          msg.reply(retryRes.choices[0].message.content);
        } catch (e) {
          msg.reply("❌ AI failed again. Please try later.");
        }
      }, 3000);
    }
  }
});

// ========= START =========
client.login(TOKEN);
server.listen(3000, () => console.log("🌐 Dashboard running on port 3000"));
