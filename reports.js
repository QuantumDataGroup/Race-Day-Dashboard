/**
 * Daily and weekly data-quality reports (Oct 2026, per Dinesh).
 *
 * Every day at 8:00 AM Sri Lanka time a report for the day before, and on
 * Mondays one for the last week (Mon-Sun), go to the ClickUp Chat channel
 * "Weekly data report" with a link to the PDF (no ClickUp task since 27 Oct
 * 2026, per Dinesh).
 * The numbers come from issue-tracker.js's history (issues found, fixed,
 * fix time, who marked them fixed, races that ran with an issue still open)
 * plus the ClickUp tickets.
 *
 * reports-state.json (data folder) remembers which reports were sent, so a
 * restart doesn't send one twice.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const SEND_HOUR = 8;
const RETRY_AFTER_MS = 30 * 60 * 1000;
const DISCIPLINES = { T: 'Thoroughbred', H: 'Harness', G: 'Greyhound' };
const C = { navy: '#121a27', ink: '#1b2330', muted: '#667085', line: '#e1e5ec', mist: '#f4f6f9', accent: '#e8900c', ok: '#1f8a4c', bad: '#c0392b', blue: '#5b8def' };

function shiftDate(dateStr, days) {
  return new Date(Date.parse(`${dateStr}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function longDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function shortDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function fmtMinutes(m) {
  if (m == null) return '-';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}
function pct(a, b) { return b ? Math.round((a / b) * 100) : null; }

// daily: send the daily report too. Off since 14 Oct 2026 (Dinesh: weekly
// only, to him, not to his boss); REPORTS_DAILY=on turns it back on.
function createReports({ issueTracker, clickup, issueLabels = {}, timezone = 'Asia/Colombo', dir, logoPath, ownerEmail = () => null, siteUrl = '', daily = false }) {
  const statePath = path.join(dir, 'reports-state.json');
  const pdfDir = path.join(dir, 'reports');
  let state = { daily: null, weekly: null, last: null, lastError: null, lastErrorAt: 0 };
  try {
    if (fs.existsSync(statePath)) state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch (err) { /* start fresh */ }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  }

  // Sri Lanka clock: date, hour and weekday (1 = Monday).
  function localNow(d = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(d).map((p) => [p.type, p.value]));
    const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday };
  }
  function localTime(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(t) : '';
  }
  const label = (code) => issueLabels[code] || code;

  async function ticketStats(from, to) {
    if (!clickup || !clickup.enabled) return null;
    try {
      const views = (await clickup.tasks(true)).map((t) => clickup.view(t));
      const inRange = (iso) => { const d = iso ? localNow(new Date(iso)).date : null; return d && d >= from && d <= to; };
      return {
        opened: views.filter((v) => inRange(v.createdAt)).length,
        done: views.filter((v) => v.status === 'done' && inRange(v.updatedAt)).length,
        todo: views.filter((v) => v.status === 'todo' && !v.ignored).length,
        overdue: views.filter((v) => v.status === 'todo' && !v.ignored && v.ageHours >= 24).length,
      };
    } catch (err) {
      return null;
    }
  }

  // One report over a run of race dates (one date = daily).
  async function build(kind, from, to) {
    const days = [];
    for (let d = from; d <= to; d = shiftDate(d, 1)) days.push(issueTracker.dayReport(d));
    const sum = (f) => days.reduce((a, d) => a + (f(d) || 0), 0);
    const merge = (field) => {
      const out = {};
      for (const d of days) {
        for (const [k, v] of Object.entries(d[field] || {})) {
          if (typeof v === 'number') out[k] = (out[k] || 0) + v;
          else { const o = out[k] || (out[k] = {}); for (const [kk, vv] of Object.entries(v)) o[kk] = (o[kk] || 0) + vv; }
        }
      }
      return out;
    };
    const fixTimes = days.filter((d) => d.avgFixMinutes != null && d.fixed);
    const avgFix = fixTimes.length ? Math.round(fixTimes.reduce((a, d) => a + d.avgFixMinutes * d.fixed, 0) / fixTimes.reduce((a, d) => a + d.fixed, 0)) : null;
    const scored = days.filter((d) => d.score != null && d.races);
    const races = sum((d) => d.races);
    const score = scored.length ? Math.round(scored.reduce((a, d) => a + d.score * d.races, 0) / scored.reduce((a, d) => a + d.races, 0)) : null;
    const prev = kind === 'daily' ? issueTracker.dayReport(shiftDate(from, -1)) : null;
    return {
      kind, from, to,
      title: kind === 'daily' ? `Daily data report · ${longDate(from)}` : `Weekly data report · ${shortDate(from)} – ${shortDate(to)}`,
      recorded: days.some((d) => d.recorded),
      races, found: sum((d) => d.found), fixed: sum((d) => d.fixed), score, avgFix,
      scoreChange: prev && prev.score != null && score != null ? score - prev.score : null,
      missed: days.flatMap((d) => d.missed.map((m) => ({ ...m, date: d.date }))),
      byType: merge('byType'), byCountry: merge('byCountry'), byPerson: merge('byPerson'),
      days: days.map((d) => ({ date: d.date, races: d.races, found: d.found, fixed: d.fixed, score: d.score, missed: d.missed.length, recorded: d.recorded })),
      tickets: await ticketStats(from, to),
    };
  }

  function markdown(r) {
    const lines = [
      `**${r.title}**`, '',
      `- Data quality: **${r.score == null ? '-' : `${r.score}%`}**${r.scoreChange != null ? ` (${r.scoreChange >= 0 ? '+' : ''}${r.scoreChange} pts vs the day before)` : ''}`,
      `- Races: ${r.races} · issues found: ${r.found} · fixed: ${r.fixed} (${pct(r.fixed, r.found) ?? '-'}%) · average fix time: ${fmtMinutes(r.avgFix)}`,
      `- Races that ran with an issue still open: **${r.missed.length}**`,
    ];
    const people = Object.entries(r.byPerson).sort((a, b) => b[1] - a[1]);
    if (people.length) lines.push(`- Marked fixed: ${people.map(([n, v]) => `${n} ${v}`).join(' · ')}`);
    const types = Object.entries(r.byType).sort((a, b) => b[1].found - a[1].found).slice(0, 5);
    if (types.length) lines.push(`- Top issues: ${types.map(([k, v]) => `${label(k)} ${v.found}`).join(' · ')}`);
    if (r.tickets) lines.push(`- Tickets: ${r.tickets.opened} opened · ${r.tickets.done} done · ${r.tickets.todo} in To Do (${r.tickets.overdue} over 24 h)`);
    if (!r.recorded) lines.push('', '_No issue history was recorded for this period._');
    lines.push('', `The full report is attached as a PDF.${siteUrl ? ` Dashboard: ${siteUrl}/overview` : ''}`);
    return lines.join('\n');
  }

  // The Chat message: headline numbers plus a link to the PDF.
  function chatText(r, filename) {
    const types = Object.entries(r.byType).sort((a, b) => b[1].found - a[1].found).slice(0, 3);
    const people = Object.entries(r.byPerson).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const lines = [
      `**[Race Day Dashboard] ${r.title}**`,
      `- Data quality **${r.score == null ? '-' : `${r.score}%`}** · races ${r.races} · issues ${r.found} · fixed ${r.fixed} (${pct(r.fixed, r.found) ?? '-'}%) · avg fix ${fmtMinutes(r.avgFix)}`,
      `- Ran with an issue still open: **${r.missed.length}**`,
    ];
    if (types.length) lines.push(`- Top issues: ${types.map(([k, v]) => `${label(k)} ${v.found}`).join(' · ')}`);
    if (people.length) lines.push(`- Marked fixed: ${people.map(([n, v]) => `${n} ${v}`).join(' · ')}`);
    if (r.tickets) lines.push(`- Tickets: ${r.tickets.opened} opened · ${r.tickets.done} done · ${r.tickets.todo} in To Do (${r.tickets.overdue} over 24 h)`);
    if (!r.recorded) lines.push('_No issue history was recorded for this period._');
    if (siteUrl) lines.push(`[📄 ${filename}](${siteUrl}/reports/${filename}) · [Overview](${siteUrl}/overview)`);
    return lines.join('\n');
  }

  // ---- PDF ----
  function pdf(r) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: r.title, Author: 'Race Day Dashboard' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const W = doc.page.width; const L = 36; const R = W - 36; const CW = R - L;
      let y = 0;

      // Header band.
      doc.rect(0, 0, W, 92).fill(C.navy);
      if (logoPath && fs.existsSync(logoPath)) { try { doc.image(logoPath, L, 18, { height: 56 }); } catch (e) { /* no logo */ } }
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('RACING', L + 74, 26, { continued: true }).fillColor(C.accent).text('HUB');
      doc.font('Helvetica').fontSize(10).fillColor('#aab4c3').text(r.kind === 'daily' ? 'DAILY DATA-QUALITY REPORT' : 'WEEKLY DATA-QUALITY REPORT', L + 75, 52, { characterSpacing: 1.2 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(r.kind === 'daily' ? longDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`, L, 30, { width: CW, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor('#aab4c3').text('Race dates · times in Sri Lanka time', L, 50, { width: CW, align: 'right' });
      y = 112;

      // KPI tiles.
      const tiles = [
        ['DATA QUALITY', r.score == null ? '-' : `${r.score}%`, r.scoreChange != null ? `${r.scoreChange >= 0 ? '+' : '-'}${Math.abs(r.scoreChange)} pts vs day before` : 'races with no open issue', r.score != null && r.score >= 90 ? C.ok : C.ink],
        ['RACES', String(r.races), r.kind === 'daily' ? 'on the day' : 'in the week', C.ink],
        ['ISSUES FOUND', String(r.found), `${Object.keys(r.byType).length} kinds`, C.ink],
        ['FIXED', String(r.fixed), `${pct(r.fixed, r.found) ?? '-'}% · avg ${fmtMinutes(r.avgFix)}`, C.ok],
        ['RAN WITH ISSUE', String(r.missed.length), 'started before a fix', r.missed.length ? C.bad : C.ok],
      ];
      const tw = (CW - 4 * 8) / 5;
      tiles.forEach(([k, v, sub, col], i) => {
        const x = L + i * (tw + 8);
        doc.roundedRect(x, y, tw, 70, 6).fill(C.mist);
        doc.rect(x, y, 3, 70).fill(col === C.ink ? C.accent : col);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted).text(k, x + 10, y + 10, { width: tw - 14, characterSpacing: 0.6 });
        doc.font('Helvetica-Bold').fontSize(20).fillColor(col).text(v, x + 10, y + 23, { width: tw - 14 });
        doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(sub, x + 10, y + 50, { width: tw - 14 });
      });
      y += 88;

      const section = (title, note) => {
        if (y > 740) { doc.addPage(); y = 40; }
        doc.font('Helvetica-Bold').fontSize(12).fillColor(C.navy).text(title, L, y);
        if (note) doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(note, L, y + 2, { width: CW, align: 'right' });
        y += 18;
        doc.rect(L, y, 34, 2).fill(C.accent);
        y += 8;
      };
      // cols: [{ h, w (fraction), align }]
      const table = (cols, rows, opts = {}) => {
        const rowH = opts.rowH || 17;
        const xs = []; let acc = L;
        cols.forEach((c) => { xs.push(acc); acc += c.w * CW; });
        const head = () => {
          doc.rect(L, y, CW, rowH).fill(C.navy);
          cols.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text(c.h, xs[i] + 6, y + 5, { width: c.w * CW - 12, align: c.align || 'left', lineBreak: false }));
          y += rowH;
        };
        head();
        if (!rows.length) {
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.muted).text(opts.empty || 'Nothing to show.', L + 6, y + 5);
          y += rowH + 10;
          return;
        }
        rows.forEach((row, ri) => {
          if (y + rowH > 800) { doc.addPage(); y = 40; head(); }
          if (ri % 2) doc.rect(L, y, CW, rowH).fill(C.mist);
          cols.forEach((c, i) => {
            const cell = row[i];
            const text = cell && typeof cell === 'object' ? cell.t : String(cell == null ? '' : cell);
            doc.font(cell && cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor((cell && cell.color) || C.ink)
              .text(text, xs[i] + 6, y + 5, { width: c.w * CW - 12, align: c.align || 'left', lineBreak: false, ellipsis: true });
          });
          y += rowH;
        });
        doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(C.line).stroke();
        y += 14;
      };

      if (!r.recorded) {
        doc.roundedRect(L, y, CW, 34, 5).fill('#fff4e2');
        doc.font('Helvetica').fontSize(9).fillColor(C.ink).text('No issue history was recorded for this period (the dashboard records issues for the current day every 5 minutes).', L + 10, y + 11, { width: CW - 20 });
        y += 48;
      }

      // Weekly: day by day bars (found vs fixed) with the quality %.
      if (r.kind === 'weekly') {
        section('Day by day', 'Issues found and fixed · data quality');
        const chartH = 120; const top = y; const max = Math.max(1, ...r.days.map((d) => d.found));
        const slot = CW / r.days.length; const bw = Math.min(22, slot / 3.2);
        doc.moveTo(L, top + chartH).lineTo(R, top + chartH).lineWidth(0.5).strokeColor(C.line).stroke();
        r.days.forEach((d, i) => {
          const cx = L + slot * i + slot / 2;
          const hf = (d.found / max) * (chartH - 18); const hx = (d.fixed / max) * (chartH - 18);
          doc.rect(cx - bw - 2, top + chartH - hf, bw, hf).fill(C.blue);
          doc.rect(cx + 2, top + chartH - hx, bw, hx).fill(C.accent);
          doc.font('Helvetica-Bold').fontSize(7).fillColor(C.ink).text(d.recorded ? `${d.found}/${d.fixed}` : 'no data', cx - slot / 2, top + chartH - Math.max(hf, hx) - 11, { width: slot, align: 'center' });
          doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(shortDate(d.date), cx - slot / 2, top + chartH + 4, { width: slot, align: 'center' });
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(d.score != null && d.score >= 90 ? C.ok : C.ink).text(d.score == null ? '' : `${d.score}%`, cx - slot / 2, top + chartH + 14, { width: slot, align: 'center' });
        });
        doc.rect(L, top + chartH + 30, 8, 8).fill(C.blue); doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('Found', L + 12, top + chartH + 30);
        doc.rect(L + 50, top + chartH + 30, 8, 8).fill(C.accent); doc.text('Fixed', L + 62, top + chartH + 30);
        y = top + chartH + 50;
      }

      section('Issues by type');
      const types = Object.entries(r.byType).sort((a, b) => b[1].found - a[1].found);
      table([{ h: 'Issue', w: 0.52 }, { h: 'Found', w: 0.16, align: 'right' }, { h: 'Fixed', w: 0.16, align: 'right' }, { h: 'Fixed %', w: 0.16, align: 'right' }],
        types.map(([k, v]) => [{ t: label(k), bold: true }, v.found, v.fixed, `${pct(v.fixed, v.found) ?? '-'}%`]), { empty: 'No issues recorded.' });

      section('By country', 'Countries with the most issues first');
      const countries = Object.entries(r.byCountry).sort((a, b) => b[1].found - a[1].found).slice(0, 18);
      table([{ h: 'Country', w: 0.34 }, { h: 'Issues', w: 0.22, align: 'right' }, { h: 'Fixed', w: 0.22, align: 'right' }, { h: 'Ran with issue', w: 0.22, align: 'right' }],
        countries.map(([k, v]) => [{ t: k, bold: true }, v.found, v.fixed, { t: String(v.missed || 0), color: v.missed ? C.bad : C.ink }]), { empty: 'No issues recorded.' });

      section('Marked fixed by', 'Fixed / Updated pressed on the dashboard');
      const people = Object.entries(r.byPerson).sort((a, b) => b[1] - a[1]);
      table([{ h: 'Person', w: 0.7 }, { h: 'Issues marked fixed', w: 0.3, align: 'right' }],
        people.map(([n, v]) => [{ t: n, bold: true }, v]), { empty: 'Nobody marked an issue fixed on the dashboard (issues that cleared in the data still count as fixed above).' });

      if (r.tickets) {
        section('ClickUp tickets');
        table([{ h: 'Opened', w: 0.25, align: 'right' }, { h: 'Done', w: 0.25, align: 'right' }, { h: 'Still in To Do', w: 0.25, align: 'right' }, { h: 'To Do over 24 h', w: 0.25, align: 'right' }],
          [[r.tickets.opened, r.tickets.done, r.tickets.todo, { t: String(r.tickets.overdue), color: r.tickets.overdue ? C.bad : C.ink }]]);
      }

      section('Races that ran with an issue still open', `${r.missed.length} race issue${r.missed.length === 1 ? '' : 's'}`);
      const missedCols = r.kind === 'daily'
        ? [{ h: 'Jump', w: 0.09 }, { h: 'Race', w: 0.27 }, { h: 'Type', w: 0.13 }, { h: 'Issue', w: 0.2 }, { h: 'Detail', w: 0.31 }]
        : [{ h: 'Date', w: 0.13 }, { h: 'Jump', w: 0.08 }, { h: 'Race', w: 0.26 }, { h: 'Type', w: 0.12 }, { h: 'Issue', w: 0.18 }, { h: 'Detail', w: 0.23 }];
      table(missedCols, r.missed.slice(0, 80).map((m) => {
        const base = [localTime(m.startUtc), { t: `${m.meeting} R${m.rNo} (${m.country})`, bold: true }, DISCIPLINES[m.discipline] || m.discipline || '', label(m.code), m.detail];
        return r.kind === 'daily' ? base : [shortDate(m.date), ...base];
      }), { empty: 'Every issue was fixed before its race started.' });
      if (r.missed.length > 80) doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(`+ ${r.missed.length - 80} more`, L, y - 8);

      // Footer on every page.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0; // writing in the bottom margin must not start a new page
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
          .text(`Race Day Dashboard${siteUrl ? ` · ${siteUrl.replace(/^https?:\/\//, '')}` : ''}`, L, 815, { width: CW / 2, lineBreak: false })
          .text(`Page ${i - range.start + 1} of ${range.count}`, L + CW / 2, 815, { width: CW / 2, align: 'right', lineBreak: false });
      }
      doc.end();
    });
  }

  function periodFor(kind, today) {
    if (kind === 'daily') { const d = shiftDate(today, -1); return { from: d, to: d }; }
    // Last full week, Monday to Sunday.
    const { weekday } = localNow(new Date(`${today}T12:00:00Z`));
    const thisMonday = shiftDate(today, -(weekday - 1));
    return { from: shiftDate(thisMonday, -7), to: shiftDate(thisMonday, -1) };
  }

  // No ClickUp task any more (27 Oct 2026, per Dinesh: "Weekly Report a
  // ticket open panna wena, ada inda chatla podunga"): the report goes to the
  // "Weekly data report" Chat channel only. ClickUp Chat can't carry a file,
  // so the PDF is kept in the data folder (reports/, the newest 26) and the
  // message links to it on the dashboard (admins, /reports/<file>).
  async function send(kind, period) {
    if (!clickup.reportChannelId) throw new Error('The report Chat channel is off (CLICKUP_REPORT_CHANNEL_ID)');
    const r = await build(kind, period.from, period.to);
    const buf = await pdf(r);
    const filename = `${kind}-report-${period.from}${kind === 'weekly' ? `-to-${period.to}` : ''}.pdf`;
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(path.join(pdfDir, filename), buf);
    const old = fs.readdirSync(pdfDir).filter((f) => f.endsWith('.pdf')).sort((a, b) => fs.statSync(path.join(pdfDir, b)).mtimeMs - fs.statSync(path.join(pdfDir, a)).mtimeMs).slice(26);
    old.forEach((f) => { try { fs.unlinkSync(path.join(pdfDir, f)); } catch (e) { /* next time */ } });
    await clickup.postChat(chatText(r, filename), clickup.reportChannelId);
    state.last = { kind, from: period.from, to: period.to, at: new Date().toISOString(), file: filename, chat: true };
    return state.last;
  }
  // A saved report PDF by name, or null.
  function pdfFile(name) {
    if (!/^(daily|weekly)-report-[\d-]+(?:-to-[\d-]+)?\.pdf$/.test(String(name || ''))) return null;
    const file = path.join(pdfDir, name);
    return fs.existsSync(file) ? file : null;
  }

  // Called every few minutes: sends whatever is due and not sent yet.
  async function runDue(nowDate = new Date()) {
    if (!clickup || !clickup.enabled) return null;
    const { date, hour, weekday } = localNow(nowDate);
    if (hour < SEND_HOUR) return null;
    if (state.lastErrorAt && Date.now() - state.lastErrorAt < RETRY_AFTER_MS) return null;
    const sent = [];
    try {
      if (daily && state.daily !== date) {
        await send('daily', periodFor('daily', date));
        state.daily = date;
        sent.push('daily');
      }
      if (weekday === 1 && state.weekly !== date) {
        await send('weekly', periodFor('weekly', date));
        state.weekly = date;
        sent.push('weekly');
      }
      state.lastError = null; state.lastErrorAt = 0;
    } catch (err) {
      state.lastError = err.message; state.lastErrorAt = Date.now();
      console.warn(`[race-dashboard] WARNING: report failed: ${err.message}`);
    }
    save();
    return sent;
  }

  async function previewPdf(kind, dateStr) {
    const today = dateStr || localNow().date;
    const period = kind === 'weekly' ? periodFor('weekly', today) : { from: dateStr || shiftDate(today, -1), to: dateStr || shiftDate(today, -1) };
    const r = await build(kind, period.from, period.to);
    return { buf: await pdf(r), filename: `${kind}-report-${period.from}.pdf`, report: r };
  }

  function status() {
    return { enabled: Boolean(clickup && clickup.enabled), dailyOn: daily, daily: state.daily, weekly: state.weekly, last: state.last, lastError: state.lastError, sendHour: SEND_HOUR, chat: Boolean(clickup && clickup.reportChannelId) };
  }

  // Admin "send now" (System Health): this period's report straight to ClickUp.
  async function sendNow(kind) {
    const period = periodFor(kind === 'weekly' ? 'weekly' : 'daily', localNow().date);
    const last = await send(kind === 'weekly' ? 'weekly' : 'daily', period);
    save();
    return last;
  }

  return { build, pdf, markdown, runDue, previewPdf, sendNow, status, localNow, pdfFile };
}

module.exports = { createReports };
