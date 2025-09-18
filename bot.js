// bot.js — Full fixed premium Discord AI bot + dashboard (single file)
// Usage: npm install discord.js express socket.io openai dotenv
//        create .env, then node bot.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder
} = require('discord.js');

// --------- ENV / CONFIG ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_PREFIX = process.env.BOT_PREFIX || '!';
const AI_CHANNEL_ID = process.env.AI_CHANNEL_ID || '1404498262379200522';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

if (!DISCORD_TOKEN || !OPENAI_API_KEY) {
  console.error('Missing DISCORD_TOKEN or OPENAI_API_KEY in .env — exiting.');
  process.exit(1);
}

// --------- Persisted settings (systemPrompt, model) ----------
let settings = {
  systemPrompt:
    `You are a friendly, highly experienced Minecraft expert assistant specialized on play.cyberland.pro. ` +
    `Give concise, practical answers, include example commands or plugin names when relevant. If out of scope, provide general Minecraft best-practices.`,
  model: process.env.OPENAI_MODEL || 'gpt-4o'
};

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    settings = Object.assign(settings, parsed || {});
    console.log('Loaded settings from', SETTINGS_FILE);
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log('Created default settings.json');
  }
} catch (err) {
  console.warn('Could not load/create settings.json — using defaults.', err?.message || err);
}

// helper to persist
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log('Saved settings.json');
  } catch (err) {
    console.error('Failed to save settings.json', err);
  }
}

// --------- OpenAI client (v4 CommonJS safe) ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// wrapper query function
async function queryAI(userContent) {
  try {
    // ensure model exists, fallback if needed
    const model = settings.model || 'gpt-4o';
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: settings.systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      max_tokens: 900
    });
    const text = response.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim() : "Sorry, I couldn't generate a response.";
  } catch (err) {
    console.error('OpenAI error:', err?.response?.data || err);
    // Friendly error message (do not leak internals)
    return '⚠️ AI service unavailable. Try again later.';
  }
}

// --------- Discord Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

let isUpdating = false;

// Utility: lock/unlock channel for @everyone
async function lockChannel(channel) {
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    return true;
  } catch (err) {
    console.error('lockChannel error', err);
    return false;
  }
}
async function unlockChannel(channel) {
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: null });
    return true;
  } catch (err) {
    console.error('unlockChannel error', err);
    return false;
  }
}

function makePremiumEmbed(title, description, colorHex = 0x1e90ff) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(colorHex)
    .setFooter({ text: 'Cyberland AI • play.cyberland.pro' })
    .setTimestamp();
}

function chunkText(text, max = 1900) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}

// Message handler
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild) return;
    if (message.channel.id !== AI_CHANNEL_ID) return;

    if (isUpdating) {
      return message.reply('⏳ The AI is currently being updated by staff. Please wait a moment.');
    }

    const mentionPattern = new RegExp(`<@!?${client.user.id}>`);
    const isMention = mentionPattern.test(message.content);
    const isPrefixed = message.content.trim().startsWith(BOT_PREFIX);
    if (!isMention && !isPrefixed) return;

    let prompt = message.content;
    if (isMention) prompt = prompt.replace(mentionPattern, '').trim();
    if (isPrefixed) prompt = prompt.slice(BOT_PREFIX.length).trim();
    if (!prompt) return;

    await message.channel.sendTyping();

    const userPrompt = `User ${message.author.tag} asks: ${prompt}\nContext: server play.cyberland.pro. Answer as a helpful Minecraft expert.`;

    const aiReply = await queryAI(userPrompt);

    const parts = chunkText(aiReply);
    for (const p of parts) {
      await message.reply({ content: p });
    }
  } catch (err) {
    console.error('messageCreate error', err);
    try { await message.reply('⚠️ Unexpected error processing your message.'); } catch {}
  }
});

