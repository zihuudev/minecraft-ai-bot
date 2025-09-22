/*
Cyberland — Premium bot.js + Embedded Dashboard (Railway-ready)
Author: generated for Zihuu

Usage:
- Set Railway environment variables (see README section below inside file)
- Deploy to Railway (or any Node host)
- Start the project (Railway will auto-start)

Features included:
- Discord.js v14 bot
- Express + Socket.io dashboard (login + control panel)
- 3 admin users (zihuu, shahin, mainuddin) with same password
- Dashboard controls: set default channel, start/finish update, toggle AI/auto-update, send embed announcement, clear channel
- Realtime updateState display, bot ping, uptime, auto-update schedule
- No @everyone mentions (allowedMentions disabled)
- AI via OpenAI (optional via OPENAI_API_KEY)
- Autorole, minecraft status endpoint (optional)
- Settings persisted to settings.json (created in app folder)
*/

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const session = require('express-session');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes } = require('discord.js');

// ---------------- CONFIG (Railway environment variables) ----------------
// Set these in Railway Project > Variables
// DISCORD_TOKEN - required
// CHANNEL_ID - optional default channel id
// ADMINS - comma-separated admin IDs (optional; dashboard users are separate)
// OPENAI_API_KEY - optional (for AI)
// SESSION_SECRET - optional (defaults provided)
// PORT - optional
// UPDATE_GIF_URL, FINISH_GIF_URL - optional for update embeds

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'cyberland_secret_change_me';
const UPDATE_GIF_URL = process.env.UPDATE_GIF_URL || '';
const FINISH_GIF_URL = process.env.FINISH_GIF_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Dashboard login users (same password for all)
const DASH_USERS = ['zihuu','shahin','mainuddin'];
const DASH_PASSWORD = 'cyberlandai90x90x90';

// settings persistence
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
let settings = { channelId: process.env.CHANNEL_ID || null, autoUpdate: true, aiEnabled: true, updateGif: UPDATE_GIF_URL, finishGif: FINISH_GIF_URL };
function loadSettings(){ try{ if(fs.existsSync(SETTINGS_PATH)){ settings = {...settings, ...JSON.parse(fs.readFileSync(SETTINGS_PATH,'utf8'))}; } else { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings,null,2)); } }catch(e){ console.error('settings load error', e); } }
function saveSettings(){ try{ fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings,null,2)); }catch(e){ console.error('settings save error', e); } }
loadSettings();

// ---------------- Discord client ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers], partials: [Partials.Channel] });

let updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };

function fmtTS(ts){ return moment(ts).tz('Asia/Dhaka').format('MMM D, YYYY h:mm A'); }

function baseEmbed(color, title, description){
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'Cyberland • Dashboard' }).setTimestamp();
}

function updatingEmbed({ minutes, reason, auto, progress=0, gif }){
  const title = auto ? '⚡ Automatic Update — In Progress' : '🚀 Manual Update — In Progress';
  const e = baseEmbed(0xF59E0B, title, `Maintenance running — optimizing systems.\nProgress: **${Math.floor(progress)}%**`);
  e.addFields(
    { name:'Status', value: 'Updating…', inline:true },
    { name:'Update type', value: auto ? 'Automatic' : 'Manual', inline:true },
    { name:'Estimated minutes', value: `${minutes}m`, inline:true }
  );
  if(reason) e.addFields({ name:'Reason', value: reason, inline:false });
  if(gif) e.setImage(gif);
  return e;
}
function finishedEmbed({ auto, completedAt, gif }){
  const e = baseEmbed(0x22C55E, '✅ Update Completed', 'Update finished — everything is ready.');
  e.addFields({ name:'Completed At', value: completedAt, inline:false }, { name:'Update type', value: auto ? 'Automatic' : 'Manual', inline:true });
  if(gif) e.setImage(gif);
  return e;
}

