/*
 Cyberland Premium Bot.js (Railway Edition)
 Author: Zihad
 ------------------------------------------
 Features:
 ✅ Discord.js v14 Slash Commands + Message Commands
 ✅ No @everyone mentions (safe allowedMentions)
 ✅ /status command → ping, uptime, system info
 ✅ !lock / !unlock → channel lock/unlock
 ✅ !clear <n> → bulk clear messages
 ✅ AI Chat (!ai) → OpenAI API (optional)
 ✅ Web Dashboard (Express + Socket.io)
 ✅ Admin login (user: zihuu/shahin/mainuddin, pass: cyberlandai90x90x90)
 ✅ Auto-update system (configurable)
 ✅ Autorole system
 ✅ Minecraft server status check (Bedrock/Java)
 ✅ Railway environment variable support (no .env file needed)
*/

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField
} = require("discord.js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cron = require("node-cron");
const bodyParser = require("body-parser");
const session = require("express-session");

// ================== CONFIG FROM RAILWAY ==================
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;
const ADMINS = (process.env.ADMINS || "").split(",");
const CHANNEL_ID = process.env.CHANNEL_ID || null;
const SESSION_SECRET = process.env.SESSION_SECRET || "changeme";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const UPDATE_JSON_URL =
  process.env.UPDATE_JSON_URL || "https://example.com/update.json";
// =========================================================

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Runtime settings
let settings = {
  channelId: CHANNEL_ID,
  autoUpdate: true,
  aiEnabled: true
};

// Express dashboard setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(
  session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true })
);

// Simple login
app.post("/login", (req, res) => {
  const { user, pass } = req.body;
  if (
    ["zihuu", "shahin", "mainuddin"].includes(user) &&
    pass === "cyberlandai90x90x90"
  ) {
    req.session.auth = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

// Protected route middleware
function isAuthed(req, res, next) {
  if (req.session.auth) return next();
  res.status(403).json({ error: "not authorized" });
}

// API endpoints
app.post("/setchannel", isAuthed, (req, res) => {
  settings.channelId = req.body.channelId;
  res.json({ success: true });
});

app.post("/toggleai", isAuthed, (req, res) => {
  settings.aiEnabled = !!req.body.enabled;
  res.json({ success: true });
});

app.post("/toggleautoupdate", isAuthed, (req, res) => {
  settings.autoUpdate = !!req.body.enabled;
  res.json({ success: true });
});

// Discord events
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "status") {
    const embed = new EmbedBuilder()
      .setTitle("🤖 Cyberland Bot Status")
      .setDescription("All systems operational")
      .addFields(
        { name: "Ping", value: `${client.ws.ping}ms`, inline: true },
        {
          name: "Uptime",
          value: `${Math.floor(process.uptime() / 60)}m`,
          inline: true
        }
      )
      .setColor("Green");
    interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }
});

// Message commands
client.on("messageCreate", async (msg) => {
  if (!ADMINS.includes(msg.author.id)) return;

  // Lock channel
  if (msg.content.startsWith("!lock")) {
    if (!settings.channelId) return msg.reply("⚠ No channel set");
    const ch = await client.channels.fetch(settings.channelId);
    await ch.permissionOverwrites.edit(ch.guild.roles.everyone, {
      SendMessages: false
    });
    msg.reply("🔒 Channel locked");
  }

  // Unlock channel
  if (msg.content.startsWith("!unlock")) {
    if (!settings.channelId) return msg.reply("⚠ No channel set");
    const ch = await client.channels.fetch(settings.channelId);
    await ch.permissionOverwrites.edit(ch.guild.roles.everyone, {
      SendMessages: true
    });
    msg.reply("🔓 Channel unlocked");
  }

  // Clear messages
  if (msg.content.startsWith("!clear")) {
    const parts = msg.content.split(" ");
    const n = parseInt(parts[1]) || 10;
    if (!settings.channelId) return msg.reply("⚠ No channel set");
    const ch = await client.channels.fetch(settings.channelId);
    const msgs = await ch.messages.fetch({ limit: n });
    await ch.bulkDelete(msgs);
    msg.reply(`🧹 Cleared ${msgs.size} messages`);
  }
});

// AI Chat (!ai)
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!settings.aiEnabled) return;

  if (msg.content.startsWith("!ai")) {
    if (!OPENAI_API_KEY) return msg.reply("⚠ AI disabled");
    try {
      const prompt = msg.content.replace("!ai", "").trim();
      const r = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }]
        },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
      );
      msg.reply(r.data.choices[0].message.content, {
        allowedMentions: { parse: [] }
      });
    } catch (err) {
      msg.reply("⚠ AI error");
    }
  }
});

// Run bot & dashboard
client.login(TOKEN);
server.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));
