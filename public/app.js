// RacingHub as an installable app (Oct 2026, per Dinesh): registers the
// service worker (push alerts, offline page) and runs the "Install app"
// button in the header. Loaded on every page.
(function () {
  var html = document.documentElement;
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) html.classList.add('is-app');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* no app features */ });
    });
  }

  var deferred = null;
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function button() { return document.getElementById('installAppBtn'); }
  function show() { var b = button(); if (b && !standalone) b.hidden = false; }
  function hide() { var b = button(); if (b) b.hidden = true; }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    show();
  });
  window.addEventListener('appinstalled', function () { deferred = null; hide(); });

  function iosHelp() {
    var box = document.getElementById('installHelp');
    if (!box) {
      box = document.createElement('div');
      box.id = 'installHelp';
      box.className = 'install-help';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Install RacingHub');
      box.innerHTML = '<button type="button" class="install-help-close" aria-label="Close">&times;</button>' +
        '<img src="/icons/icon-192.png" alt="" width="48" height="48">' +
        '<b>Install RacingHub on this iPhone</b>' +
        '<ol><li>Tap <b>Share</b> <span aria-hidden="true">⎙</span> at the bottom of Safari</li><li>Choose <b>Add to Home Screen</b></li><li>Open RacingHub from the home screen and turn on alerts in the bell</li></ol>';
      document.body.appendChild(box);
      box.querySelector('.install-help-close').addEventListener('click', function () { box.hidden = true; });
    }
    box.hidden = false;
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#installAppBtn');
    if (!b) return;
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function (c) { if (c.outcome === 'accepted') hide(); deferred = null; });
    } else if (isIos) {
      iosHelp();
    }
  });

  // iPhone Safari never fires beforeinstallprompt: offer the how-to instead.
  document.addEventListener('DOMContentLoaded', function () { if (isIos && !standalone) show(); });
})();
