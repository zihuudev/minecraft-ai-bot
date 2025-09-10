// =================== Cyberland Ultra-Premium Bot (single file) ===================
// Features:
// - Ultra-premium animated dashboard (login: zihuu/shahin/mainuddin)
// - AI replies only in one specific channel (CHANNEL_ID)
// - Manual update (purge -> lock -> send premium embed w/ optional GIF -> finish -> unlock)
// - Auto updates twice daily: 11:20-11:25 and 15:00-15:05 Asia/Dhaka
// - Dashboard shows "Next update" times, countdown, Minecraft status, animated UI
// - Robust purge fallback and resilient OpenAI calls
// - Do NOT commit env vars to public repos
// ==================================================================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const axios = require('axios');
const https = require('https');
const cron = require('node-cron');
const moment = require('moment-timezone');
const mcu = require('minecraft-server-util');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

/////////////////////// CONFIG ///////////////////////
const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Dhaka';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CHANNEL_ID = process.env.CHANNEL_ID || ''; // REQUIRED

const UPDATE_GIF_URL = process.env.UPDATE_GIF_URL || ''; // optional thumbnail GIF for update embeds

// Minecraft
const MINECRAFT_IP = 'play.cyberland.pro';
const MINECRAFT_PORT = 19132;

/////////////////////// DISCORD CLIENT ///////////////////////
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [ Partials.Channel, Partials.Message, Partials.GuildMember ],
});

let aiEnabled = true;
let autoUpdate = true;
let autoroleId = null;
let updateTimer = null;
let updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };

const httpsAgent = new https.Agent({ keepAlive: true });
const RETRYABLE = new Set([408,409,429,500,502,503,504]);

// short-term conversation context per user
const userContexts = new Map();
const MAX_TURNS = 6;

function nowTs(){ return Date.now(); }
function fmtTS(ts){ return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A'); }

// ---------------- Robust purge (bulkDelete fallback) ----------------
async function purgeChannel(channel){
  try {
    if (!channel || !channel.isTextBased?.()) return;
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched || fetched.size === 0) break;
      try {
        // bulk delete (skips >14 days)
        await channel.bulkDelete(fetched, true);
      } catch (bulkErr) {
        // fallback: delete individually for maximum removal
        for (const [, msg] of fetched) {
          try { await msg.delete(); } catch(_) {}
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error('purgeChannel error:', e?.message || e);
  }
}

// ---------------- Lock / unlock channel ----------------
async function lockChannel(channel, lock){
  try {
    if (!channel || !channel.guild) return;
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: lock ? false : true });
  } catch (e) {
    console.error('lockChannel error:', e?.message || e);
  }
}

// ---------------- Ultra-premium embeds ----------------
function ultraEmbed(color, title, description){
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'Developed by Zihuu • Cyberland' })
    .setTimestamp();
  return e;
}

