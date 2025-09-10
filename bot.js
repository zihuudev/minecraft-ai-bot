// ================================================================
// Cyberland Ultra-Premium All-in-One bot.js
// Features:
// - Ultra premium animated dashboard (5s loader + particles)
// - 3 admin users (zihuu, shahin, mainuddin) password: cyberlandai90x90x90
// - AI chat (OpenAI) restricted to one channel (configurable via dashboard)
// - Manual update: purge -> lock -> premium GIF embed -> progress -> finish -> unlock
// - Auto updates: 11:20-11:25 & 15:00-15:05 (Asia/Dhaka)
// - Dashboard can send normal messages & premium embeds to any channel
// - Minecraft Bedrock status
// - Socket.io for real-time dashboard updates
// ================================================================

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const http = require('http');
const { Server: IOServer } = require('socket.io');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');
const mcu = require('minecraft-server-util');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Dhaka';

let CHANNEL_ID = process.env.CHANNEL_ID || ''; // can be changed from dashboard
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const FINISH_GIF_URL = process.env.FINISH_GIF_URL || 'https://cdn.discordapp.com/attachments/1372904503791321230/1415325589258371153/standard_8.gif?ex=68c2cc2b&is=68c17aab&hm=48b6bdf43ecc7caabc31c70abd47f1e2959ff0b19b36038266475f0327ef8cd0&';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cyberland_ultra_session_secret';

// Minecraft server
const MINECRAFT_IP = 'play.cyberland.pro';
const MINECRAFT_PORT = 19132;

// ---------- Discord Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ---------- Runtime state ----------
let aiEnabled = true;
let autoUpdate = true;
let autoroleId = null;
let updateTimer = null;
let updateState = { active: false, auto: false, reason: '', startedAt: 0, endsAt: 0, minutes: 0, messageId: null };

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const userContexts = new Map();
const MAX_TURNS = 10;
let prefix = '!'; // can be edited via dashboard

function nowTs() { return Date.now(); }
function fmtTS(ts) { return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A'); }

// ---------- Helpers: purge & lock ----------
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
    await channel.permissionOverwrites.edit(channel.guild.roles.members, { SendMessages: lock ? false : true });
  } catch (e) { console.error('lockChannel error:', e?.message || e); }
}

// ---------- OpenAI chat ----------
async function chatOpenAI(messages, attempt = 1) {
  if (!OPENAI_API_KEY) return '❌ OpenAI API key not configured.';
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, messages, temperature: 0.7, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 70000, validateStatus: () => true }
    );
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

// ---------- Embed helpers ----------
function ultraEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'Developed by Zihuu • Cyberland' }).setTimestamp();
}
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

function createUpdatingEmbed({ minutes, reason, auto, progress = 0 }) {
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
  if (UPDATE_GIF_URL) e.setImage(UPDATE_GIF_URL);
  return e;
}

function createUpdatedEmbed({ auto, completedAt }) {
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
  if (FINISH_GIF_URL) e.setImage(FINISH_GIF_URL);
  return e;
}

// ---------- Update flow with live progress editing ----------
async function startUpdateFlow({ minutes, reason = '', auto = false, progressIntervalMs = 2000 }) {
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and permissions.');

  const now = nowTs();
  updateState = { active: true, auto, reason, startedAt: now, endsAt: now + minutes * 60000, minutes, messageId: null };

  // purge -> lock -> send initial embed and start progress editing
  await purgeChannel(ch);
  await lockChannel(ch, true);

  const initialMsg = await ch.send({ content: '@everyone', embeds: [createUpdatingEmbed({ minutes, reason, auto, progress: 0 })] }).catch(e => { throw e; });
  updateState.messageId = initialMsg.id;

  // progress: edit message every progressIntervalMs to show incremental progress
  const totalMs = minutes * 60000;
  const startTs = Date.now();

  if (updateTimer) clearTimeout(updateTimer);

  // create a background loop that edits the embed progressively
  let progress = 0;
  const editLoop = setInterval(async () => {
    try {
      const elapsed = Date.now() - startTs;
      progress = Math.min(100, (elapsed / totalMs) * 100);
      const e = createUpdatingEmbed({ minutes, reason, auto, progress });
      await initialMsg.edit({ content: '@everyone', embeds: [e] }).catch(() => { /* ignore */ });
      // emit update to dashboard
      io.emit('updateState', updateState);
    } catch (err) {
      console.error('progress edit err', err);
    }
  }, progressIntervalMs);

  updateTimer = setTimeout(async () => {
    clearInterval(editLoop);
    try {
      await finishUpdateFlow({ auto });
    } catch (e) {
      console.error('auto finish err', e);
    }
  }, totalMs);

  io.emit('updateState', updateState);
}