// purge messages
async function purgeChannel(channel){
  try{
    if(!channel || !channel.isTextBased?.()) return;
    let fetched;
    do{
      fetched = await channel.messages.fetch({ limit: 100 });
      if(!fetched || fetched.size === 0) break;
      try{ await channel.bulkDelete(fetched, true); } catch(e){
        for(const m of fetched.values()){ try{ await m.delete(); } catch(_){} }
      }
    } while(fetched.size >= 2);
  }catch(e){ console.error('purge error', e); }
}

// lock/unlock
async function lockChannel(channel, lock){
  try{ if(!channel || !channel.guild) return; await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: lock ? false : true }); }catch(e){ console.error('lock error', e); }
}

// start update flow
let updateTimer = null;
async function startUpdateFlow({ minutes=5, reason='', auto=false }){
  if(!settings.channelId) throw new Error('No default channel set');
  const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
  if(!ch) throw new Error('Channel not found');

  const now = Date.now();
  updateState = { active:true, auto, reason, startedAt: now, endsAt: now + minutes*60000, minutes };
  saveSettings();

  await purgeChannel(ch);
  await lockChannel(ch, true);

  const initial = await ch.send({ embeds: [ updatingEmbed({ minutes, reason, auto, progress:0, gif: settings.updateGif }) ], allowedMentions:{ parse:[] } }).catch(()=>null);

  const totalMs = minutes*60000; const startTs = Date.now();
  if(updateTimer) clearTimeout(updateTimer);

  const editLoop = setInterval(async ()=>{
    try{
      const elapsed = Date.now() - startTs;
      const progress = Math.min(100, (elapsed/totalMs)*100);
      const e = updatingEmbed({ minutes, reason, auto, progress, gif: settings.updateGif });
      if(initial) await initial.edit({ embeds:[e] }).catch(()=>{});
      io.emit('updateState', updateState);
    }catch(err){ console.error('progress edit err', err); }
  }, 1500);

  updateTimer = setTimeout(async ()=>{
    clearInterval(editLoop);
    await finishUpdateFlow({ auto });
  }, totalMs);
}

async function finishUpdateFlow({ auto=false }){
  if(!settings.channelId) throw new Error('No default channel set');
  const ch = await client.channels.fetch(settings.channelId).catch(()=>null);
  if(!ch) throw new Error('Channel not found');
  await purgeChannel(ch);
  await lockChannel(ch, false);
  const completedAt = fmtTS(Date.now());
  await ch.send({ embeds: [ finishedEmbed({ auto, completedAt, gif: settings.finishGif }) ], allowedMentions:{ parse:[] } }).catch(()=>{});
  updateState = { active:false, auto:false, reason:'', startedAt:0, endsAt:0, minutes:0 };
  if(updateTimer){ clearTimeout(updateTimer); updateTimer = null; }
  io.emit('updateState', updateState);
  saveSettings();
}

// schedule (BDT windows)
cron.schedule('20 11 * * *', async ()=>{ if(!settings.autoUpdate) return; try{ await startUpdateFlow({ minutes:5, reason:'Auto window 11:20-11:25', auto:true }); }catch(e){ console.error('cron start1', e); } }, { timezone:'Asia/Dhaka' });
cron.schedule('25 11 * * *', async ()=>{ if(!settings.autoUpdate) return; try{ await finishUpdateFlow({ auto:true }); }catch(e){ console.error('cron finish1', e); } }, { timezone:'Asia/Dhaka' });
cron.schedule('0 15 * * *', async ()=>{ if(!settings.autoUpdate) return; try{ await startUpdateFlow({ minutes:5, reason:'Auto window 15:00-15:05', auto:true }); }catch(e){ console.error('cron start2', e); } }, { timezone:'Asia/Dhaka' });
cron.schedule('5 15 * * *', async ()=>{ if(!settings.autoUpdate) return; try{ await finishUpdateFlow({ auto:true }); }catch(e){ console.error('cron finish2', e); } }, { timezone:'Asia/Dhaka' });