function updatingEmbed({ minutes, reason, auto }){
  const title = auto ? '⚡ Automatic Update — In Progress' : '🚀 Manual Update — In Progress';
  const e = ultraEmbed(0xF59E0B, title, 'Maintenance in progress — keeping systems stable and fast.');
  e.addFields(
    { name: 'Status', value: 'Updating…', inline: true },
    { name: 'Channel', value: 'Locked', inline: true },
    { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
    { name: 'Mode', value: auto ? 'Automatic (daily)' : 'Manual', inline: true },
    { name: 'Developer', value: 'Zihuu', inline: true },
  );
  if (reason) e.addFields({ name: 'Reason', value: reason });
  // Next auto windows field
  e.addFields({ name: 'Next Update Windows (BDT)', value: nextUpdateWindowsString() });
  if (UPDATE_GIF_URL) e.setThumbnail(UPDATE_GIF_URL);
  return e;
}

function updatedEmbed({ auto, completedAt }){
  const title = auto ? '✅ Automatic Update — Completed' : '✅ Manual Update — Completed';
  const e = ultraEmbed(0x22C55E, title, 'All systems are up-to-date. You can chat now!');
  e.addFields(
    { name: 'Status', value: 'Ready', inline: true },
    { name: 'Channel', value: 'Unlocked', inline: true },
    { name: 'Mode', value: auto ? 'Automatic (daily)' : 'Manual', inline: true },
    { name: 'Developer', value: 'Zihuu', inline: true },
  );
  if (completedAt) e.addFields({ name: 'Completed At', value: completedAt });
  if (UPDATE_GIF_URL) e.setThumbnail(UPDATE_GIF_URL);
  return e;
}

// ---------------- OpenAI helper (resilient) ----------------
async function chatOpenAI(messages, attempt = 1){
  if (!OPENAI_API_KEY) return '❌ OpenAI API key not configured.';
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, messages, temperature: 0.65, max_tokens: 900 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 70000, httpsAgent, validateStatus: ()=>true }
    );
    if (res.status >= 200 && res.status < 300) return res.data?.choices?.[0]?.message?.content?.trim() || "I'm here!";
    if (res.status === 401) return '❌ Invalid OpenAI API Key.';
    if (RETRYABLE.has(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 700 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    return '⚠️ AI temporarily unavailable. Try again later.';
  } catch (e) {
    if (['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(e?.code) && attempt < 3) {
      await new Promise(r => setTimeout(r, 700 * attempt));
      return chatOpenAI(messages, attempt + 1);
    }
    console.error('chatOpenAI error:', e?.message || e);
    return '⚠️ AI temporarily unavailable. Try again later.';
  }
}

// ---------------- Context management ----------------
function buildContext(userId, username, userMsg){
  const sys = { role:'system', content: 'You are a friendly assistant for the Cyberland Minecraft community. Provide concise, practical, and Minecraft-specific help.' };
  const out = [sys];
  const hist = userContexts.get(userId) || [];
  for (const t of hist.slice(-MAX_TURNS)) {
    out.push({ role:'user', content: `${username}: ${t.q}` });
    out.push({ role:'assistant', content: t.a });
  }
  out.push({ role:'user', content: `${username}: ${userMsg}` });
  return out;
}
function saveContext(userId, q, a){
  const arr = userContexts.get(userId) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  userContexts.set(userId, arr);
}

// ---------------- Chunked typing reply ----------------
async function typeAndReply(message, fullText){
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
      await new Promise(r => setTimeout(r, Math.min(900, Math.max(120, c.length * 5))));
    } catch (e) {
      console.error('typeAndReply send error:', e?.message || e);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// ------------ Auto update schedule helpers (two windows daily) --------------
////////////////////////////////////////////////////////////////////////////////
// Two windows in BD time: 11:20-11:25 and 15:00-15:05
function nextUpdateWindowsString(){
  const now = moment().tz(TZ);
  const today = now.clone().startOf('day');
  const w1Start = today.clone().add(11, 'hours').add(20, 'minutes'); // 11:20
  const w1End   = today.clone().add(11, 'hours').add(25, 'minutes'); // 11:25
  const w2Start = today.clone().add(15, 'hours').add(0, 'minutes');  // 15:00
  const w2End   = today.clone().add(15, 'hours').add(5, 'minutes');  // 15:05

  // If now before w1Start -> today's both windows; if between w1End and w2Start -> show w2 today; if after w2End -> show next day's windows
  if (now.isBefore(w1Start)) {
    return `${w1Start.format('h:mm A')} - ${w1End.format('h:mm A')} (BDT)  — next: ${w2Start.format('h:mm A')} - ${w2End.format('h:mm A')}`;
  } else if (now.isBefore(w2Start)) {
    return `${w2Start.format('h:mm A')} - ${w2End.format('h:mm A')} (BDT) — previous: ${w1Start.format('h:mm A')} - ${w1End.format('h:mm A')}`;
  } else {
    const tomorrow = today.clone().add(1, 'day');
    const tw1Start = tomorrow.clone().add(11, 'hours').add(20, 'minutes');
    const tw1End   = tomorrow.clone().add(11, 'hours').add(25, 'minutes');
    return `${tw1Start.format('MMM D h:mm A')} - ${tw1End.format('h:mm A')} (BDT) — and ${tomorrow.clone().add(15,'hours').format('h:mm A')} - ${tomorrow.clone().add(15,'hours').add(5,'minutes').format('h:mm A')}`;
  }
}

// ---------------- Start / finish update flow ----------------
async function startUpdateFlow({ minutes, reason, auto=false }){
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID environment variable is not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  const now = nowTs();
  updateState = { active:true, auto, reason, startedAt: now, endsAt: now + minutes * 60000, minutes };

  // Purge -> lock -> send embed (embed will stay)
  await purgeChannel(ch);
  await lockChannel(ch, true);

  // send the premium update embed with GIF thumbnail (if provided) and next update info
  await ch.send({ content: '@everyone', embeds: [ updatingEmbed({ minutes, reason, auto }) ] });

  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try { await finishUpdateFlow({ auto }); } catch (e) { console.error('auto finish error:', e); }
  }, minutes * 60000);
}

