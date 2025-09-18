// bot.js  — Premium all-in-one Discord AI + Dashboard (single file)
// -> Drop into a single folder, install deps, set env vars, run `node bot.js`
//
// Dependencies:
// npm install discord.js express socket.io openai dotenv

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits
} = require('discord.js');

// ====== CONFIG / ENV ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';
const PORT = process.env.PORT || 3000;
const BOT_PREFIX = process.env.BOT_PREFIX || '!';
const AI_CHANNEL_ID = process.env.AI_CHANNEL_ID || '1404498262379200522'; // fixed channel you gave

if (!DISCORD_TOKEN || !OPENAI_API_KEY) {
  console.error('Missing DISCORD_TOKEN or OPENAI_API_KEY in environment variables. Exiting.');
  process.exit(1);
}

// ====== OPENAI CLIENT (v4) ======
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// ====== AI SYSTEM PROMPT (editable via dashboard) ======
let systemPrompt = `You are a highly experienced Minecraft expert and friendly assistant, specialized in the server play.cyberland.pro.
Answer concisely, give practical in-server commands, plugin tips, building & survival advice, and troubleshoot common server issues.
When appropriate include example commands, coordinates, plugin names, and short configuration hints.
If a question is outside the server scope, provide best-practice general Minecraft advice.`;

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

let isUpdating = false; // update lock state

// Utility: lock/unlock the AI channel for @everyone
async function lockChannel(channel) {
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: false
    });
    return true;
  } catch (err) {
    console.error('lockChannel error:', err);
    return false;
  }
}
async function unlockChannel(channel) {
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: null // reset to default
    });
    return true;
  } catch (err) {
    console.error('unlockChannel error:', err);
    return false;
  }
}

// Create a premium embed (no @everyone mention)
function makePremiumEmbed(title, description, colorHex = 0x1E90FF) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(colorHex)
    .setFooter({ text: 'Cyberland AI • play.cyberland.pro' })
    .setTimestamp();
}

// Helper: split long text into Discord-sized chunks
function chunkText(text, max = 1900) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + max));
    i += max;
  }
  return parts;
}

// ====== AI Query Function (Chat Completions) ======
async function queryAI(userContent) {
  try {
    // Using OpenAI v4 client pattern: openai.chat.completions.create(...)
    // Model choice: gpt-4o is used here for highest-quality answers (if not available for your key, switch to gpt-4o-mini)
    const modelToUse = process.env.OPENAI_MODEL || 'gpt-4o'; // change via env if needed

    const resp = await openai.chat.completions.create({
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      max_tokens: 900,
      temperature: 0.2
    });

    const text = resp.choices?.[0]?.message?.content;
    return text ? String(text).trim() : "Sorry, I couldn't generate a response.";
  } catch (err) {
    console.error('OpenAI query error:', err?.response?.data || err);
    return '⚠️ AI service error. Please try again later.';
  }
}

// ====== Discord Message Handler ======
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild) return;

    // Limit listening to only the configured AI channel
    if (message.channel.id !== AI_CHANNEL_ID) return;

    // If updating, politely block messages
    if (isUpdating) {
      // reply ephemeral-ish: short message
      await message.reply('⏳ The AI is being updated by staff. Please wait a moment.');
      return;
    }

    // Trigger: either mention the bot or use prefix
    const mentionPattern = new RegExp(`<@!?${client.user.id}>`);
    const isMention = mentionPattern.test(message.content);
    const isPrefixed = message.content.trim().startsWith(BOT_PREFIX);
    if (!isMention && !isPrefixed) return;

    // Extract user prompt
    let prompt = message.content;
    if (isMention) prompt = prompt.replace(mentionPattern, '').trim();
    if (isPrefixed) prompt = prompt.slice(BOT_PREFIX.length).trim();
    if (!prompt) return;

    // Show typing
    await message.channel.sendTyping();

    // Add a small context note about server
    const userPrompt = `User ${message.author.tag} on play.cyberland.pro asks: ${prompt}\n\nAnswer as a helpful Minecraft server expert.`;

    const aiReply = await queryAI(userPrompt);

    // Send reply in chunks if needed
    const chunks = chunkText(aiReply);
    for (const chunk of chunks) {
      await message.reply({ content: chunk });
    }
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