async function finishUpdateFlow({ auto = false }) {
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel.');

  // purge -> unlock -> send finished embed
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ content: '@everyone', embeds: [createUpdatedEmbed({ auto, completedAt })] }).catch(() => { /* ignore */ });

  updateState = { active: false, auto: false, reason: '', startedAt: 0, endsAt: 0, minutes: 0, messageId: null };
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  io.emit('updateState', updateState);
}

// ---------- Auto update cron (BDT windows) ----------
cron.schedule('20 11 * * *', async () => { if (!autoUpdate) return; try { await startUpdateFlow({ minutes: 5, reason: 'Auto window 11:20-11:25', auto: true }); } catch (e) { console.error('auto start1 err', e); } }, { timezone: TZ });
cron.schedule('25 11 * * *', async () => { if (!autoUpdate) return; try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto finish1 err', e); } }, { timezone: TZ });

cron.schedule('0 15 * * *', async () => { if (!autoUpdate) return; try { await startUpdateFlow({ minutes: 5, reason: 'Auto window 15:00-15:05', auto: true }); } catch (e) { console.error('auto start2 err', e); } }, { timezone: TZ });
cron.schedule('5 15 * * *', async () => { if (!autoUpdate) return; try { await finishUpdateFlow({ auto: true }); } catch (e) { console.error('auto finish2 err', e); } }, { timezone: TZ });

// ---------- Express + Socket.io Dashboard ----------
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 24 * 60 * 60 * 1000 } }));

// 3 admin users
const USERS = new Map([['zihuu', 'cyberlandai90x90x90'], ['shahin', 'cyberlandai90x90x90'], ['mainuddin', 'cyberlandai90x90x90']]);

