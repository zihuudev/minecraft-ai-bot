require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");
const util = require("minecraft-server-util");
const path = require("path");

// ====== CONFIG ======
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

// ====== AI Chat ======
async function queryOpenAI(prompt) {
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
        console.error("OpenAI Error:", err.response?.data || err.message);
        return "⚠️ AI সার্ভার বর্তমানে অনুপলব্ধ। পরে আবার চেষ্টা করুন।";
    }
}

// ====== Express Dashboard ======
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

// ====== Dashboard HTML ======
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyberland Bot Dashboard</title>
<style>
body { margin: 0; background: #0f172a; color: white; font-family: Poppins, sans-serif; text-align: center; }
.container { margin-top: 40px; }
button { margin: 10px; padding: 15px; width: 280px; font-size: 16px; border: none; border-radius: 12px; cursor: pointer; transition: 0.3s; }
#manualUpdate { background-color: #22c55e; color: white; }
#finishUpdate { background-color: #06b6d4; color: white; }
#toggleAuto { background-color: #facc15; color: black; }
button:hover { transform: scale(1.05); }
.status-box { margin-top: 25px; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 12px; display: inline-block; }
</style>
</head>
<body>
<div class="container">
    <h1>⚡ Cyberland Bot Dashboard</h1>
    <input id="updateTime" type="number" placeholder="Enter minutes" style="padding:10px;border-radius:12px;width:250px;">
    <button id="manualUpdate" onclick="startManualUpdate()">🚀 Start Manual Update</button>
    <button id="finishUpdate" onclick="finishUpdate()">✅ Finish Update</button>
    <button id="toggleAuto" onclick="toggleAuto()">🔄 Toggle Auto Update</button>
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
async function toggleAuto(){
    await fetch('/api/toggle-auto',{method:'POST'});
    alert('Toggled Auto Update!');
}
getStatus();
setInterval(getStatus, 10000);
</script>
</body>
</html>`;

// ====== Routes ======
app.get("/", (req, res) => {
    if (!req.session.loggedIn)
        return res.send(
            `<form method='POST' action='/login'><input type='password' name='password' placeholder='Enter Password'><button type='submit'>Login</button></form>`
        );
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

async function deleteAllMessages(channel) {
    try {
        let messages;
        do {
            messages = await channel.messages.fetch({ limit: 100 });
            if (messages.size > 0) {
                await channel.bulkDelete(messages);
            }
        } while (messages.size > 0);
    } catch (err) {
        console.error("Error deleting messages:", err);
    }
}

app.post("/api/start-update", async (req, res) => {
    try {
        const { minutes } = req.body;
        const channel = await client.channels.fetch(CHANNEL_ID);

        // Channel Lock + Delete Messages
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
        await deleteAllMessages(channel);

        // Premium Embed
        const embed = new EmbedBuilder()
            .setColor("#ff9800")
            .setTitle("🚀 Cyberland Bot Updating...")
            .setDescription(`**Bot is currently updating for ${minutes} minutes!**\nPlease wait patiently.`)
            .setImage("https://i.imgur.com/zAeQvOj.gif")
            .setFooter({ text: "Cyberland Premium Bot", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();
        await channel.send({ content: "@everyone", embeds: [embed] });

        if (manualUpdateTimeout) clearTimeout(manualUpdateTimeout);
        manualUpdateTimeout = setTimeout(async () => {
            await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
            await deleteAllMessages(channel);
            const finishEmbed = new EmbedBuilder()
                .setColor("#4caf50")
                .setTitle("✅ Cyberland Bot Updated")
                .setDescription("The bot update has completed successfully!")
                .setImage("https://i.imgur.com/Ws5lTQ1.gif")
                .setFooter({ text: "Cyberland Premium Bot", iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            await channel.send({ content: "@everyone", embeds: [finishEmbed] });
        }, minutes * 60000);

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
        await deleteAllMessages(channel);
        const embed = new EmbedBuilder()
            .setColor("#4caf50")
            .setTitle("✅ Cyberland Bot Updated")
            .setDescription("The bot update has completed successfully!")
            .setImage("https://i.imgur.com/Ws5lTQ1.gif")
            .setFooter({ text: "Cyberland Premium Bot", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();
        await channel.send({ content: "@everyone", embeds: [embed] });
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

app.get("/api/server-status", async (req, res) => {
    try {
        const status = await util.status(MINECRAFT_IP, MINECRAFT_PORT);
        res.json({ online: true, players: status.players.online, ping: status.roundTripLatency });
    } catch {
        res.json({ online: false });
    }
});

// ====== Auto Update ======
cron.schedule("0 15 * * *", async () => {
    if (!autoUpdate) return;
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    await deleteAllMessages(channel);
    const embed = new EmbedBuilder()
        .setColor("#ff5722")
        .setTitle("⚡ Auto Update Started")
        .setDescription("Bot is automatically updating...")
        .setImage("https://i.imgur.com/zAeQvOj.gif")
        .setFooter({ text: "Cyberland Premium Bot", iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
    await channel.send({ content: "@everyone", embeds: [embed] });
}, { timezone: "Asia/Dhaka" });

cron.schedule("5 15 * * *", async () => {
    if (!autoUpdate) return;
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    await deleteAllMessages(channel);
    const embed = new EmbedBuilder()
        .setColor("#4caf50")
        .setTitle("✅ Auto Update Finished")
        .setDescription("Bot is back online and fully updated!")
        .setImage("https://i.imgur.com/Ws5lTQ1.gif")
        .setFooter({ text: "Cyberland Premium Bot", iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
    await channel.send({ content: "@everyone", embeds: [embed] });
}, { timezone: "Asia/Dhaka" });

// ====== AI Chat Handler ======
client.on("messageCreate", async (message) => {
    if (message.author.bot || message.channel.id !== CHANNEL_ID) return;
    await message.channel.sendTyping();
    const reply = await queryOpenAI(`${message.author.username}: ${message.content}`);
    message.reply(reply);
});

// ====== Bot Ready ======
client.on("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🌐 Dashboard running on PORT ${PORT}`));