// ====== Dashboard (Express + Socket.IO) ======
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve login page + dashboard single-page (all inline styles & scripts)
app.get('/', (req, res) => {
  // minimal check - we'll still require password via socket auth for actions
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cyberland AI — Dashboard</title>
  <style>
    /* Modern premium styles, animated gradient, card UI */
    :root{--bg:#0f1724;--card:#0b1220;--accent:linear-gradient(90deg,#6EE7B7,#3B82F6,#8B5CF6);}
    html,body{height:100%;margin:0;font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,'Helvetica Neue',Arial}
    body{background:radial-gradient(circle at 10% 10%, rgba(59,130,246,0.06), transparent 10%),
                      radial-gradient(circle at 90% 90%, rgba(139,92,246,0.04), transparent 10%), background-color:var(--bg); color:#e6eef8}
    .center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);backdrop-filter: blur(6px);padding:28px;border-radius:14px;max-width:980px;width:100%;box-shadow:0 8px 40px rgba(2,6,23,0.6)}
    .row{display:flex;gap:20px;align-items:flex-start}
    .left{flex:1;min-width:280px}
    .right{width:360px}
    h1{margin:0 0 12px;font-size:22px}
    p.small{margin:0 0 14px;color:#a9c0d9}
    input[type=password], textarea, input[type=text]{width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit}
    button{cursor:pointer;padding:10px 14px;border-radius:10px;border:none;background:var(--accent);color:#071129;font-weight:600}
    .muted{color:#98a8bf;font-size:13px}
    .controls{display:flex;gap:8px;margin-top:12px}
    .log{height:160px;overflow:auto;background:rgba(0,0,0,0.2);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.03);font-family:monospace;color:#cfeffe}
    .title-badge{display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.03);font-weight:600;color:#bfe7d6}
    .small-note{font-size:13px;color:#9fb7d0}
    .field{margin-bottom:10px}
    .status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
    .btn-danger{background:linear-gradient(90deg,#fb7185,#ef4444);color:white}
    footer{margin-top:16px;font-size:13px;color:#7f99b3;text-align:center}
    /* animation */
    .logo-anim{height:56px;width:56px;border-radius:12px;background:conic-gradient(from 0deg,var(--accent));box-shadow:0 6px 18px rgba(59,130,246,0.16);display:inline-block;animation:spin 9s linear infinite}
    @keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
    @media(max-width:880px){.row{flex-direction:column}.right{width:100%}}
  </style>
</head>
<body>
  <div class="center">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="display:flex;align-items:center;gap:12px">
            <div class="logo-anim"></div>
            <div>
              <div class="title-badge">Cyberland AI</div>
              <h1>Premium Dashboard</h1>
              <p class="small">Manage the Minecraft AI, update workflow, and tune the system prompt — secure login required.</p>
            </div>
          </div>
        </div>
        <div style="text-align:right">
          <div class="muted">Channel ID</div>
          <div style="font-weight:700">${AI_CHANNEL_ID}</div>
        </div>
      </div>

      <div class="row">
        <div class="left">
          <div style="margin-bottom:10px">
            <label class="small-note">Admin Password</label>
            <div style="display:flex;gap:8px;margin-top:6px">
              <input id="pwd" type="password" placeholder="Enter admin password" />
              <button id="loginBtn">Unlock</button>
            </div>
            <div id="loginMsg" class="small-note" style="margin-top:8px"></div>
          </div>

          <div id="mainArea" style="display:none">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <span class="status-dot" id="statusDot" style="background:#22c55e"></span>
                <span id="statusText">Bot Online</span>
                <div class="muted">AI Model: <b id="modelName">gpt-4o</b></div>
              </div>
              <div style="text-align:right">
                <button id="btnLock" class="btn-danger">Start Update (Lock)</button>
                <button id="btnUnlock">Finish Update (Unlock)</button>
              </div>
            </div>

            <hr style="margin:12px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">

            <div>
              <label class="small-note">System Prompt (AI behavior)</label>
              <textarea id="sysPrompt" rows="7"></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                <div class="muted">Edit the AI system prompt used for chat completions.</div>
                <div class="controls">
                  <button id="savePrompt">Save</button>
                </div>
              </div>
            </div>

            <div style="margin-top:12px">
              <label class="small-note">Recent activity & logs</label>
              <div class="log" id="logBox"></div>
            </div>
          </div>
        </div>

        <div class="right">
          <div style="background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);padding:12px;border-radius:10px">
            <div style="font-weight:700;margin-bottom:6px">Quick Info</div>
            <div class="muted">AI Channel</div>
            <div style="font-weight:700;margin-bottom:8px">${AI_CHANNEL_ID}</div>
            <div class="muted">Dashboard access uses socket authentication (password).</div>
            <div style="margin-top:10px">
              <label class="small-note">Model override</label>
              <input id="modelInput" placeholder="gpt-4o or gpt-4o-mini" />
              <div style="display:flex;gap:8px;margin-top:8px">
                <button id="setModel">Set Model</button>
              </div>
            </div>
          </div>

          <footer>
            <div>Built for play.cyberland.pro • Premium AI</div>
            <div style="margin-top:6px">Use responsibly • Keep your OpenAI key secure</div>
          </footer>
        </div>
      </div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io('/', { autoConnect: false });
    const loginBtn = document.getElementById('loginBtn');
    const pwd = document.getElementById('pwd');
    const loginMsg = document.getElementById('loginMsg');
    const mainArea = document.getElementById('mainArea');
    const sysPrompt = document.getElementById('sysPrompt');
    const logBox = document.getElementById('logBox');
    const btnLock = document.getElementById('btnLock');
    const btnUnlock = document.getElementById('btnUnlock');
    const savePrompt = document.getElementById('savePrompt');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const modelInput = document.getElementById('modelInput');
    const modelName = document.getElementById('modelName');
    const setModel = document.getElementById('setModel');

    function appendLog(t){ logBox.innerText = '['+new Date().toLocaleTimeString()+'] ' + t + "\\n" + logBox.innerText; }

    loginBtn.onclick = () => {
      loginMsg.innerText = 'Attempting to connect…';
      socket.auth = { token: pwd.value };
      socket.connect();
      socket.once('connect_error', (err) => {
        loginMsg.innerText = 'Auth failed. Check password.';
        socket.disconnect();
      });
      socket.once('connect', () => {
        loginMsg.innerText = '';
        mainArea.style.display = 'block';
        document.getElementById('pwd').value = '';
        appendLog('Dashboard connected');
        // request state
        socket.emit('getState');
      });
    };

    socket.on('state', (s) => {
      isUpdating = s.isUpdating;
      sysPrompt.value = s.systemPrompt || '';
      modelName.innerText = s.model || 'gpt-4o';
      statusText.innerText = s.isUpdating ? 'Updating (locked)' : 'Bot Online';
      statusDot.style.background = s.isUpdating ? '#f59e0b' : '#22c55e';
      appendLog('State synced');
    });

    socket.on('log', (t) => { appendLog(t); });
    socket.on('status', (t) => { appendLog(t); });

    btnLock.onclick = () => {
      socket.emit('startUpdate');
    };
    btnUnlock.onclick = () => {
      socket.emit('finishUpdate');
    };
    savePrompt.onclick = () => {
      socket.emit('savePrompt', sysPrompt.value);
      appendLog('Saved prompt (in-memory)');
    };
    setModel.onclick = () => {
      const m = modelInput.value.trim();
      if (!m) return;
      socket.emit('setModel', m);
      modelName.innerText = m;
      appendLog('Model set to ' + m);
    }

    // helpful disconnect handling
    socket.on('disconnect', (r) => {
      appendLog('Dashboard disconnected (' + r + ')');
    });
  </script>
</body>
</html>`);
});

// ===== Socket.IO Auth & Events =====
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token === ADMIN_PASSWORD) return next();
  return next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('state', {
    isUpdating,
    systemPrompt,
    model: process.env.OPENAI_MODEL || 'gpt-4o'
  });

  socket.on('getState', () => {
    socket.emit('state', { isUpdating, systemPrompt, model: process.env.OPENAI_MODEL || 'gpt-4o' });
  });

  socket.on('savePrompt', (newPrompt) => {
    systemPrompt = String(newPrompt || '').trim() || systemPrompt;
    socket.emit('status', 'System prompt updated (in-memory).');
    io.emit('log', 'System prompt updated by admin.');
  });

  socket.on('setModel', (m) => {
    process.env.OPENAI_MODEL = String(m);
    socket.emit('status', 'Model override set: ' + process.env.OPENAI_MODEL);
    io.emit('log', 'Model changed to ' + process.env.OPENAI_MODEL);
  });

  socket.on('startUpdate', async () => {
    try {
      const ch = await client.channels.fetch(AI_CHANNEL_ID);
      if (!ch) return socket.emit('status', 'AI channel not found.');

      isUpdating = true;
      await lockChannel(ch);

      const embed = makePremiumEmbed('🔧 Bot Update Started', 'Staff initiated an update — chat is temporarily locked. We will unlock when update completes.', 0xffb347);
      await ch.send({ embeds: [embed] });

      io.emit('status', 'Update started & channel locked (no @everyone).');
      io.emit('state', { isUpdating, systemPrompt, model: process.env.OPENAI_MODEL || 'gpt-4o' });
    } catch (err) {
      console.error('startUpdate error:', err);
      socket.emit('status', 'Error starting update: ' + String(err?.message || err));
    }
  });

  socket.on('finishUpdate', async () => {
    try {
      const ch = await client.channels.fetch(AI_CHANNEL_ID);
      if (!ch) return socket.emit('status', 'AI channel not found.');

      isUpdating = false;
      await unlockChannel(ch);

      const embed = makePremiumEmbed('✅ Update Complete', 'The AI bot has been updated successfully. Chat is unlocked and ready.', 0x60a5fa);
      await ch.send({ embeds: [embed] });

      io.emit('status', 'Update finished & channel unlocked.');
      io.emit('state', { isUpdating, systemPrompt, model: process.env.OPENAI_MODEL || 'gpt-4o' });
    } catch (err) {
      console.error('finishUpdate error:', err);
      socket.emit('status', 'Error finishing update: ' + String(err?.message || err));
    }
  });

  socket.on('disconnect', (reason) => {
    // nothing required
  });
});

// ====== Start server when Discord ready ======
client.once('ready', async () => {
  console.log('Discord logged in as', client.user.tag);
  server.listen(PORT, () => console.log('Dashboard running on port', PORT));
  // ensure channel exists (log)
  try {
    const ch = await client.channels.fetch(AI_CHANNEL_ID);
    if (ch) {
      console.log('AI Channel ready:', AI_CHANNEL_ID, '->', ch.guild?.name || '(guild)');
    } else {
      console.warn('AI Channel not found:', AI_CHANNEL_ID);
    }
  } catch (err) {
    console.error('Error fetching AI channel at startup:', err?.message || err);
  }
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login error:', err);
});