async function finishUpdateFlow({ auto=false }){
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID environment variable is not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
  if (!ch) throw new Error('Could not fetch channel. Check CHANNEL_ID and bot permissions.');

  // purge current messages to keep channel clean, then unlock and announce finished embed
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ content: '@everyone', embeds: [ updatedEmbed({ auto, completedAt }) ] });

  updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
}

////////////////////////////////////////////////////////////////////////////////
// ---------- Auto update cron (two daily windows) ---------------------------
// Schedule starts and finishes for both update windows.
// Times are in Asia/Dhaka timezone.
////////////////////////////////////////////////////////////////////////////////
// Window 1 start: 11:20
cron.schedule('20 11 * * *', async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes: 5, reason: 'Auto maintenance window 11:20-11:25 (BDT)', auto: true }); }
  catch (e) { console.error('auto-start window1 error:', e); }
}, { timezone: TZ });

// Window 1 end: 11:25
cron.schedule('25 11 * * *', async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto: true }); }
  catch (e) { console.error('auto-finish window1 error:', e); }
}, { timezone: TZ });

// Window 2 start: 15:00
cron.schedule('0 15 * * *', async () => {
  if (!autoUpdate) return;
  try { await startUpdateFlow({ minutes: 5, reason: 'Auto maintenance window 15:00-15:05 (BDT)', auto: true }); }
  catch (e) { console.error('auto-start window2 error:', e); }
}, { timezone: TZ });

// Window 2 end: 15:05
cron.schedule('5 15 * * *', async () => {
  if (!autoUpdate) return;
  try { await finishUpdateFlow({ auto: true }); }
  catch (e) { console.error('auto-finish window2 error:', e); }
}, { timezone: TZ });

////////////////////////////////////////////////////////////////////////////////
// ------------------ Web Dashboard (ultra premium animated) -----------------
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: 'cyberland-ultra-final', resave: false, saveUninitialized: true }));

// 3 fixed admin users
const USERS = new Map([
  ['zihuu','cyberlandai90x90x90'],
  ['shahin','cyberlandai90x90x90'],
  ['mainuddin','cyberlandai90x90x90'],
]);