// --------- Express Dashboard + Socket.IO ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Cyberland AI — Dashboard</title>
<style>
  :root{--bg:#071127}
  html,body{height:100%;margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial;color:#e7f0fb;background:linear-gradient(180deg,#071127 0%, #07162a 100%)}
  .wrap{max-width:1000px;margin:40px auto;padding:22px;background:rgba(255,255,255,0.02);border-radius:12px;box-shadow:0 10px 40px rgba(2,6,23,0.7)}
  h1{margin:0 0 6px;font-size:20px}
  p.small{color:#9fb0c8;margin:0 0 12px}
  .grid{display:flex;gap:18px}
  .left{flex:1}
  .right{width:320px}
  input,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit}
  button{padding:10px 12px;border-radius:8px;border:none;background:linear-gradient(90deg,#6ee7b7,#3b82f6);color:#021026;font-weight:700;cursor:pointer}
  .muted{color:#9fb0c8;font-size:13px}
  .log{background:rgba(0,0,0,0.2);padding:10px;border-radius:8px;height:220px;overflow:auto;font-family:monospace;color:#cfeffe}
  .controls{display:flex;gap:8px}
  .danger{background:linear-gradient(90deg,#fb7185,#ef4444);color:white}
  .logo{width:56px;height:56px;border-radius:12px;background:conic-gradient(#6EE7B7,#3B82F6,#8B5CF6);animation:spin 10s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:880px){.grid{flex-direction:column}.right{width:100%}}
</style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="display:flex;gap:12px;align-items:center">
        <div class="logo"></div>
        <div>
          <h1>Cyberland AI — Premium Dashboard</h1>
          <p class="small">Manage AI behavior, start/finish updates, change model, and view logs.</p>
        </div>
      </div>
      <div style="text-align:right">
        <div class="muted">AI Channel</div>
        <div style="font-weight:700">${AI_CHANNEL_ID}</div>
      </div>
    </div>

    <div style="margin-top:18px" class="grid">
      <div class="left">
        <div style="margin-bottom:10px">
          <label class="muted">Admin Password</label>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input id="pwd" type="password" placeholder="Enter admin password" />
            <button id="btnLogin">Unlock</button>
          </div>
          <div id="loginMsg" class="muted" style="margin-top:8px"></div>
        </div>

        <div id="main" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div id="statusText" style="font-weight:700">Bot Online</div>
              <div class="muted">Model: <span id="modelLabel"></span></div>
            </div>
            <div style="display:flex;gap:8px">
              <button id="btnLock" class="danger">Start Update (Lock)</button>
              <button id="btnUnlock">Finish Update</button>
            </div>
          </div>

          <hr style="margin:12px 0;border:none;border-top:1px solid rgba(255,255,255,0.04)">

          <div>
            <label class="muted">System Prompt</label>
            <textarea id="sysPrompt" rows="7"></textarea>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
              <div class="muted">Update the AI system prompt (saved to settings.json)</div>
              <div style="display:flex;gap:8px">
                <button id="savePrompt">Save</button>
              </div>
            </div>
          </div>

          <div style="margin-top:12px">
            <label class="muted">Console & Activity</label>
            <div class="log" id="log"></div>
          </div>
        </div>
      </div>

      <div class="right">
        <div style="background:rgba(255,255,255,0.02);padding:12px;border-radius:10px">
          <div style="font-weight:700;margin-bottom:8px">Quick Controls</div>
          <div class="muted">Model override</div>
          <input id="modelInput" placeholder="gpt-4o or gpt-4o-mini" style="margin-top:8px" />
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="btnSetModel">Set Model</button>
          </div>
          <div style="margin-top:12px" class="muted">Settings persist to <b>settings.json</b> in the bot folder.</div>
        </div>
      </div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io('/', { autoConnect: false });
  const btnLogin = document.getElementById('btnLogin');
  const pwd = document.getElementById('pwd');
  const loginMsg = document.getElementById('loginMsg');
  const main = document.getElementById('main');
  const sysPrompt = document.getElementById('sysPrompt');
  const log = document.getElementById('log');
  const btnLock = document.getElementById('btnLock');
  const btnUnlock = document.getElementById('btnUnlock');
  const savePrompt = document.getElementById('savePrompt');
  const modelLabel = document.getElementById('modelLabel');
  const modelInput = document.getElementById('modelInput');
  const btnSetModel = document.getElementById('btnSetModel');
  const statusText = document.getElementById('statusText');

  function appendLog(t){ log.innerText = '[' + new Date().toLocaleTimeString() + '] ' + t + "\\n" + log.innerText; }

  btnLogin.onclick = () => {
    loginMsg.innerText = 'Connecting...';
    socket.auth = { token: pwd.value || '' };
    socket.connect();
    socket.once('connect_error', (err) => {
      loginMsg.innerText = 'Auth failed. Check password.';
      socket.disconnect();
    });
    socket.once('connect', () => {
      loginMsg.innerText = '';
      pwd.value = '';
      main.style.display = 'block';
      appendLog('Dashboard connected');
      socket.emit('getState');
    });
  };

  socket.on('state', s => {
    sysPrompt.value = s.systemPrompt || '';
    modelLabel.innerText = s.model || '';
    statusText.innerText = s.isUpdating ? 'Updating (locked)' : 'Bot Online';
    appendLog('State synced');
  });
  socket.on('log', t => appendLog(t));
  socket.on('status', t => appendLog(t));

  btnLock.onclick = () => socket.emit('startUpdate');
  btnUnlock.onclick = () => socket.emit('finishUpdate');
  savePrompt.onclick = () => { socket.emit('savePrompt', sysPrompt.value); appendLog('Saved prompt'); };
  btnSetModel.onclick = () => { const m = modelInput.value.trim(); if (!m) return; socket.emit('setModel', m); appendLog('Set model to ' + m); modelLabel.innerText = m; };
  socket.on('disconnect', () => appendLog('Socket disconnected'));
</script>
</body>
</html>`);
});

// Socket auth & events
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token === ADMIN_PASSWORD) return next();
  return next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('state', { isUpdating, systemPrompt: settings.systemPrompt, model: settings.model });

  socket.on('getState', () => {
    socket.emit('state', { isUpdating, systemPrompt: settings.systemPrompt, model: settings.model });
  });

  socket.on('savePrompt', (p) => {
    settings.systemPrompt = String(p || settings.systemPrompt).trim();
    saveSettings();
    io.emit('status', 'System prompt updated (saved).');
    io.emit('log', 'System prompt updated by admin.');
  });

  socket.on('setModel', (m) => {
    settings.model = String(m || settings.model).trim();
    saveSettings();
    io.emit('status', 'Model set to ' + settings.model);
    io.emit('log', 'Model changed to ' + settings.model);
  });

  socket.on('startUpdate', async () => {
    try {
      const ch = await client.channels.fetch(AI_CHANNEL_ID);
      if (!ch) return socket.emit('status', 'AI channel not found.');

      isUpdating = true;
      const locked = await lockChannel(ch);
      if (!locked) return socket.emit('status', 'Failed to lock channel — check permissions.');

      const embed = makePremiumEmbed('🔧 Bot Update Started', 'Staff initiated an update — chat is temporarily locked. We will unlock when update is complete.', 0xffb347);
      await ch.send({ embeds: [embed] });

      io.emit('status', 'Update started & channel locked.');
      io.emit('state', { isUpdating, systemPrompt: settings.systemPrompt, model: settings.model });
      io.emit('log', 'Update started by admin.');
    } catch (err) {
      console.error('startUpdate error', err);
      socket.emit('status', 'Error starting update: ' + String(err?.message || err));
    }
  });

  socket.on('finishUpdate', async () => {
    try {
      const ch = await client.channels.fetch(AI_CHANNEL_ID);
      if (!ch) return socket.emit('status', 'AI channel not found.');

      isUpdating = false;
      const unlocked = await unlockChannel(ch);
      if (!unlocked) return socket.emit('status', 'Failed to unlock channel — check permissions.');

      const embed = makePremiumEmbed('✅ Update Complete', 'The AI has been updated successfully. Chat is unlocked and ready.', 0x60a5fa);
      await ch.send({ embeds: [embed] });

      io.emit('status', 'Update finished & channel unlocked.');
      io.emit('state', { isUpdating, systemPrompt: settings.systemPrompt, model: settings.model });
      io.emit('log', 'Update finished by admin.');
    } catch (err) {
      console.error('finishUpdate error', err);
      socket.emit('status', 'Error finishing update: ' + String(err?.message || err));
    }
  });
});

// --------- Start bot and dashboard ----------
client.once('ready', async () => {
  console.log('Discord logged in as', client.user.tag);
  server.listen(PORT, () => console.log(`Dashboard available at http://localhost:${PORT}`));

  // try fetch channel for sanity
  try {
    const ch = await client.channels.fetch(AI_CHANNEL_ID);
    if (!ch) console.warn('AI channel not found (check AI_CHANNEL_ID):', AI_CHANNEL_ID);
    else console.log('AI channel ok:', AI_CHANNEL_ID, 'guild:', ch.guild?.name || '(unknown)');
  } catch (err) {
    console.error('Error fetching AI channel:', err?.message || err);
  }
});

client.on('error', (err) => console.error('Discord client error', err));
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
