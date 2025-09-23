// Full fixed: Cyberland Ultra-Premium bot.js
// - Dashboard login (3 users: zihuu, shahin, mainuddin)
// - AI auto-reply (no prefix) with robust OpenAI handling + fallback
// - Channel lock/unlock, clear messages, announcement embed
// - Railway-ready (uses process.env variables)
// - Safe allowedMentions (no @everyone pings)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes
} = require('discord.js');

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const ADMIN_USERS = ['zihuu', 'shahin', 'mainuddin'];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cyberlandai90x90x90';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cyberland_secret_change_me';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'; // or gpt-4o-mini if available

if (!DISCORD_TOKEN) console.error('ERROR: DISCORD_TOKEN not set in env. Bot will not login.');

// ---------------- SETTINGS ----------------
let settings = {
  channelId: process.env.CHANNEL_ID || null,
  aiEnabled: true,
  updateRunning: false,
  updateGif: process.env.UPDATE_GIF_URL || '',
  finishGif: process.env.FINISH_GIF_URL || ''
};
function loadSettings(){
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}';
      const parsed = JSON.parse(raw);
      settings = { ...settings, ...parsed };
    } else {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
  } catch (e) {
    console.error('loadSettings error', e);
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('saveSettings error', e);
  }
}
loadSettings();

// ---------------- DISCORD CLIENT ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [ Partials.Channel, Partials.Message, Partials.GuildMember ]
});

// Simple queue to avoid concurrent OpenAI calls per channel
const aiChannelLocks = new Map(); // channelId -> boolean

// Robust OpenAI helper with retries + timeouts
async function callOpenAI(userContent, attempt = 1) {
  if (!OPENAI_KEY) throw new Error('OPENAI_KEY_MISSING');
  try {
    const payload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are Cyberland assistant — helpful, concise, and friendly.' },
        { role: 'user', content: userContent }
      ],
      temperature: 0.7,
      max_tokens: 600
    };
    const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 60000,
      validateStatus: () => true
    });
    if (res.status >= 200 && res.status < 300) {
      const first = res.data?.choices?.[0];
      const text = first?.message?.content ?? first?.text ?? null;
      if (!text) throw new Error('no_reply_from_openai');
      return text.trim();
    }
    // handle 401 quickly
    if (res.status === 401) throw new Error('OPENAI_KEY_INVALID');
    // retry on 429/5xx up to 3 attempts
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return callOpenAI(userContent, attempt + 1);
    }
    throw new Error(`openai_error_status_${res.status}`);
  } catch (e) {
    // network/timeouts -> retry up to 3
    if (['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return callOpenAI(userContent, attempt + 1);
    }
    // rethrow with informative message
    throw e;
  }
}

// Utility: purge channel messages safely (bulkDelete + fallback)
async function purgeChannel(channel, limit = 100) {
  try {
    if (!channel || typeof channel.messages?.fetch !== 'function') return 0;
    let totalDeleted = 0;
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: Math.min(100, limit) });
      if (!fetched || fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
        totalDeleted += fetched.size;
      } catch (e) {
        // fallback single deletes
        for (const m of fetched.values()) {
          try { await m.delete(); totalDeleted++; } catch (_) {}
        }
      }
      limit -= fetched.size;
    } while (fetched.size > 0 && limit > 0);
    return totalDeleted;
  } catch (e) {
    console.error('purgeChannel error', e);
    return 0;
  }
}

// Lock / unlock channel (everyone role)
async function setChannelLocked(channel, locked) {
  try {
    if (!channel || !channel.guild) return false;
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: !locked ? true : false });
    return true;
  } catch (e) {
    console.error('setChannelLocked error', e);
    return false;
  }
}

// ---------------- EXPRESS + DASHBOARD ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 24*60*60*1000 }}));

