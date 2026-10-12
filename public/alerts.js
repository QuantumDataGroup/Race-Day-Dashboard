// Race alerts: the bell in the header + browser pop-ups (Oct 2026, per
// Dinesh: notify before the jump when something is missing). Loaded on every
// page for users with the Overview section (raceView.js renderUserBlock).
//
// - Races starting in the next 3 hours with an open issue pop up once at 3h,
//   2h, 1h, 30 min and 10 min to the jump. An issue marked "Not at source yet"
//   only pops up again at 30 and 10 min.
// - A late scratching not yet updated in ours pops up straight away.
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

  function minsTo(race) {
    var t = Date.parse(race.startUtc || '');
    return isFinite(t) ? (t - Date.now()) / 60000 : null;
  }
  function inText(m) {
    if (m == null) return '';
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

  function popup(title, body, url, tag) {
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
    // Forget what is over a day old.
    var cutoff = Date.now() - 24 * 60 * 60 * 1000;
    Object.keys(seen).forEach(function (k) { if (seen[k] < cutoff) delete seen[k]; });
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
    return data.races.filter(function (race) {
      var m = minsTo(race);
      return liveIssues(race, milestoneFor(m)).length || race.issues.some(function (i) { return i.lateScratching && i.workflow !== 'fixed'; });
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
    list.innerHTML = data.races.map(function (race) {
      var m = minsTo(race);
      var soon = m != null && m <= 30;
      return '<article class="al-race">' +
        '<div class="al-race-head"><a href="' + esc(race.raceUrl) + '">' + esc(race.meeting) + ' <b>R' + esc(race.rNo) + '</b> <span class="al-cc">' + esc(race.country) + '</span></a>' + discTag(race) +
        '<span class="al-when' + (soon ? ' al-soon' : '') + '">' + esc(inText(m)) + ' · ' + esc(race.time || '') + '</span></div>' +
        race.issues.map(function (i) {
          var src = i.source ? '<div class="al-src ' + (i.source.available ? 'al-src-yes' : 'al-src-no') + '">' + esc(i.source.text) + (i.source.available ? ' — update it' : '') + '</div>' : '';
          return '<div class="al-issue">' +
            '<div class="al-issue-text"><b>' + esc(i.lateScratching ? 'Late scratching' : i.label) + '</b> <span>' + esc(i.detail) + '</span>' + src + statusChip(i) + '</div>' +
            '<div class="al-actions">' +
            '<button type="button" class="adm-btn primary" data-al-key="' + esc(i.key) + '" data-al-to="fixed"><i class="fa-solid fa-check"></i> Updated</button>' +
            (i.workflow === 'waiting_source' ? '' : '<button type="button" class="adm-btn" data-al-key="' + esc(i.key) + '" data-al-to="waiting_source"><i class="fa-regular fa-hourglass-half"></i> Not at source yet</button>') +
            '</div></div>';
        }).join('') + '</article>';
    }).join('') || '<p class="al-empty"><i class="fa-solid fa-circle-check"></i> No open issues on races in the next 3 hours.</p>';
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
      '<label><input type="checkbox" id="alSound"' + (settings.sound ? ' checked' : '') + '> Sound</label>' +
      '<a href="/overview">Overview</a>' +
      '<p class="al-note" id="alNote">' + (canPopup ? 'Pop-ups show while a dashboard tab is open, even minimised.' : 'This browser does not support pop-up notifications.') + '</p>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('#alClose').addEventListener('click', function () { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); });
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
  load();
  setInterval(load, POLL_MS);
  // Milestones are crossed between polls too.
  setInterval(function () { render(); check(); }, 20 * 1000);
})();