// --- Login HTML (ultra animated particles, glass panels) ---
const loginHTML = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyberland Admin Login</title>
<style>
:root{--accent1:#7c3aed;--accent2:#06b6d4;--glass:rgba(255,255,255,0.03)}
*{box-sizing:border-box}
html,body{height:100%;margin:0;font-family:Inter,system-ui;background:radial-gradient(900px 600px at 10% 10%,#072048,#010417);color:#EAF2FF}
.canvas{position:fixed;inset:0;z-index:0}
.center{min-height:100vh;display:grid;place-items:center;position:relative;z-index:2}
.card{width:94%;max-width:920px;padding:28px;border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.02),transparent);border:1px solid rgba(255,255,255,.03);backdrop-filter:blur(12px);box-shadow:0 30px 80px rgba(0,0,0,.6);display:flex;gap:18px;align-items:center}
.left{flex:1}
.right{width:420px}
.logo{font-weight:800}
.h{font-size:22px;margin-top:8px}
.input{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;margin-top:12px;outline:none}
.btn{width:100%;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;margin-top:14px;cursor:pointer}
.small{opacity:.85;margin-top:10px}
.err{color:#ff7b7b;margin-top:8px}
.footer{margin-top:8px;font-size:12px;opacity:.75}
@media(max-width:900px){ .card{flex-direction:column} .left{display:none} }
</style></head><body>
<canvas id="bg"></canvas>
<div class="center">
  <form class="card" method="POST" action="/login">
    <div class="left">
      <div class="logo">CYBERLAND</div>
      <div class="h">Ultra Premium Dashboard</div>
      <div class="small">Authorized users: <b>zihuu</b>, <b>shahin</b>, <b>mainuddin</b></div>
    </div>
    <div class="right">
      <div style="font-weight:700">🔐 Login</div>
      <input class="input" name="username" placeholder="Username" required />
      <input class="input" name="password" type="password" placeholder="Password" required />
      <button class="btn" type="submit">Enter Dashboard</button>
      <div class="err">{{ERR}}</div>
      <div class="footer">Developed by Zihuu • Cyberland</div>
    </div>
  </form>
</div>
<script>
// simple animated gradient background
const canvas = document.getElementById('bg');
const ctx = canvas.getContext('2d');
let W = canvas.width = innerWidth, H = canvas.height = innerHeight;
window.addEventListener('resize', ()=>{ W=canvas.width=innerWidth; H=canvas.height=innerHeight; });
let t=0;
function render(){
  t += 0.005;
  const g = ctx.createLinearGradient(0,0,W,H);
  g.addColorStop(0, `rgba(124,58,237,${0.08 + 0.02*Math.sin(t*3)})`);
  g.addColorStop(0.5, `rgba(6,182,212,${0.06 + 0.02*Math.cos(t*2)})`);
  g.addColorStop(1, `rgba(2,6,23,0.92)`);
  ctx.fillStyle = g;
  ctx.fillRect(0,0,W,H);
  requestAnimationFrame(render);
}
render();
</script>
</body></html>`;

// --- Dashboard HTML: ultra premium, morphing gradient, animated controls ---
const dashHTML = (user) => `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyberland • Ultra Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--accent1:#7c3aed;--accent2:#06b6d4;--glass:rgba(255,255,255,0.03);--muted:rgba(255,255,255,0.04)}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui;background:linear-gradient(180deg,#02102a,#020617);color:#EAF2FF;min-height:100vh}
.header{display:flex;justify-content:space-between;align-items:center;padding:18px 28px;border-bottom:1px solid rgba(255,255,255,0.02)}
.brand{font-weight:800}
.controls{display:flex;gap:12px;align-items:center}
.badge{padding:8px 12px;border-radius:999px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.01));border:1px solid var(--muted)}
.container{max-width:1200px;margin:28px auto;padding:20px}
.morph{height:6px;width:100%;border-radius:999px;background:linear-gradient(90deg,#7c3aed,#06b6d4,#22c55e,#f59e0b);background-size:300% 100%;animation:morph 8s linear infinite}
@keyframes morph{0%{background-position:0%}50%{background-position:100%}100%{background-position:0%}}
.grid{display:grid;grid-template-columns:1fr 420px;gap:18px;margin-top:18px}
.card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));padding:18px;border-radius:14px;border:1px solid var(--muted);backdrop-filter:blur(10px);box-shadow:0 18px 56px rgba(2,6,23,.6);transition:transform .18s}
.card:hover{transform:translateY(-8px)}
.tabrow{display:flex;gap:8px;margin-top:12px}
.tab{padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid var(--muted);cursor:pointer}
.tab.active{background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(6,182,212,.12));transform:translateY(-3px)}
.input,textarea{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(255,255,255,.03);color:#fff;outline:none}
.btn{padding:10px 12px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;cursor:pointer}
.btn:hover{transform:translateY(-3px)}
.small{font-size:13px;opacity:.9}
.pulse{animation:pulse 1.4s infinite ease-in-out}@keyframes pulse{0%{opacity:.7}50%{opacity:1}100%{opacity:.7}}
.progressWrap{display:flex;align-items:center;gap:12px}
.progressCircle{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#7c3aed var(--p,0%), rgba(255,255,255,0.06) 0%)}
@media(max-width:980px){ .grid{grid-template-columns:1fr} .controls{display:none} }
</style></head><body>
<div class="header">
  <div class="brand">⚡ Cyberland Ultra Dashboard</div>
  <div class="controls">
    <div id="autoBadge" class="badge">Auto: …</div>
    <div id="aiBadge" class="badge">AI: …</div>
    <div id="updBadge" class="badge">Update: idle</div>
    <a href="/logout" style="color:#93c5fd">Logout</a>
  </div>
</div>

<div class="container">
  <div class="morph"></div>

  <div class="tabrow">
    <div class="tab active" data-tab="updates">Updates</div>
    <div class="tab" data-tab="server">Server</div>
    <div class="tab" data-tab="about">About</div>
  </div>

  <div class="grid">
    <div>
      <div id="tab-updates" class="card">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="flex:1">
            <label class="small">Duration (minutes)</label>
            <input id="minutes" class="input" type="number" min="1" placeholder="e.g., 5" />
          </div>
          <div style="width:360px">
            <label class="small">Reason</label>
            <textarea id="reason" class="input" rows="3" placeholder="Why update? (optional)"></textarea>
          </div>
        </div>

        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="startUpdate()">🚀 Start Update</button>
          <button class="btn" style="background:linear-gradient(135deg,#16a34a,#06b6d4)" onclick="finishUpdate()">✅ Finish</button>
          <button class="btn" style="background:linear-gradient(135deg,#f59e0b,#f97316)" onclick="toggleAuto()">🔄 Toggle Auto</button>
          <button class="btn" style="background:linear-gradient(135deg,#06b6d4,#7c3aed)" onclick="toggleAI()">🤖 Toggle AI</button>
          <button class="btn" style="background:linear-gradient(135deg,#ef4444,#7c3aed)" onclick="refreshStatus()">🔁 Refresh</button>
        </div>

        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
          <div>Countdown: <b id="countdown" class="small pulse">—</b></div>
          <div class="small">Next windows: <span id="nextWindows">—</span></div>
        </div>
      </div>

      <div id="tab-server" class="card" style="margin-top:18px;display:none">
        <h3>Minecraft Bedrock Status</h3>
        <div id="mcStatus" class="small pulse">Checking…</div>
        <hr/>
        <label class="small">Autorole ID (optional)</label>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input id="roleId" class="input" placeholder="Role ID" />
          <button class="btn" onclick="saveAutorole()">Save</button>
        </div>
      </div>

      <div id="tab-about" class="card" style="margin-top:18px;display:none">
        <h3>About</h3>
        <p class="small">Ultra-premium animated dashboard. AI replies only in the configured channel. Developed by <b>Zihuu</b>.</p>
      </div>
    </div>

    <div>
      <div class="card">
        <h3>Live</h3>
        <div class="small">Bot: <span id="botStatus">Loading...</span></div>
        <div class="small">Last update: <span id="lastUpdate">—</span></div>
        <div style="margin-top:12px"><button class="btn" onclick="startQuick5()">Quick 5m</button></div>
      </div>

      <div class="card" style="margin-top:18px">
        <h3>Details</h3>
        <pre id="details" class="small">loading…</pre>
      </div>
    </div>
  </div>

  <div style="margin-top:18px" class="small">Dashboard time: <span id="dsTime"></span></div>
</div>

<script>
const tabs=[...document.querySelectorAll('.tab')];
tabs.forEach(t=>t.onclick=()=>{ tabs.forEach(x=>x.classList.remove('active')); t.classList.add('active'); document.getElementById('tab-updates').style.display='none'; document.getElementById('tab-server').style.display='none'; document.getElementById('tab-about').style.display='none'; document.getElementById('tab-'+t.dataset.tab).style.display='block'; });

async function api(path, opts={}){ const r = await fetch(path, opts); return r.json().catch(()=>({})); }
async function badges(){ const s=await api('/api/state'); document.getElementById('autoBadge').innerText='Auto: '+(s.autoUpdate?'ON':'OFF'); document.getElementById('aiBadge').innerText='AI: '+(s.aiEnabled?'ON':'OFF'); document.getElementById('roleId').value = s.autoroleId||''; }
async function startUpdate(){ const minutes = Number(document.getElementById('minutes').value||0); const reason = document.getElementById('reason').value||''; if(!minutes||minutes<1) return alert('Enter minutes >=1'); await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})}); alert('Update started'); }
async function startQuick5(){ await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:5,reason:'Quick 5m'})}); alert('Quick 5m started'); }
async function finishUpdate(){ await fetch('/api/finish-update',{method:'POST'}); alert('Finish requested'); }
async function toggleAuto(){ const r = await fetch('/api/toggle-auto',{method:'POST'}).then(r=>r.json()); badges(); alert('Auto: '+(r.autoUpdate?'ON':'OFF')); }
async function toggleAI(){ const r = await fetch('/api/toggle-ai',{method:'POST'}).then(r=>r.json()); badges(); alert('AI: '+(r.aiEnabled?'ON':'OFF')); }
async function saveAutorole(){ const v=document.getElementById('roleId').value.trim(); await fetch('/api/autorole',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId:v})}); alert('Saved'); }
async function refreshStatus(){ badges(); pollStatus(); tick(); loadDetails(); }
async function loadDetails(){ const d=await api('/api/details'); document.getElementById('details').innerText = JSON.stringify(d,null,2).slice(0,1200); }

