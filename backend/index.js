require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const db = require('./db');
const { scrapeAll } = require('./scraper');
const { addMemberToGuild, sendMessage, sendDM, sendDailyReminders, sendNightSummary, checkDMReplies, kickMember } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cas-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  if (req.session.user.discord_id !== process.env.ADMIN_DISCORD_ID) return res.status(403).json({ error: 'Accès refusé' });
  next();
}

// Calcule le score d'une candidature
function calcScore(data) {
  let score = 0;
  const s = {
    tiktok_followers: { '1000+': 3, 'moins_1000': 1, 'non': 0 },
    has_live_access: { 'oui': 3, 'non': 0 },
    live_frequency: { 'tous_jours': 4, '5-6j': 3, '3-4j': 1, 'moins': 0 },
    live_duration: { '2h+': 3, '1-2h': 2, '30-60min': 1, '<30min': 0 },
    money_goal: { '5k+': 3, '2-5k': 3, '1-2k': 2, '<1k': 1 },
    voice_type: { 'grave': 3, 'dynamique': 3, 'douce': 2, 'juvenile': 0 },
    seriousness: { 'toujours': 3, 'souvent': 2, 'depond': 1, 'non': 0 },
    multi_accounts: { 'oui': 2, 'non': 1 },
  };
  for (const [key, vals] of Object.entries(s)) {
    if (data[key] && vals[data[key]] !== undefined) score += vals[data[key]];
  }
  const max = 24;
  const lead = score >= 17 ? 'hot' : score >= 10 ? 'mid' : 'cold';
  return { score, lead };
}