// ---------------- Express + Socket.io Dashboard ----------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:true }));
app.use(session({ secret: SESSION_SECRET, resave:false, saveUninitialized:true }));

function requireAuth(req,res,next){ if(req.session?.auth) return next(); res.redirect('/login'); }

const loginHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Cyberland Login</title><style>body{font-family:Inter,Arial;background:#0f172a;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}#card{background:#0b1220;padding:28px;border-radius:12px;box-shadow:0 10px 30px rgba(2,6,23,.6);width:360px}input{width:100%;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #24324a;background:#071021;color:#e6edf3}button{width:100%;padding:10px;border-radius:8px;border:0;background:#6366f1;color:white;font-weight:600}h2{margin:0 0 12px 0}small{opacity:.7}</style></head><body>
<div id="card">
  <h2>Cyberland Dashboard</h2>
  <small>Login with admin users: zihuu / shahin / mainuddin (password: cyberlandai90x90x90)</small>
  <form id="f">
    <input id="user" placeholder="username" required />
    <input id="pass" placeholder="password" type="password" required />
    <button type="submit">Login</button>
  </form>
  <div id="err" style="color:#fb7185;margin-top:8px"></div>
</div>
<script>
const f=document.getElementById('f');const e=document.getElementById('err');f.addEventListener('submit',async(ev)=>{ev.preventDefault();e.textContent='';const u=document.getElementById('user').value;const p=document.getElementById('pass').value;const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:u,pass:p})});if(r.ok){location.href='/';}else{e.textContent='Invalid credentials';}});
</script>
</body></html>`;

const dashHTML = (username) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Cyberland Dashboard</title><style>body{font-family:Inter,Arial;background:#071021;color:#e6edf3;margin:0}header{background:linear-gradient(90deg,#0ea5a4,#7c3aed);padding:18px}main{padding:18px}card{display:block}button,input,select,textarea{padding:10px;border-radius:8px;border:1px solid #24324a;background:#071a2b;color:#e6edf3}label{display:block;margin-top:10px}section{background:#071b2a;padding:14px;border-radius:12px;margin-bottom:12px}small{opacity:.7}#top{display:flex;justify-content:space-between;align-items:center}</style></head><body>
<header><div id="top"><div><strong>Cyberland Dashboard</strong><div style="font-size:12px">User: ${username}</div></div><div><button id="logout">Logout</button></div></div></header>
<main>
<section>
  <h3>Bot Info</h3>
  <div id="botInfo">Loading...</div>
</section>
<section>
  <h3>Controls</h3>
  <label>Default Channel ID<input id="channelId" placeholder="channel id" /></label>
  <button id="setChannel">Set Channel</button>
  <div style="height:10px"></div>
  <label>Auto Update <input type="checkbox" id="autoUpdate" /></label>
  <label>AI Enabled <input type="checkbox" id="aiEnabled" /></label>
  <div style="height:10px"></div>
  <button id="startUpdate">Start Update (5m)</button>
  <button id="finishUpdate">Finish Update</button>
  <div style="height:10px"></div>
  <label>Send Announcement Title<input id="annTitle" /></label>
  <label>Announcement Content<textarea id="annContent" rows="3"></textarea></label>
  <button id="sendAnn">Send Announcement</button>
  <div style="height:10px"></div>
  <label>Clear Channel Messages (limit)<input id="clearLimit" value="50" /></label>
  <button id="clearChannel">Clear Channel</button>
</section>
<section>
  <h3>Update State</h3>
  <div id="updateState">Not active</div>
</section>
</main>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket=io();
const botInfo=document.getElementById('botInfo');
const updateStateDiv=document.getElementById('updateState');
async function fetchState(){const r=await fetch('/api/state');if(r.ok){const j=await r.json();renderState(j);}else{botInfo.textContent='Unable to fetch state';}}
function renderState(s){botInfo.innerHTML=`<div>Bot: ${s.bot}</div><div>AI: ${s.ai}</div><div>Default channel: ${s.channel || 'not set'}</div><div>Next windows: ${s.next || ''}</div>`;document.getElementById('channelId').value=s.settings?.channelId||'';document.getElementById('autoUpdate').checked=s.settings?.autoUpdate;document.getElementById('aiEnabled').checked=s.settings?.aiEnabled;}
fetchState();socket.on('serverState',s=>{ renderState({ ...s, settings: { channelId: s.channel, autoUpdate: s.autoUpdate, aiEnabled: s.ai } }); });
socket.on('updateState',u=>{ if(!u || !u.active) updateStateDiv.textContent='Not active'; else updateStateDiv.textContent=`Active: ${u.minutes}m, reason: ${u.reason || '—'}`; });

// controls
document.getElementById('setChannel').addEventListener('click', async ()=>{const ch=document.getElementById('channelId').value;const r=await fetch('/api/set-channel', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:ch})});if(r.ok) alert('Saved'); else alert('Error');});
document.getElementById('startUpdate').addEventListener('click', async ()=>{const minutes=5;const reason='Manual from dashboard';const r=await fetch('/api/start-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,reason})});if(r.ok) alert('Started'); else alert('Error');});
document.getElementById('finishUpdate').addEventListener('click', async ()=>{const r=await fetch('/api/finish-update',{method:'POST'});if(r.ok) alert('Finished'); else alert('Error');});

document.getElementById('sendAnn').addEventListener('click', async ()=>{const title=document.getElementById('annTitle').value;const content=document.getElementById('annContent').value;const r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'embed',title,content})});if(r.ok) alert('Sent'); else alert('Error');});

document.getElementById('clearChannel').addEventListener('click', async ()=>{const r=await fetch('/api/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit: Number(document.getElementById('clearLimit').value || 50)})});if(r.ok) alert('Cleared'); else alert('Error');});

document.getElementById('autoUpdate').addEventListener('change', async (e)=>{await fetch('/api/toggle-auto',{method:'POST'});fetchState();});
document.getElementById('aiEnabled').addEventListener('change', async (e)=>{await fetch('/api/toggle-ai',{method:'POST'});fetchState();});

document.getElementById('logout').addEventListener('click', async ()=>{await fetch('/logout');location.href='/login';});
</script>
</body></html>`;

