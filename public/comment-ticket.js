// One ClickUp ticket per kind of comment issue (30 Oct 2026, per Dinesh:
// "same comment issue naraya racesku warudu"): the title and details for
// the race popup and the Comment Checks page alike. The server keys it
// "comment-type|<slug>" and hides that kind of finding everywhere while the
// ticket is open (server.js commentTypeTickets).
//
//   RddCommentTicket.ticket(claim, items) -> { code, title, details, items }
//   items: the findings of that kind, as /api/comment-checks lists them.
(function () {
  var WHAT = {
    'last-start win': 'The comment says the horse won its last start (or is coming off a win), but its form shows it didn\'t.',
    'recent win': 'The comment says the horse has a recent win, but its form shows no win lately.',
    'last-start placing': 'The comment gives a finishing place for the horse\'s last start that its form doesn\'t show.',
    'result at a course': 'The comment gives a result at a named track that the horse\'s form doesn\'t show.',
    'step up in class': 'The comment says the horse steps up in class today, but its last start was the same class or higher.',
    'drop in class': 'The comment says the horse drops in class today, but its last start was the same class or lower.',
    'first-up / after a break': 'The comment says the horse returns from a break, but it ran recently.',
    'maiden / yet to win': 'The comment says the horse hasn\'t won yet, but it has.',
    'debut': 'The comment says the horse is a first starter, but it has run before.',
    'record at this track': 'The comment claims a record at this track that the horse\'s stats don\'t show.',
    'record at the distance': 'The comment claims a record at this distance that the horse\'s stats don\'t show.',
  };
  var MAX_CHARS = 7600; // ClickUp descriptions are cut at 8000
  function slug(claim) {
    return String(claim || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }
  // "Runner Comment Issue" / "Race Comment Issue" / both.
  function label(items) {
    var race = items.some(function (i) { return i.where === 'race comment'; });
    var runner = items.some(function (i) { return i.where === 'runner comment'; });
    return race && runner ? 'Race & Runner Comment Issue' : race ? 'Race Comment Issue' : 'Runner Comment Issue';
  }
  function dayLabel(d) {
    var p = String(d || '').split('-').map(Number);
    return p.length === 3 ? new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  }
  function ticket(claim, items) {
    items = items.slice().sort(function (a, b) { return String(a.startUtc).localeCompare(String(b.startUtc)) || (a.tab || 0) - (b.tab || 0); });
    var races = {};
    items.forEach(function (i) { races[i.raceId] = true; });
    var raceCount = Object.keys(races).length;
    var title = '[' + label(items) + '] ' + cap(claim) + ' – ' + raceCount + ' race' + (raceCount === 1 ? '' : 's');
    var lines = [
      'Issue: ' + cap(claim) + ' (' + items.length + ' in ' + raceCount + ' race' + (raceCount === 1 ? '' : 's') + ')',
      WHAT[claim] || 'The comment says something the horse\'s form doesn\'t show.',
      'It is the same mistake in every race below, so it is likely in how the comments are written. Please fix the cause and correct these comments.',
      '',
      'Races with this issue now:',
    ];
    var shown = {};
    var n = 0;
    for (; n < items.length; n++) {
      var i = items[n];
      var block = ['', '—— ' + (n + 1) + '. ' + i.meeting + ' (' + i.country + ') R' + i.rNo + ' · ' + dayLabel(i.date) + ' ——',
        'Race ID: ' + i.raceId,
        'Horse: #' + i.tab + ' ' + i.horse,
        'Where: ' + cap(i.where),
        'Comment says: "' + i.quote + '"',
        'Form shows: ' + i.why];
      if (i.recent) block.push('Last 3 runs: ' + i.recent);
      // The whole comment once per comment, for the first few races.
      var c = i.raceId + '|' + i.where + '|' + (i.where === 'runner comment' ? i.tab : '');
      if (i.comment && !shown[c] && n < 5) {
        shown[c] = true;
        block.push(cap(i.where) + ' (full):', i.comment);
      }
      if (lines.concat(block).join('\n').length > MAX_CHARS) break;
      lines = lines.concat(block);
    }
    if (n < items.length) lines.push('', '… and ' + (items.length - n) + ' more on the Comment Checks page.');
    return { code: slug(claim), title: title, details: lines.join('\n'), items: items };
  }
  window.RddCommentTicket = { slug: slug, label: label, ticket: ticket, what: WHAT };
})();