// write basic HTML files (login + dashboard) if not present (safe for Railway)
const LOGIN_HTML = path.join(__dirname, 'login.html');
const DASH_HTML = path.join(__dirname, 'dashboard.html');
if (!fs.existsSync(LOGIN_HTML)) {
  fs.writeFileSync(LOGIN_HTML, `<!doctype html><html><head><meta charset="utf-8"><title>Login</title><style>body{background:#0f172a;color:white;font-family:Inter,Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}#c{background:#071428;padding:28px;border-radius:12px}input{display:block;margin:8px 0;padding:10px;border-radius:8px;border:1px solid #1e293b;background:#071021;color:white;width:240px}button{padding:10px;border-radius:8px;border:none;background:#6366f1;color:white;cursor:pointer}</style></head><body><div id="c"><h2>Cyberland Dashboard</h2><form method="POST" action="/login"><input name="username" placeholder="username" required /><input name="password" placeholder="password" type="password" required /><button type="submit">Login</button></form></div></body></html>`);
}
if (!fs.existsSync(DASH_HTML)) {
  fs.writeFileSync(DASH_HTML, `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title><script src="/socket.io/socket.io.js"></script><style>body{background:#071021;color:white;font-family:Inter,Arial;padding:16px}button{margin:6px;padding:10px;border-radius:8px;border:none;background:#7c3aed;color:white;cursor:pointer}#log{margin-top:12px;background:#07182a;padding:10px;border-radius:8px;height:260px;overflow:auto}</style></head><body><h1>Cyberland Dashboard</h1><a href="/logout">Logout</a><div style="margin-top:12px"><button onclick="promptChannel()">Set Channel</button><button onclick="toggleAI()">Toggle AI</button><button onclick="startUpdate()">Start Update</button><button onclick="finishUpdate()">Finish Update</button><button onclick="sendAnn()">Send Announcement</button></div><div id="log"></div><script>const s=io();s.on('msg',m=>{const l=document.getElementById('log');l.innerHTML+='<div>'+m+'</div>';l.scrollTop=l.scrollHeight});function promptChannel(){const id=prompt('Channel ID:');if(id) s.emit('setChannel',id)}function toggleAI(){s.emit('toggleAI')}function startUpdate(){s.emit('startUpdate')}function finishUpdate(){s.emit('finishUpdate')}function sendAnn(){const t=prompt('Title:');const c=prompt('Content:');s.emit('sendAnn',{title:t,content:c})}</script></body></html>`);
}

// Simple auth middleware
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(LOGIN_HTML));
app.post('/login', (req, res) => {
  try {
    const u = (req.body.username || '').toString().trim().toLowerCase();
    const p = (req.body.password || '').toString();
    if (!u || !p) return res.send('Invalid login. <a href="/login">Try again</a>');
    if (ADMIN_USERS.includes(u) && p === ADMIN_PASSWORD) {
      req.session.user = u;
      return res.redirect('/');
    }
    return res.send('Invalid login. <a href="/login">Try again</a>');
  } catch (e) {
    console.error('login err', e);
    return res.send('Error during login. <a href="/login">Back</a>');
  }
});
app.get('/logout', (req, res) => { req.session.destroy(()=>res.redirect('/login')); });
app.get('/', requireAuth, (req, res) => res.sendFile(DASH_HTML));

// Small API for dashboard to fetch state
app.get('/api/state', requireAuth, (req, res) => {
  res.json({ settings, bot: client.user ? client.user.tag : null, wsPing: client.ws?.ping || null });
});

// Socket.io events (dashboard)
io.on('connection', socket => {
  socket.emit('msg', `Connected. Bot status: ${client.user ? client.user.tag : 'disconnected'}`);
  socket.on('setChannel', async (channelId) => {
    settings.channelId = channelId;
    saveSettings();
    socket.emit('msg', `Default channel set to ${channelId}`);
  });
  socket.on('toggleAI', () => {
    settings.aiEnabled = !settings.aiEnabled;
    saveSettings();
    socket.emit('msg', `AI is now ${settings.aiEnabled ? 'ENABLED' : 'DISABLED'}`);
  });

  socket.on('startUpdate', async () => {
    if (!settings.channelId) return socket.emit('msg', 'No channel configured');
    try {
      settings.updateRunning = true; saveSettings();
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg','Channel not found or bot has no access');
      await setChannelLocked(ch, true);
      await purgeChannel(ch, 100);
      const emb = new EmbedBuilder().setTitle('🚧 Update in progress').setDescription('Maintenance running').addFields({name:'Status',value:'Updating',inline:true}).setTimestamp();
      await ch.send({ embeds: [emb], allowedMentions: { parse: [] } });
      socket.emit('msg', 'Update started (locked & cleared)');
    } catch (e) {
      console.error('startUpdate error', e);
      socket.emit('msg', 'Error starting update: ' + e.message);
    }
  });

  socket.on('finishUpdate', async () => {
    if (!settings.channelId) return socket.emit('msg', 'No channel configured');
    try {
      settings.updateRunning = false; saveSettings();
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg','Channel not found or bot has no access');
      await setChannelLocked(ch, false);
      const emb = new EmbedBuilder().setTitle('✅ Update finished').setDescription('Channel unlocked').setTimestamp();
      await ch.send({ embeds: [emb], allowedMentions: { parse: [] } });
      socket.emit('msg', 'Update finished (unlocked)');
    } catch (e) {
      console.error('finishUpdate error', e);
      socket.emit('msg', 'Error finishing update: ' + e.message);
    }
  });

  socket.on('sendAnn', async (payload) => {
    if (!settings.channelId) return socket.emit('msg','No channel configured');
    try {
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg','Channel not found');
      const e = new EmbedBuilder().setTitle(payload.title || 'Announcement').setDescription(payload.content || '').setTimestamp();
      await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
      socket.emit('msg','Announcement sent');
    } catch (err) {
      console.error('sendAnn err', err);
      socket.emit('msg', 'Error sending announcement: ' + err.message);
    }
  });
});