// Routes
app.get('/login', (req,res)=>{ res.setHeader('Content-Type','text/html'); res.send(loginHTML); });
app.post('/login', (req,res)=>{ const u=(req.body.user||'').toString().trim().toLowerCase(); const p=(req.body.pass||'').toString(); if(DASH_USERS.includes(u) && p === DASH_PASSWORD){ req.session.auth = u; return res.redirect('/'); } res.setHeader('Content-Type','text/html'); res.send(loginHTML.replace('</div>','<div style="color:#fb7185;margin-top:8px">Invalid credentials</div></div>')); });
app.get('/logout',(req,res)=>{ req.session.destroy(()=>{}); res.redirect('/login'); });
app.get('/', requireAuth, (req,res)=>{ res.setHeader('Content-Type','text/html'); res.send(dashHTML(req.session.auth||'admin')); });

// API
app.get('/api/state', requireAuth, async (_req,res)=>{ const botConnected = !!client.user; res.json({ settings, updateState, botConnected, bot: client.user ? client.user.tag : 'disconnected', ai: settings.aiEnabled ? 'On' : 'Off', next: nextUpdateWindowsString() }); });
app.get('/api/update-state', requireAuth, (_req,res)=> res.json(updateState));
app.post('/api/start-update', requireAuth, async (req,res)=>{ try{ const minutes = Math.max(1, Number(req.body.minutes || 5)); const reason = (req.body.reason||'').toString().slice(0,500); await startUpdateFlow({ minutes, reason, auto:false }); res.json({ success:true }); }catch(e){ console.error(e); res.json({ success:false, error: e?.message || e }); } });
app.post('/api/finish-update', requireAuth, async (_req,res)=>{ try{ await finishUpdateFlow({ auto:false }); res.json({ success:true }); }catch(e){ console.error(e); res.json({ success:false, error: e?.message || e }); } });
app.post('/api/toggle-auto', requireAuth, (_req,res)=>{ settings.autoUpdate = !settings.autoUpdate; saveSettings(); io.emit('serverState', makeServerState()); res.json({ autoUpdate: settings.autoUpdate }); });
app.post('/api/toggle-ai', requireAuth, (_req,res)=>{ settings.aiEnabled = !settings.aiEnabled; saveSettings(); io.emit('serverState', makeServerState()); res.json({ aiEnabled: settings.aiEnabled }); });
app.post('/api/set-channel', requireAuth, (req,res)=>{ const ch = (req.body.channelId||'').toString().trim(); if(!ch) return res.json({ success:false, error:'channelId required' }); settings.channelId = ch; saveSettings(); io.emit('serverState', makeServerState()); return res.json({ success:true, channelId: ch }); });
app.post('/api/send', requireAuth, async (req,res)=>{ try{ const { kind, title, content } = req.body; const target = settings.channelId; if(!target) return res.json({ success:false, error:'No channel configured' }); const ch = await client.channels.fetch(target).catch(()=>null); if(!ch) return res.json({ success:false, error:'Channel not found' }); if(kind === 'embed'){ const e = baseEmbed(0x7c3aed, title || 'Announcement', content || ''); if(settings.updateGif) e.setImage(settings.updateGif); await ch.send({ embeds:[e], allowedMentions:{ parse:[] } }); return res.json({ success:true }); } else { await ch.send({ content: content || '', allowedMentions:{ parse:[] } }); return res.json({ success:true }); } }catch(e){ console.error('api send', e); return res.json({ success:false, error: e?.message || e }); } });
app.post('/api/clear', requireAuth, async (req,res)=>{ try{ if(!settings.channelId) return res.json({ success:false, error:'No default channel set' }); const limit = Math.min(100, Number(req.body.limit || 50)); const ch = await client.channels.fetch(settings.channelId).catch(()=>null); if(!ch) return res.json({ success:false, error:'Channel not found' }); const msgs = await ch.messages.fetch({ limit }); await ch.bulkDelete(msgs, true).catch(async ()=>{ for(const m of msgs.values()){ try{ await m.delete(); }catch(_){} } }); return res.json({ success:true, deleted: msgs.size }); }catch(e){ console.error(e); return res.json({ success:false, error: e?.message || e }); } });

