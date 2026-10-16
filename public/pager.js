// Page-size box + page numbers under a list (16 Oct 2026, per Dinesh: "10,
// 25, 50, 100 ... defoult ha 25 ... mattadella pages open panni varanum").
// Used by Comment picks races, Overview all open issues, Tickets, User
// Activity, Data Changes and both Missing Data lists.
//
//   var pager = RddPager.create(document.getElementById('xPager'), render);
//   function render() { var shown = pager.slice(allRows); ... }
//   filters changed -> pager.reset(); render();
//
// slice() remembers the total, keeps the page in range and redraws the bar;
// a size or page click calls render again.
(function () {
  var SIZES = [10, 25, 50, 100];
  var DEFAULT_SIZE = 25;

  function pageList(page, pages) {
    var out = [];
    var add = function (n) { if (out.indexOf(n) === -1 && n >= 1 && n <= pages) out.push(n); };
    add(1);
    for (var n = page - 2; n <= page + 2; n++) add(n);
    add(pages);
    out.sort(function (a, b) { return a - b; });
    var withGaps = [];
    out.forEach(function (n, i) { if (i && n - out[i - 1] > 1) withGaps.push('gap'); withGaps.push(n); });
    return withGaps;
  }

  function create(el, onChange, opts) {
    opts = opts || {};
    var p = { size: opts.size || DEFAULT_SIZE, page: 1, total: 0, label: opts.label || 'rows' };
    if (!el) return { slice: function (rows) { return rows; }, reset: function () {} };
    el.classList.add('rdd-pager');
    el.hidden = true; // until the list has rows

    p.reset = function () { p.page = 1; };
    p.slice = function (rows) {
      p.total = rows.length;
      var pages = Math.max(1, Math.ceil(p.total / p.size));
      if (p.page > pages) p.page = pages;
      draw(pages);
      return rows.slice((p.page - 1) * p.size, p.page * p.size);
    };

    function draw(pages) {
      if (!p.total) { el.hidden = true; el.innerHTML = ''; return; }
      el.hidden = false;
      var from = (p.page - 1) * p.size + 1;
      var to = Math.min(p.total, p.page * p.size);
      var btn = function (n, text, aria, cls) {
        return '<button type="button" class="rdd-pager-btn' + (cls ? ' ' + cls : '') + '" data-page="' + n + '"' +
          (aria ? ' aria-label="' + aria + '"' : '') + (n === p.page && !cls ? ' aria-current="page"' : '') + '>' + text + '</button>';
      };
      var nums = pages > 1 ? pageList(p.page, pages).map(function (n) {
        return n === 'gap' ? '<span class="rdd-pager-gap">…</span>' : btn(n, String(n), 'Page ' + n, n === p.page ? 'on' : '');
      }).join('') : '';
      el.innerHTML =
        '<label class="rdd-pager-size">Show <select aria-label="Rows per page">' +
          SIZES.map(function (s) { return '<option value="' + s + '"' + (s === p.size ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
        '</select> per page</label>' +
        '<span class="rdd-pager-count">' + from.toLocaleString() + '–' + to.toLocaleString() + ' of ' + p.total.toLocaleString() + '</span>' +
        (pages > 1
          ? '<span class="rdd-pager-nav">' +
              '<button type="button" class="rdd-pager-btn" data-page="' + (p.page - 1) + '" aria-label="Previous page"' + (p.page === 1 ? ' disabled' : '') + '>‹</button>' +
              nums +
              '<button type="button" class="rdd-pager-btn" data-page="' + (p.page + 1) + '" aria-label="Next page"' + (p.page === pages ? ' disabled' : '') + '>›</button>' +
            '</span>'
          : '');
    }

    el.addEventListener('change', function (e) {
      if (e.target.tagName !== 'SELECT') return;
      e.stopPropagation();
      p.size = Number(e.target.value) || DEFAULT_SIZE;
      p.page = 1;
      onChange();
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      e.stopPropagation();
      p.page = Number(b.getAttribute('data-page')) || 1;
      onChange();
      // Back to the top of the list when it scrolled away.
      var host = el.closest('section, .ov-card, .adm-card') || el.parentNode;
      if (host && host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return p;
  }

  window.RddPager = { create: create, SIZES: SIZES, DEFAULT_SIZE: DEFAULT_SIZE };
})();
