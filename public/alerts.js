// Race alerts: the bell in the header + browser pop-ups (Oct 2026, per
// Dinesh: notify before the jump when something is missing). Loaded on every
// page for users with the Overview section (raceView.js renderUserBlock).
//
// - Races starting in the next 3 hours with an open issue pop up once at 3h,
//   2h, 1h, 30 min and 10 min to the jump. An issue marked "Not at source yet"
//   only pops up again at 30 and 10 min.
// - A late scratching not yet updated in ours pops up straight away, and so
//   do results missing (a race run with no results while a later race at the
//   meeting has them, 21 Oct 2026).
// - Each alert: Updated (marks it fixed) / Not at source yet, and the race.
// - Pop-ups and sound are per browser (on/off in the bell panel). Pop-ups
//   only work while a dashboard tab is open.
(function () {
  var bell = document.getElementById('alertsBell');
  if (!bell || !window.fetch) return;

  var MILESTONES = [180, 120, 60, 30, 10];
  var POLL_MS = 60 * 1000;
  var SETTINGS_KEY = 'rdd_alert_settings_v1';
  var SEEN_KEY = 'rdd_alert_seen_v1';
  var data = null;
  var settings = read(SETTINGS_KEY, { popups: false, sound: true });
  var seen = read(SEEN_KEY, {});
  var panel = null;

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private window: just no memory */ }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Race type on every alert, the dashboard tabs' icon + name (12 Oct 2026, per Dinesh).
  var DISCIPLINES = { T: ['Thoroughbred', 'thoroughbred'], H: ['Harness', 'harness'], G: ['Greyhound', 'greyhound'] };
  function discName(race) { return (DISCIPLINES[race.discipline] || [race.discipline || ''])[0]; }
  function raceTitle(race) { return race.meeting + ' R' + race.rNo + (discName(race) ? ' · ' + discName(race) : ''); }
  function discTag(race) {
    var d = DISCIPLINES[race.discipline];
    if (!d) return '';
    return '<span class="al-disc al-disc-' + race.discipline + '"><span class="disc-icon disc-icon-' + d[1] + '" aria-hidden="true"></span>' + d[0] + '</span>';
  }

  // A race on another day than today says which ("Tue 13 Oct 14:30"); the
  // time is the race's local time, as on the dashboard.
  function dayLabel(race) {
    if (!data || !data.today || !race.date || race.date === data.today) return '';
    var d = new Date(race.date + 'T12:00:00Z');
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ' ';
  }

  function minsTo(race) {
    var t = Date.parse(race.startUtc || '');
    return isFinite(t) ? (t - Date.now()) / 60000 : null;
  }
  function inText(m) {
    if (m == null) return '';
    if (m < -5) return 'ran';
    if (m < 0) return 'started';
    if (m < 60) return 'in ' + Math.max(1, Math.round(m)) + ' min';
    return 'in ' + Math.floor(m / 60) + ' h ' + String(Math.round(m % 60)).padStart(2, '0') + ' m';
  }
  // The milestone a race is in now: the smallest of 180/120/60/30/10 that is
  // still >= its minutes to the jump (null when over 3 hours away).
  function milestoneFor(m) {
    var hit = null;
    MILESTONES.forEach(function (x) { if (m != null && m <= x) hit = x; });
    return hit;
  }
  function liveIssues(race, milestone) {
    return race.issues.filter(function (i) {
      if (i.workflow === 'fixed') return false;
      if (i.workflow === 'waiting_source') return milestone != null && milestone <= 30;
      return true;
    });
  }

  function beep() {
    if (!settings.sound) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      [0, 0.18].forEach(function (offset) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.15);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + offset); o.stop(ctx.currentTime + offset + 0.16);
      });
    } catch (e) { /* no audio */ }
  }

  // Push from the server (Oct 2026): with "Keep alerting when the tab is
  // closed" on, the server sends the same alerts to this device itself
  // (push.js / sw.js), so this page doesn't pop up a second copy.
  var pushOn = false;
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function keyBytes(b64) {
    var s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s); var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function currentSub() {
    // serviceWorker.ready never settles if the worker didn't register: give up after 4 s.
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 4000); });
    return Promise.race([navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }), timeout]);
  }
  // Is this device getting pushed alerts? (Re-registers a subscription the server lost.)
  function refreshPush() {
    if (!pushSupported()) return Promise.resolve(false);
    return currentSub().then(function (sub) {
      if (!sub) return false;
      return fetch('/api/push/key?endpoint=' + encodeURIComponent(sub.endpoint)).then(function (r) { return r.json(); }).then(function (j) {
        if (j.subscribed) return true;
        return postJson('/api/push/subscribe', { subscription: sub.toJSON() }).then(function (r) { return r.ok; });
      });
    }).then(function (on) { pushOn = on; return on; }).catch(function () { return pushOn; });
  }
  function enablePush(box, note) {
    box.disabled = true;
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') throw new Error('blocked');
      return fetch('/api/push/key').then(function (r) { return r.json(); });
    }).then(function (j) {
      var late = new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('no worker')); }, 8000); });
      return Promise.race([navigator.serviceWorker.ready, late]).then(function (reg) {
        return reg.pushManager.getSubscription().then(function (s) {
          return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(j.publicKey) });
        });
      });
    }).then(function (sub) {
      return postJson('/api/push/subscribe', { subscription: sub.toJSON() });
    }).then(function (r) {
      if (!r.ok) throw new Error('save');
      pushOn = true; box.checked = true;
      note.textContent = 'Alerts will reach this device even when the dashboard is closed. A test alert is on its way.';
      return postJson('/api/push/test');
    }).catch(function (err) {
      pushOn = false; box.checked = false;
      note.textContent = err && err.message === 'blocked'
        ? 'Notifications are blocked for this site: allow them in the address bar (or the phone\'s settings), then tick this again.'
        : 'Couldn\'t turn this on in this browser. On an iPhone, install the app first (Share → Add to Home Screen), then open it and tick this.';
    }).then(function () { box.disabled = false; });
  }
  function disablePush(box, note) {
    pushOn = false;
    currentSub().then(function (sub) {
      if (!sub) return null;
      postJson('/api/push/unsubscribe', { endpoint: sub.endpoint });
      return sub.unsubscribe();
    }).catch(function () {}).then(function () {
      box.checked = false;
      note.textContent = 'Alerts only show while a dashboard tab is open.';
    });
  }

  function popup(title, body, url, tag) {
    if (pushOn) return;
    if (!settings.popups || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      var n = new Notification(title, { body: body, tag: tag, icon: '/logo.png' });
      n.onclick = function () { window.focus(); if (url) location.href = url; n.close(); };
    } catch (e) { /* some browsers only allow it from a service worker */ }
  }

  function issueSummary(list) {
    return list.map(function (i) { return i.detail || i.label; }).join(', ');
  }

  // Works out which pop-ups are due now; several at once become one summary.
  function check() {
    if (!data) return;
    var due = [];
    data.races.forEach(function (race) {
      var m = minsTo(race);
      race.issues.forEach(function (i) {
        if (i.lateScratching && i.workflow !== 'fixed' && !seen['ls|' + i.key]) {
          seen['ls|' + i.key] = Date.now();
          due.push({ title: 'Late scratching not updated · ' + discName(race), body: raceTitle(race) + ' (' + race.country + ') ' + inText(m) + ': ' + i.detail, url: race.raceUrl, tag: 'ls-' + race.raceId });
        }
        if (i.missingResult && i.workflow !== 'fixed' && !seen['mr|' + i.key]) {
          seen['mr|' + i.key] = Date.now();
          due.push({ title: 'Results missing · ' + discName(race), body: raceTitle(race) + ' (' + race.country + ') ' + (race.time || '') + ': no results yet, a later race already has them', url: race.raceUrl, tag: 'mr-' + race.raceId });
        }
      });
      var milestone = milestoneFor(m);
      if (milestone == null || m < -5) return;
      var list = liveIssues(race, milestone);
      var key = race.raceId + '|' + milestone;
      if (!list.length || seen[key]) return;
      seen[key] = Date.now();
      var label = milestone >= 60 ? (milestone / 60) + ' h' : milestone + ' min';
      due.push({ title: raceTitle(race) + ' — ' + label + ' to jump', body: issueSummary(list), url: race.raceUrl, tag: 'race-' + race.raceId });
    });
    // Missing meetings (25 Oct 2026): a feed meeting not on the dashboard.
    (data.missingMeetings || []).forEach(function (a) {
      if (seen[a.key]) return;
      seen[a.key] = Date.now();
      due.push({ title: a.title, body: a.body, url: '/missing-meetings', tag: 'mm-' + a.key });
    });
    // Forget what is over a day old (missing meetings 4 days: they go up to
    // the day after tomorrow).
    var cutoff = Date.now() - 24 * 60 * 60 * 1000;
    Object.keys(seen).forEach(function (k) { if (seen[k] < (k.indexOf('mm|') === 0 ? cutoff - 72 * 60 * 60 * 1000 : cutoff)) delete seen[k]; });
    write(SEEN_KEY, seen);
    if (!due.length) return;
    beep();
    if (due.length > 3) {
      popup(due.length + ' race alerts', due.slice(0, 4).map(function (d) { return d.title; }).join('\n') + (due.length > 4 ? '\n…' : ''), '/overview', 'race-alerts');
    } else {
      due.forEach(function (d) { popup(d.title, d.body, d.url, d.tag); });
    }
    bell.classList.add('alerts-ping');
    setTimeout(function () { bell.classList.remove('alerts-ping'); }, 4000);
  }

  function activeCount() {
    if (!data) return 0;
    return (data.missingMeetings || []).length + data.races.filter(function (race) {
      var m = minsTo(race);
      return liveIssues(race, milestoneFor(m)).length || race.issues.some(function (i) { return (i.lateScratching || i.missingResult) && i.workflow !== 'fixed'; });
    }).length;
  }

  function statusChip(i) {
    if (i.workflow === 'waiting_source') return '<span class="al-chip al-wait">Not at source yet · ' + esc(i.updatedBy || i.owner || '') + '</span>';
    if (i.workflow === 'in_progress') return '<span class="al-chip al-prog">' + esc(i.owner || '') + ' is fixing</span>';
    return '';
  }

  function render() {
    var count = activeCount();
    var badge = bell.querySelector('.alerts-count');
    badge.textContent = count;
    badge.hidden = !count;
    bell.setAttribute('aria-label', 'Race alerts' + (count ? ': ' + count : ''));
    if (!panel || panel.hidden) return;
    var list = panel.querySelector('.al-list');
    if (!data) { list.innerHTML = '<p class="al-empty">Loading...</p>'; return; }
    var mm = (data.missingMeetings || []).map(function (a) {
      return '<article class="al-race al-missing">' +
        '<div class="al-race-head"><a href="/missing-meetings"><i class="fa-solid fa-triangle-exclamation"></i> Missing meeting · ' + esc(a.course) + ' <span class="al-cc">' + esc(a.country) + '</span></a></div>' +
        '<div class="al-issue"><div class="al-issue-text"><span>' + esc(a.body) + '</span></div>' +
        '<div class="al-actions"><a class="adm-btn" href="/missing-meetings"><i class="fa-solid fa-arrow-right"></i> Missing Meetings</a></div></div></article>';
    }).join('');
    list.innerHTML = mm + data.races.map(function (race) {
      var m = minsTo(race);
      var soon = m != null && m <= 30;
      return '<article class="al-race">' +
        '<div class="al-race-head"><a href="' + esc(race.raceUrl) + '">' + esc(race.meeting) + ' <b>R' + esc(race.rNo) + '</b> <span class="al-cc">' + esc(race.country) + '</span></a>' + discTag(race) +
        '<span class="al-when' + (soon ? ' al-soon' : '') + '">' + esc(inText(m)) + ' · ' + esc(dayLabel(race)) + esc(race.time || '') + '</span></div>' +
        race.issues.map(function (i) {
          var src = i.source ? '<div class="al-src ' + (i.source.available ? 'al-src-yes' : 'al-src-no') + '">' + esc(i.source.text) + (i.source.available ? ' — update it' : '') + '</div>' : '';
          return '<div class="al-issue">' +
            '<div class="al-issue-text"><b>' + esc(i.lateScratching ? 'Late scratching' : i.label) + '</b> <span>' + esc(i.detail) + '</span>' + src + statusChip(i) + '</div>' +
            '<div class="al-actions">' +
            '<button type="button" class="adm-btn primary" data-al-key="' + esc(i.key) + '" data-al-to="fixed"><i class="fa-solid fa-check"></i> Updated</button>' +
            (i.workflow === 'waiting_source' ? '' : '<button type="button" class="adm-btn" data-al-key="' + esc(i.key) + '" data-al-to="waiting_source"><i class="fa-regular fa-hourglass-half"></i> Not at source yet</button>') +
            // The race in the Troyen admin, to fix it in the DB (22 Oct 2026, per Dinesh).
            '<a class="adm-btn" href="https://troyendata.com/Race?raceId=' + encodeURIComponent(race.raceId) + '" target="_blank" rel="noopener"><i class="fa-solid fa-pen-to-square"></i> Admin</a>' +
            '</div></div>';
        }).join('') + '</article>';
    }).join('') || (mm ? '' : '<p class="al-empty"><i class="fa-solid fa-circle-check"></i> No open issues on races in the next 3 hours.</p>');
  }

  function buildPanel() {
    panel = document.createElement('section');
    panel.className = 'al-panel';
    panel.id = 'alertsPanel';
    panel.setAttribute('aria-label', 'Race alerts');
    panel.hidden = true;
    var canPopup = 'Notification' in window;
    panel.innerHTML = '<div class="al-head"><b>Race alerts</b><span class="al-sub">next 3 hours · pops up at 3h, 2h, 1h, 30 and 10 min</span>' +
      '<button type="button" class="adm-btn" id="alClose" aria-label="Close">&times;</button></div>' +
      '<div class="al-list"></div>' +
      '<div class="al-foot">' +
      '<label><input type="checkbox" id="alPopups"' + (settings.popups ? ' checked' : '') + (canPopup ? '' : ' disabled') + '> Pop-up notifications</label>' +
      '<label class="al-push-row"><input type="checkbox" id="alPush"' + (pushOn ? ' checked' : '') + (pushSupported() ? '' : ' disabled') + '> Keep alerting when the tab is closed <span class="al-tag">NEW</span></label>' +
      '<label><input type="checkbox" id="alSound"' + (settings.sound ? ' checked' : '') + '> Sound</label>' +
      '<a href="/overview">Overview</a>' +
      '<p class="al-note" id="alNote">' + (canPopup ? 'Pop-ups show while a dashboard tab is open, even minimised.' : 'This browser does not support pop-up notifications.') + '</p>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('#alClose').addEventListener('click', function () { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); });
    var pushBox = panel.querySelector('#alPush');
    pushBox.addEventListener('change', function () {
      var note = document.getElementById('alNote');
      if (pushBox.checked) enablePush(pushBox, note); else disablePush(pushBox, note);
    });
    refreshPush().then(function (on) { pushBox.checked = on; });
    panel.querySelector('#alSound').addEventListener('change', function (e) { settings.sound = e.target.checked; write(SETTINGS_KEY, settings); if (settings.sound) beep(); });
    panel.querySelector('#alPopups').addEventListener('change', function (e) {
      var box = e.target;
      if (!box.checked) { settings.popups = false; write(SETTINGS_KEY, settings); return; }
      Notification.requestPermission().then(function (p) {
        settings.popups = p === 'granted';
        box.checked = settings.popups;
        write(SETTINGS_KEY, settings);
        document.getElementById('alNote').textContent = settings.popups
          ? 'Pop-ups are on. They show while a dashboard tab is open, even minimised.'
          : 'The browser blocked pop-ups for this site: allow notifications in the address bar, then tick this again.';
        if (settings.popups) popup('Race alerts are on', 'You will get a pop-up before races with missing data.', null, 'alerts-on');
      });
    });
    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-al-key]');
      if (!btn) return;
      btn.disabled = true;
      fetch('/api/issues/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: btn.getAttribute('data-al-key'), status: btn.getAttribute('data-al-to') }),
      }).then(function (res) { if (!res.ok) throw new Error('Could not save'); return load(); })
        .catch(function (err) { btn.disabled = false; alert(err.message); });
    });
  }

  function load() {
    return fetch('/api/alerts').then(function (res) { return res.ok ? res.json() : null; }).then(function (j) {
      if (!j) return;
      data = j;
      render();
      check();
    }).catch(function () { /* try again next minute */ });
  }

  bell.hidden = false;
  bell.addEventListener('click', function () {
    if (!panel) buildPanel();
    panel.hidden = !panel.hidden;
    bell.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    render();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel && !panel.hidden) { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); bell.focus(); }
  });
  // A click anywhere outside the panel and the bell closes it too.
  document.addEventListener('click', function (e) {
    if (!panel || panel.hidden || panel.contains(e.target) || bell.contains(e.target)) return;
    panel.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
  });
  refreshPush().then(load);
  setInterval(load, POLL_MS);
  // Milestones are crossed between polls too.
  setInterval(function () { render(); check(); }, 20 * 1000);
})();