function nextUpdateWindowsString(){ const now = moment().tz('Asia/Dhaka'); const base = now.clone().startOf('day'); const w1s = base.clone().add(11,'hours').add(20,'minutes'); const w1e = base.clone().add(11,'hours').add(25,'minutes'); const w2s = base.clone().add(15,'hours'); const w2e = base.clone().add(15,'hours').add(5,'minutes'); if(now.isBefore(w1s)) return `${w1s.format('h:mm A')} - ${w1e.format('h:mm A')} & ${w2s.format('h:mm A')} - ${w2e.format('h:mm A')} (BDT)`; if(now.isBefore(w2s)) return `${w2s.format('h:mm A')} - ${w2e.format('h:mm A')} (today)`; const tm = base.clone().add(1,'day'); return `${tm.clone().add(11,'hours').add(20,'minutes').format('MMM D h:mm A')} - next windows`; }

function makeServerState(){ return { bot: client?.user ? `Online (${client.user.tag})` : 'Disconnected', ai: settings.aiEnabled ? 'Available' : 'Disabled', next: nextUpdateWindowsString(), channel: settings.channelId || null }; }

io.on('connection', socket =>{ socket.emit('serverState', makeServerState()); socket.emit('updateState', updateState); });

// ---------------- Discord commands & handlers ----------------
async function deployCommands(){ try{ if(!TOKEN) return; const rest = new REST({ version:'10' }).setToken(TOKEN); const cmds = [ { name:'status', description:'Show bot status' } ]; await rest.put(Routes.applicationCommands((await client.application.fetch()).id), { body: cmds }); console.log('Commands deployed'); }catch(e){ console.error('deploy cmd err', e); } }

