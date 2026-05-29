const axios = require('axios');
const db = require('./db');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_ID = process.env.DISCORD_AFFILIATE_ROLE_ID;
const ADMIN_ID = process.env.ADMIN_DISCORD_ID;
const NOTIF_CHANNEL = process.env.DISCORD_NOTIF_CHANNEL;

const MOTIVATION_MESSAGES = [
  "🔴 **CAS'INDUSTRIES** — T'as pensé à faire ton live aujourd'hui ? Chaque live compte. Go !",
  "🔴 **CAS'INDUSTRIES** — Rappel : ton live du jour t'attend. La régularité fait la différence. 💪",
  "🔴 **CAS'INDUSTRIES** — C'est l'heure de live ! Ceux qui livrent chaque jour progressent.",
  "🔴 **CAS'INDUSTRIES** — Un live aujourd'hui = un pas de plus vers tes objectifs. Lance-toi !",
  "🔴 **CAS'INDUSTRIES** — Rappel quotidien : le live d'aujourd'hui, c'est maintenant. 🎯",
];

function randomMotivation() {
  return MOTIVATION_MESSAGES[Math.floor(Math.random() * MOTIVATION_MESSAGES.length)];
}

async function getDMChannel(discordId) {
  try {
    const cached = db.prepare('SELECT channel_id FROM dm_channels WHERE discord_id = ?').get(discordId);
    if (cached) return cached.channel_id;
    const res = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: discordId },
      { headers: { Authorization: 'Bot ' + BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
    const channelId = res.data.id;
    db.prepare('INSERT OR REPLACE INTO dm_channels (discord_id, channel_id) VALUES (?, ?)').run(discordId, channelId);
    return channelId;
  } catch(err) {
    console.error('[BOT] getDMChannel error:', discordId, err.response?.status);
    return null;
  }
}

async function sendDM(discordId, content) {
  const channelId = await getDMChannel(discordId);
  if (!channelId) return false;
  try {
    await axios.post(
      'https://discord.com/api/v10/channels/' + channelId + '/messages',
      { content },
      { headers: { Authorization: 'Bot ' + BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch(err) {
    console.error('[BOT] sendDM error:', err.response?.status);
    return false;
  }
}

async function sendMessage(channelId, content) {
  if (!channelId || !BOT_TOKEN) return;
  try {
    await axios.post(
      'https://discord.com/api/v10/channels/' + channelId + '/messages',
      { content },
      { headers: { Authorization: 'Bot ' + BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch(err) {
    console.error('[BOT] sendMessage error:', err.message);
  }
}

async function addMemberToGuild(discordId, accessToken) {
  try {
    if (accessToken) {
      await axios.put(
        'https://discord.com/api/v10/guilds/' + GUILD_ID + '/members/' + discordId,
        { access_token: accessToken, roles: [ROLE_ID] },
        { headers: { Authorization: 'Bot ' + BOT_TOKEN, 'Content-Type': 'application/json' } }
      );
    }
    await axios.put(
      'https://discord.com/api/v10/guilds/' + GUILD_ID + '/members/' + discordId + '/roles/' + ROLE_ID,
      {},
      { headers: { Authorization: 'Bot ' + BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('[BOT] Role given to:', discordId);
    return true;
  } catch(err) {
    console.error('[BOT] addMember error:', err.response?.status, JSON.stringify(err.response?.data));
    return false;
  }
}

async function kickMember(discordId) {
  try {
    await axios.delete(
      'https://discord.com/api/v10/guilds/' + GUILD_ID + '/members/' + discordId,
      { headers: { Authorization: 'Bot ' + BOT_TOKEN } }
    );
    console.log('[BOT] Kicked:', discordId);
    return true;
  } catch(err) {
    console.error('[BOT] kick error:', err.response?.status);
    return false;
  }
}

async function sendDailyReminders() {
  const today = new Date().toISOString().split('T')[0];
  const affiliates = db.prepare('SELECT * FROM users WHERE role = ? AND status = ?').all('affiliate', 'active');
  for (const user of affiliates) {
    const log = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(user.discord_id, today);
    if (log && log.did_live) continue;
    await sendDM(user.discord_id, randomMotivation() + "\n\n> Si tu ne peux pas live aujourd'hui, réponds à ce message en expliquant pourquoi.");
    await sleep(500);
  }
}

async function sendNightSummary() {
  if (!NOTIF_CHANNEL) return;
  const today = new Date().toISOString().split('T')[0];
  const affiliates = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');
  let liveList = [], absentList = [];
  for (const user of affiliates) {
    const log = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(user.discord_id, today);
    if (log && log.did_live) {
      const h = Math.floor(log.total_minutes / 60), m = log.total_minutes % 60;
      liveList.push('✅ **' + user.discord_username + '** — ' + (h > 0 ? h + 'h' + (m > 0 ? m : '') : m + 'min'));
    } else {
      const reason = db.prepare('SELECT * FROM absence_reasons WHERE user_id = ? AND date = ?').get(user.discord_id, today);
      absentList.push(reason ? '⚠️ **' + user.discord_username + '** — ' + reason.reason : '❌ **' + user.discord_username + '** — Aucune raison');
    }
  }
  let msg = '📊 **RECAP DU JOUR — ' + today + '**\n\n';
  if (liveList.length) msg += '**Ont livé (' + liveList.length + ') :**\n' + liveList.join('\n') + '\n\n';
  if (absentList.length) msg += '**Absents (' + absentList.length + ') :**\n' + absentList.join('\n');
  await sendMessage(NOTIF_CHANNEL, msg);
}

async function checkDMReplies() {
  const today = new Date().toISOString().split('T')[0];
  const affiliates = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');
  for (const user of affiliates) {
    const channelId = await getDMChannel(user.discord_id);
    if (!channelId) continue;
    try {
      const res = await axios.get(
        'https://discord.com/api/v10/channels/' + channelId + '/messages?limit=10',
        { headers: { Authorization: 'Bot ' + BOT_TOKEN } }
      );
      for (const msg of res.data) {
        if (msg.author.id !== user.discord_id) continue;
        const msgDate = new Date(msg.timestamp).toISOString().split('T')[0];
        if (msgDate !== today) continue;

        // Check if /depot command
        const depotMatch = msg.content.match(/^\/depot\s+(\d+)/i);
        if (depotMatch) {
          const count = parseInt(depotMatch[1]);
          const existing = db.prepare('SELECT * FROM deposits WHERE user_id = ? AND date = ?').get(user.discord_id, today);
          if (!existing) {
            db.prepare('INSERT INTO deposits (user_id, discord_username, count, date) VALUES (?, ?, ?, ?)').run(user.discord_id, user.discord_username, count, today);
            console.log('[BOT] Depot enregistre:', user.discord_username, count);
            if (NOTIF_CHANNEL) {
              sendMessage(NOTIF_CHANNEL, '💰 **' + user.discord_username + '** a enregistré **' + count + ' dépôt(s)** aujourd\'hui via /depot');
            }
          } else {
            db.prepare('UPDATE deposits SET count = ? WHERE user_id = ? AND date = ?').run(count, user.discord_id, today);
          }
          break;
        }

        // Absence reason
        const existing = db.prepare('SELECT * FROM absence_reasons WHERE user_id = ? AND date = ?').get(user.discord_id, today);
        if (!existing && msg.content.length > 2) {
          db.prepare('INSERT INTO absence_reasons (user_id, discord_username, date, reason) VALUES (?, ?, ?, ?)').run(user.discord_id, user.discord_username, today, msg.content);
          if (NOTIF_CHANNEL) sendMessage(NOTIF_CHANNEL, '💬 **' + user.discord_username + '** a répondu au rappel :\n> ' + msg.content);
        }
        break;
      }
      await sleep(300);
    } catch(err) {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { addMemberToGuild, sendMessage, sendDM, sendDailyReminders, sendNightSummary, checkDMReplies, kickMember };
