// bot.js - All in one premium AI Discord Bot + Dashboard

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const OpenAI = require("openai");

// ========== ENV VARS ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS || "cblbotai0x9x";
const AI_CHANNEL_ID = process.env.AI_CHANNEL_ID || "1404498262379200522";
const PORT = process.env.PORT || 3000;

// ========== DISCORD CLIENT ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ========== OPENAI ==========
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========== DASHBOARD ==========
const app = express();
let isUpdating = false;

app.use(express.urlencoded({ extended: true }));

// Login Page
app.get("/", (req, res) => {
  res.send(`
  <html>
    <head>
      <title>Cyberland AI Dashboard</title>
      <style>
        body{font-family:Arial;background:#0f172a;color:white;text-align:center;padding:50px;}
        .box{background:#1e293b;padding:20px;border-radius:12px;display:inline-block;}
        input{padding:10px;border-radius:6px;border:none;margin:5px;}
        button{padding:10px 20px;border:none;border-radius:6px;background:#38bdf8;color:#000;font-weight:bold;cursor:pointer;}
        button:hover{background:#0ea5e9;color:white;}
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Cyberland AI Dashboard</h1>
        <form method="post" action="/login">
          <input type="password" name="pass" placeholder="Admin Password"/><br/>
          <button type="submit">Login</button>
        </form>
      </div>
    </body>
  </html>
  `);
});

// Dashboard after login
app.post("/login", (req, res) => {
  if (req.body.pass === ADMIN_PASS) {
    res.send(`
    <html>
      <head>
        <title>Dashboard</title>
        <style>
          body{font-family:Arial;background:#0f172a;color:white;text-align:center;padding:40px;}
          .btn{padding:15px 25px;border:none;border-radius:8px;margin:10px;font-size:18px;cursor:pointer;}
          .lock{background:#facc15;color:black;}
          .unlock{background:#4ade80;color:black;}
        </style>
      </head>
      <body>
        <h1>⚡ Cyberland AI Control</h1>
        <p>Status: ${isUpdating ? "⏳ Updating..." : "✅ Online"}</p>
        <form method="post" action="/start"><button class="btn lock">Start Update</button></form>
        <form method="post" action="/stop"><button class="btn unlock">Finish Update</button></form>
      </body>
    </html>
    `);
  } else {
    res.send("❌ Wrong Password");
  }
});

// Start Update
app.post("/start", async (req, res) => {
  try {
    const ch = await client.channels.fetch(AI_CHANNEL_ID);
    if (!ch) return res.send("Channel not found!");
    isUpdating = true;
    await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false });

    const embed = new EmbedBuilder()
      .setTitle("🚧 Bot Updating...")
      .setDescription("The AI is being updated. Chat is temporarily locked.")
      .setColor("Orange")
      .setTimestamp();

    await ch.send({ embeds: [embed] });
    res.redirect("/login?pass=" + ADMIN_PASS);
  } catch (e) {
    console.error(e);
    res.send("Error locking channel");
  }
});

// Stop Update
app.post("/stop", async (req, res) => {
  try {
    const ch = await client.channels.fetch(AI_CHANNEL_ID);
    if (!ch) return res.send("Channel not found!");
    isUpdating = false;
    await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true });

    const embed = new EmbedBuilder()
      .setTitle("✅ Update Completed")
      .setDescription("Bot update finished successfully. Chat is unlocked.")
      .setColor("Green")
      .setTimestamp();

    await ch.send({ embeds: [embed] });
    res.redirect("/login?pass=" + ADMIN_PASS);
  } catch (e) {
    console.error(e);
    res.send("Error unlocking channel");
  }
});

// ========== AI CHAT ==========
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== AI_CHANNEL_ID) return;
  if (isUpdating) return message.reply("⏳ Bot is updating, please wait...");

  try {
    await message.channel.sendTyping();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are Cyberland Minecraft Expert AI. You know everything about the server play.cyberland.pro and Minecraft in general.",
        },
        { role: "user", content: message.content },
      ],
    });

    const reply = response.choices[0].message.content;
    message.reply(reply);
  } catch (err) {
    console.error(err);
    message.reply("⚠️ Error getting AI response.");
  }
});

// ========== START ==========
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  app.listen(PORT, () =>
    console.log(`🌍 Dashboard running at http://localhost:${PORT}`)
  );
});

client.login(DISCORD_TOKEN);
