// bot.js
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");
const express = require("express");
const OpenAI = require("openai");

// === OpenAI Setup ===
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Discord Setup ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// === Express Dashboard Setup ===
const app = express();
const PORT = process.env.PORT || 3000;

// Store update status
let isUpdating = false;
let updateChannelId = null;

// Serve dashboard
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>Cyberland AI Dashboard</title></head>
      <body style="font-family:sans-serif; background:#111; color:white; text-align:center; padding:50px;">
        <h1>⚡ Cyberland AI Dashboard</h1>
        <p>Status: <b style="color:${isUpdating ? "orange" : "lightgreen"};">${isUpdating ? "Updating..." : "Active"}</b></p>
        <button onclick="fetch('/start-update').then(()=>location.reload())" style="padding:10px 20px; margin:10px;">Start Update</button>
        <button onclick="fetch('/stop-update').then(()=>location.reload())" style="padding:10px 20px; margin:10px;">Stop Update</button>
      </body>
    </html>
  `);
});

// Start Update
app.get("/start-update", async (req, res) => {
  if (!updateChannelId) return res.send("No update channel set!");
  const channel = await client.channels.fetch(updateChannelId);
  if (!channel) return res.send("Channel not found!");

  isUpdating = true;
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: false,
  });

  const embed = new EmbedBuilder()
    .setTitle("🚧 Bot Updating...")
    .setDescription("The AI is currently updating, please wait.\n\n🔒 Channel locked.")
    .setColor("Orange")
    .setTimestamp();

  await channel.send({ content: "@everyone", embeds: [embed] });
  res.send("Update started!");
});

// Stop Update
app.get("/stop-update", async (req, res) => {
  if (!updateChannelId) return res.send("No update channel set!");
  const channel = await client.channels.fetch(updateChannelId);
  if (!channel) return res.send("Channel not found!");

  isUpdating = false;
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: true,
  });

  const embed = new EmbedBuilder()
    .setTitle("✅ Update Completed")
    .setDescription("Bot has been updated successfully.\n\n🔓 Channel unlocked. You may chat now!")
    .setColor("Green")
    .setTimestamp();

  await channel.send({ content: "@everyone", embeds: [embed] });
  res.send("Update stopped!");
});

// === AI Chat Handling ===
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Set update channel automatically from first AI message channel
  if (!updateChannelId) updateChannelId = message.channel.id;

  if (isUpdating) {
    return message.reply("⏳ Bot is updating, please wait...");
  }

  if (message.mentions.has(client.user)) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini", // ⚡ Best balance model
        messages: [
          { role: "system", content: "You are a Minecraft expert AI specialized in the server play.cyberland.pro. Always give helpful, professional answers about Minecraft, servers, plugins, mods, and gameplay." },
          { role: "user", content: message.content },
        ],
      });

      const reply = response.choices[0].message.content;
      message.reply(reply);
    } catch (err) {
      console.error("OpenAI Error:", err);
      message.reply("⚠️ Error while contacting AI.");
    }
  }
});

// === Bot Ready ===
client.once("ready", () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  app.listen(PORT, () => console.log(`🌍 Dashboard running at http://localhost:${PORT}`));
});

// === Login ===
client.login(process.env.DISCORD_TOKEN);