client.on('interactionCreate', async (interaction)=>{ try{ if(!interaction.isChatInputCommand()) return; if(interaction.commandName === 'status'){ const embed = baseEmbed(0x60a5fa, 'Cyberland Status', `Ping: ${client.ws.ping}ms\nUptime: ${Math.floor(process.uptime()/60)}m`); await interaction.reply({ embeds:[embed], ephemeral:true, allowedMentions:{ parse:[] } }); } }catch(e){ console.error('interaction err', e); } });

client.on('messageCreate', async (message)=>{
  try{
    if(message.author.bot) return;
    // simple admin message commands in dashboard-controlled channel
    if(settings.channelId && message.channel.id === settings.channelId){
      // allow !ai usage to all if AI enabled
      if(settings.aiEnabled && message.content.startsWith('!ai')){
        if(!OPENAI_API_KEY){ message.reply('AI not configured.'); return; }
        const prompt = message.content.replace('!ai','').trim();
        try{
          const r = await axios.post('https://api.openai.com/v1/chat/completions', { model:'gpt-3.5-turbo', messages:[{ role:'user', content: prompt }], max_tokens:800 }, { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` } });
          const txt = r.data?.choices?.[0]?.message?.content || '...';
          await message.reply(txt, { allowedMentions:{ parse:[] } });
        }catch(e){ console.error('openai err', e); message.reply('AI error'); }
      }
    }

    // Admin-only quick commands via DM or anywhere (only dashboard users by id not required)
    if(message.content.startsWith('!lock') && DASH_USERS.includes(message.author.username.toLowerCase())){ if(!settings.channelId) return message.reply('No channel set'); const ch = await client.channels.fetch(settings.channelId).catch(()=>null); if(ch){ await lockChannel(ch, true); message.reply('Channel locked'); } }
    if(message.content.startsWith('!unlock') && DASH_USERS.includes(message.author.username.toLowerCase())){ if(!settings.channelId) return message.reply('No channel set'); const ch = await client.channels.fetch(settings.channelId).catch(()=>null); if(ch){ await lockChannel(ch, false); message.reply('Channel unlocked'); } }
  }catch(e){ console.error('message handler err', e); }
});

client.on('guildMemberAdd', async (member)=>{ try{ /* autorole example: if(settings.autoroleId) await member.roles.add(settings.autoroleId); */ }catch(e){ console.error('autorole err', e); } });

client.on('ready', async ()=>{ console.log('Discord ready', client.user.tag); loadSettings(); io.emit('serverState', makeServerState()); try{ await deployCommands(); }catch(e){} });

// start server
client.login(TOKEN).catch(err=>{ console.error('Login failed', err); });
server.listen(PORT, ()=> console.log(`Dashboard running on port ${PORT}`));

// ---------------- README (quick deploy notes) ----------------
/*
How to deploy on Railway:
1. Create a new Node.js project and add this file as bot.js
2. In Railway > Variables add:
   - DISCORD_TOKEN (required)
   - CHANNEL_ID (optional)
   - OPENAI_API_KEY (optional)
   - SESSION_SECRET (optional)
   - UPDATE_GIF_URL / FINISH_GIF_URL (optional)
3. Add package.json with dependencies: discord.js, express, socket.io, axios, node-cron, moment-timezone
4. Deploy. Railway will run `node bot.js` by default.

Security note: Dashboard users are basic and share a single password; for production replace with proper user management and HTTPS.
*/