// ---------- Login page (5s loader) ----------
const loginHTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberland Admin Login</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--a1:#7c3aed;--a2:#06b6d4}
*{box-sizing:border-box}html,body{height:100%;margin:0;font-family:Inter,system-ui;background:linear-gradient(180deg,#020617,#071026);color:#EAF2FF;overflow:hidden}
.canvas{position:fixed;inset:0;z-index:0}
.center{position:relative;z-index:2;min-height:100vh;display:grid;place-items:center;padding:20px}
.card{width:94%;max-width:980px;padding:28px;border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);border:1px solid rgba(255,255,255,0.03);backdrop-filter:blur(12px);box-shadow:0 40px 120px rgba(0,0,0,.6);display:flex;gap:18px;align-items:center}
.left{flex:1}.right{width:420px}.logo{font-weight:800;font-size:20px}.h{font-size:24px;margin-top:6px}
.input{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,0.03);color:#fff;margin-top:12px;outline:none}
.btn{width:100%;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--a1),var(--a2));color:#fff;margin-top:14px;cursor:pointer;font-weight:700;box-shadow:0 18px 44px rgba(124,58,237,.12)}
.small{opacity:.85;margin-top:10px}.err{color:#ff8888;margin-top:8px}
.loaderOverlay{position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,rgba(2,6,23,0.6),rgba(2,6,23,0.8))}
.loaderBox{width:280px;height:120px;border-radius:12px;background:rgba(255,255,255,0.02);display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.03)}
.loadingDots{display:flex;gap:8px}.dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(90deg,var(--a1),var(--a2));animation:jump 1s infinite}
@keyframes jump{0%{transform:translateY(0)}50%{transform:translateY(-8px)}100%{transform:translateY(0)}}
</style></head><body>
<canvas id="bg" class="canvas"></canvas>
<div id="loader" class="loaderOverlay" style="display:none"><div class="loaderBox"><div style="font-weight:700;margin-bottom:8px">Loading Dashboard</div><div class="loadingDots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div></div>
<div class="center"><form class="card" method="POST" action="/login" onsubmit="onLogin(event)"><div class="left"><div class="logo">CYBERLAND</div><div class="h">Admin Dashboard</div><div class="small">Authorized For Cyberland Owners <b></b> <b></b> <b></b></div><div style="height:12px"></div><div class="small">Secure admin panel</div></div><div class="right"><div style="font-weight:700">🔐 Login</div><input class="input" name="username" placeholder="Username" required /><input class="input" name="password" type="password" placeholder="Password" required /><button class="btn" type="submit">Enter Dashboard</button><div class="err">{{ERR}}</div><div style="height:8px"></div><div class="small">Developed by Zihuu • Cyberland</div></div></form></div>
<script>
const canvas = document.getElementById('bg'); const ctx = canvas.getContext('2d'); let W = canvas.width = innerWidth, H = canvas.height = innerHeight; window.addEventListener('resize', ()=>{ W = canvas.width = innerWidth; H = canvas.height = innerHeight; });
const blobs = []; for (let i=0;i<30;i++) blobs.push({ x: Math.random()*W, y: Math.random()*H, r: 40+Math.random()*220, a: Math.random()*Math.PI*2, s: 0.0006 + Math.random()*0.0016 }); let mx=-9999,my=-9999; document.addEventListener('mousemove', e=>{ mx=e.clientX; my=e.clientY; });
function drawBg(){ ctx.clearRect(0,0,W,H); const g = ctx.createLinearGradient(0,0,W,H); g.addColorStop(0,'rgba(124,58,237,0.06)'); g.addColorStop(0.5,'rgba(6,182,212,0.04)'); g.addColorStop(1,'rgba(2,6,23,0.96)'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H); for (const b of blobs){ b.a += b.s; const gx = b.x + Math.cos(b.a)*60 + ((mx>-9000)? (mx-W/2)/30 : 0); const gy = b.y + Math.sin(b.a)*60 + ((my>-9000)? (my-H/2)/30 : 0); const rg = ctx.createRadialGradient(gx,gy,b.r*0.05,gx,gy,b.r); rg.addColorStop(0,'rgba(124,58,237,0.16)'); rg.addColorStop(0.5,'rgba(6,182,212,0.12)'); rg.addColorStop(1,'rgba(124,58,237,0)'); ctx.beginPath(); ctx.fillStyle = rg; ctx.arc(gx,gy,b.r,0,Math.PI*2); ctx.fill(); } requestAnimationFrame(drawBg); } drawBg();
function onLogin(e){ const loader = document.getElementById('loader'); loader.style.display = 'flex'; e.preventDefault(); setTimeout(()=> e.target.submit(), 1000); }
</script></body></html>`;

// ---------- Dashboard HTML (ultra premium, controls & send embed/message) ----------
const dashHTML = (user) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberland Ai</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--a1:#7c3aed;--a2:#06b6d4;--glass:rgba(255,255,255,0.03);--muted:rgba(255,255,255,0.04)}
*{box-sizing:border-box}html,body{height:100%;margin:0;font-family:Inter,system-ui;background:linear-gradient(180deg,#020617,#071026);color:#EAF2FF;overflow:hidden}
#particleCanvas{position:fixed;inset:0;z-index:0}.app{position:relative;z-index:2;min-height:100vh}
.header{display:flex;justify-content:space-between;align-items:center;padding:18px 28px;border-bottom:1px solid rgba(255,255,255,0.02)}.brand{font-weight:800}.controls{display:flex;gap:12px;align-items:center}.badge{padding:8px 12px;border-radius:999px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.01));border:1px solid var(--muted)}
.container{max-width:1200px;margin:28px auto;padding:20px}.morph{height:6px;width:100%;border-radius:999px;background:linear-gradient(90deg,#7c3aed,#06b6d4,#22c55e,#f59e0b);background-size:300% 100%;animation:morph 8s linear infinite}@keyframes morph{0%{background-position:0%}50%{background-position:100%}100%{background-position:0%}}
.grid{display:grid;grid-template-columns:1fr 420px;gap:18px;margin-top:18px}.card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));padding:18px;border-radius:14px;border:1px solid var(--muted);backdrop-filter:blur(10px);box-shadow:0 18px 56px rgba(2,6,23,.6);transition:transform .18s}.card:hover{transform:translateY(-8px)}.tabrow{display:flex;gap:8px;margin-top:12px}.tab{padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid var(--muted);cursor:pointer}.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(6,182,212,.12));transform:translateY(-3px)}.input,textarea{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;outline:none}.btn{padding:10px 12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--a1),var(--a2));color:#fff;cursor:pointer}.small{font-size:13px;opacity:.9}.pulse{animation:pulse 1.4s infinite ease-in-out}@keyframes pulse{0%{opacity:.7}50%{opacity:1}100%{opacity:.7}}.statGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat{padding:12px;border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,0.01),transparent);border:1px solid var(--muted);display:flex;flex-direction:column;gap:6px}
.sendBox{display:flex;gap:8px;align-items:center}
.smallMono{font-family:monospace;font-size:13px}
.loadingOverlay{position:fixed;inset:0;z-index:99;display:none;align-items:center;justify-content:center;background:linear-gradient(180deg,rgba(0,0,0,0.6),rgba(0,0,0,0.8))}
.loadingBox{width:360px;height:160px;border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent);display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.03)}
.loadingSpinner{width:64px;height:64px;border-radius:50%;background:conic-gradient(var(--a1),var(--a2));animation:spin 1.6s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:980px){ .grid{grid-template-columns:1fr} .controls{display:none} }
</style></head><body>
<canvas id="particleCanvas"></canvas>
<div id="loadingOverlay" class="loadingOverlay" style="display:none"><div class="loadingBox"><div class="loadingTitle">Loading…</div><div class="loadingSpinner"></div><div style="height:8px"></div><div class="small">Preparing widgets</div></div></div>
<div class="app"><div class="header"><div class="brand">Cyberland Ai Dashboard</div><div class="controls"><div id="autoBadge" class="badge">Auto: …</div><div id="aiBadge" class="badge">AI: …</div><div id="updBadge" class="badge">Update: idle</div><a href="/logout" style="color:#93c5fd">Logout</a></div></div>
<div class="container"><div class="morph"></div><div class="tabrow"><div class="tab active" data-tab="updates">Updates</div><div class="tab" data-tab="server">Server</div><div class="tab" data-tab="controls">Controls</div><div class="tab" data-tab="about">About</div></div>
<div class="grid">
  <div>
    <div id="tab-updates" class="card">
      <div class="statGrid"><div class="stat"><div class="small">Bot Status</div><div id="botStatus" style="font-weight:700">–</div></div><div class="stat"><div class="small">AI Status</div><div id="aiStatus" style="font-weight:700">–</div></div><div class="stat"><div class="small">Next Update</div><div id="nextWindows" style="font-weight:700">–</div></div></div>
      <div style="margin-top:12px;display:flex;gap:12px">
        <div style="flex:1"><label class="small">Duration (minutes)</label><input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5" /></div>
        <div style="width:360px"><label class="small">Reason</label><textarea id="reason" class="input" rows="3" placeholder="Optional reason for update"></textarea></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="startUpdate()">🚀 Start Update</button>
        <button class="btn" style="background:linear-gradient(135deg,#16a34a,#06b6d4)" onclick="finishUpdate()">✅ Finish</button>
        <button class="btn" style="background:linear-gradient(135deg,#f59e0b,#f97316)" onclick="toggleAuto()">🔄 Toggle Auto</button>
        <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="toggleAI()">🤖 Toggle AI</button>
        <button class="btn" style="background:linear-gradient(135deg,#ef4444,#7c3aed)" onclick="refreshAll()">🔁 Refresh</button>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center"><div>Countdown: <b id="countdown" class="small pulse">—</b></div><div class="small">Developed by <b>Zihuu</b></div></div>
    </div>

    <div id="tab-server" class="card" style="margin-top:18px;display:none">
      <h3>Minecraft Bedrock Status</h3>
      <div id="mcStatus" class="small pulse">Checking…</div><hr/>
      <label class="small">Autorole ID (optional)</label>
      <div style="display:flex;gap:8px;margin-top:8px"><input id="roleId" class="input" placeholder="Role ID" /><button class="btn" onclick="saveAutorole()">Save</button></div>
    </div>

    <div id="tab-controls" class="card" style="margin-top:18px;display:none">
      <h3>Bot Controls & Message Sender</h3>
      <div class="small">Current Channel ID: <span id="currentChannel" class="smallMono">-</span></div>
      <div style="margin-top:10px" class="sendBox">
        <input id="targetChannel" class="input" placeholder="Channel ID (leave empty to use default)" />
        <select id="messageType" class="input" style="width:220px">
          <option value="message">Normal Message</option>
          <option value="embed">Premium Embed</option>
        </select>
      </div>
      <div style="margin-top:8px"><textarea id="messageContent" class="input" rows="4" placeholder="Message text or embed description"></textarea></div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <input id="embedTitle" class="input" placeholder="Embed Title (for embed)" style="width:300px" />
        <input id="embedGif" class="input" placeholder="GIF URL (optional for embed)" style="width:300px" />
      </div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="btn" onclick="sendMessage()">📤 Send</button>
        <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="setDefaultChannel()">Set Default Channel</button>
        <button class="btn" style="background:linear-gradient(135deg,#ef4444,#f97316)" onclick="clearAllMessages()">🧹 Clear Default Channel</button>
      </div>
      <hr/>
      <div style="margin-top:8px">
        <label class="small">Prefix</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="prefixInput" class="input" placeholder="Bot prefix" style="width:150px" />
          <button class="btn" onclick="savePrefix()">Save</button>
        </div>
      </div>
    </div>

    <div id="tab-about" class="card" style="margin-top:18px;display:none"><h3>About</h3><p class="small">Ultra premium dashboard. AI replies only in configured channel. Developed by <b>Zihuu</b>.</p></div>
  </div>

  <div>
    <div class="card"><h3>Live</h3><div class="small">Bot: <span id="liveBot">Loading...</span></div><div class="small">Last update: <span id="lastUpdate">—</span></div><div style="margin-top:12px"><button class="btn" onclick="startQuick5()">Quick 5m</button></div></div>
    <div class="card" style="margin-top:18px"><h3>Details</h3><pre id="details" class="small">loading…</pre></div>
  </div>
</div>
<div style="margin-top:18px" class="small">Dashboard time: <span id="dsTime"></span></div></div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
socket.on('serverState', (s)=>{ document.getElementById('botStatus').innerText = s.bot; document.getElementById('aiStatus').innerText = s.ai; document.getElementById('nextWindows').innerText = s.next; document.getElementById('liveBot').innerText = s.bot; document.getElementById('currentChannel').innerText = s.channel || '-'; });
socket.on('updateState', (u)=>{ window.__updateState = u; });

const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach(t=>t.onclick=()=>{ tabs.forEach(x=>x.classList.remove('active')); t.classList.add('active'); document.getElementById('tab-updates').style.display='none'; document.getElementById('tab-server').style.display='none'; document.getElementById('tab-controls').style.display='none'; document.getElementById('tab-about').style.display='none'; document.getElementById('tab-'+t.dataset.tab).style.display='block'; });

async function api(path, opts={}){ const r = await fetch(path, opts); return r.json().catch(()=>({})); }
async function refreshAll(){ badges(); pollStatus(); tick(); loadDetails(); }
async function badges(){ const s = await api('/api/state'); document.getElementById('autoBadge').innerText='Auto: '+(s.autoUpdate?'ON':'OFF'); document.getElementById('aiBadge').innerText='AI: '+(s.aiEnabled?'ON':'OFF'); document.getElementById('roleId').value = s.autoroleId||''; document.getElementById('prefixInput').value = s.prefix || ''; }
async function startUpdate(){ const minutes = Number(document.getElementById('minutes').value||0); const reason = document.getElementById('reason').value||''; if(!minutes||minutes<1) return alert('Enter minutes >= 1'); await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})}); alert('Update started'); }
async function startQuick5(){ await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:5,reason:'Quick 5m'})}); alert('Quick 5m started'); }
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); alert('Finish requested'); }
async function toggleAuto(){ const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); badges(); alert('Auto: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r = await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const v=document.getElementById('roleId').value.trim(); await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId:v})}); alert('Saved'); }
async function loadDetails(){ const d = await api('/api/details'); document.getElementById('details').innerText = JSON.stringify(d,null,2).slice(0,1200); }
async function pollStatus(){ const s = await api('/api/server-status'); document.getElementById('mcStatus').innerText = s.online?('🟢 Online — Players: '+s.players+' | Ping: '+s.ping+'ms'):'🔴 Offline'; document.getElementById('nextWindows').innerText = (await api('/api/next-windows')).text; }
async function tick(){ const s = await api('/api/update-state'); const cd = document.getElementById('countdown'); const ub = document.getElementById('updBadge'); if(!s.active){ cd.innerText='—'; ub.innerText='Update: idle'; document.getElementById('lastUpdate').innerText='—'; return } const left = s.endsAt - Date.now(); cd.innerText = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…'; ub.innerText = 'Update: ' + (s.auto ? 'auto' : 'manual'); document.getElementById('lastUpdate').innerText = new Date(s.startedAt).toLocaleString(); }
function dsTime(){ document.getElementById('dsTime').innerText = new Date().toLocaleString(); }

async function sendMessage(){
  const kind = document.getElementById('messageType').value;
  const channel = document.getElementById('targetChannel').value.trim() || '';
  const content = document.getElementById('messageContent').value || '';
  const title = document.getElementById('embedTitle').value || '';
  const gif = document.getElementById('embedGif').value || '';
  const body = { channel, content, kind, title, gif };
  const res = await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r=>r.json());
  alert(JSON.stringify(res).slice(0,200));
}
async function setDefaultChannel(){ const ch = document.getElementById('targetChannel').value.trim(); if(!ch) return alert('Enter channel id'); await fetch('/api/set-channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:ch})}); alert('Default channel updated'); }
async function clearAllMessages(){ if(!confirm('Clear default channel messages?')) return; const r = await fetch('/api/clear',{method:'POST'}).then(r=>r.json()); alert(JSON.stringify(r).slice(0,200)); }
async function savePrefix(){ const p = document.getElementById('prefixInput').value.trim(); if(!p) return alert('Enter prefix'); await fetch('/api/set-prefix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix:p})}); alert('Prefix saved'); }

setTimeout(()=>{ document.getElementById('loadingOverlay').style.display='none'; }, 5000);

badges(); pollStatus(); loadDetails(); tick(); dsTime();
setInterval(pollStatus,10000); setInterval(tick,1000); setInterval(dsTime,1000);
</script></body></html>`;

