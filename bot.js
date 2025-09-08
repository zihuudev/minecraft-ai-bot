require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment-timezone");
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");
const util = require("minecraft-server-util");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MINECRAFT_IP = "play.cyberland.pro";
const MINECRAFT_PORT = 19132;

// ====== DISCORD BOT ======
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ====== OPENAI QUERY ======
async function queryOpenAI(prompt) {
    try {
        const res = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-3.5-turbo",
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
        console.error("OpenAI Error:", err.response?.data || err.message);
        return "⚠️ OpenAI API not reachable right now. Try again later.";
    }
}

// ====== EXPRESS DASHBOARD ======
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

// ====== LOGIN PAGE ======
const loginPage = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyberland Bot Dashboard</title>
<style>
body { margin: 0; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Poppins, sans-serif; }
.container { background: rgba(255,255,255,0.05); padding: 40px; border-radius: 20px; box-shadow: 0 0 25px rgba(0,255,255,0.3); backdrop-filter: blur(15px); text-align: center; width: 350px; }
input { padding: 12px; width: 90%; margin-top: 15px; border: none; border-radius: 12px; background: rgba(255,255,255,0.1); color: white; }
button { margin-top: 20px; width: 100%; padding: 12px; border: none; border-radius: 12px; background: #06b6d4; color: white; font-weight: bold; cursor: pointer; transition: 0.3s; }
button:hover { background: #0891b2; transform: scale(1.05); }
.error { color: red; margin-top: 10px; }
</style>
</head>
<body>
<div class="container">
    <h2>🔐 Cyberland Bot Dashboard</h2>
    <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Enter Admin Password" required>
        <button type="submit">Login</button>
    </form>
</div>
</body>
</html>
`;

// ====== DASHBOARD PAGE ======
const dashboardPage = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyberland Bot Dashboard</title>
<style>
body { margin: 0; background: #0f172a; color: white; font-family: Poppins, sans-serif; text-align: center; }
.container { margin-top: 40px; }
button { margin: 15px; padding: 15px; width: 260px; font-size: 16px; border: none; border-radius: 12px; cursor: pointer; transition: 0.3s; }
#startUpdate { background-color: #22c55e; color: white; }
#finishUpdate { background-color: #06b6d4; color: white; }
#toggleAuto { background-color: #facc15; color: black; }
button:hover { transform: scale(1.05); }
.status-box { margin-top: 25px; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 12px; display: inline-block; }
</style>
</head>
<body>
<div class="container">
    <h1>⚡ Cyberland Bot Dashboard</h1>
    <button id="startUpdate" onclick="fetch('/api/start-update',{method:'POST'}).then(()=>alert('Update Started!'))">🚀 Start Update</button>
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
getStatus();
setInterval(getStatus, 10000);
</script>
</body>
</html>
`;

// ====== ROUTES ======
app.get("/", (req, res) => res.send(loginPage));

app.post("/login", (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.send(dashboardPage);
    } else {
        res.send("<h1 style='color:red; text-align:center;'>Invalid Password</h1>");
    }
});

app.post("/api/start-update", async (req, res) => {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
        await channel.send({
            content: "@everyone",
            embeds: [new EmbedBuilder()
                .setColor("Gold")
                .setTitle("🚀 Bot Update Started")
                .setDescription("The bot is now updating. Please wait...")]
        });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

app.post("/api/finish-update", async (req, res) => {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
        await channel.send({
            content: "@everyone",
            embeds: [new EmbedBuilder()
                .setColor("Green")
                .setTitle("✅ Update Finished")
                .setDescription("The bot update has been completed successfully!")]
        });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

app.post("/api/toggle-auto", (req, res) => {
    autoUpdate = !autoUpdate;
    res.json({ autoUpdate });
});

// ====== MINECRAFT STATUS API ======
app.get("/api/server-status", async (req, res) => {
    try {
        const status = await util.status(MINECRAFT_IP, MINECRAFT_PORT);
        res.json({ online: true, players: status.players.online, ping: status.roundTripLatency });
    } catch {
        res.json({ online: false });
    }
});

// ====== DAILY AUTO UPDATE ======
let autoUpdate = true;
cron.schedule("0 15 * * *", async () => {
    if (!autoUpdate) return;
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    await channel.send({
        content: "@everyone",
        embeds: [new EmbedBuilder()
            .setColor("Orange")
            .setTitle("⚡ Auto Update Started")
            .setDescription("The bot is updating automatically...")]
    });
}, { timezone: "Asia/Dhaka" });

cron.schedule("5 15 * * *", async () => {
    if (!autoUpdate) return;
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    await channel.send({
        content: "@everyone",
        embeds: [new EmbedBuilder()
            .setColor("Green")
            .setTitle("✅ Auto Update Finished")
            .setDescription("Bot is back online!")]
    });
}, { timezone: "Asia/Dhaka" });

// ====== DISCORD AI CHAT ======
client.on("messageCreate", async (message) => {
    if (message.author.bot || message.channel.id !== CHANNEL_ID) return;
    if (!OPENAI_API_KEY) return message.reply("⚠️ AI is disabled. No OpenAI key configured.");
    await message.channel.sendTyping();
    const reply = await queryOpenAI(`${message.author.username}: ${message.content}`);
    message.reply(reply);
});

// ====== DISCORD LOGIN ======
client.on("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);

// ====== START EXPRESS SERVER ======
app.listen(PORT, () => console.log(`🌐 Dashboard running: http://localhost:${PORT}`));
