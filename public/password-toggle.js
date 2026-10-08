// Show / hide password (8 Oct 2026, per Dinesh: "password type pannadu show
// password podunga ... Password podra ella placeslau"). Adds an eye button
// inside every password box on the page -- including ones added later, like
// the admin page's Reset password row -- that switches it between hidden and
// plain text. Included on the login and admin pages.
(function () {
  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function setShown(input, btn, shown) {
    input.type = shown ? 'text' : 'password';
    btn.innerHTML = shown ? EYE_OFF : EYE;
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    btn.title = shown ? 'Hide password' : 'Show password';
  }

  function addToggle(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    var wrap = document.createElement('span');
    wrap.className = 'pw-wrap' + (getComputedStyle(input).width === '100%' || input.closest('.login-card, .adm-panel') ? ' pw-block' : '');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    setShown(input, btn, false);
    btn.addEventListener('click', function () {
      setShown(input, btn, input.type === 'password');
      input.focus();
    });
    wrap.appendChild(btn);
    // Hidden again once the form is sent, so the next one starts hidden.
    if (input.form) input.form.addEventListener('submit', function () { setShown(input, btn, false); });
  }

  var SELECTOR = 'input[type="password"]:not([data-pw-toggle])';
  function scan(root) {
    if (root.matches && root.matches(SELECTOR)) addToggle(root);
    root.querySelectorAll(SELECTOR).forEach(addToggle);
  }

  function start() {
    scan(document);
    new MutationObserver(function (records) {
      records.forEach(function (rec) {
        rec.addedNodes.forEach(function (node) { if (node.nodeType === 1) scan(node); });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
