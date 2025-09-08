/*
 * Cyberland Premium Discord Bot
 * AI + Minecraft + Auto Update + Premium Dashboard
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');
const multer = require('multer');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');
const { statusBedrock } = require('minecraft-server-util');

// ------------ ENV CONFIG ------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;
const BOT_PREFIX = process.env.BOT_PREFIX || '!';
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || 'play.cyberland.pro';
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT || '19132', 10);

// ------------ DISCORD CLIENT ------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

let updateState = {
  active: false,
  startMsgId: null,
  finishMsgId: null,
  autoUpdateEnabled: true,
};

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ------------ SUPER PREMIUM EMBED ------------
async function sendPremiumEmbed(channel, title, description, color = '#8b5cf6') {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: '⚡ Cyberland AI Bot',
      iconURL: client.user.displayAvatarURL(),
    })
    .setTitle(`✨ ${title}`)
    .setDescription(description)
    .setThumbnail('https://cdn.discordapp.com/icons/1404498262379200522/a_premium.gif')
    .setFooter({
      text: '🚀 Cyberland Bot | AI + Minecraft Integration',
      iconURL: client.user.displayAvatarURL(),
    })
    .setTimestamp();

  return channel.send({
    content: '@everyone',
    embeds: [embed],
    allowedMentions: { parse: ['everyone'] },
  });
}

// ------------ CHANNEL LOCK/UNLOCK ------------
async function lockChannel(channel) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: false,
  });
}
async function unlockChannel(channel) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: null,
  });
}

// ------------ DELETE MESSAGES EXCEPT EMBEDS ------------
async function deleteAllMessagesExceptEmbeds(channel, io) {
  io && io.emit('update-log', '🧹 Clearing old messages…');
  try {
    let lastId;
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const msgs = await channel.messages.fetch(options);
      if (!msgs || msgs.size === 0) break;

      const toDelete = msgs.filter(
        (m) => ![updateState.startMsgId, updateState.finishMsgId].includes(m.id)
      );

      if (toDelete.size > 0) await channel.bulkDelete(toDelete, true);
      if (msgs.size < 100) break;
      lastId = msgs.last().id;
    }
    io && io.emit('update-log', '✅ Messages cleared.');
  } catch (err) {
    io && io.emit('update-log', `❌ Error: ${err.message}`);
  }
}

// ------------ OPENAI AI CHAT ------------
async function sendToOpenAI(prompt) {
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a Minecraft AI assistant. Server: ${MINECRAFT_HOST}:${MINECRAFT_PORT}`,
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return res.data.choices[0].message.content || 'No response.';
  } catch {
    return '⚠️ Error contacting AI.';
  }
}

// ------------ UPDATE CONTROLS ------------
async function startUpdate(io) {
  if (updateState.active) return;
  const channel = await client.channels.fetch(CHANNEL_ID);
  updateState.active = true;

  await lockChannel(channel);
  const startMsg = await sendPremiumEmbed(
    channel,
    '🚀 Bot Update — Starting',
    '⚡ **Cyberland AI** is upgrading to the **latest premium version**.\n\n🔒 Channel locked.\n🕒 Please wait…'
  );
  updateState.startMsgId = startMsg.id;
  await deleteAllMessagesExceptEmbeds(channel, io);
}

async function finishUpdate(io) {
  if (!updateState.active) return;
  const channel = await client.channels.fetch(CHANNEL_ID);
  await unlockChannel(channel);

  const finishMsg = await sendPremiumEmbed(
    channel,
    '✅ Bot Update — Completed',
    '🎉 Update finished successfully!\n\n🔓 Channel unlocked.\n💎 Enjoy the **new premium features**!'
  );
  updateState.finishMsgId = finishMsg.id;
  updateState.active = false;
}

// ------------ AUTO UPDATE (3:00 → 3:05 PM BD) ------------
cron.schedule(
  '0 15 * * *',
  async () => {
    if (!updateState.autoUpdateEnabled) return;
    console.log('[AUTO] Starting daily update…');
    await startUpdate(io);
  },
  { scheduled: true, timezone: 'Asia/Dhaka' }
);

cron.schedule(
  '5 15 * * *',
  async () => {
    if (!updateState.autoUpdateEnabled) return;
    console.log('[AUTO] Finishing daily update…');
    await finishUpdate(io);
  },
  { scheduled: true, timezone: 'Asia/Dhaka' }
);

// ------------ MESSAGE HANDLER ------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // Delete messages if update active
  if (updateState.active && message.channelId === CHANNEL_ID) {
    await message.delete().catch(() => null);
    return;
  }

  // Commands
  if (message.content.startsWith(BOT_PREFIX)) {
    const args = message.content.slice(BOT_PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();

    if (cmd === 'status') {
      try {
        const mcStatus = await statusBedrock(MINECRAFT_HOST, MINECRAFT_PORT);
        const embed = new EmbedBuilder()
          .setColor('#06b6d4')
          .setTitle('🌍 Minecraft Server Status')
          .addFields(
            { name: 'Host', value: `${MINECRAFT_HOST}:${MINECRAFT_PORT}` },
            { name: 'Players', value: `${mcStatus.players.online}/${mcStatus.players.max}` },
            { name: 'Version', value: mcStatus.version.name }
          )
          .setTimestamp();
        await message.reply({ embeds: [embed] });
      } catch {
        await message.reply('⚠️ Server seems offline or unreachable.');
      }
      return;
    }

    if (cmd === 'ping') {
      const sent = await message.reply('🏓 Pinging…');
      sent.edit(`🏓 Pong! Latency: ${sent.createdTimestamp - message.createdTimestamp}ms`);
      return;
    }

    if (cmd === 'uptime') {
      const uptime = moment.duration(client.uptime).humanize();
      message.reply(`⏳ Uptime: **${uptime}**`);
      return;
    }
  }

  // AI Chat
  if (message.channelId === CHANNEL_ID) {
    await message.channel.sendTyping();
    const aiReply = await sendToOpenAI(message.content);
    await message.reply(aiReply);
  }
});

// ------------ EXPRESS DASHBOARD ------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(session({ secret: 'supersecret', resave: false, saveUninitialized: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth Middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.isAuthenticated) return next();
  return res.redirect('/login');
}

// Login Page
app.get('/login', (req, res) => {
  res.send(`
    <html><head><title>Login</title>
    <style>
    body {background:#0f172a;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;}
    .card {background:#1e293b;padding:20px;border-radius:12px;text-align:center;box-shadow:0 0 30px #8b5cf6;}
    input,button {width:100%;padding:10px;margin-top:10px;border:none;border-radius:6px;}
    button {background:linear-gradient(90deg,#8b5cf6,#06b6d4);color:#fff;font-weight:bold;cursor:pointer;}
    </style></head>
    <body>
      <div class="card">
        <h2>Cyberland Dashboard Login</h2>
        <form method="POST" action="/login">
          <input type="password" name="password" placeholder="Admin Password" required>
          <button type="submit">Login</button>
        </form>
      </div>
    </body></html>
  `);
});

// Login Auth
app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login');
});

// Dashboard Page
app.get('/', requireAuth, (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Cyberland Dashboard</title>
        <style>
          body {background:#0f172a;color:#fff;font-family:sans-serif;padding:20px;}
          .btn {padding:12px 20px;margin:5px;background:linear-gradient(90deg,#8b5cf6,#06b6d4);border:none;border-radius:8px;color:white;font-weight:bold;cursor:pointer;transition:transform 0.2s;}
          .btn:hover {transform:scale(1.05);}
          .logs {background:#1e293b;padding:15px;height:300px;overflow-y:auto;margin-top:10px;border-radius:8px;font-family:monospace;box-shadow:inset 0 0 10px #8b5cf6;}
        </style>
      </head>
      <body>
        <h1>Cyberland Premium Bot Dashboard</h1>
        <button class="btn" id="startUpdate">⚡ Start Update</button>
        <button class="btn" id="finishUpdate">✅ Finish Update</button>
        <button class="btn" id="toggleAuto">🔄 Toggle Auto Update</button>
        <div class="logs" id="logs"></div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const logs = document.getElementById('logs');
          function append(msg){
            const div=document.createElement('div');
            div.textContent='['+new Date().toLocaleTimeString()+'] '+msg;
            logs.prepend(div);
          }
          socket.on('update-log', append);
          document.getElementById('startUpdate').onclick=async()=>{
            const res=await fetch('/api/start-update',{method:'POST'});
            const data=await res.json();
            if(!data.ok)append('Error: '+data.error);
          };
          document.getElementById('finishUpdate').onclick=async()=>{
            const res=await fetch('/api/finish-update',{method:'POST'});
            const data=await res.json();
            if(!data.ok)append('Error: '+data.error);
          };
          document.getElementById('toggleAuto').onclick=async()=>{
            const res=await fetch('/api/toggle-auto',{method:'POST'});
            const data=await res.json();
            append(data.message);
          };
        </script>
      </body>
    </html>
  `);
});

// API Endpoints
app.post('/api/start-update', requireAuth, async (req, res) => {
  try { await startUpdate(io); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/finish-update', requireAuth, async (req, res) => {
  try { await finishUpdate(io); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/toggle-auto', requireAuth, (req, res) => {
  updateState.autoUpdateEnabled = !updateState.autoUpdateEnabled;
  res.json({ ok: true, message: `Auto Update ${updateState.autoUpdateEnabled ? 'Enabled ✅' : 'Disabled ❌'}` });
});

// Start server
server.listen(PORT, () => console.log(`🌐 Dashboard running: http://localhost:${PORT}`));

// Login Discord Bot
client.login(DISCORD_TOKEN);
