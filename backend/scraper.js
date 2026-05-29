const axios = require('axios');
const db = require('./db');

async function checkIsLive(handle) {
  const clean = handle.replace('@', '');
  try {
    const res = await axios.get('https://www.tiktok.com/@' + clean + '/live', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      timeout: 10000,
      validateStatus: (s) => s < 400,
    });

    const html = res.data;
    const notLive = ['"isLiving":false', '"status":4', '"status":0'];
    if (notLive.some(i => html.includes(i))) return false;
    if (html.includes('"isLiving":true') || html.includes('"status":2')) return true;
    return false;
  } catch(err) {
    if (err.response && err.response.status === 404) return false;
    return null;
  }
}

async function updateLiveStatus(handle, userId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await checkIsLive(handle);
  const now = Math.floor(Date.now() / 1000);

  const existing = db.prepare('SELECT * FROM live_status WHERE tiktok_handle = ?').get(handle);

  if (result === null && existing) return existing.is_live === 1;

  const isLive = result === true;

  if (!existing) {
    db.prepare('INSERT INTO live_status (tiktok_handle, user_id, is_live, last_checked, today_minutes, last_reset_date) VALUES (?, ?, ?, ?, 0, ?)')
      .run(handle, userId, isLive ? 1 : 0, now, today);
    if (isLive) {
      db.prepare('INSERT INTO live_sessions (tiktok_handle, user_id) VALUES (?, ?)').run(handle, userId);
    }
    return isLive;
  }

  let todayMinutes = existing.today_minutes;
  if (existing.last_reset_date !== today) todayMinutes = 0;

  const wasLive = existing.is_live === 1;

  if (wasLive && isLive) {
    todayMinutes += 2;
  } else if (wasLive && !isLive) {
    const session = db.prepare('SELECT * FROM live_sessions WHERE tiktok_handle = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(handle);
    if (session) {
      const dur = Math.floor((now - session.started_at) / 60);
      db.prepare('UPDATE live_sessions SET ended_at = ?, duration_minutes = ? WHERE id = ?').run(now, dur, session.id);
    }
  } else if (!wasLive && isLive) {
    db.prepare('INSERT INTO live_sessions (tiktok_handle, user_id) VALUES (?, ?)').run(handle, userId);
  }

  db.prepare('UPDATE live_status SET is_live = ?, last_checked = ?, today_minutes = ?, last_reset_date = ? WHERE tiktok_handle = ?')
    .run(isLive ? 1 : 0, now, todayMinutes, today, handle);

  // Met à jour le daily_log
  if (isLive || todayMinutes > 0) {
    db.prepare('INSERT INTO daily_logs (user_id, date, total_minutes, did_live) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, date) DO UPDATE SET total_minutes = ?, did_live = 1')
      .run(userId, today, todayMinutes, todayMinutes);
  }

  return isLive;
}

async function scrapeAll() {
  const accounts = db.prepare('SELECT * FROM tiktok_accounts').all();
  for (const acc of accounts) {
    await updateLiveStatus(acc.tiktok_handle, acc.user_id);
    await sleep(1500);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrapeAll, checkIsLive };