// ---------------- DISCORD: ready & commands ----------------
client.on('ready', async () => {
  console.log(`Discord ready: ${client.user.tag}`);
  // optionally register a simple slash command 'status' for convenience
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const appId = client.application?.id || (await client.application.fetch()).id;
    if (appId) {
      await rest.put(Routes.applicationCommands(appId), { body: [
        { name: 'status', description: 'Show bot status' }
      ]});
      console.log('Slash commands deployed');
    }
  } catch (e) {
    console.error('slash deploy error', e?.message || e);
  }
});

// slash handling
client.on('interactionCreate', async (it) => {
  try {
    if (!it.isCommand()) return;
    if (it.commandName === 'status') {
      const embed = new EmbedBuilder()
        .setTitle('Cyberland Status')
        .addFields(
          { name: 'Bot', value: client.user ? client.user.tag : 'disconnected', inline: true },
          { name: 'AI', value: settings.aiEnabled ? 'enabled' : 'disabled', inline: true },
          { name: 'Channel', value: settings.channelId || 'not set', inline: true }
        )
        .setTimestamp();
      await it.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    }
  } catch (e) {
    console.error('interaction err', e);
  }
});

// ---------------- DISCORD: AI auto-reply (no prefix) ----------------
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!settings.aiEnabled) return;
    if (!settings.channelId) return;
    if (msg.channel?.id !== settings.channelId) return;

    // ensure single processing per channel
    if (aiChannelLocks.get(msg.channel.id)) return;
    aiChannelLocks.set(msg.channel.id, true);

    // build reply
    let replyText = null;
    try {
      if (OPENAI_KEY) {
        replyText = await callOpenAI(msg.content);
      } else {
        // fallback: simple helpful reply (not echoing too verbatim)
        replyText = `I got your message: "${msg.content}". (AI not configured)`;
      }
    } catch (openErr) {
      console.error('OpenAI call failed:', openErr?.message || openErr);
      // friendly fallback
      if (openErr?.message === 'OPENAI_KEY_MISSING') {
        replyText = `AI is not configured on this bot. Set OPENAI_API_KEY to enable smarter replies.`;
      } else if (openErr?.message === 'OPENAI_KEY_INVALID') {
        replyText = `OpenAI API key invalid. Check configuration.`;
      } else {
        replyText = `Sorry, AI is temporarily unavailable. (${openErr?.message || 'error'})`;
      }
    }

    if (replyText) {
      await msg.reply({ content: replyText, allowedMentions: { parse: [] } });
    }
    aiChannelLocks.set(msg.channel.id, false);
  } catch (e) {
    console.error('messageCreate handler error', e);
    // ensure lock released
    try { aiChannelLocks.set(msg.channel.id, false); } catch (_) {}
  }
});

// ---------------- START HTTP SERVER & DISCORD LOGIN ----------------
server.listen(PORT, () => console.log(`Dashboard listening on port ${PORT}`));

client.login(DISCORD_TOKEN)
  .then(() => console.log('Discord login successful'))
  .catch(err => console.error('Discord login failed:', err));

// catch unhandled rejections to avoid silent crashes
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
