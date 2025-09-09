require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const util = require("minecraft-server-util");

// === ENV Variables ===
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// === Discord Client ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// === AI Chat Function (FIXED) ===
async function askOpenAI(prompt) {
    try {
        const response = await axios({
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            data: {
                model: "gpt-4o-mini", // ✅ ফাস্ট + স্টেবল
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500,
                temperature: 0.7,
            },
            timeout: 60000, // ✅ 60 সেকেন্ড টাইমআউট, আগের 10s এর পরিবর্তে
        });

        if (
            response.data &&
            response.data.choices &&
            response.data.choices.length > 0
        ) {
            return response.data.choices[0].message.content.trim();
        } else {
            return "⚠️ AI কোনো উত্তর পাঠায়নি। আবার চেষ্টা করুন।";
        }
    } catch (error) {
        console.error("OpenAI Error:", error.response?.data || error.message);

        // ✅ স্পেশাল এরর হ্যান্ডলিং
        if (error.response?.status === 401) {
            return "❌ **Invalid OpenAI API Key**। `.env` ফাইল চেক করুন।";
        } else if (error.response?.status === 429) {
            return "⏳ **Rate limit exceeded**। একটু পরে আবার চেষ্টা করুন।";
        } else if (error.code === "ECONNABORTED") {
            return "⚡ OpenAI সার্ভার স্লো, আবার চেষ্টা করুন।";
        } else {
            return "⚠️ AI সার্ভার বর্তমানে অনুপলব্ধ। পরে আবার চেষ্টা করুন।";
        }
    }
}

// === Express Dashboard ===
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

// === Dashboard HTML ===
const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyberland Bot Dashboard</title>
<style>
body {
    margin: 0;
    background: linear-gradient(135deg,#0f172a,#1e293b);
    color: white;
    font-family: Poppins, sans-serif;
    text-align: center;
}
.container { margin-top: 40px; }
button {
    margin: 10px;
    padding: 15px;
    width: 280px;
    font-size: 16px;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    transition: 0.3s;
}
#manualUpdate { background-color: #22c55e; color: white; }
#finishUpdate { background-color: #06b6d4; color: white; }
#toggleAuto { background-color: #facc15; color: black; }
button:hover { transform: scale(1.05); filter: brightness(1.1); }
.status-box {
    margin-top: 25px;
    padding: 20px;
    background: rgba(255,255,255,0.05);
    border-radius: 12px;
    display: inline-block;
}
input {
    padding: 10px;
    border-radius: 12px;
    width: 250px;
    border: none;
}
</style>
</head>
<body>
<div class="container">
    <h1>⚡ Cyberland Premium Bot Dashboard</h1>
    <input id="updateTime" type="number" placeholder="Enter minutes">
    <button id="manualUpdate" onclick="startManualUpdate()">🚀 Start Manual Update</button>
    <button id="finishUpdate" onclick="fetch('/api/finish-update',{method:'POST'}).then(()=>alert('Update Finished!'))">✅ Finish Update</button>
    <button id="toggleAuto" onclick="fetch('/api/toggle-auto',{method:'POST'}).then(()=>alert('Toggled Auto Update!'))">🔄 Toggle Auto Update</button>
    <div id="status" class="status-box">Fetching Minecraft server status...</div>
</div>
<script>
async function getStatus() {
    const res = await fetch('/api/server-status');
    const data = await res.json();
    document.getElementById('status').innerText =
        data.online
            ? '🟢 Online - Players: ' + data.players + ' | Ping: ' + data.ping + 'ms'
            : '🔴 Server Offline';
}
async function startManualUpdate(){
    const mins=document.getElementById('updateTime').value;
    if(!mins)return alert('Please enter minutes!');
    await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:mins})});
    alert('Manual Update Started for '+mins+' minutes!');
}
getStatus();
setInterval(getStatus, 10000);
</script>
</body>
</html>`;

// === Routes ===
app.get("/", (req, res) => {
    if (!req.session.loggedIn)
        return res.send(`<form method='POST' action='/login'><input type='password' name='password'><button type='submit'>Login</button></form>`);
    res.send(dashboardHTML);
});

app.post("/login", (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.redirect("/");
    } else {
        res.send("<h1 style='color:red;'>Invalid Password</h1>");
    }
});

let autoUpdate = true;
let manualUpdateTimeout = null;

// === Delete All Messages in Channel ===
async function clearChannelMessages(channel) {
    let fetched;
    do {
        fetched = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(fetched);
    } while (fetched.size >= 2);
}

// === Start Manual Update ===
app.post("/api/start-update", async (req, res) => {
    try {
        const { minutes } = req.body;
        const channel = await client.channels.fetch(CHANNEL_ID);

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
        await clearChannelMessages(channel);

        const embed = new EmbedBuilder()
            .setColor("#ff2d55")
            .setTitle("🚀 Cyberland Bot Updating...")
            .setDescription(`⚡ **Bot Maintenance Started**\n⏳ Duration: **${minutes} minutes**\n\nPlease wait while we upgrade the system...`)
            .setImage("https://i.imgur.com/Lr9F1jE.gif")
            .setFooter({ text: "Cyberland Premium Bot" })
            .setTimestamp();

        await channel.send({ content: "@everyone", embeds: [embed] });

        if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
        manualUpdateTimeout = setTimeout(async () => {
            await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
            await clearChannelMessages(channel);

            const finishEmbed = new EmbedBuilder()
                .setColor("#4caf50")
                .setTitle("✅ Cyberland Bot Updated Successfully!")
                .setDescription("🎉 The bot has been updated and is now **online**!")
                .setFooter({ text: "Cyberland Premium Bot" })
                .setTimestamp();
            await channel.send({ content: "@everyone", embeds: [finishEmbed] });
        }, minutes * 60000);

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

// === Finish Update Manually ===
app.post("/api/finish-update", async (req, res) => {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
        await clearChannelMessages(channel);

        const embed = new EmbedBuilder()
            .setColor("#4caf50")
            .setTitle("✅ Bot Updated Successfully!")
            .setDescription("🎉 The bot has been updated and is now **online**!")
            .setFooter({ text: "Cyberland Premium Bot" })
            .setTimestamp();

        await channel.send({ content: "@everyone", embeds: [embed] });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

// === AI Chat Normal Reply ===
client.on("messageCreate", async (message) => {
    if (message.author.bot || message.channel.id !== CHANNEL_ID) return;

    await message.channel.sendTyping();
    const reply = await askOpenAI(`${message.author.username}: ${message.content}`);
    message.reply(reply);
});

// === Ready Event ===
client.on("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// === Start Bot ===
client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🌐 Dashboard: http://localhost:${PORT}`));
