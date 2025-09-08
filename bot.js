// ─────────────────────────────
// Premium Cyberland AI Bot
// Secure + Render Ready Version
// ─────────────────────────────

// Load environment variables
require("dotenv").config();

// Import modules
const express = require("express");
const session = require("express-session");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const Discord = require("discord.js");
const cron = require("node-cron");
const moment = require("moment-timezone");
const multer = require("multer");
const fs = require("fs");

// Environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cyberland_dashboard_pass";
const PORT = process.env.PORT || 3000;
const BOT_PREFIX = process.env.BOT_PREFIX || "!";
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || "play.cyberland.pro";
const MINECRAFT_PORT = process.env.MINECRAFT_PORT || "19132";

// ─────────────────────────────
// Discord Client Setup
// ─────────────────────────────
const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent
    ]
});

// Function to send premium embeds
async function sendPremiumEmbed(channel, title, description, color = "#00FFAA") {
    const embed = new Discord.EmbedBuilder()
        .setColor(color)
        .setTitle(`🌌 ${title}`)
        .setDescription(description)
        .setTimestamp()
        .setFooter({ text: "⚡ Cyberland AI Bot", iconURL: client.user?.displayAvatarURL() });

    await channel.send({ embeds: [embed] });
}

// ─────────────────────────────
// Token Validation Before Login
// ─────────────────────────────
if (!DISCORD_TOKEN || !DISCORD_TOKEN.startsWith("M")) {
    console.error("\n❌ Invalid or missing Discord token!\n");
    console.error("🔹 Fix: Set DISCORD_TOKEN properly in Render Environment Variables.");
    process.exit(1);
}

// ─────────────────────────────
// Express Server + Dashboard
// ─────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: "cyberland_secret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Login middleware
function requireLogin(req, res, next) {
    if (req.session.loggedIn) return next();
    res.redirect("/login");
}

// Login route
app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public/login.html"));
});

app.post("/login", (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        return res.redirect("/");
    }
    res.send("<h1>❌ Wrong Password!</h1>");
});

// Dashboard home
app.get("/", requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, "public/dashboard.html"));
});

// ─────────────────────────────
// Auto Update System
// ─────────────────────────────
let isUpdating = false;

io.on("connection", (socket) => {
    socket.on("startUpdate", async () => {
        if (isUpdating) return;
        isUpdating = true;

        const channel = client.channels.cache.get(CHANNEL_ID);
        if (channel) {
            await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
            await channel.bulkDelete(100).catch(() => {});

            await sendPremiumEmbed(
                channel,
                "🚀 Bot Updating...",
                `⚡ **Cyberland AI Bot** is updating...\n\n🔒 **Channel Locked** 🔒\n\nPlease wait a moment.`
            );
        }
    });

    socket.on("finishUpdate", async () => {
        if (!isUpdating) return;
        isUpdating = false;

        const channel = client.channels.cache.get(CHANNEL_ID);
        if (channel) {
            await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

            await sendPremiumEmbed(
                channel,
                "✅ Update Complete!",
                `🌟 **Cyberland AI Bot** update finished successfully!\n\n🔓 **Channel Unlocked** 🔓`
            );
        }
    });
});

// ─────────────────────────────
// Auto Update Schedule (BD Time)
// ─────────────────────────────
cron.schedule("0 15 * * *", async () => {
    const channel = client.channels.cache.get(CHANNEL_ID);
    if (channel) {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
        await channel.bulkDelete(100).catch(() => {});

        await sendPremiumEmbed(
            channel,
            "🔄 Scheduled Update Started",
            `🕒 **Daily Update** has started automatically.\n\n🔒 **Channel Locked** until update completes.`,
            "#FFA500"
        );
    }
}, { timezone: "Asia/Dhaka" });

cron.schedule("5 15 * * *", async () => {
    const channel = client.channels.cache.get(CHANNEL_ID);
    if (channel) {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

        await sendPremiumEmbed(
            channel,
            "✅ Scheduled Update Complete",
            `🌟 Daily update completed automatically.\n\n🔓 **Channel Unlocked**.`,
            "#00FF7F"
        );
    }
}, { timezone: "Asia/Dhaka" });

// ─────────────────────────────
// Start Express + Discord Bot
// ─────────────────────────────
server.listen(PORT, () => {
    console.log(`🌐 Dashboard running: http://localhost:${PORT}`);
});

client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    client.user.setActivity("🌐 Cyberland AI | Premium Mode", { type: Discord.ActivityType.Playing });
});

client.login(DISCORD_TOKEN).catch(async () => {
    console.error("❌ Invalid Discord token detected!");
    const channel = client.channels.cache.get(CHANNEL_ID);
    if (channel) {
        await sendPremiumEmbed(
            channel,
            "⚠️ Bot Offline",
            "❌ The bot could not log in due to an **invalid Discord token**.\n\nPlease fix it in Render environment variables."
        );
    }
    process.exit(1);
});
