/**
 * Cyberland Backend (bot.js)
 * - Express + Socket.io API for the React dashboard
 * - Discord bot (AI chat, update system, slash commands)
 * - Persistent settings in settings.json
 *
 * Make sure environment variables are configured (see top of file).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const http = require('http');
const { Server: IOServer } = require('socket.io');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');
const mcu = require('minecraft-server-util');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes } = require('discord.js');

/////////// Configuration (from env) ///////////
const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Dhaka'; // Bangladesh timezone
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_session_secret';
const DEFAULT_CHANNEL = process.env.DEFAULT_CHANNEL || null;
const UPDATE_GIF_URL = process.env.UPDATE_GIF_URL || 'https://i.imgur.com/qfXDW5P.gif';
const FINISH_GIF_URL = process.env.FINISH_GIF_URL || 'https://i.imgur.com/ZL8Jk7M.gif';
const ADMINS_ENV = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);

// minecraft server
const MINECRAFT_IP = 'play.cyberland.pro';
const MINECRAFT_PORT = 19132;

/////////// Persistence ///////////
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = {
  channelId: DEFAULT_CHANNEL || null,
  updateGif: UPDATE_GIF_URL,
  finishGif: FINISH_GIF_URL,
  prefix: '!',
  autoUpdate: true,
  aiEnabled: true,
  autoroleId: null,
  admins: ADMINS_ENV || [], // discord user IDs with admin privileges (optional)
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      settings = { ...settings, ...parsed };
    } else {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
  } catch (e) {
    console.error('Failed to load settings.json', e);
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings.json', e);
  }
}
loadSettings();

/////////// Discord client ///////////
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

let updateTimer = null;
let updateState = { active: false, auto: false, reason: '', startedAt: 0, endsAt: 0, minutes: 0, messageId: null };
const userContexts = new Map();
const MAX_TURNS = 10;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/////////// Helpers ///////////
function nowTs() { return Date.now(); }
function fmtTS(ts) { return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A'); }
function nextUpdateWindowsString() {
  const now = moment().tz(TZ);
  const base = now.clone().startOf('day');
  const w1s = base.clone().add(11, 'hours').add(20, 'minutes');
  const w1e = base.clone().add(11, 'hours').add(25, 'minutes');
  const w2s = base.clone().add(15, 'hours').add(0, 'minutes');
  const w2e = base.clone().add(15, 'hours').add(5, 'minutes');
  if (now.isBefore(w1s)) return `${w1s.format('h:mm A')} - ${w1e.format('h:mm A')} & ${w2s.format('h:mm A')} - ${w2e.format('h:mm A')} (BDT)`;
  if (now.isBefore(w2s)) return `${w2s.format('h:mm A')} - ${w2e.format('h:mm A')} (today)`;
  const tm = base.clone().add(1, 'day');
  return `${tm.clone().add(11, 'hours').add(20, 'minutes').format('MMM D h:mm A')} - next windows`;
}

async function purgeChannel(channel) {
  try {
    if (!channel || !channel.isTextBased?.()) return;
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched || fetched.size === 0) break;
      try {
        await channel.bulkDelete(fetched, true);
      } catch (bulkErr) {
        for (const [, msg] of fetched) {
          try { await msg.delete(); } catch (_) { }
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error('purgeChannel error:', e?.message || e);
  }
}

async function lockChannel(channel, lock) {
  try {
    if (!channel || !channel.guild) return;
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: lock ? false : true });
  } catch (e) {
    console.error('lockChannel error:', e?.message || e);
  }
}

/////////// OpenAI wrapper ///////////
async function chatOpenAI(messages, attempt = 1) {
  if (!OPENAI_API_KEY) return '❌ OpenAI API key not configured.';
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 900,
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 70000,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) return res.data?.choices?.[0]?.message?.content?.trim() || '';
    if (res.status === 401) return '❌ Invalid OpenAI API Key.';
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 700 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return '⚠️ AI temporarily unavailable. Try again later.';
  } catch (e) {
    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 700 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    console.error('chatOpenAI err:', e?.message || e);
    return '⚠️ AI temporarily unavailable. Try again later.';
  }
}

function buildContext(userId, username, userMsg) {
  const sys = { role: 'system', content: 'You are Cyberland assistant — friendly, concise, and Minecraft-expert when asked.' };
  const out = [sys];
  const hist = userContexts.get(userId) || [];
  for (const t of hist.slice(-MAX_TURNS)) {
    out.push({ role: 'user', content: `${username}: ${t.q}` });
    out.push({ role: 'assistant', content: t.a });
  }
  out.push({ role: 'user', content: `${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a) {
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}

async function typeAndReply(message, fullText) {
  if (!fullText) { await message.reply('...'); return; }
  const words = fullText.split(/\s+/);
  const chunks = []; let buf = '';
  for (const w of words) {
    const cand = (buf ? buf + ' ' : '') + w;
    if (cand.length > 180) { chunks.push(buf); buf = w; } else buf = cand;
  }
  if (buf) chunks.push(buf);
  let first = true;
  for (const c of chunks) {
    try {
      await message.channel.sendTyping();
      if (first) { await message.reply(c); first = false; } else { await message.channel.send(c); }
      await new Promise(r => setTimeout(r, Math.min(900, Math.max(80, c.length * 6))));
    } catch (e) { console.error('typeAndReply send error:', e?.message || e); }
  }
}

/////////// Embeds ///////////
function ultraEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'Developed by Zihuu • Cyberland' }).setTimestamp();
}
function createUpdatingEmbed({ minutes, reason, auto, progress = 0, gif }) {
  const title = auto ? '⚡ Automatic Update — In Progress' : '🚀 Manual Update — In Progress';
  const e = ultraEmbed(0xF59E0B, title, `Maintenance running — optimizing systems.\n\nProgress: **${Math.floor(progress)}%**`);
  e.addFields(
    { name: '🎉 Status', value: 'Updating…', inline: true },
    { name: '🔓 Chat', value: 'Locked', inline: true },
    { name: '⚡ Server Performance', value: 'Boosting', inline: true },
    { name: '⏰ Next update', value: nextUpdateWindowsString(), inline: false },
    { name: '🤖 Update system', value: auto ? 'Automatic' : 'Manual', inline: true },
    { name: '⚙️ Frequency', value: '11:20-11:25 & 15:00-15:05 (BDT)', inline: true }
  );
  if (reason) e.addFields({ name: '📝 Reason', value: reason, inline: false });
  if (gif) e.setImage(gif);
  return e;
}
function createUpdatedEmbed({ auto, completedAt, gif }) {
  const e = ultraEmbed(0x22C55E, '✅ You can now use the bot!', 'Update finished — everything is ready and optimized.');
  e.addFields(
    { name: '🎉 Status', value: 'Completed', inline: true },
    { name: '🔓 Chat', value: 'Unlocked', inline: true },
    { name: '⚡ Server Performance', value: 'Optimized', inline: true },
    { name: '⏰ Next update', value: nextUpdateWindowsString(), inline: false },
    { name: '🤖 Update system', value: auto ? 'Automatic' : 'Manual', inline: true },
    { name: '⚙️ Frequency', value: '11:20-11:25 & 15:00-15:05 (BDT)', inline: true }
  );
  if (completedAt) e.addFields({ name: '✅ Completed At', value: completedAt, inline: false });
  if (gif) e.setImage(gif);
  return e;
}

/////////// Update flow (with live progress edits) ///////////
async function startUpdateFlow({ minutes, reason = '', auto = false, progressIntervalMs = 2000 }) {
  if (!settings.channelId) throw new Error('CHANNEL_ID not configured (set in dashboard or env).');
  const ch = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  const now = nowTs();
  updateState = { active: true, auto, reason, startedAt: now, endsAt: now + minutes * 60000, minutes, messageId: null };

  await purgeChannel(ch);
  await lockChannel(ch, true);

  const initialMsg = await ch.send({ content: '@everyone', embeds: [createUpdatingEmbed({ minutes, reason, auto, progress: 0, gif: settings.updateGif })] }).catch(e => { throw e; });
  updateState.messageId = initialMsg.id;

  const totalMs = minutes * 60000;
  const startTs = Date.now();
  if (updateTimer) clearTimeout(updateTimer);

  let progress = 0;
  const editLoop = setInterval(async () => {
    try {
      const elapsed = Date.now() - startTs;
      progress = Math.min(100, (elapsed / totalMs) * 100);
      const e = createUpdatingEmbed({ minutes, reason, auto, progress, gif: settings.updateGif });
      await initialMsg.edit({ content: '@everyone', embeds: [e] }).catch(() => {});
      io.emit('updateState', updateState);
    } catch (err) { console.error('progress edit err', err); }
  }, progressIntervalMs);

  updateTimer = setTimeout(async () => {
    clearInterval(editLoop);
    try {
      await finishUpdateFlow({ auto });
    } catch (e) { console.error('auto finish err', e); }
  }, totalMs);

  io.emit('updateState', updateState);
  saveSettings();
}

async function finishUpdateFlow({ auto = false }) {
  if (!settings.channelId) throw new Error('CHANNEL_ID not configured.');
  const ch = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel.');
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ content: '@everyone', embeds: [createUpdatedEmbed({ auto, completedAt, gif: settings.finishGif })] }).catch(() => {});
  updateState = { active: false, auto: false, reason: '', startedAt: 0, endsAt: 0, minutes: 0, messageId: null };
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  io.emit('updateState', updateState);
  saveSettings();
}

/////////// Auto-update cron schedule (BDT) ///////////
// start at 11:20 run 5 minutes (finish at 11:25)
cron.schedule('20 11 * * *', async () => { if (!settings.autoUpdate) return; try { await startUpdateFlow({ minutes: 5, reason: 'Auto window 11:20-11:25', auto: true }); } catch (e) { console.error('auto start1 err', e); } }, { timezone: TZ });
cron.schedule('25 11 * * *', async () => { if (!settings.autoUpdate) return; try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto finish1 err', e); } }, { timezone: TZ });

// second window 15:00 -> 15:05
cron.schedule('0 15 * * *', async () => { if (!settings.autoUpdate) return; try { await startUpdateFlow({ minutes: 5, reason: 'Auto window 15:00-15:05', auto: true }); } catch (e) { console.error('auto start2 err', e); } }, { timezone: TZ });
cron.schedule('5 15 * * *', async () => { if (!settings.autoUpdate) return; try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto finish2 err', e); } }, { timezone: TZ });

/////////// Express + Socket.io backend for dashboard ///////////
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 24 * 3600 * 1000 } }));

// JWT secret
const JWT_SECRET = SESSION_SECRET || 'cyberland_jwt_secret';

// Hard-coded dashboard accounts (per your request)
// usernames: zihuu, shahin, mainuddin  —  password: cyberlandai90x90x90
const DASH_USERS = new Map([
  ['zihuu', 'cyberlandai90x90x90'],
  ['shahin', 'cyberlandai90x90x90'],
  ['mainuddin', 'cyberlandai90x90x90'],
]);

// Serve static React build if present (dashboard built into /dashboard/build)
const staticPath = path.join(__dirname, 'dashboard', 'build');
if (fs.existsSync(staticPath)) {
  app.use(express.static(staticPath));
  // serve index.html for client-side routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(staticPath, 'index.html'));
  });
} else {
  // simple homepage / info if dashboard build not present
  app.get('/', (req, res) => {
    res.type('text').send('Cyberland backend running. Dashboard build not found. Put your React build into /dashboard/build or use the provided HTML dashboard client.');
  });
}

// Auth helpers (JWT via httpOnly cookie)
function createToken(username) {
  return jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '12h' });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ', '') || req.body?.token || req.query?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Invalid token' });
  req.user = data.u;
  next();
}

// parsing cookies for simple JWT retrieval
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Login endpoint for dashboard (returns httpOnly cookie + JSON)
app.post('/api/login', (req, res) => {
  const username = (req.body.username || '').toString().trim().toLowerCase();
  const password = (req.body.password || '').toString();
  if (!DASH_USERS.has(username) || DASH_USERS.get(username) !== password) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  const token = createToken(username);
  res.cookie('token', token, { httpOnly: true, maxAge: 12 * 3600 * 1000 });
  res.json({ success: true, token });
});

// Logout
app.post('/api/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Dashboard APIs (protected)
app.get('/api/state', requireAuth, (_req, res) => {
  res.json({ settings, updateState, botConnected: !!client.user });
});

app.get('/api/update-state', requireAuth, (_req, res) => res.json(updateState));

app.post('/api/start-update', requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || '').toString().slice(0, 1000);
    await startUpdateFlow({ minutes, reason, auto: false });
    return res.json({ success: true });
  } catch (e) {
    console.error('api start-update error:', e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

app.post('/api/finish-update', requireAuth, async (_req, res) => {
  try {
    await finishUpdateFlow({ auto: false });
    return res.json({ success: true });
  } catch (e) {
    console.error('api finish-update error:', e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

app.post('/api/toggle-auto', requireAuth, (_req, res) => {
  settings.autoUpdate = !settings.autoUpdate;
  saveSettings();
  io.emit('serverState', makeServerState());
  res.json({ autoUpdate: settings.autoUpdate });
});

app.post('/api/toggle-ai', requireAuth, (_req, res) => {
  settings.aiEnabled = !settings.aiEnabled;
  saveSettings();
  io.emit('serverState', makeServerState());
  res.json({ aiEnabled: settings.aiEnabled });
});

app.post('/api/set-channel', requireAuth, (req, res) => {
  const ch = (req.body.channelId || '').toString().trim();
  settings.channelId = ch || null;
  saveSettings();
  io.emit('serverState', makeServerState());
  res.json({ success: true, channelId: settings.channelId });
});

app.post('/api/set-gifs', requireAuth, (req, res) => {
  const updateGif = (req.body.updateGif || '').toString().trim();
  const finishGif = (req.body.finishGif || '').toString().trim();
  if (updateGif) settings.updateGif = updateGif;
  if (finishGif) settings.finishGif = finishGif;
  saveSettings();
  res.json({ success: true, updateGif: settings.updateGif, finishGif: settings.finishGif });
});

app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { channel, content, kind, title, gif } = req.body;
    const target = (channel && channel.trim()) || settings.channelId;
    if (!target) return res.status(400).json({ success: false, error: 'No channel configured' });
    const ch = await client.channels.fetch(target).catch(() => null);
    if (!ch) return res.status(404).json({ success: false, error: 'Channel not found' });
    if (kind === 'embed') {
      const emb = ultraEmbed(0x7c3aed, title || 'Announcement', content || '');
      if (gif) emb.setImage(gif);
      await ch.send({ content: '@everyone', embeds: [emb] });
      return res.json({ success: true });
    } else {
      await ch.send({ content: content || '' });
      return res.json({ success: true });
    }
  } catch (e) {
    console.error('api send err', e);
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

app.post('/api/clear', requireAuth, async (_req, res) => {
  try {
    if (!settings.channelId) return res.status(400).json({ success: false, error: 'No default channel set' });
    const ch = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!ch) return res.status(404).json({ success: false, error: 'Channel not found' });
    await purgeChannel(ch);
    return res.json({ success: true });
  } catch (e) {
    console.error('api clear err', e);
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

app.post('/api/set-prefix', requireAuth, (req, res) => {
  const p = (req.body.prefix || '').toString().trim();
  if (!p) return res.status(400).json({ success: false, error: 'prefix required' });
  settings.prefix = p;
  saveSettings();
  res.json({ success: true, prefix: p });
});

app.post('/api/save-autorole', requireAuth, (req, res) => {
  const r = (req.body.roleId || '').toString().trim();
  settings.autoroleId = r || null;
  saveSettings();
  res.json({ success: true, autoroleId: settings.autoroleId });
});

app.get('/api/server-status', requireAuth, async (_req, res) => {
  try {
    const s = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online: true, players: s.players.online, ping: s.roundTripLatency });
  } catch (e) {
    res.json({ online: false });
  }
});

app.get('/api/next-windows', requireAuth, (_req, res) => {
  res.json({ text: nextUpdateWindowsString() });
});

app.get('/api/details', requireAuth, (_req, res) => {
  res.json({ updateState, settings, botConnected: !!client.user });
});

// Socket.io: push server state & update state to dashboard
function makeServerState() {
  return {
    bot: client?.user ? `Online (${client.user.tag})` : 'Disconnected',
    ai: settings.aiEnabled ? 'Available' : 'Disabled',
    next: nextUpdateWindowsString(),
    channel: settings.channelId || null,
  };
}
io.on('connection', socket => {
  socket.emit('serverState', makeServerState());
  socket.emit('updateState', updateState);
});

/////////// Slash commands & Discord message handling ///////////
async function deployCommands() {
  try {
    if (!DISCORD_TOKEN) return;
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const commands = [
      { name: 'status', description: 'Show bot status' },
      { name: 'startupdate', description: 'Start manual update (admins only)', options: [{ name: 'minutes', description: 'minutes', type: 4, required: true }] },
      { name: 'finishupdate', description: 'Finish update (admins only)' },
      { name: 'setchannel', description: 'Set default channel (admins only)', options: [{ name: 'channelid', description: 'channel id', type: 3, required: true }] }
    ];
    if (client.user) {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('Slash commands deployed');
    }
  } catch (e) {
    console.error('deployCommands error', e);
  }
}

function isAdminDiscordMember(member) {
  try {
    if (!member) return false;
    if (settings.admins && settings.admins.includes(member.id)) return true;
    return member.permissions?.has?.('ManageGuild') || member.permissions?.has?.('Administrator');
  } catch (e) { return false; }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    const cmd = interaction.commandName;
    if (cmd === 'status') {
      await interaction.reply({ content: `Bot: ${client.user.tag}\nAI: ${settings.aiEnabled ? 'On' : 'Off'}\nDefault channel: ${settings.channelId || 'not set'}`, ephemeral: true });
    } else if (cmd === 'startupdate') {
      const minutes = interaction.options.getInteger('minutes') || 5;
      const m = interaction.member;
      if (!isAdminDiscordMember(m)) return interaction.reply({ content: 'You are not authorized', ephemeral: true });
      await interaction.reply({ content: `Starting update for ${minutes} minutes...`, ephemeral: true });
      await startUpdateFlow({ minutes, reason: 'Manual (slash command)', auto: false });
    } else if (cmd === 'finishupdate') {
      const m = interaction.member;
      if (!isAdminDiscordMember(m)) return interaction.reply({ content: 'You are not authorized', ephemeral: true });
      await finishUpdateFlow({ auto: false });
      await interaction.reply({ content: 'Finish requested', ephemeral: true });
    } else if (cmd === 'setchannel') {
      const id = interaction.options.getString('channelid');
      const m = interaction.member;
      if (!isAdminDiscordMember(m)) return interaction.reply({ content: 'You are not authorized', ephemeral: true });
      settings.channelId = id;
      saveSettings();
      io.emit('serverState', makeServerState());
      await interaction.reply({ content: `Default channel set to ${id}`, ephemeral: true });
    }
  } catch (e) {
    console.error('interaction error', e);
    try { await interaction.reply({ content: 'Error', ephemeral: true }); } catch (_) { }
  }
});

// AI chat handler — only listens in settings.channelId
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!settings.channelId) return;
    if (message.channel.id !== settings.channelId) return;
    if (!settings.aiEnabled) return;

    // simple prefix admin commands in channel
    if (message.content.startsWith(settings.prefix)) {
      const args = message.content.slice(settings.prefix.length).trim().split(/\s+/);
      const cmd = args.shift().toLowerCase();
      if (cmd === 'status') {
        await message.reply(`Bot: ${client.user.tag}\nAI: ${settings.aiEnabled ? 'On' : 'Off'}\nPrefix: ${settings.prefix}`);
        return;
      }
    }

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const ctx = buildContext(message.author.id, message.author.username, message.content);
      const ans = await chatOpenAI(ctx);
      saveContext(message.author.id, message.content, ans);
      await typeAndReply(message, ans || "Sorry, I couldn't generate a reply right now.");
    });
    await aiQueue;
  } catch (e) {
    console.error('AI handler error:', e);
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    if (!settings.autoroleId) return;
    const role = member.guild.roles.cache.get(settings.autoroleId) || await member.guild.roles.fetch(settings.autoroleId).catch(() => null);
    if (role) await member.roles.add(role).catch(() => { });
  } catch (e) { console.error('autorole error', e); }
});

client.on('ready', async () => {
  console.log('✅ Discord ready as', client.user?.tag || 'unknown');
  io.emit('serverState', makeServerState());
  if (process.env.DEFAULT_CHANNEL && !settings.channelId) { settings.channelId = process.env.DEFAULT_CHANNEL; saveSettings(); }
  try { await deployCommands(); } catch (e) { console.error('slash deploy err', e); }
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err?.message || err);
  // backend remains available for debugging
});

server.listen(PORT, () => {
  console.log(`🌐 Cyberland backend running on port ${PORT}`);
});