// ---------- Routes & Auth ----------
function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.redirect('/login');
}
app.get('/login', (req, res) => res.send(loginHTML.replace('{{ERR}}', '')));
app.post('/login', (req, res) => {
  const u = (req.body.username || '').toString().trim().toLowerCase();
  const p = (req.body.password || '').toString();
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true; req.session.username = u; return res.redirect('/');
  }
  return res.send(loginHTML.replace('{{ERR}}', 'Invalid credentials.'));
});
app.get('/logout', (req, res) => { req.session.destroy(() => { }); res.redirect('/login'); });
app.get('/', requireAuth, (req, res) => res.send(dashHTML(req.session.username || 'admin')));

// ---------- Dashboard APIs ----------
app.get('/api/state', requireAuth, (_req, res) => res.json({ autoUpdate, aiEnabled, autoroleId, prefix, channelId: CHANNEL_ID }));
app.get('/api/update-state', requireAuth, (_req, res) => res.json(updateState));
app.post('/api/toggle-auto', requireAuth, (_req, res) => { autoUpdate = !autoUpdate; io.emit('serverState', makeServerState()); res.json({ autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req, res) => { aiEnabled = !aiEnabled; io.emit('serverState', makeServerState()); res.json({ aiEnabled }); });
app.post('/api/autorole', requireAuth, (req, res) => { autoroleId = (req.body.roleId || '').toString().trim() || null; res.json({ success: true, autoroleId }); });

app.get('/api/bot-status', requireAuth, (_req, res) => res.json({ status: client?.user ? `Logged in as ${client.user.tag}` : 'Disconnected' }));
app.get('/api/details', requireAuth, (_req, res) => res.json({ updateState, aiEnabled, autoUpdate, channelId: CHANNEL_ID || null, openaiConfigured: !!OPENAI_API_KEY, discordConnected: !!client?.user }));
app.get('/api/server-status', requireAuth, async (_req, res) => {
  try {
    const s = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 });
    res.json({ online: true, players: s.players.online, ping: s.roundTripLatency });
  } catch (e) { res.json({ online: false }); }
});
app.get('/api/next-windows', requireAuth, (_req, res) => res.json({ text: nextUpdateWindowsString() }));

