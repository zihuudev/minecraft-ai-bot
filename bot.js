require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment-timezone");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const util = require("minecraft-server-util");

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== AI Chat =====
async function askOpenAI(prompt) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini", // Super fast & stable
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.7,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        timeout: 60000,
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("🔴 OpenAI Error:", err.response?.data || err.message);
    if (err.response?.status === 401) {
      return "❌ Invalid OpenAI API Key। `.env` চেক করুন।";
    } else if (err.response?.status === 429) {
      return "⏳ AI সার্ভারের লিমিট শেষ হয়েছে। কিছুক্ষণ পর চেষ্টা করুন।";
    } else {
      return "⚠️ AI সার্ভার বর্তমানে অনুপলব্ধ। পরে আবার চেষ্টা করুন।";
    }
  }
}

// ===== Express Dashboard =====
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "cyberland-dashboard-secret",
    resave: false,
    saveUninitialized: true,
  })
);

const dashboardHTML = `<!DOCTYPE html>
<html>
<head>
<title>Cyberland Bot Dashboard</title>
<style>
body { background:#0f172a;color:white;font-family:Poppins,sans-serif;text-align:center; }
button {margin:10px;padding:15px 20px;border:none;border-radius:10px;cursor:pointer;font-size:16px;}
#start{background:#f97316;color:white;}#finish{background:#22c55e;color:white;}#toggle{background:#eab308;color:black;}
input{padding:10px;border-radius:8px;width:250px;}
</style>
</head>
<body>
<h1>⚡ Cyberland Bot Dashboard</h1>
<input id="mins" type="number" placeholder="Update duration (minutes)">
<input id="reason" type="text" placeholder="Reason for update">
<br>
<button id="start" onclick="startUpdate()">🚀 Start Manual Update</button>
<button id="finish" onclick="finishUpdate()">✅ Finish Update</button>
<button id="toggle" onclick="toggleAuto()">🔄 Toggle Auto Update</button>
<script>
async function startUpdate(){
 const mins=document.getElementById("mins").value;
 const reason=document.getElementById("reason").value;
 if(!mins)return alert("Enter minutes!");
 await fetch("/api/start-update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({minutes:mins,reason:reason})});
 alert("Update started!");
}
async function finishUpdate(){
 await fetch("/api/finish-update",{method:"POST"});
 alert("Update finished!");
}
async function toggleAuto(){
 await fetch("/api/toggle-auto",{method:"POST"});
 alert("Toggled Auto Update!");
}
</script>
</body>
</html>`;

// ===== Routes =====
app.get("/", (req, res) => {
  if (!req.session.loggedIn)
    return res.send(
      `<form method='POST' action='/login'><input type='password' name='password'><button type='submit'>Login</button></form>`
    );
  res.send(dashboardHTML);
});

app.post("/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect("/");
  } else res.send("<h1 style='color:red;'>Invalid Password</h1>");
});

let autoUpdate = true;

// ===== Manual Update =====
app.post("/api/start-update", async (req, res) => {
  try {
    const { minutes, reason } = req.body;
    const channel = await client.channels.fetch(CHANNEL_ID);

    // Delete all messages first
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      await channel.bulkDelete(fetched);
    } while (fetched.size >= 2);

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: false,
    });

    const embed = new EmbedBuilder()
      .setColor("Gold")
      .setTitle("🚀 Bot Updating...")
      .setDescription(
        `**Reason:** ${reason || "No reason provided"}\n⏳ Estimated time: **${minutes} minutes**`
      )
      .addFields({ name: "Developed By", value: "Zihuu", inline: false })
      .setFooter({ text: "Cyberland Bot" })
      .setTimestamp();

    await channel.send({ content: "@everyone", embeds: [embed] });

    // Auto finish after given minutes
    setTimeout(async () => {
      let fetched2;
      do {
        fetched2 = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(fetched2);
      } while (fetched2.size >= 2);

      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
        SendMessages: true,
      });

      const finishEmbed = new EmbedBuilder()
        .setColor("Green")
        .setTitle("✅ Bot Updated Successfully!")
        .setDescription("Bot is now back online.")
        .addFields({ name: "Developed By", value: "Zihuu", inline: false })
        .setFooter({ text: "Cyberland Bot" })
        .setTimestamp();

      await channel.send({ content: "@everyone", embeds: [finishEmbed] });
    }, minutes * 60000);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// ===== Finish Update =====
app.post("/api/finish-update", async (req, res) => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);

    // Delete all messages
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      await channel.bulkDelete(fetched);
    } while (fetched.size >= 2);

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: true,
    });

    const embed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("✅ Bot Updated Successfully!")
      .setDescription("Bot is now back online.")
      .addFields({ name: "Developed By", value: "Zihuu", inline: false })
      .setFooter({ text: "Cyberland Bot" })
      .setTimestamp();

    await channel.send({ content: "@everyone", embeds: [embed] });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// ===== Toggle Auto Update =====
app.post("/api/toggle-auto", (req, res) => {
  autoUpdate = !autoUpdate;
  res.json({ autoUpdate });
});

// ===== Auto Update (BD Time) =====
cron.schedule(
  "0 15 * * *",
  async () => {
    if (!autoUpdate) return;
    const channel = await client.channels.fetch(CHANNEL_ID);

    // Delete all
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      await channel.bulkDelete(fetched);
    } while (fetched.size >= 2);

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: false,
    });

    const embed = new EmbedBuilder()
      .setColor("Orange")
      .setTitle("⚡ Auto Update Started")
      .setDescription("Bot is auto-updating.\n⏳ Estimated time: **5 minutes**")
      .addFields({ name: "Developed By", value: "Zihuu", inline: false })
      .setFooter({ text: "Cyberland Bot" })
      .setTimestamp();

    await channel.send({ content: "@everyone", embeds: [embed] });
  },
  { timezone: "Asia/Dhaka" }
);

cron.schedule(
  "5 15 * * *",
  async () => {
    if (!autoUpdate) return;
    const channel = await client.channels.fetch(CHANNEL_ID);

    // Delete all
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      await channel.bulkDelete(fetched);
    } while (fetched.size >= 2);

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: true,
    });

    const embed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("✅ Auto Update Finished")
      .setDescription("Bot is now back online.")
      .addFields({ name: "Developed By", value: "Zihuu", inline: false })
      .setFooter({ text: "Cyberland Bot" })
      .setTimestamp();

    await channel.send({ content: "@everyone", embeds: [embed] });
  },
  { timezone: "Asia/Dhaka" }
);

// ===== AI Chat Handler =====
client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channel.id !== CHANNEL_ID) return;
  await message.channel.sendTyping();
  const reply = await askOpenAI(`${message.author.username}: ${message.content}`);
  message.reply(reply);
});

// ===== Bot Ready =====
client.on("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🌐 Dashboard: http://localhost:${PORT}`));
