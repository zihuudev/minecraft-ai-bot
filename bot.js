// Cyberland Ultra-Premium All-in-One bot.js
// ===================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const session = require("express-session");
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");
const OpenAI = require("openai");

// ========= ENV VARIABLES =========
const TOKEN = process.env.TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS || "cyberlandai90x90x90";
const ADMINS = ["zihuu", "shahin", "mainuddin"];
const FIXED_CHANNEL_ID = "1419702204171813015";

// ========= DISCORD CLIENT =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const openai = new OpenAI({ apiKey: OPENAI_KEY });
let aiEnabled = true;
let updateInProgress = false;

// ========= EXPRESS DASHBOARD =========
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: "cyberland_secret", resave: false, saveUninitialized: true }));

// ---------------- LOGIN PAGE ----------------
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.send(`
  <html>
  <head>
    <title>Cyberland Login</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
      body{margin:0;font-family:'Roboto',sans-serif;background:linear-gradient(135deg,#8e2de2,#4a00e0);display:flex;align-items:center;justify-content:center;height:100vh;color:#fff;}
      .login-box{background:rgba(0,0,0,0.6);padding:40px;border-radius:15px;box-shadow:0 0 20px rgba(0,0,0,0.5);animation:fadeIn 1s;}
      input{width:100%;padding:12px;margin:10px 0;border:none;border-radius:10px;}
      button{width:100%;padding:12px;background:linear-gradient(to right,#ff416c,#ff4b2b);border:none;color:#fff;font-weight:bold;border-radius:10px;cursor:pointer;transition:0.3s;}
      button:hover{opacity:0.8;}
      h1{margin-bottom:20px;text-shadow: 2px 2px 10px #000;text-align:center;}
      @keyframes fadeIn{0%{opacity:0}100%{opacity:1}}
    </style>
  </head>
  <body>
    <div class="login-box">
      <h1>🔐 Cyberland Login</h1>
      <form method="POST" action="/login">
        <input name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button>Login</button>
      </form>
    </div>
  </body>
  </html>
  `);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (ADMINS.includes(username) && password === ADMIN_PASS) {
    req.session.user = username;
    res.redirect("/dashboard");
  } else {
    res.send("<h2 style='color:red;text-align:center'>Invalid login!</h2><a href='/'>Back</a>");
  }
});

// ---------------- DASHBOARD ----------------
app.get("/dashboard", (req,res)=>{
  if(!req.session.user) return res.redirect("/");
  res.send(`
  <html>
  <head>
    <title>Cyberland Dashboard</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
      body{margin:0;font-family:'Roboto',sans-serif;background:linear-gradient(135deg,#00c6ff,#0072ff);color:#fff;padding:20px;}
      h1{text-align:center;text-shadow:2px 2px 10px #000;margin-bottom:40px;}
      button{margin:10px;padding:15px 25px;border:none;border-radius:12px;background:linear-gradient(45deg,#ff416c,#ff4b2b);color:#fff;font-weight:bold;cursor:pointer;transition:0.3s;font-size:16px;box-shadow:0 5px 15px rgba(0,0,0,0.3);}
      button:hover{opacity:0.9;transform:translateY(-2px);}
      #log{margin-top:20px;background:rgba(0,0,0,0.6);padding:15px;height:300px;overflow:auto;border-radius:15px;box-shadow:0 5px 15px rgba(0,0,0,0.3);}
    </style>
  </head>
  <body>
    <h1>⚡ Cyberland Dashboard ⚡</h1>
    <div style="text-align:center;">
      <button onclick="toggleAI()">🤖 Toggle AI</button>
      <button onclick="announce()">📢 Announcement</button>
      <button onclick="clearChannel()">🧹 Clear Channel</button>
      <button onclick="startUpdate()">🔄 Start Update</button>
      <button onclick="finishUpdate()">✅ Finish Update</button>
      <button onclick="botInfo()">📊 Bot Info</button>
    </div>
    <div id="log"></div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      const s=io();
      s.on('msg',m=>{const l=document.getElementById('log');l.innerHTML+=\`<div>\${new Date().toLocaleTimeString()} - \${m}</div>\`;l.scrollTop=l.scrollHeight;});
      function toggleAI(){s.emit('toggleAI');}
      function announce(){const t=prompt("Title?");const c=prompt("Content?");const r=prompt("Reason?");s.emit("announce",{title:t,content:c,reason:r});}
      function clearChannel(){s.emit("clearChannel");}
      function startUpdate(){const r=prompt("Reason?"); const m=prompt("Minutes?","5"); s.emit("startUpdate",{reason:r,minutes:Number(m)});}
      function finishUpdate(){s.emit("finishUpdate");}
      function botInfo(){s.emit("botInfo");}
    </script>
  </body>
  </html>
  `);
});

