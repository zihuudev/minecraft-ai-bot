require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment-timezone");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const util = require("minecraft-server-util");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// --- Discord Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// --- AI Query ---
async function queryAI(prompt) {
    try {
        const res = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                },
            }
        );
        return res.data.choices[0].message.content.trim();
    } catch (err) {
        console.error("AI Error:", err.response?.data || err.message);
        return "⚠️ AI service is currently unavailable. Please try again later.";
    }
}

// --- Express App ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
    session({
        secret: "ultra-premium-dashboard",
        resave: false,
        saveUninitialized: true,
    })
);

// --- Ultra-premium Dashboard HTML ---
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Cyberland AI Bot Dashboard</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;800&display=swap');
body {
    margin: 0;
    font-family: Poppins, sans-serif;
    background: linear-gradient(135deg, #0f172a, #1e293b, #0f172a);
    color: white;
    overflow-x: hidden;
}
.container {
    text-align: center;
    margin-top: 50px;
    animation: fadeIn 1.5s ease;
}
h1 {
    font-size: 38px;
    font-weight: 800;
    background: linear-gradient(90deg, #00f5ff, #00ff8c);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}
button {
    margin: 10px;
    padding: 15px;
    width: 260px;
    font-size: 16px;
    font-weight: bold;
    border: none;
    border-radius: 15px;
    cursor: pointer;
    color: white;
    transition: all 0.3s;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}
button:hover {
    transform: scale(1.08);
}
#manualUpdate { background: #4ade80; }
#finishUpdate { background: #06b6d4; }
#toggleAuto { background: #facc15; color: black; }
.status-box {
    margin-top: 20px;
    padding: 20px;
    background: rgba(255,255,255,0.05);
    border-radius: 15px;
    display: inline-block;
    font-size: 18px;
    box-shadow: inset 0 0 15px rgba(0,0,0,0.4);
}
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(-30px); }
    to { opacity: 1; transform: translateY(0); }
}
</style>
</head>
<body>
<div class="container">
    <h1>⚡ Cyberland AI Bot Dashboard</h1>
    <input id="updateTime" type="number" placeholder="Enter minutes" style="padding:10px;border-radius:12px;width:250px;">
    <button id="manualUpdate" onclick="startManualUpdate()">🚀 Start Manual Update</button>
    <button id="finishUpdate" onclick="finishUpdate()">✅ Finish Update</button>
    <button id="toggleAuto" onclick="toggleAutoUpdate()">🔄 Toggle Auto Update</button>
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
async function finishUpdate(){
    await fetch('/api/finish-update',{method:'POST'});
    alert('Update Finished!');
}
async function toggleAutoUpdate(){
    await fetch('/api/toggle-auto',{method:'POST'});
    alert('Toggled Auto Update!');
}
getStatus();
setInterval(getStatus, 10000);
</script>
</body>
</html>`;

// --- Dashboard Routes ---
app.get("/", (req, res) => {
    if (!req.session.loggedIn)
        return res.send(`
            <form method='POST' action='/login' style="text-align:center;margin-top:20%">
                <h1>🔐 Cyberland AI Dashboard Login</h1>
                <input type='text' name='username' placeholder='Username' required style="padding:10px;width:250px;border-radius:12px;"><br><br>
                <input type='password' name='password' placeholder='Password' required style="padding:10px;width:250px;border-radius:12px;"><br><br>
                <button type='submit' style="padding:10px 20px;border:none;border-radius:12px;background:#06b6d4;color:white;font-size:18px;">Login</button>
            </form>
        `);
    res.send(dashboardHTML);
});

const USERS = ["zihuu", "shahin", "mainuddin"];
app.post("/login", (req, res) => {
    if (USERS.includes(req.body.username) && req.body.password === "cyberlandai90x90x90") {
        req.session.loggedIn = true;
        res.redirect("/");
    } else {
        res.send("<h1 style='color:red;text-align:center;'>❌ Invalid Login</h1>");
    }
});

let autoUpdate = true;
let manualUpdateTimeout = null;

// --- Manual Update ---
app.post("/api/start-update", async (req, res) => {
    try {
        const { minutes } = req.body;
        const channel = await client.channels.fetch(CHANNEL_ID);

        // Delete all messages instantly
        const messages = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(messages);

        // Lock channel instantly
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });

        const embed = new EmbedBuilder()
            .setColor("#facc15")
            .setTitle("🚀 Bot Updating...")
            .setDescription(`Bot is under manual maintenance for **${minutes} minutes**. Please wait...`)
            .setThumbnail("https://i.ibb.co/9NV4c3P/update.gif")
            .addFields([
                { name: "⏳ Next Auto Update", value: "Today 11:20 AM & 3:00 PM", inline: true },
                { name: "Developed By", value: "Zihuu", inline: true },
            ])
            .setFooter({ text: "Cyberland AI Bot" })
            .setTimestamp();

        await channel.send({ content: "@everyone", embeds: [embed] });

        if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
        manualUpdateTimeout = setTimeout(async () => {
            const messages = await channel.messages.fetch({ limit: 100 });
            await channel.bulkDelete(messages);
            await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

            const finishEmbed = new EmbedBuilder()
                .setColor("#22c55e")
                .setTitle("✅ Update Completed")
                .setDescription("The bot is back online. Enjoy the AI features!")
                .setFooter({ text: "Cyberland AI Bot" })
                .setTimestamp();
            await channel.send({ content: "@everyone", embeds: [finishEmbed] });
        }, minutes * 60000);

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

// --- Finish Update API ---
app.post("/api/finish-update", async (req, res) => {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        const messages = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(messages);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

        const embed = new EmbedBuilder()
            .setColor("#22c55e")
            .setTitle("✅ Update Completed")
            .setDescription("The bot is back online. Enjoy the AI features!")
            .setFooter({ text: "Cyberland AI Bot" })
            .setTimestamp();

        await channel.send({ content: "@everyone", embeds: [embed] });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

// --- Toggle Auto Update ---
app.post("/api/toggle-auto", (req, res) => {
    autoUpdate = !autoUpdate;
    res.json({ autoUpdate });
});

// --- Minecraft Status ---
app.get("/api/server-status", async (req, res) => {
    try {
        const status = await util.status(MINECRAFT_IP, MINECRAFT_PORT);
        res.json({ online: true, players: status.players.online, ping: status.roundTripLatency });
    } catch {
        res.json({ online: false });
    }
});

// --- Auto Updates ---
const autoUpdateSlots = [
    { start: "30 11 * * *", end: "35 11 * * *" },
    { start: "0 15 * * *", end: "5 15 * * *" },
];

autoUpdateSlots.forEach((slot) => {
    cron.schedule(slot.start, async () => {
        if (!autoUpdate) return;
        const channel = await client.channels.fetch(CHANNEL_ID);

        const messages = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(messages);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });

        const embed = new EmbedBuilder()
            .setColor("#f97316")
            .setTitle("⚡ Auto Update Started")
            .setDescription("Bot updating automatically. Please wait...")
            .setThumbnail("https://i.ibb.co/9NV4c3P/update.gif")
            .addFields([{ name: "Developed By", value: "Zihuu", inline: true }])
            .setFooter({ text: "Cyberland AI Bot" })
            .setTimestamp();
        await channel.send({ content: "@everyone", embeds: [embed] });
    }, { timezone: "Asia/Dhaka" });

    cron.schedule(slot.end, async () => {
        if (!autoUpdate) return;
        const channel = await client.channels.fetch(CHANNEL_ID);

        const messages = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(messages);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

        const embed = new EmbedBuilder()
            .setColor("#22c55e")
            .setTitle("✅ Auto Update Finished")
            .setDescription("Bot is back online and ready!")
            .setFooter({ text: "Cyberland AI Bot" })
            .setTimestamp();
        await channel.send({ content: "@everyone", embeds: [embed] });
    }, { timezone: "Asia/Dhaka" });
});

// --- AI Chat ---
client.on("messageCreate", async (message) => {
    if (message.author.bot || message.channel.id !== CHANNEL_ID) return;
    await message.channel.sendTyping();
    const reply = await queryAI(`${message.author.username}: ${message.content}`);
    message.reply(reply);
});

// --- Bot Ready ---
client.on("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🌐 Dashboard Running: http://localhost:${PORT}`));