// ── DISCORD OAUTH ────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    const { id, username, avatar } = userRes.data;
    db.prepare(`INSERT INTO users (id, discord_id, discord_username, discord_avatar, access_token) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET discord_username=excluded.discord_username, discord_avatar=excluded.discord_avatar, access_token=excluded.access_token`)
      .run(id, id, username, avatar, access_token);
    req.session.user = { discord_id: id, discord_username: username, discord_avatar: avatar, access_token };
    req.session.save(() => {
      const isAdmin = id === process.env.ADMIN_DISCORD_ID;
      const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id);
      const isAffiliate = userRow && userRow.role === 'affiliate';
      res.redirect('/?logged=1&admin=' + isAdmin + '&affiliate=' + isAffiliate);
    });
  } catch(err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/auth/me', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(user.discord_id);
    const accounts = db.prepare('SELECT * FROM tiktok_accounts WHERE user_id = ?').all(user.discord_id);
    const games = db.prepare('SELECT * FROM affiliate_games WHERE user_id = ?').all(user.discord_id);
    const application = db.prepare('SELECT * FROM applications WHERE discord_id = ? ORDER BY submitted_at DESC LIMIT 1').get(user.discord_id);

    // Stats perso affilié
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekLogs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date >= ?').all(user.discord_id, weekAgo);
    const weekMinutes = weekLogs.reduce((s, l) => s + l.total_minutes, 0);
    const streak = calcStreak(user.discord_id);

    res.json({
      discord_id: user.discord_id,
      discord_username: user.discord_username,
      discord_avatar: user.discord_avatar,
      is_admin: user.discord_id === process.env.ADMIN_DISCORD_ID,
      is_affiliate: userRow && userRow.role === 'affiliate',
      affiliate_status: userRow ? userRow.status : null,
      has_pending: application && application.status === 'pending',
      has_rejected: application && application.status === 'rejected',
      tiktok_accounts: accounts,
      games,
      week_minutes: weekMinutes,
      streak,
    });
  } catch(err) {
    console.error('me error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vérifie si membre du serveur
app.get('/check/guild', requireAuth, async (req, res) => {
  try {
    await axios.get('https://discord.com/api/v10/guilds/' + process.env.DISCORD_GUILD_ID + '/members/' + req.session.user.discord_id,
      { headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN } });
    res.json({ is_member: true });
  } catch(e) { res.json({ is_member: false }); }
});

function calcStreak(userId) {
  const logs = db.prepare('SELECT date, did_live FROM daily_logs WHERE user_id = ? ORDER BY date DESC').all(userId);
  let streak = 0;
  let d = new Date();
  for (const log of logs) {
    const logDate = log.date;
    const expected = d.toISOString().split('T')[0];
    if (logDate === expected && log.did_live) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

// ── CANDIDATURE ──────────────────────────────────────────────
app.post('/apply', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const { prenom, nom, phone, email, tiktok_account, tiktok_followers,
      has_live_access, live_frequency, live_duration, multi_accounts,
      voice_type, money_goal, seriousness, free_text } = req.body;

    if (!prenom || !nom || !phone || !email) return res.status(400).json({ error: 'Champs obligatoires manquants' });

    const existing = db.prepare('SELECT * FROM applications WHERE discord_id = ? AND status = ?').get(user.discord_id, 'pending');
    if (existing) return res.status(409).json({ error: 'Candidature déjà en attente' });

    const { score, lead } = calcScore(req.body);

    db.prepare(`INSERT INTO applications (discord_id, discord_username, discord_avatar,
      prenom, nom, phone, email, tiktok_account, tiktok_followers, has_live_access,
      live_frequency, live_duration, multi_accounts, voice_type, money_goal, seriousness, free_text, score, lead)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.discord_id, user.discord_username, user.discord_avatar,
        prenom, nom, phone, email, tiktok_account || '', tiktok_followers || '',
        has_live_access || '', live_frequency || '', live_duration || '',
        multi_accounts || '', voice_type || '', money_goal || '', seriousness || '', free_text || '', score, lead);

    if (process.env.DISCORD_NOTIF_CHANNEL) {
      const leadEmoji = lead === 'hot' ? '🔥' : lead === 'mid' ? '🟡' : '🧊';
      sendMessage(process.env.DISCORD_NOTIF_CHANNEL,
        '🔴 **Nouvelle candidature** de **' + user.discord_username + '** — Lead: ' + leadEmoji + ' ' + lead.toUpperCase() + ' (score: ' + score + '/24)\nA traiter sur le dashboard admin.');
    }
    res.json({ ok: true });
  } catch(err) {
    console.error('apply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN CANDIDATURES ───────────────────────────────────────
app.get('/admin/applications', requireAdmin, (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM applications ORDER BY submitted_at DESC').all());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/applications/:id/accept', requireAdmin, async (req, res) => {
  try {
    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!appRow) return res.status(404).json({ error: 'Introuvable' });
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('accepted', req.params.id);
    db.prepare('UPDATE users SET role = ? WHERE discord_id = ?').run('affiliate', appRow.discord_id);
    const userRow = db.prepare('SELECT access_token FROM users WHERE discord_id = ?').get(appRow.discord_id);
    await addMemberToGuild(appRow.discord_id, userRow ? userRow.access_token : null);
    await sendDM(appRow.discord_id, '✅ **Félicitations ' + appRow.discord_username + ' !** Ta candidature CAS\'INDUSTRIES a été acceptée. Bienvenue dans l\'équipe ! Connecte-toi sur le dashboard pour ajouter tes comptes TikTok et tes jeux. 🎯');
    if (process.env.DISCORD_NOTIF_CHANNEL) sendMessage(process.env.DISCORD_NOTIF_CHANNEL, '✅ **' + appRow.discord_username + '** a été accepté(e) comme affilié(e) !');
    res.json({ ok: true });
  } catch(err) { console.error('accept error:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/admin/applications/:id/reject', requireAdmin, async (req, res) => {
  try {
    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('rejected', req.params.id);
    if (appRow) await sendDM(appRow.discord_id, '❌ Ta candidature CAS\'INDUSTRIES n\'a pas été retenue pour le moment. Tu pourras repostuler dans 30 jours. Bonne continuation !');
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN DASHBOARD ──────────────────────────────────────────
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  try {
    const users = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const result = users.map(user => {
      const accounts = db.prepare('SELECT * FROM tiktok_accounts WHERE user_id = ?').all(user.discord_id);
      const games = db.prepare('SELECT * FROM affiliate_games WHERE user_id = ?').all(user.discord_id);
      const weekLogs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date >= ?').all(user.discord_id, weekAgo);
      const streak = calcStreak(user.discord_id);
      const absence = db.prepare('SELECT * FROM absence_reasons WHERE user_id = ? AND date = ?').get(user.discord_id, today);

      const accountsWithStatus = accounts.map(acc => {
        const status = db.prepare('SELECT * FROM live_status WHERE tiktok_handle = ?').get(acc.tiktok_handle);
        return {
          handle: acc.tiktok_handle,
          is_live: status ? status.is_live === 1 : false,
          today_minutes: (status && status.last_reset_date === today) ? status.today_minutes : 0,
        };
      });

      const todayLog = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(user.discord_id, today);
      const weekDaysLived = weekLogs.filter(l => l.did_live).length;
      const weekMinutes = weekLogs.reduce((s, l) => s + l.total_minutes, 0);

      return {
        discord_id: user.discord_id,
        discord_username: user.discord_username,
        discord_avatar: user.discord_avatar,
        affiliate_status: user.status,
        admin_note: user.admin_note || '',
        accounts: accountsWithStatus,
        games,
        is_live: accountsWithStatus.some(a => a.is_live),
        today_minutes: todayLog ? todayLog.total_minutes : 0,
        week_days_lived: weekDaysLived,
        week_minutes: weekMinutes,
        streak,
        absence_reason: absence ? absence.reason : null,
      };
    });

    res.json(result);
  } catch(err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN — NOTES ET STATUTS ─────────────────────────────────
app.patch('/admin/affiliates/:id', requireAdmin, (req, res) => {
  try {
    const { admin_note, status } = req.body;
    if (admin_note !== undefined) db.prepare('UPDATE users SET admin_note = ? WHERE discord_id = ?').run(admin_note, req.params.id);
    if (status !== undefined) db.prepare('UPDATE users SET status = ? WHERE discord_id = ?').run(status, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN — MESSAGE DIRECT ────────────────────────────────────
app.post('/admin/message/:discordId', requireAdmin, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Message vide' });
    const sent = await sendDM(req.params.discordId, '📩 **Message de CAS\'INDUSTRIES :**\n' + content);
    res.json({ ok: sent });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN — RAISONS D'ABSENCE ────────────────────────────────
app.get('/admin/absences', requireAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const absences = db.prepare('SELECT * FROM absence_reasons WHERE date = ? ORDER BY created_at DESC').all(today);
    res.json(absences);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── ADMIN — KICK AFFILIÉ ─────────────────────────────────────
app.post('/admin/affiliates/:id/kick', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.id;
    const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
    if (!userRow) return res.status(404).json({ error: 'Utilisateur introuvable' });

    // Passe en candidate + supprime ses données
    db.prepare('UPDATE users SET role = ?, status = ? WHERE discord_id = ?').run('candidate', 'active', discordId);
    db.prepare('DELETE FROM tiktok_accounts WHERE user_id = ?').run(discordId);
    db.prepare('DELETE FROM affiliate_games WHERE user_id = ?').run(discordId);
    db.prepare('DELETE FROM live_status WHERE user_id = ?').run(discordId);

    // DM avant kick
    await sendDM(discordId, "❌ Tu as été retiré(e) du programme CAS'INDUSTRIES. Tes accès ont été révoqués.");

    // Kick du serveur Discord
    const kicked = await kickMember(discordId);

    if (process.env.DISCORD_NOTIF_CHANNEL) {
      sendMessage(process.env.DISCORD_NOTIF_CHANNEL,
        '🚫 **' + userRow.discord_username + '** a été retiré(e) du programme et kické(e) du serveur.'
      );
    }

    res.json({ ok: true, kicked });
  } catch(err) {
    console.error('kick error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── COMPTES TIKTOK ───────────────────────────────────────────
app.post('/accounts', requireAuth, (req, res) => {
  try {
    const clean = '@' + (req.body.tiktok_handle || '').trim().replace('@', '');
    db.prepare('INSERT INTO tiktok_accounts (user_id, tiktok_handle) VALUES (?, ?)').run(req.session.user.discord_id, clean);
    res.json({ ok: true, handle: clean });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Déjà ajouté' });
    res.status(500).json({ error: e.message });
  }
});
app.delete('/accounts/:handle', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM tiktok_accounts WHERE user_id = ? AND tiktok_handle = ?').run(req.session.user.discord_id, req.params.handle);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── JEUX ────────────────────────────────────────────────────
app.get('/games', requireAuth, (req, res) => {
  try { res.json(db.prepare('SELECT * FROM affiliate_games WHERE user_id = ?').all(req.session.user.discord_id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/games', requireAuth, (req, res) => {
  try {
    const { game_name, platform } = req.body;
    if (!game_name) return res.status(400).json({ error: 'Nom requis' });
    db.prepare('INSERT INTO affiliate_games (user_id, game_name, platform) VALUES (?, ?, ?)').run(req.session.user.discord_id, game_name, platform || '');
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Déjà ajouté' });
    res.status(500).json({ error: e.message });
  }
});
app.delete('/games/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM affiliate_games WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.discord_id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/scrape', requireAdmin, (req, res) => { scrapeAll().catch(console.error); res.json({ ok: true }); });


// ── ADMIN — LEADERBOARD ──────────────────────────────────────
app.get('/admin/leaderboard', requireAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const affiliates = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');

    const board = affiliates.map(u => {
      const weekLogs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date >= ?').all(u.discord_id, weekAgo);
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const monthLogs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date >= ?').all(u.discord_id, monthAgo);
      const streak = calcStreak(u.discord_id);
      const todayLog = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(u.discord_id, today);

      return {
        discord_id: u.discord_id,
        discord_username: u.discord_username,
        discord_avatar: u.discord_avatar,
        streak,
        week_minutes: weekLogs.reduce((s, l) => s + l.total_minutes, 0),
        week_days: weekLogs.filter(l => l.did_live).length,
        month_minutes: monthLogs.reduce((s, l) => s + l.total_minutes, 0),
        today_minutes: todayLog ? todayLog.total_minutes : 0,
        today_done: todayLog ? todayLog.did_live === 1 : false,
      };
    }).sort((a, b) => b.week_minutes - a.week_minutes);

    res.json(board);
  } catch(err) {
    console.error('leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN — CALENDRIER D'UN AFFILIÉ ─────────────────────────
app.get('/admin/calendar/:id', requireAdmin, (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? ORDER BY date DESC LIMIT 30').all(req.params.id);
    res.json(logs);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN — STATS GLOBALES ────────────────────────────────────
app.get('/admin/stats', requireAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const logs = db.prepare('SELECT SUM(total_minutes) as total, COUNT(*) as count, SUM(did_live) as lived FROM daily_logs WHERE date = ?').get(d);
      days.push({
        date: d,
        total_minutes: logs.total || 0,
        affiliates_count: logs.count || 0,
        affiliates_lived: logs.lived || 0,
      });
    }
    const totalAffiliates = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('affiliate').c;
    const totalApplications = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
    const pendingApplications = db.prepare('SELECT COUNT(*) as c FROM applications WHERE status = ?').get('pending').c;
    const todayLive = db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM live_status WHERE is_live = 1').get().c;

    res.json({ days, totalAffiliates, totalApplications, pendingApplications, todayLive });
  } catch(err) {
    console.error('stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── DEPOTS ────────────────────────────────────────────────────
app.get('/admin/deposits', requireAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const todayDeposits = db.prepare('SELECT * FROM deposits WHERE date = ? ORDER BY created_at DESC').all(today);
    const allDeposits = db.prepare('SELECT user_id, discord_username, SUM(count) as total, COUNT(*) as days, MAX(date) as last_date FROM deposits GROUP BY user_id ORDER BY total DESC').all();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekDeposits = db.prepare('SELECT user_id, discord_username, SUM(count) as total FROM deposits WHERE date >= ? GROUP BY user_id ORDER BY total DESC').all(weekAgo);
    res.json({ today: todayDeposits, all: allDeposits, week: weekDeposits });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Endpoint SSE pour temps réel
app.get('/admin/live-feed', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const users = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');
      const result = users.map(user => {
        const accounts = db.prepare('SELECT * FROM tiktok_accounts WHERE user_id = ?').all(user.discord_id);
        const accountsWithStatus = accounts.map(acc => {
          const status = db.prepare('SELECT * FROM live_status WHERE tiktok_handle = ?').get(acc.tiktok_handle);
          return {
            handle: acc.tiktok_handle,
            is_live: status ? status.is_live === 1 : false,
            today_minutes: (status && status.last_reset_date === today) ? status.today_minutes : 0,
          };
        });
        const todayDeposit = db.prepare('SELECT * FROM deposits WHERE user_id = ? AND date = ?').get(user.discord_id, today);
        return {
          discord_id: user.discord_id,
          discord_username: user.discord_username,
          is_live: accountsWithStatus.some(a => a.is_live),
          today_minutes: accountsWithStatus.reduce((s, a) => s + a.today_minutes, 0),
          today_deposits: todayDeposit ? todayDeposit.count : 0,
        };
      });
      res.write('data: ' + JSON.stringify(result) + '\n\n');
    } catch(e) {}
  };

  send();
  const interval = setInterval(send, 10000); // toutes les 10s
  req.on('close', () => clearInterval(interval));
});

// Leaderboard public (accessible aux affilies aussi)
app.get('/leaderboard', requireAuth, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const affiliates = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');
    const board = affiliates.map(u => {
      const weekLogs = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date >= ?').all(u.discord_id, weekAgo);
      const streak = calcStreak(u.discord_id);
      const todayLog = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(u.discord_id, today);
      const weekDeposit = db.prepare('SELECT SUM(count) as total FROM deposits WHERE user_id = ? AND date >= ?').get(u.discord_id, weekAgo);
      return {
        discord_id: u.discord_id,
        discord_username: u.discord_username,
        discord_avatar: u.discord_avatar,
        streak,
        week_minutes: weekLogs.reduce((s, l) => s + l.total_minutes, 0),
        week_days: weekLogs.filter(l => l.did_live).length,
        today_done: todayLog ? todayLog.did_live === 1 : false,
        today_deposits: 0,
        week_deposits: weekDeposit ? weekDeposit.total || 0 : 0,
      };
    }).sort((a, b) => b.week_minutes - a.week_minutes);
    res.json(board);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── FORMATIONS ────────────────────────────────────────────────

// Tous les modules + chapitres (pour les affiliés)
app.get('/formations', requireAuth, (req, res) => {
  try {
    const modules = db.prepare('SELECT * FROM formation_modules ORDER BY position ASC').all();
    const result = modules.map(m => {
      const chapters = db.prepare('SELECT * FROM formation_chapters WHERE module_id = ? ORDER BY position ASC').all(m.id);
      const progress = db.prepare('SELECT chapter_id FROM formation_progress WHERE user_id = ?').all(req.session.user.discord_id);
      const completedIds = new Set(progress.map(p => p.chapter_id));
      const chaptersWithProgress = chapters.map(ch => ({
        ...ch,
        completed: completedIds.has(ch.id)
      }));
      const totalChapters = chapters.length;
      const completedCount = chaptersWithProgress.filter(ch => ch.completed).length;
      return {
        ...m,
        chapters: chaptersWithProgress,
        total_chapters: totalChapters,
        completed_chapters: completedCount,
        progress_pct: totalChapters > 0 ? Math.round((completedCount / totalChapters) * 100) : 0
      };
    });
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Marquer un chapitre comme complété
app.post('/formations/progress/:chapterId', requireAuth, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO formation_progress (user_id, chapter_id) VALUES (?, ?)').run(req.session.user.discord_id, req.params.chapterId);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Démarquer un chapitre
app.delete('/formations/progress/:chapterId', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM formation_progress WHERE user_id = ? AND chapter_id = ?').run(req.session.user.discord_id, req.params.chapterId);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Créer un module
app.post('/admin/formations/modules', requireAdmin, (req, res) => {
  try {
    const { title, description, cover_url, position } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    const maxPos = db.prepare('SELECT MAX(position) as m FROM formation_modules').get();
    const pos = position !== undefined ? position : (maxPos.m || 0) + 1;
    const result = db.prepare('INSERT INTO formation_modules (title, description, cover_url, position) VALUES (?, ?, ?, ?)').run(title, description || '', cover_url || '', pos);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Modifier un module
app.patch('/admin/formations/modules/:id', requireAdmin, (req, res) => {
  try {
    const { title, description, cover_url, position } = req.body;
    if (title !== undefined) db.prepare('UPDATE formation_modules SET title = ? WHERE id = ?').run(title, req.params.id);
    if (description !== undefined) db.prepare('UPDATE formation_modules SET description = ? WHERE id = ?').run(description, req.params.id);
    if (cover_url !== undefined) db.prepare('UPDATE formation_modules SET cover_url = ? WHERE id = ?').run(cover_url, req.params.id);
    if (position !== undefined) db.prepare('UPDATE formation_modules SET position = ? WHERE id = ?').run(position, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Supprimer un module
app.delete('/admin/formations/modules/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM formation_chapters WHERE module_id = ?').run(req.params.id);
    db.prepare('DELETE FROM formation_modules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Créer un chapitre
app.post('/admin/formations/modules/:moduleId/chapters', requireAdmin, (req, res) => {
  try {
    const { title, description, video_url, video_type, duration_minutes } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    const maxPos = db.prepare('SELECT MAX(position) as m FROM formation_chapters WHERE module_id = ?').get(req.params.moduleId);
    const pos = (maxPos.m || 0) + 1;
    const vtype = video_type || (video_url && video_url.includes('vimeo') ? 'vimeo' : 'youtube');
    const result = db.prepare('INSERT INTO formation_chapters (module_id, title, description, video_url, video_type, duration_minutes, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.params.moduleId, title, description || '', video_url || '', vtype, duration_minutes || 0, pos);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Modifier un chapitre
app.patch('/admin/formations/chapters/:id', requireAdmin, (req, res) => {
  try {
    const { title, description, video_url, video_type, duration_minutes } = req.body;
    if (title !== undefined) db.prepare('UPDATE formation_chapters SET title = ? WHERE id = ?').run(title, req.params.id);
    if (description !== undefined) db.prepare('UPDATE formation_chapters SET description = ? WHERE id = ?').run(description, req.params.id);
    if (video_url !== undefined) db.prepare('UPDATE formation_chapters SET video_url = ? WHERE id = ?').run(video_url, req.params.id);
    if (video_type !== undefined) db.prepare('UPDATE formation_chapters SET video_type = ? WHERE id = ?').run(video_type, req.params.id);
    if (duration_minutes !== undefined) db.prepare('UPDATE formation_chapters SET duration_minutes = ? WHERE id = ?').run(duration_minutes, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Supprimer un chapitre
app.delete('/admin/formations/chapters/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM formation_progress WHERE chapter_id = ?').run(req.params.id);
    db.prepare('DELETE FROM formation_chapters WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ADMIN — Stats formations
app.get('/admin/formations/stats', requireAdmin, (req, res) => {
  try {
    const modules = db.prepare('SELECT * FROM formation_modules').all();
    const affiliates = db.prepare('SELECT * FROM users WHERE role = ?').all('affiliate');
    const stats = affiliates.map(u => {
      const totalChapters = db.prepare('SELECT COUNT(*) as c FROM formation_chapters').get().c;
      const completed = db.prepare('SELECT COUNT(*) as c FROM formation_progress WHERE user_id = ?').get(u.discord_id).c;
      return {
        discord_id: u.discord_id,
        discord_username: u.discord_username,
        discord_avatar: u.discord_avatar,
        completed,
        total: totalChapters,
        pct: totalChapters > 0 ? Math.round((completed / totalChapters) * 100) : 0
      };
    }).sort((a, b) => b.pct - a.pct);
    res.json(stats);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ── CRONS ────────────────────────────────────────────────────
cron.schedule('*/2 * * * *', () => scrapeAll().catch(console.error));
// Rappel quotidien à 10h
cron.schedule('0 10 * * *', () => sendDailyReminders().catch(console.error));
// Check réponses DM toutes les 30 min
cron.schedule('*/30 * * * *', () => checkDMReplies().catch(console.error));
// Récap du soir à 23h
cron.schedule('0 23 * * *', () => sendNightSummary().catch(console.error));

app.listen(PORT, () => {
  console.log('CAS\'INDUSTRIES v8 — port ' + PORT);
  scrapeAll().catch(console.error);
});