async function pollStatus(){ const s = await api('/api/server-status'); document.getElementById('mcStatus').innerText = s.online?('🟢 Online — Players: '+s.players+' | Ping: '+s.ping+'ms'):'🔴 Offline'; document.getElementById('botStatus').innerText = (await api('/api/bot-status')).status; document.getElementById('nextWindows').innerText = (await api('/api/next-windows')).text; }
async function tick(){ const s = await api('/api/update-state'); const cd = document.getElementById('countdown'); const ub = document.getElementById('updBadge'); if(!s.active){ cd.innerText='—'; ub.innerText='Update: idle'; document.getElementById('lastUpdate').innerText='—'; return } const left = s.endsAt - Date.now(); cd.innerText = left>0 ? (Math.floor(left/60000)+'m '+Math.floor((left%60000)/1000)+'s') : 'finishing…'; ub.innerText = 'Update: ' + (s.auto ? 'auto' : 'manual'); document.getElementById('lastUpdate').innerText = new Date(s.startedAt).toLocaleString(); }
function dsTime(){ document.getElementById('dsTime').innerText = new Date().toLocaleString(); }

badges(); pollStatus(); loadDetails(); tick(); dsTime();
setInterval(pollStatus,10000); setInterval(tick,1000); setInterval(dsTime,1000);
</script>
</body></html>`;

// ---------- Routes and Auth ----------
function requireAuth(req,res,next){
  if (req.session?.loggedIn) return next();
  return res.redirect('/login');
}

app.get('/login',(req,res)=>res.send(loginHTML.replace('{{ERR}}','')));
app.post('/login',(req,res)=>{
  const u = (req.body.username||'').toString().trim().toLowerCase();
  const p = (req.body.password||'').toString();
  if (USERS.has(u) && USERS.get(u) === p) {
    req.session.loggedIn = true; req.session.username = u; return res.redirect('/');
  }
  return res.send(loginHTML.replace('{{ERR}}','Invalid credentials.'));
});
app.get('/logout',(req,res)=>{ req.session.destroy(()=>{}); res.redirect('/login'); });
app.get('/', requireAuth, (req,res)=>res.send(dashHTML(req.session.username || 'admin')));

// Dashboard APIs
app.get('/api/state', requireAuth, (_req,res)=>res.json({ autoUpdate, aiEnabled, autoroleId }));
app.get('/api/update-state', requireAuth, (_req,res)=>res.json(updateState));
app.post('/api/toggle-auto', requireAuth, (_req,res)=>{ autoUpdate = !autoUpdate; res.json({ autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req,res)=>{ aiEnabled = !aiEnabled; res.json({ aiEnabled }); });
app.post('/api/autorole', requireAuth, (req,res)=>{ autoroleId = (req.body.roleId||'').toString().trim() || null; res.json({ success:true, autoroleId }); });

app.get('/api/bot-status', requireAuth, (_req,res)=>res.json({ status: client?.user ? `Logged in as ${client.user.tag}` : 'Disconnected' }));
app.get('/api/details', requireAuth, (_req,res)=>res.json({ updateState, aiEnabled, autoUpdate, channelId: CHANNEL_ID || null, openaiConfigured: !!OPENAI_API_KEY, discordConnected: !!client?.user }));
app.get('/api/server-status', requireAuth, async (_req,res)=>{ try { const s = await mcu.statusBedrock(MINECRAFT_IP, MINECRAFT_PORT, { timeout: 4000 }); res.json({ online:true, players: s.players.online, ping: s.roundTripLatency }); } catch { res.json({ online:false }); } });

// provide next windows string to front-end
app.get('/api/next-windows', requireAuth, (_req,res)=>{
  res.json({ text: nextUpdateWindowsString() });
});

app.post('/api/start-update', requireAuth, async (req,res)=>{
  try {
    const minutes = Math.max(1, Number(req.body.minutes || 1));
    const reason = (req.body.reason || '').toString().slice(0,1000);
    await startUpdateFlow({ minutes, reason, auto:false });
    res.json({ success:true });
  } catch (e) { console.error('api start-update error:', e?.message || e); res.json({ success:false, error: e?.message || e }); }
});

app.post('/api/finish-update', requireAuth, async (_req,res)=>{
  try { await finishUpdateFlow({ auto:false }); res.json({ success:true }); }
  catch (e) { console.error('api finish-update error:', e?.message || e); res.json({ success:false, error: e?.message || e }); }
});

////////////////////////////////////////////////////////////////////////////////
// ---------------- AI message handler (single channel) ----------------------
////////////////////////////////////////////////////////////////////////////////
let aiQueue = Promise.resolve();
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!CHANNEL_ID) return;
    if (message.channel.id !== CHANNEL_ID) return;
    if (!aiEnabled) return;

    await message.channel.sendTyping();
    aiQueue = aiQueue.then(async () => {
      const ctx = buildContext(message.author.id, message.author.username, message.content);
      const reply = await chatOpenAI(ctx);
      saveContext(message.author.id, message.content, reply);
      await typeAndReply(message, reply || "Sorry, I couldn't generate a reply right now.");
    });
    await aiQueue;
  } catch (e) {
    console.error('AI handler error:', e?.message || e);
  }
});

////////////////////////////////////////////////////////////////////////////////
// ---------------- Autorole on join (optional) -------------------------------
////////////////////////////////////////////////////////////////////////////////
client.on('guildMemberAdd', async (member) => {
  try {
    if (!autoroleId) return;
    const role = member.guild.roles.cache.get(autoroleId) || await member.guild.roles.fetch(autoroleId).catch(()=>null);
    if (role) await member.roles.add(role).catch(()=>{});
  } catch (e) { console.error('autorole error:', e?.message || e); }
});

////////////////////////////////////////////////////////////////////////////////
// ------------------ Discord login & server start ---------------------------
////////////////////////////////////////////////////////////////////////////////
client.on('ready', () => {
  console.log('✅ Discord client ready as', client.user?.tag || 'unknown');
  if (!CHANNEL_ID) console.warn('⚠️ CHANNEL_ID not set — AI and update features will not work until set.');
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err?.message || err);
  // Keep dashboard up so user can inspect env variables
});

app.listen(PORT, () => {
  console.log(`🌐 Ultra Dashboard running on port ${PORT}`);
});