// Start/finish update endpoints
app.post('/api/start-update', requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || '').toString().slice(0, 1000);
    await startUpdateFlow({ minutes, reason, auto: false });
    io.emit('updateState', updateState);
    res.json({ success: true });
  } catch (e) { console.error('api start-update error:', e?.message || e); res.json({ success: false, error: e?.message || e }); }
});
app.post('/api/finish-update', requireAuth, async (_req, res) => {
  try { await finishUpdateFlow({ auto: false }); io.emit('updateState', updateState); res.json({ success: true }); }
  catch (e) { console.error('api finish-update error:', e?.message || e); res.json({ success: false, error: e?.message || e }); }
});

// Send message or premium embed from dashboard
app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { channel, content, kind, title, gif } = req.body;
    const target = channel?.trim() || CHANNEL_ID;
    if (!target) return res.json({ success: false, error: 'No channel configured' });
    const ch = await client.channels.fetch(target).catch(() => null);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    if (kind === 'embed') {
      const e = ultraEmbed(0x7c3aed, title || 'Announcement', content || '');
      if (gif) e.setImage(gif);
      await ch.send({ content: '@everyone', embeds: [e] });
      return res.json({ success: true });
    } else {
      await ch.send({ content: content || '' });
      return res.json({ success: true });
    }
  } catch (e) { console.error('api send err', e); res.json({ success: false, error: e?.message || e }); }
});

