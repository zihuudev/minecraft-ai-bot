require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");

// Discord Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
    session({
        secret: "cyberland-secret",
        resave: false,
        saveUninitialized: true,
    })
);

// Embed HTML for Login Page
const loginPage = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyberland Bot - Login</title>
<style>
    body { margin: 0; font-family: Arial; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; }
    .box { background: rgba(255,255,255,0.05); padding: 30px; border-radius: 15px; box-shadow: 0 0 20px rgba(0,255,255,0.2); backdrop-filter: blur(10px); }
    input { padding: 12px; width: 100%; border: none; border-radius: 10px; margin-top: 10px; background: rgba(255,255,255,0.1); color: white; }
    button { margin-top: 15px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #06b6d4; color: white; font-weight: bold; cursor: pointer; transition: 0.3s; }
    button:hover { background: #0891b2; }
    .error { color: red; margin-top: 10px; }
</style>
</head>
<body>
<div class="box">
    <h2>🔐 Cyberland Bot Dashboard</h2>
    <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Enter Admin Password" required>
        <button type="submit">Login</button>
    </form>
    <p class="error"></p>
</div>
</body>
</html>
`;

// Embed HTML for Dashboard Page
const dashboardPage = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyberland Bot Dashboard</title>
<style>
    body { margin: 0; font-family: Arial; background: #0f172a; color: white; text-align: center; }
    .container { margin-top: 50px; }
    button { margin: 15px; padding: 15px; width: 250px; font-size: 16px; border: none; border-radius: 12px; cursor: pointer; transition: 0.3s; }
    #startUpdate { background-color: #22c55e; color: white; }
    #finishUpdate { background-color: #06b6d4; color: white; }
    #toggleAuto { background-color: #facc15; color: black; }
    button:hover { transform: scale(1.05); }
</style>
</head>
<body>
<div class="container">
    <h1>⚡ Cyberland Bot Dashboard</h1>
    <button id="startUpdate" onclick="fetch('/api/start-update', {method: 'POST'}).then(()=>alert('Update Started!'))">🚀 Start Update</button>
    <button id="finishUpdate" onclick="fetch('/api/finish-update', {method: 'POST'}).then(()=>alert('Update Finished!'))">✅ Finish Update</button>
    <button id="toggleAuto" onclick="fetch('/api/toggle-auto', {method: 'POST'}).then(()=>alert('Toggled Auto Update!'))">🔄 Toggle Auto Update</button>
</div>
</body>
</html>
`;

// Routes
app.get("/", (req, res) => res.send(loginPage));

app.post("/login", (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.send(dashboardPage);
    } else {
        res.send("<h1 style='color:red; text-align:center;'>Invalid Password</h1>");
    }
});

// Example API Routes
app.post("/api/start-update", (req, res) => {
    console.log("Update started...");
    res.json({ status: "Update started" });
});

app.post("/api/finish-update", (req, res) => {
    console.log("Update finished...");
    res.json({ status: "Update finished" });
});

app.post("/api/toggle-auto", (req, res) => {
    console.log("Auto update toggled");
    res.json({ status: "Auto update toggled" });
});

// Discord Bot Login
client.on("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// Start Express Server
app.listen(PORT, () => console.log(`🌐 Dashboard running: http://localhost:${PORT}`));
