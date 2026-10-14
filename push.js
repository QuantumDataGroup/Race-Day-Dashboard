/**
 * Web push for race alerts (Oct 2026, per Dinesh: alerts must arrive even
 * when the dashboard tab or app is closed).
 *
 * - VAPID keys are made on first start and kept in push-keys.json in the
 *   data folder (the Docker /data volume), so no server setting is needed.
 * - Each browser that ticks "Keep alerting when the tab is closed" in the
 *   bell panel sends its push subscription; push-subscriptions.json keeps
 *   them per username. A subscription the push service says is gone (404 /
 *   410) is dropped.
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

function createPush({ dir, subject }) {
  const keysPath = path.join(dir, 'push-keys.json');
  const subsPath = path.join(dir, 'push-subscriptions.json');
  let keys = null;
  let subs = {};
  let lastError = null;
  let sentCount = 0;

  function writeJson(file, data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  }

  try {
    if (fs.existsSync(keysPath)) keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  } catch (err) { keys = null; }
  if (!keys || !keys.publicKey || !keys.privateKey) {
    keys = webpush.generateVAPIDKeys();
    try { writeJson(keysPath, keys); } catch (err) { lastError = `could not save push keys: ${err.message}`; }
  }
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  try {
    if (fs.existsSync(subsPath)) subs = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
  } catch (err) { subs = {}; }

  const keyOf = (s) => String(s && s.endpoint || '');

  function subscribe(username, subscription, userAgent) {
    if (!subscription || !/^https:\/\//.test(keyOf(subscription)) || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      throw new Error('Not a push subscription');
    }
    const list = (subs[username] || []).filter((s) => keyOf(s.sub) !== keyOf(subscription));
    list.push({ sub: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }, at: new Date().toISOString(), ua: String(userAgent || '').slice(0, 160) });
    subs[username] = list.slice(-10);
    writeJson(subsPath, subs);
  }

  function unsubscribe(username, endpoint) {
    const before = (subs[username] || []).length;
    subs[username] = (subs[username] || []).filter((s) => keyOf(s.sub) !== endpoint);
    if (!subs[username].length) delete subs[username];
    if ((subs[username] || []).length !== before) writeJson(subsPath, subs);
  }

  function has(username, endpoint) {
    return (subs[username] || []).some((s) => keyOf(s.sub) === endpoint);
  }

  // Sends one notification to every device of the given users. payload:
  // { title, body, url, tag }.
  async function sendTo(usernames, payload) {
    const data = JSON.stringify(payload);
    let changed = false;
    let sent = 0;
    for (const u of usernames) {
      for (const s of [...(subs[u] || [])]) {
        try {
          await webpush.sendNotification(s.sub, data, { TTL: 15 * 60, urgency: 'high' });
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            subs[u] = subs[u].filter((x) => x !== s);
            if (!subs[u].length) delete subs[u];
            changed = true;
          } else {
            lastError = `${err.statusCode || ''} ${err.message}`.trim();
          }
        }
      }
    }
    if (changed) writeJson(subsPath, subs);
    sentCount += sent;
    return sent;
  }

  function status() {
    const devices = Object.values(subs).reduce((a, l) => a + l.length, 0);
    return { publicKey: keys.publicKey, users: Object.keys(subs).length, devices, sent: sentCount, lastError };
  }

  return { publicKey: keys.publicKey, subscribe, unsubscribe, has, sendTo, users: () => Object.keys(subs), status };
}

module.exports = { createPush };
