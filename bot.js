/**
 * Cyberland Ultra-Premium All-in-One bot.js
 * - Single file: bot + dashboard + scheduler + AI + premium embeds
 * - Minimal external deps: discord.js, express, socket.io, axios, node-cron, express-session, body-parser, moment-timezone
 *
 * Install:
 * npm install discord.js express socket.io axios node-cron express-session body-parser moment-timezone
 *
 * Run:
 * node bot.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');

const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes } = require('discord.js');

// ---------- CONFIG ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cyberlandai90x90x90';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cyberland_session_secret';
const ADMIN_USERS = ['zihuu','shahin','mainuddin']; // case-insensitive
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const TZ = 'Asia/Dhaka';

// ---------- SIMPLE LOGGER ----------
function logInfo(...a){ console.log(new Date().toISOString(),'[INFO]',...a); }
function logSuccess(...a){ console.log(new Date().toISOString(),'[OK]',...a); }
function logWarn(...a){ console.warn(new Date().toISOString(),'[WARN]',...a); }
function logError(...a){ console.error(new Date().toISOString(),'[ERR]',...a); }

// ---------- SETTINGS persistence ----------
let settings = {
  channelId: process.env.CHANNEL_ID || null,
  aiEnabled: true,
  autoUpdate: true
};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const raw = fs.readFileSync(SETTINGS_FILE,'utf8')||'{}';
    const parsed = JSON.parse(raw);
    settings = { ...settings, ...parsed };
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  }
} catch (e) {
  logError('Failed to load settings:', e.message || e);
}
function saveSettings(){
  try{ fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
  catch(e){ logError('saveSettings error', e.message || e); }
}

// ---------- DISCORD client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [ Partials.Message, Partials.Channel, Partials.GuildMember ]
});

// ---------- Safe OpenAI caller with retries ----------
async function callOpenAI(content, attempt = 1){
  if (!OPENAI_KEY) throw new Error('OPENAI_KEY_MISSING');
  try {
    const payload = {
      model: OPENAI_MODEL,
      messages: [{ role:'system', content:'You are Cyberland assistant — concise and helpful.' }, { role:'user', content }],
      temperature: 0.7,
      max_tokens: 700
    };
    const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 65000,
      validateStatus: () => true
    });
    if (res.status >= 200 && res.status < 300) {
      const txt = res.data?.choices?.[0]?.message?.content ?? res.data?.choices?.[0]?.text;
      if (!txt) throw new Error('NO_OPENAI_REPLY');
      return txt.trim();
    }
    // Handle transient / throttling
    if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < 3) {
      logWarn('OpenAI temporary error', res.status, 'retry', attempt);
      await new Promise(r=>setTimeout(r, 1000 * attempt));
      return callOpenAI(content, attempt + 1);
    }
    // Specific 401
    if (res.status === 401) throw new Error('OPENAI_KEY_INVALID');
    throw new Error('openai_error_status_' + res.status);
  } catch (e) {
    if (['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r=>setTimeout(r, 1000 * attempt));
      return callOpenAI(content, attempt + 1);
    }
    throw e;
  }
}

// ---------- embed maker (premium) ----------
function makePremiumEmbed({ title='Status', reason='Not specified', duration='N/A' } = {}){
  const guildName = client.guilds.cache.first()?.name || 'Unknown';
  const ping = client.ws?.ping ? `${client.ws.ping}ms` : 'N/A';
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x60A5FA) // soft blue
    .setDescription(`**${title}** — ${reason}`)
    .addFields(
      { name: '⏳ Update Duration', value: String(duration), inline:true },
      { name: '📡 Bot Ping', value: String(ping), inline:true },
      { name: '🌍 Server', value: guildName, inline:true },
      { name: '📝 Reason', value: reason || '—', inline:false },
      { name: '👨‍💻 Developed By', value: 'ZIHUU', inline:false },
    )
    .setTimestamp();
}

// ---------- EXPRESS + SOCKET.IO dashboard ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.urlencoded({ extended:true }));
app.use(bodyParser.json());
app.use(session({ secret: SESSION_SECRET, resave:false, saveUninitialized:true }));

// create minimal HTML if not exists
const HTML_LOGIN = path.join(__dirname,'login.html');
const HTML_DASH = path.join(__dirname,'dashboard.html');
if (!fs.existsSync(HTML_LOGIN)) {
  fs.writeFileSync(HTML_LOGIN, `<!doctype html><html><head><meta charset="utf-8"><title>Login</title>
  <style>body{background:#071426;color:#e6eef6;font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh}form{background:#071a2b;padding:24px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.6)}input{display:block;margin:8px 0;padding:8px;border-radius:6px;border:1px solid #123}</style>
  </head><body><form method="POST" action="/login"><h2 style="color:#60a5fa">Cyberland Dashboard</h2><input name="username" placeholder="username" required /><input type="password" name="password" placeholder="password" required /><button type="submit">Login</button></form></body></html>`);
}
if (!fs.existsSync(HTML_DASH)) {
  fs.writeFileSync(HTML_DASH, `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title><script src="/socket.io/socket.io.js"></script>
  <style>body{background:#071426;color:#e6eef6;font-family:Arial;padding:20px}button{margin:6px;padding:10px;border-radius:8px;border:none;background:linear-gradient(90deg,#7c3aed,#06b6d4);color:white;cursor:pointer}#log{background:#041827;padding:12px;border-radius:8px;height:320px;overflow:auto;margin-top:12px}</style>
  </head><body><h1>Cyberland Premium Dashboard</h1><a href="/logout" style="color:#fb7185">Logout</a><div style="margin-top:12px">
  <button onclick="setChannel()">Set Channel</button>
  <button onclick="toggleAI()">Toggle AI</button>
  <button onclick="startUpdate()">Start Update</button>
  <button onclick="finishUpdate()">Finish Update</button>
  <button onclick="announce()">Announce</button>
  <button onclick="botInfo()">Bot Info</button>
  </div><div id="log"></div><script>const s=io();s.on('msg',m=>{const l=document.getElementById('log');l.innerHTML+=`<div>${new Date().toLocaleTimeString()} - ${m}</div>`;l.scrollTop=l.scrollHeight});function setChannel(){const id=prompt('Channel ID'); if(id) s.emit('setChannel',id);}function toggleAI(){s.emit('toggleAI');}function startUpdate(){const r=prompt('Reason?'); const m=prompt('Minutes?','5'); s.emit('startUpdate',{reason:r,minutes:Number(m)});}function finishUpdate(){s.emit('finishUpdate');}function announce(){const t=prompt('Title');const c=prompt('Content'); const r=prompt('Reason'); s.emit('announce',{title:t,content:c,reason:r});}function botInfo(){s.emit('botInfo');}</script></body></html>`);
}

// routes
app.get('/login', (req,res) => res.sendFile(HTML_LOGIN));
app.post('/login', (req,res) => {
  try {
    const u = (req.body.username||'').toString().trim().toLowerCase();
    const p = (req.body.password||'').toString();
    if (!u || !p) return res.send('Invalid login. <a href="/login">Back</a>');
    if (ADMIN_USERS.includes(u) && p === ADMIN_PASSWORD) {
      req.session.user = u;
      logSuccess('Dashboard login by', u);
      return res.redirect('/');
    } else {
      logWarn('Failed login attempt', u);
      return res.send('Invalid credentials. <a href="/login">Back</a>');
    }
  } catch (e) {
    logError('login error', e);
    return res.send('Error. <a href="/login">Back</a>');
  }
});
app.get('/logout', (req,res) => { req.session.destroy(()=>res.redirect('/login')); });
app.get('/', (req,res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.sendFile(HTML_DASH);
});

// small api
app.get('/api/state', (req,res) => {
  if (!req.session?.user) return res.status(403).json({error:'unauthorized'});
  res.json({ settings, bot: client.user ? client.user.tag : null, ping: client.ws?.ping || null });
});

// ---------- socket handlers ----------
io.on('connection', socket => {
  logInfo('Dashboard socket connected');
  socket.emit('msg','Connected to Cyberland dashboard');

  socket.on('setChannel', async (channelId) => {
    settings.channelId = channelId;
    saveSettings();
    logSuccess('Default channel set to', channelId);
    socket.emit('msg', `Default channel set to ${channelId}`);
  });

  socket.on('toggleAI', () => {
    settings.aiEnabled = !settings.aiEnabled;
    saveSettings();
    logInfo('AI toggled:', settings.aiEnabled);
    socket.emit('msg', `AI: ${settings.aiEnabled}`);
  });

  socket.on('startUpdate', async ({ reason = 'Manual', minutes = 5 } = {}) => {
    try {
      if (!settings.channelId) return socket.emit('msg','No channel configured');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg','Channel not found or bot lacks access');
      // announce start, lock, purge
      await ch.send({ embeds: [ makePremiumEmbed({ title: '⚡ Update Starting', reason, duration: `${minutes}m` }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      await purgeChannelSafe(ch, 200);
      logWarn('Manual update started:', reason);
      socket.emit('msg', 'Update started (locked & purged)');
    } catch (e) {
      logError('startUpdate error', e.message || e);
      socket.emit('msg', 'Failed to start update: ' + (e.message||e));
    }
  });

  socket.on('finishUpdate', async () => {
    try {
      if (!settings.channelId) return socket.emit('msg','No channel configured');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg','Channel not found');
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      await ch.send({ embeds: [ makePremiumEmbed({ title:'✅ Update Finished', reason:'Manual finish', duration:'—' }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
      logSuccess('Manual update finished');
      socket.emit('msg', 'Update finished (unlocked)');
    } catch (e) {
      logError('finishUpdate error', e.message || e);
      socket.emit('msg', 'Failed to finish update: ' + (e.message||e));
    }
  });

  socket.on('announce', async (payload) => {
    try {
      if (!settings.channelId) return socket.emit('msg','No channel configured');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return socket.emit('msg','Channel not found');
      const emb = makePremiumEmbed({ title: payload.title || 'Announcement', reason: payload.reason || '—', duration: '—' }).setDescription(payload.content || '');
      await ch.send({ embeds: [emb], allowedMentions:{ parse:[] } });
      logInfo('Announcement sent:', payload.title);
      socket.emit('msg','Announcement sent');
    } catch (e) {
      logError('announce error', e.message || e);
      socket.emit('msg','Failed to send announcement: ' + (e.message||e));
    }
  });

  socket.on('botInfo', () => {
    const info = `Bot: ${client.user?.tag || 'offline'}\nPing: ${client.ws?.ping || 'N/A'}\nGuilds: ${client.guilds.cache.size || 0}`;
    logInfo('BotInfo requested');
    socket.emit('msg', info);
  });
});

// ---------- helper: purge safely ----------
async function purgeChannelSafe(channel, limit = 1000) {
  try {
    if (!channel || !channel.messages?.fetch) return 0;
    let remaining = limit;
    let totalDeleted = 0;
    while (remaining > 0) {
      const fetched = await channel.messages.fetch({ limit: Math.min(100, remaining) });
      if (!fetched || fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
        totalDeleted += fetched.size;
      } catch (e) {
        // fallback delete individually
        for (const m of fetched.values()) {
          try { await m.delete(); totalDeleted++; } catch(_) {}
        }
      }
      remaining -= fetched.size;
      if (fetched.size < 2) break;
    }
    return totalDeleted;
  } catch (e) {
    logError('purgeChannelSafe error', e.message || e);
    return 0;
  }
}

// ---------- schedule auto updates (BDT) ----------
function scheduleAutoUpdates() {
  try {
    // start windows at 11:00 and finish at 11:05; start at 15:00 finish at 15:05
    cron.schedule('0 11 * * *', async ()=> {
      if (!settings.autoUpdate) return;
      logInfo('Auto update window start 11:00 (BDT)');
      if (!settings.channelId) return logWarn('Auto update aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto update channel fetch failed');
      await ch.send({ embeds: [ makePremiumEmbed({ title:'⚡ Auto Update Starting (11:00)', reason:'Scheduled maintenance', duration:'5m' }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      await purgeChannelSafe(ch, 200);
    }, { timezone: TZ });

    cron.schedule('5 11 * * *', async ()=> {
      if (!settings.autoUpdate) return;
      logInfo('Auto update window finish 11:05 (BDT)');
      if (!settings.channelId) return logWarn('Auto update finish aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto update finish channel fetch failed');
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      await ch.send({ embeds: [ makePremiumEmbed({ title:'✅ Auto Update Finished (11:05)', reason:'Scheduled done', duration:'5m' }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
    }, { timezone: TZ });

    cron.schedule('0 15 * * *', async ()=> {
      if (!settings.autoUpdate) return;
      logInfo('Auto update window start 15:00 (BDT)');
      if (!settings.channelId) return logWarn('Auto update aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto update channel fetch failed');
      await ch.send({ embeds: [ makePremiumEmbed({ title:'⚡ Auto Update Starting (15:00)', reason:'Scheduled maintenance', duration:'5m' }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      await purgeChannelSafe(ch, 200);
    }, { timezone: TZ });

    cron.schedule('5 15 * * *', async ()=> {
      if (!settings.autoUpdate) return;
      logInfo('Auto update window finish 15:05 (BDT)');
      if (!settings.channelId) return logWarn('Auto update finish aborted: no channel set');
      const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
      if (!ch) return logWarn('Auto update finish channel fetch failed');
      await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      await ch.send({ embeds: [ makePremiumEmbed({ title:'✅ Auto Update Finished (15:05)', reason:'Scheduled done', duration:'5m' }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
    }, { timezone: TZ });

    logInfo('Auto update scheduler registered (BDT windows: 11:00-11:05, 15:00-15:05)');
  } catch (e) {
    logError('scheduleAutoUpdates error', e.message || e);
  }
}

// ---------- slash / interaction optional (status) ----------
async function registerSlashCommands(){
  if (!DISCORD_TOKEN) return;
  try {
    const rest = new REST({ version:'10' }).setToken(DISCORD_TOKEN);
    const appId = (client.application && client.application.id) ? client.application.id : (await client.application.fetch()).id;
    if (!appId) return;
    await rest.put(Routes.applicationCommands(appId), {
      body: [
        { name:'status', description:'Show bot status' }
      ]
    });
    logInfo('Slash commands deployed');
  } catch (e) {
    logWarn('registerSlashCommands', e.message || e);
  }
}

// ---------- interaction handler ----------
client.on('interactionCreate', async (int) => {
  try {
    if (!int.isChatInputCommand()) return;
    if (int.commandName === 'status') {
      const embed = makePremiumEmbed({ title:'Bot Status', reason:'Status report', duration:'—' });
      await int.reply({ embeds:[embed], ephemeral:true, allowedMentions:{ parse:[] } });
    }
  } catch (e) {
    logError('interactionCreate err', e.message || e);
  }
});

// ---------- message AI auto-reply (robust) ----------
const channelLocks = new Map(); // prevent concurrent handling in one channel
client.on('messageCreate', async (msg) => {
  if (msg.author?.bot) return;
  try {
    if (!settings.aiEnabled) return;
    if (!settings.channelId) return;
    if (msg.channel?.id !== settings.channelId) return;

    // lock per channel
    if (channelLocks.get(msg.channel.id)) return;
    channelLocks.set(msg.channel.id, true);

    let replyText = null;
    try {
      if (OPENAI_KEY) {
        replyText = await callOpenAI(msg.content);
      } else {
        replyText = `💤 AI disabled (no API key). You said: "${msg.content}"`;
      }
    } catch (e) {
      // map error to friendly message (preserve code like openai_error_status_429)
      const emsg = (e.message || String(e)).replace(/\s+/g,' ');
      replyText = `⚠️ Sorry, AI is temporarily unavailable. (${emsg})`;
      logWarn('OpenAI error:', emsg);
    }

    if (replyText) {
      await msg.reply({ content: replyText, allowedMentions:{ parse: [] } }).catch(err => logWarn('reply failed', err.message || err));
    }
  } catch (e) {
    logError('messageCreate handler error', e.message || e);
  } finally {
    channelLocks.set(msg.channel.id, false);
  }
});

// ---------- utilities ----------
async function purgeChannelSafe(channel, limit=1000){
  try {
    let deleted = 0;
    while (limit > 0) {
      const fetched = await channel.messages.fetch({ limit: Math.min(100, limit) });
      if (!fetched || fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
        deleted += fetched.size;
      } catch (e) {
        // fallback
        for (const m of fetched.values()) {
          try { await m.delete(); deleted++; } catch(_) {}
        }
      }
      limit -= fetched.size;
      if (fetched.size < 2) break;
    }
    return deleted;
  } catch (e) {
    logError('purgeChannelSafe error', e.message || e);
    return 0;
  }
}

// ---------- startup ----------
server.listen(PORT, () => {
  logSuccess(`Dashboard server listening on port ${PORT}`);
});

// Attempt Discord login
if (!DISCORD_TOKEN) {
  logError('DISCORD_TOKEN missing. Set it in environment variables.');
} else {
  client.login(DISCORD_TOKEN)
    .then(() => {
      logSuccess('Discord login successful:', client.user.tag);
      registerSlashCommands().catch(()=>{});
      scheduleAutoUpdates();
    })
    .catch(err => {
      logError('Discord login failed:', err.message || err);
    });
}

// handle unhandled rejections
process.on('unhandledRejection', (err) => {
  logError('Unhandled Rejection:', err && (err.message || err));
});