// ========= SOCKET.IO =========
io.on("connection",(socket)=>{
  socket.on("toggleAI", ()=>{
    aiEnabled = !aiEnabled;
    socket.emit("msg",`AI is now ${aiEnabled?"enabled ✅":"disabled ❌"}`);
  });

  socket.on("announce", async (data)=>{
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if(!channel) return;
    const embed = new EmbedBuilder()
      .setTitle(`📢 ${data.title}`)
      .setDescription(data.content)
      .addFields(
        {name:"Reason", value:data.reason||"No reason", inline:true},
        {name:"Developed By", value:"🔥 **ZIHUU** 🔥", inline:true}
      ).setColor("Purple").setTimestamp();
    channel.send({embeds:[embed]});
    socket.emit("msg","✅ Announcement sent!");
  });

  socket.on("clearChannel", async ()=>{
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if(!channel) return;
    const msgs = await channel.messages.fetch({limit:100});
    await channel.bulkDelete(msgs);
    const embed = new EmbedBuilder()
      .setTitle("⚡ Channel Cleared ⚡")
      .setDescription("All messages have been removed.")
      .addFields(
        {name:"Ping", value:client.ws.ping+"ms", inline:true},
        {name:"Server", value:channel.guild.name, inline:true},
        {name:"Developed By", value:"✨ **ZIHUU** ✨", inline:true}
      ).setColor("Gold").setTimestamp();
    channel.send({embeds:[embed]});
    socket.emit("msg","🧹 Channel cleared & embed sent!");
  });

  // ========= START UPDATE =========
  socket.on("startUpdate", async (data)=>{
    if(updateInProgress) return socket.emit("msg","⚠️ Update already in progress!");
    updateInProgress = true;
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if(!channel) return;
    try{
      // Lock channel
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {SendMessages:false});
      // Delete old messages
      const msgs = await channel.messages.fetch({limit:100});
      await channel.bulkDelete(msgs);
      // Send update embed
      const embed = new EmbedBuilder()
        .setTitle(`🔄 Update Started 🔄`)
        .setDescription(`The bot is updating for **${data.minutes} minute(s)**.`)
        .addFields(
          {name:"Reason", value:data.reason || "No reason", inline:true},
          {name:"Ping", value:client.ws.ping+"ms", inline:true},
          {name:"Developed By", value:"🔥 **ZIHUU** 🔥", inline:true}
        ).setColor("Orange").setTimestamp();
      channel.send({embeds:[embed]});
      socket.emit("msg",`⏳ Update started for ${data.minutes} minute(s)!`);
      // Auto finish after given minutes
      setTimeout(async ()=>{
        const finishEmbed = new EmbedBuilder()
          .setTitle("✅ Update Finished ✅")
          .setDescription(`The bot has finished updating.`)
          .addFields(
            {name:"Ping", value:client.ws.ping+"ms", inline:true},
            {name:"Reason", value:data.reason || "No reason", inline:true},
            {name:"Developed By", value:"✨ **ZIHUU** ✨", inline:true}
          ).setColor("Green").setTimestamp();
        channel.send({embeds:[finishEmbed]});
        // Unlock channel
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {SendMessages:true});
        updateInProgress = false;
        socket.emit("msg","✅ Update finished and channel unlocked!");
      }, data.minutes*60*1000);
    }catch(err){
      console.error(err);
      socket.emit("msg","❌ Update failed: "+err.message);
      updateInProgress=false;
    }
  });

  socket.on("finishUpdate", async ()=>{
    const channel = await client.channels.fetch(FIXED_CHANNEL_ID);
    if(!channel) return;
    const finishEmbed = new EmbedBuilder()
      .setTitle("✅ Update Finished ✅")
      .setDescription(`The bot update has been manually finished.`)
      .addFields(
        {name:"Ping", value:client.ws.ping+"ms", inline:true},
        {name:"Developed By", value:"✨ **ZIHUU** ✨", inline:true}
      ).setColor("Green").setTimestamp();
    channel.send({embeds:[finishEmbed]});
    // Unlock channel
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {SendMessages:true});
    updateInProgress=false;
    socket.emit("msg","✅ Update manually finished and channel unlocked!");
  });

  socket.on("botInfo", ()=>{
    socket.emit("msg",`Bot Ping: ${client.ws.ping}ms`);
  });
});

// ========= DISCORD EVENTS =========
client.on("ready", ()=>{
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (msg)=>{
  if(msg.author.bot) return;
  if(msg.channel.id !== FIXED_CHANNEL_ID) return;
  if(aiEnabled){
    try{
      const res = await openai.chat.completions.create({
        model:"gpt-4o-mini",
        messages:[{role:"user",content:msg.content}],
        max_tokens:150
      });
      if(res.choices[0]?.message?.content) msg.reply(res.choices[0].message.content);
      else msg.reply("⚠️ AI could not generate a response.");
    }catch(err){
      console.error("AI Error:",err.message);
      msg.reply("⚠️ AI is temporarily unavailable.");
    }
  }
});

// ========= START =========
client.login(TOKEN);
server.listen(3000,()=>console.log("🌐 Dashboard running on port 3000"));