// set default channel
app.post('/api/set-channel', requireAuth, (req, res) => {
  const c = (req.body.channelId || '').toString().trim();
  if (!c) return res.json({ success: false, error: 'channelId required' });
  CHANNEL_ID = c;
  io.emit('serverState', makeServerState());
  res.json({ success: true, channelId: CHANNEL_ID });
});

// clear default channel messages
app.post('/api/clear', requireAuth, async (req, res) => {
  try {
    if (!CHANNEL_ID) return res.json({ success: false, error: 'No default channel' });
    const ch = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    await purgeChannel(ch);
    res.json({ success: true });
  } catch (e) { console.error('api clear err', e); res.json({ success: false, error: e?.message || e }); }
});

// set prefix
app.post('/api/set-prefix', requireAuth, (req, res) => {
  const p = (req.body.prefix || '').toString().trim();
  if (!p) return res.json({ success: false, error: 'prefix required' });
  prefix = p;
  res.json({ success: true, prefix });
});

// ---------- Socket.io ---------- 
function makeServerState() {
  return {
    bot: client?.user ? `Online (${client.user.tag})` : 'Disconnected',
    ai: aiEnabled ? 'Available' : 'Disabled',
    next: nextUpdateWindowsString(),
    channel: CHANNEL_ID || null,
  };
}
io.on('connection', (socket) => {
  socket.emit('serverState', makeServerState());
  socket.emit('updateState', updateState);
});

// ---------- AI message handler (single channel) ----------
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!CHANNEL_ID) return;
    if (message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    // basic commands for admins inside dashboard / chat (optional)
    if (message.content.startsWith(prefix)) {
      const args = message.content.slice(prefix.length).trim().split(/\s+/);
      const cmd = args.shift().toLowerCase();
      if (cmd === 'status') {
        await message.reply(`Bot: ${client.user.tag}\nAI: ${aiEnabled ? 'Enabled' : 'Disabled'}\nPrefix: ${prefix}`);
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
    console.error('AI handler error:', e?.message || e);
  }
});

// ---------- Autorole ----------
client.on('guildMemberAdd', async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(() => null);
    if (role) await member.roles.add(role).catch(() => { });
  } catch (e) { console.error('autorole error:', e?.message || e); }
});

// ---------- Start ---------- 
client.on('ready', () => {
  console.log('✅ Discord ready as', client.user?.tag || 'unknown');
  io.emit('serverState', makeServerState());
  if (!CHANNEL_ID) console.warn('⚠️ CHANNEL_ID not set — AI & update features disabled until configured.');
});
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err?.message || err);
});

// start web server
server.listen(PORT, () => console.log(`🌐 Ultra Dashboard running on port ${PORT}`));

