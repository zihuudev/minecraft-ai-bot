// ================================================================
// Cyberland Ultra-Premium All-in-One bot.js (Fixed Lock/Unlock)
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
  PermissionsBitField,
} = require('discord.js');

const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Dhaka';

let CHANNEL_ID = process.env.CHANNEL_ID || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const FINISH_GIF_URL =
  process.env.FINISH_GIF_URL ||
  'https://cdn.discordapp.com/attachments/1372904503791321230/1415325589258371153/standard_8.gif';
const SESSION_SECRET =
  process.env.SESSION_SECRET || 'cyberland_ultra_session_secret';

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
let updateState = {
  active: false,
  auto: false,
  reason: '',
  startedAt: 0,
  endsAt: 0,
  minutes: 0,
  messageId: null,
};

// ---------- Helpers ----------
function nowTs() {
  return Date.now();
}
function fmtTS(ts) {
  return moment(ts).tz(TZ).format('MMM D, YYYY h:mm A');
}

// ---------- Purge & Lock ----------
async function purgeChannel(channel) {
  try {
    if (!channel?.isTextBased?.()) return;
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (!fetched.size) break;
      try {
        await channel.bulkDelete(fetched, true);
      } catch {
        for (const [, msg] of fetched) {
          try {
            await msg.delete();
          } catch {}
        }
      }
    } while (fetched.size >= 2);
  } catch (e) {
    console.error('purgeChannel error:', e?.message);
  }
}

async function lockChannel(channel, lock) {
  try {
    if (!channel || !channel.guild) return;
    const role = channel.guild.roles.everyone;

    await channel.permissionOverwrites.edit(role, {
      SendMessages: lock ? false : true,
      AddReactions: lock ? false : true,
    });

    console.log(`✅ Channel ${lock ? 'locked' : 'unlocked'} successfully.`);
  } catch (e) {
    console.error(`lockChannel error: ${e?.message}`);
  }
}

// ---------- Embeds ----------
function ultraEmbed(color, title, description) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'Developed by Zihuu • Cyberland' })
    .setTimestamp();
}

function createUpdatingEmbed({ minutes, reason, auto, progress = 0 }) {
  const title = auto
    ? '⚡ Automatic Update — In Progress'
    : '🚀 Manual Update — In Progress';
  const e = ultraEmbed(
    0xf59e0b,
    title,
    `Maintenance running — optimizing systems.\n\nProgress: **${Math.floor(
      progress
    )}%**`
  );
  e.addFields(
    { name: '🎉 Status', value: 'Updating…', inline: true },
    { name: '🔓 Chat', value: 'Locked', inline: true },
    { name: '⚡ Performance', value: 'Boosting', inline: true }
  );
  if (reason) e.addFields({ name: '📝 Reason', value: reason, inline: false });
  return e;
}

function createUpdatedEmbed({ auto, completedAt }) {
  const e = ultraEmbed(
    0x22c55e,
    '✅ You can now use the bot!',
    'Update finished — everything is optimized.'
  );
  e.addFields(
    { name: '🎉 Status', value: 'Completed', inline: true },
    { name: '🔓 Chat', value: 'Unlocked', inline: true }
  );
  if (completedAt)
    e.addFields({ name: '✅ Completed At', value: completedAt });
  if (FINISH_GIF_URL) e.setImage(FINISH_GIF_URL);
  return e;
}

// ---------- Update Flow ----------
async function startUpdateFlow({ minutes, reason = '', auto = false }) {
  if (!CHANNEL_ID) throw new Error('CHANNEL_ID not set.');
  const ch = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) throw new Error('Could not fetch channel.');

  updateState = {
    active: true,
    auto,
    reason,
    startedAt: nowTs(),
    endsAt: nowTs() + minutes * 60000,
    minutes,
    messageId: null,
  };

  await purgeChannel(ch);
  await lockChannel(ch, true);

  const msg = await ch.send({
    embeds: [createUpdatingEmbed({ minutes, reason, auto, progress: 0 })],
  });
  updateState.messageId = msg.id;

  setTimeout(async () => {
    try {
      await finishUpdateFlow({ auto });
    } catch (e) {
      console.error('finish err', e);
    }
  }, minutes * 60000);
}

async function finishUpdateFlow({ auto }) {
  if (!CHANNEL_ID) return;
  const ch = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) return;

  await purgeChannel(ch);
  await lockChannel(ch, false);

  const completedAt = fmtTS(Date.now());
  await ch.send({ embeds: [createUpdatedEmbed({ auto, completedAt })] });

  updateState = {
    active: false,
    auto: false,
    reason: '',
    startedAt: 0,
    endsAt: 0,
    minutes: 0,
    messageId: null,
  };
}

// ---------- Cron Auto Updates ----------
cron.schedule(
  '20 11 * * *',
  () => autoUpdate && startUpdateFlow({ minutes: 5, auto: true }),
  { timezone: TZ }
);
cron.schedule(
  '25 11 * * *',
  () => autoUpdate && finishUpdateFlow({ auto: true }),
  { timezone: TZ }
);

// ---------- Dashboard ----------
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 86400000 },
  })
);

const USERS = new Map([
  ['zihuu', 'cyberlandai90x90x90'],
  ['shahin', 'cyberlandai90x90x90'],
  ['mainuddin', 'cyberlandai90x90x90'],
]);

// ... keep dashboard/login routes same as before ...

// ---------- Start ----------
server.listen(PORT, () =>
  console.log(`Dashboard running http://localhost:${PORT}`)
);
client.login(DISCORD_TOKEN);
