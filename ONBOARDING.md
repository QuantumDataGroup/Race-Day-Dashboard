# Race Day Dashboard — Handover / Technical Documentation

A single-server Node.js/Express app that shows one day's horse/harness/greyhound
race schedule as a **Meeting × Race-number grid**, flags data-quality problems
automatically, and lets you click through to full race and runner detail.

Production URL: `https://racedaydashboard.troyendata.com/`

---

## 1. Architecture — what each file does

```
server.js            Express routes, MongoDB queries, external-API fetches,
                      all the "attach a status flag to this doc" functions,
                      report/export generation (CSV/Excel/JSON/PDF), auth.
raceView.js           Pure functions, no DB/network access: turns raw race
                      docs into the schedule grid, the race/runner detail
                      payload, and renders every HTML page from templates.
                      Also home of every data-quality-check RULE (thresholds,
                      "what counts as an issue").
db-config.js          Shared helper: reads db.json, extracts a Mongo
                      connection string by connection name.
setup-auth.js         Run manually on the server to set/change the
                      dashboard's single login username + password.
prune-ignores.js       One-off cleanup utility (see §12) — not part of the
                      running app.
run.bat               Convenience local launcher (installs deps, starts
                      server.js, opens Chrome). NOT what production uses —
                      production runs as a WinSW Windows Service instead
                      (see §10).
views/dashboard.html  Main page template + ALL client-side JavaScript
                      (silk rendering, popups, filters, search, exports,
                      the Speed Map bar chart, the Chart tab's SVG, etc.)
views/login.html      Login page template.
views/meetings-list.html  Date-range "flat list of meetings" page template.
public/styles.css     All CSS (dark/light theme via CSS variables).
public/logo.png       Brand mark, also used as the browser-tab favicon.
public/discipline-icons/, public/silks/, public/greyhound-silks/,
public/speedmap-icons/   Static image assets referenced by the pages above.
```

Every template file under `views/` and `raceView.js`/`server.js` themselves
are loaded ONCE via `fs.readFileSync` at server startup — **editing any of
these requires a full process restart** to take effect. `public/styles.css`
is the one exception: it's served fresh on every request via
`express.static`, so a plain browser refresh picks up CSS changes without a
restart (a restart is still harmless/recommended for consistency).

---

## 2. Data sources

### MongoDB
- Connection: via `db-config.js`, reading a config file (see §10) for a
  connection string keyed by name **`mongodb-prod`**.
- Database: whatever the connection string's own path segment points to
  (confirmed in production: **`Troyen_Prod`**).
- Collections actually read by this app:
  - **`races`** — the core collection. One document per race, with a
    `runners[]` array embedded inside (tabNo, horseName, jockey, trainer,
    isScratched, age, sex, bp, fp, colors/silk description, etc.). Every
    discipline (Thoroughbred/Harness/Greyhound) lives here.
  - **`racecards`** — **Thoroughbred only**. A richer per-runner feed
    (multiple "Style/Client" source variants per race) with sire/dam,
    pastRaces (FormLines), performanceStatistics, runnerComment,
    currentOdds, weightKg, form-figures, race-level comment/weather. Joined
    onto the `races` doc by `RaceId`/`RunnerId` in `attachFormLineStatus`.
  - **`datadumps`** — a separate, richer per-runner feed (used for the raw
    "Data Dump" debug tab and as a fallback source for narrative comments).
  - **`meetings`** — one doc per meeting: `isTAB`, `isHidden`,
    `rsMeetingId` and `tabMeetingId` (two DIFFERENT external-system ids,
    see the Speed Map / Scratchings checks below — do not confuse them).
  - **`speedMaps`** — one doc per race (`rId` == `races._id`), with a
    `predictions[]` array of per-runner barrier/settling/closing speed
    measures + a pace rating/category. Only fetched for the single race a
    popup is open on, not the whole grid.

### External HTTP APIs (fetched server-side, per date)
- **Speed Map source**: `http://57.181.204.168:8085/getStatsGrey/{date}`
  — Greyhound-only predictions feed. Each row's `EventID` is shaped
  `"<rsMeetingId>:<raceNo>"`; joined to our own races via
  `meetings.rsMeetingId` (verified exact match against real data).
- **Scratchings source**:
  `http://57.181.204.168:8085/getScratchingsGrey/{date}` — covers ALL
  three disciplines. Each meeting's `MeetingID` matches
  `meetings.tabMeetingId` (**not** `rsMeetingId` — a different id space,
  confirmed against real meetings). Runners inside are matched to our own
  by tab/box number (`RunnerNo` ↔ `tabNo`).
- **Video listing**: `https://s3.troyendata.com/rob-rp-videos/` — an S3
  bucket file listing, used to check whether a video exists for
  today's race (by building the expected S3 key from
  date+country+course+race-number) and for past races (by horse's region).
- **Country flags** (client-side only, not fetched by the server):
  `https://flagcdn.com/20x15/{iso2}.png` — a free public flag-image CDN.

### Local JSON config/override files (all outside the git repo — see §10)
- `db.json` — Mongo connection string(s).
- `auth.json` — dashboard login (`username`, bcrypt `passwordHash`,
  session secret).
- `form-line-ignores.json`, `age-ignores.json`, `dup-jockey-ignores.json`,
  `missing-jockey-ignores.json` — the four manual "Confirm/Ignore" override
  stores (see §6).

---

## 3. How the schedule grid gets built (request lifecycle for `/`)

1. `fetchRaceDocs(dateStr, includeTrials)` (server.js) queries `races` for
   that date, joins in `meetings` extras (isTAB/isHidden/rsMeetingId/
   tabMeetingId), then runs 4 "attach a status" passes in parallel:
   `attachFormLineStatus` (racecards join, Thoroughbred only),
   `attachVideoStatus` (S3 listing), `attachSpeedMapStatus` (external Speed
   Map feed, Greyhound only), `attachScratchingStatus` (external
   Scratchings feed, all disciplines). A 60-second in-memory cache
   (`raceDocsCache`, keyed by `date|includeTrials`) avoids re-querying Mongo
   on every request.
2. `buildSchedule(docs, dateStr)` (raceView.js) groups races into meetings
   (course+country+discipline), computes every per-race and per-meeting
   issue flag (§4), and produces the `{ byDiscipline, countries }`
   structure the grid is rendered from.
3. `renderHtml(...)` fills the `views/dashboard.html` template.

**Speed (1 Oct 2026).** Everything slow goes through `cached()` in
server.js: fresh for a short TTL, then the old value is served instantly
while one background refresh runs. The day's race docs (60 s fresh, 10 min
stale), each race popup (30 s / 60 s), the three external feeds (per date,
shared by the grid and popups), search and the Upcoming ticker. Manual
confirms are applied on every read (`applyAllIgnores`), so nothing has to
clear the cache. The grid reads a light racecards aggregation (form-line
counts + comments, ~3 MB) instead of full past-race history (~49 MB);
only the popup loads full racecards. Today's data is kept warm while the
dashboard has been used in the last 30 min, and opening a race prefetches
the other races at that meeting. Measured: cold dashboard 43 s → instant
for today (15 s for a date nobody has opened yet), race popup 3-5 s → 1.2 s
first time, instant after.

Clicking a race calls `GET /api/race/:id` → `fetchRaceById` (a DIFFERENT,
single-race fetch path — same racecards/video/speedMap/scratchings joins,
but scoped to one race, no 60s cache) → `buildRaceDetail` → returned as
JSON and rendered client-side into the popup (or, via a `/race/...`
link, as a full standalone page — see §7).

---

## 4. Data-quality checks — the complete list

Every check below can be filtered on via the dashboard's **"All Issues"**
dropdown, and a meeting's Status column (✓ / ⚠) opens a race-by-race
breakdown of exactly which checks fired.

**Abandoned races raise no issues** (20 Oct 2026, per Dinesh): `ABANDONED_QUIET` in raceView.js empties every issue field of an abandoned race in the schedule (grid, meeting Status, Data quality, alerts, UK/US notifications) and the popup shows no runner issues for it.

| Check | Scope | Discipline | Trigger |
|---|---|---|---|
| **Missing Jockey** | per-runner (meeting flagged if >0 in any race) | Thoroughbred + Harness only | `jockey` field blank, and not manually confirmed-no-issue |
| **Duplicate Jockey** | per-runner | T + H only | Same (non-placeholder) jockey name assigned to more than one runner in the same race |
| **Missing/Duplicate TAB number** | per-runner | all | Runner has no tab number, or shares one with another runner in the race |
| **Missing Trainer** | per-runner | all | `trainer` field blank |
| **Missing Form Lines** | per-race count, meeting flagged if count > 3 | Thoroughbred only | Runner has no racecards FormLines data from ANY feed variant. First starters (racecard career `0:0-0-0`) are skipped |
| **Horse Age Issue** | per-runner | Thoroughbred only | Age > 10 years, and not manually confirmed-no-issue |
| **Missing Runner Comment** | per-runner | Thoroughbred only | No `runnerComment` on the racecards join. The comment that names the horse ("RICO (10) ...") wins over the RunnerId match, since a racecard written before the field changed has its comments on the old tabs' RunnerIds (`runnerCommentFor`, 18 Oct 2026) |
| **Comment Tab Wrong** | per-runner | Thoroughbred only | The runner comment names this horse with another tab number ("RICO (10)" while Rico is now 13) -- written before the field changed. `commentNamedTab` (server.js) reads the number, `commentTabWrong` (raceView.js) compares; filter code `commenttab` (19 Oct 2026) |
| **Race Comment Tab Wrong** | per-race | Thoroughbred only | The (AU) race comment gives a horse another tab ("CITY GOLD SPEED (7)" while it is 8). Filter `racecommenttab` |
| **Unknown Horse in Race Comment** | per-race | Thoroughbred only | A CAPITALS name + (tab) in the race comment that is no runner here, not even misspelt ("HORSE NAME (3)" templates, a copied comment). 4+ letters only. Filter `racecommentunknown` |
| **Comment Names Wrong Horse** | per-runner | Thoroughbred only | The runner comment starts with another name ("HORSENAME (1)", "DON'TPUSHSEND (6)" on Don'tmindameeting) and does not name this horse further in. Filter `commentwronghorse` |
| **Horse Name Misspelt** | race + runner comments | Thoroughbred only | A name a few letters off ("HEADCUNTER" = Headhunter; up to 25% of the letters, swaps count once). A short form ("DARCY" for Dominant Darcy) is fine. Filter `namemisspelt`. All four: `raceCommentCheck` / `runnerCommentCheck` in server.js, `commentChecks` in raceView.js (19 Oct 2026) |
| **Horse Name Missing in Comment** | race + runner comments | Thoroughbred only | The template word left in, no name: "HORSENAME (1) was always chasing ..." / "HORSE NAME (3)" (Strathalbyn R5 21 Oct 2026). Not counted as misspelt / unknown. Filter `namemissing` |
| **Runner Comment Problem** (code `ai-comment`; never shown as "AI") | per-runner | Thoroughbred only | A running horse whose runner comment says it is SCRATCHED ("SYDNEY DOLLARS (5) is SCRATCHED."). Filter `aicomment` |
| **Missing Race Comment** | per-race | Thoroughbred only | No race-level narrative comment |
| **Missing Video** | per-race, TODAY's date only | Thoroughbred, AUS/GB/SAF/IRE | No matching file in the S3 video listing |
| **Missing Speed Map** | per-race | Greyhound only | The external Speed Map feed HAS a prediction for this race, but our own `speedMaps` collection doesn't (a genuine sync gap, not "no prediction made yet") |
| **Scratching Not Updated** | per-race AND per-runner | all | The external Scratchings feed lists a runner (by tab/box number) as scratched, but our own race doc doesn't have that runner marked `isScratched` yet |
| **Scratched Runner in Comment** (15 Oct 2026) | per-race: every race from tomorrow on, plus today's races still more than 12 h from the jump (a runner scratched closer to the race is a late scratching, not an issue) | Thoroughbred (wherever there's a race comment) | The race comment still mentions a runner scratched in our race doc — by tab number in brackets "(8)" or by the horse's name in capitals (`scratchedInComment` in raceView.js). The popup shows a warning and strikes the name through in the comment |
| **Results Missing** | per-race | all | This race has no result, but a LATER race (higher race number) at the SAME meeting already does — abandoned races and trials are excluded (no result is ever expected there) |
| **Time Mismatch** | per-race | all, AUS/MEX/PAN/SPA/CHI/ARG/URU/BRZ/SAU/GB/IRE | A race not run yet whose RAS API start time (Neds day page when RAS fails) is more than 2 min from ours. Popup **Ignore** (per race + that RAS time). See "Time mismatch (RAS)" below |
| **Schedule Issue** | per-race | all | Either: (a) scheduled time is a placeholder `00:00`, (b) two races at the same meeting share the exact same scheduled time, or (c) this race is scheduled less than 15 minutes after the previous race at the same meeting |

Two meeting-level filter options aggregate the above: **"Meetings with
Issues"** (any check above fired) and **"Healthy Meetings"** (none did).
`ABBN` is a separate status tag (a race is abandoned) — shown, but never
counted as a "data problem" issue.

---

## 5. Manual override system ("Confirm / Ignore")

Four of the checks above can be manually cleared by a logged-in user when
someone has actually verified the real source and confirmed it's not a real
problem (e.g. a genuine first-starter with no form, confirmed via the
"Site for check" link — see §7):

| Override | Keyed by | Endpoint |
|---|---|---|
| Missing Form Lines | `runnerId` | `POST /api/runner/:runnerId/form-ignore` |
| Horse Age Issue | `runnerId` | `POST /api/runner/:runnerId/age-ignore` |
| Duplicate Jockey | `raceId` + jockey name | `POST /api/race/:raceId/jockey-ignore` |
| Missing Jockey | `raceId` + `runnerId` | `POST /api/race/:raceId/runner/:runnerId/missing-jockey-ignore` |

Each writes to its own local JSON file (see §2) with who confirmed it and
when, and clears the 60-second race-docs cache immediately so the grid
reflects it without delay.

---

## 6. Pages & features

### Admin area access
The Admin link opens four section buttons: **User Activity** (`/admin`,
the default), **System Health** (`/system-health`), **Data Changes**
(`/changes`) and **Missing Data** (`/missing-meetings`). Admins get all
four plus user management. Anyone else gets
only the sections an admin ticked for them when adding the user (or later
with "Access"), stored as `permissions` on the user; with none ticked they
see just the dashboard. User Activity for a non-admin is read-only.
Every non-admin also has a **type**, picked when adding the user (required)
or later in "Access": **USER** (`type: 'work'`, `access.work`) can make
dashboard changes — Confirm / Ignore buttons, runners-check and
missing-meeting Ignore, issue status, tickets, the alerts bell — while
**VIEW** looks only: pages get `html.view-only` (styles.css hides the change
buttons) and those routes answer 403 (`requireWork`). The type is separate
from the sections ticked. Users saved before 12 Oct 2026 without a type
count as USER if they had a section ticked, VIEW otherwise (`userType`).

### Data Changes (`/changes`)
What was added, removed or changed in meetings/races after each scrape
(e.g. a missing jockey filled in = "Fixed", a runner scratched, race time
moved, result arrived, meeting/race/runner added). The database has no
change feed (not a replica set), so every 2 minutes the server re-reads
races whose `updatedAt` moved (plus a full re-read every 30 minutes) for
yesterday..today+2 and compares them with a snapshot
(`data-changes-snapshot.json`). Changes go to one file per race date,
`data-changes-YYYY-MM-DD.jsonl`, kept 30 days (`change-tracker.js`). A
date entering the window for the first time is recorded silently. Odds
are not tracked.

### Missing Data (`/missing-meetings`)
Two sub-tabs: **Missing Meetings** (below) and **Missing / Mismatched Runners**
(`#runners`, `/api/missing-runners`): every race where the last runners
check (see Runners check) found a Runner Missing / Runner Mismatched /
Runner Count Mismatched that is still true in our DB, with filters.

Missing Meetings: Thoroughbred meetings the Scratchings feed (`getScratchingsGrey`, which
lists every meeting of the day) has for UAE, KOR, MAL, MUS, ARG, BRZ, CHI,
GER, DEN, ITY, SAU, SWE and CAN, for today to 2 days ahead, compared with
our `meetings` collection (`missing-meetings.js`). Matched on the feed's
MeetingID (= `meetings.tabMeetingId`), else on date + country + course name
ignoring surface words (the feed splits WOODBINE / WOODBINE AW where we
have one WOODBINE). Shows our meeting name + OK, or Missing. Uses the same
cached feed fetch as the scratching check (one retry, since the feed often
504s). **Ignore** on a Missing row (for a meeting nobody needs or that
can't be added) stops it counting as missing; Undo brings it back. Saved
by the server in `missing-meeting-ignores.json` next to the other ignore
files (`MISSING_MEETING_IGNORE_PATH`), keyed by the feed MeetingID, with
who/when; entries for dates over a week old are dropped. Logged in User
Activity as a confirm. **Countries** (admins only): add/remove which
countries are checked; saved in `missing-meeting-countries.json`
(`MISSING_MEETING_COUNTRIES_PATH`), defaulting to `DEFAULT_COUNTRIES` in
missing-meetings.js until first changed. Countries with thoroughbred
meetings in the feed that aren't checked are offered as quick-add chips.
An earlier version used RAS `GetMeetingsByCountry` on
nextdc.racingandsports.com.au:8813, which production can't reach.

**Missing meeting alerts (25 Oct 2026):** WOODBINE was in the feed and nobody
picked it up. The feed has no timestamps, so `noteFirstSeen` keeps when our
check first saw each feed MeetingID (`missing-meeting-seen.json` in the data
folder, 7 days). The page shows "RAS: …" under the meeting ("RAS: before …"
for one already there on the server's first check of that date, after a restart
/ deploy) and "DB: …" in the Status column (the meeting's `createdAt`, a UTC
string) to the master admin only:
`MASTER_ADMINS` (usernames, default `Dinesh`); `/api/missing-meetings` leaves
both out for everyone else. The alerts don't carry the feed time. Every 5 min `dispatchMissingMeetingAlerts` runs the check: a meeting
still missing (not ignored) 30 min after it first showed (`MISSING_ALERT_AFTER_MIN`,
time for the scraper to add it normally) is pushed once (`mm|` in
`alerts-sent.json`, 4 days) to admins and users with the Missing Data section,
naming the meeting, click → `/missing-meetings`; over 3 at once become one
summary. `/api/alerts` also returns them (`missingMeetings`) for those users,
so the bell lists them at the top and pops them up, until added or ignored.
The same run also sends one **Telegram** message to Dinesh (`TELEGRAM_BOT_TOKEN`
+ `TELEGRAM_CHAT_ID`, set in Portainer only; off without them) and one ClickUp
Chat message to the team's "New Meetings Need to Scrape" group (`2kz0m0zv-12476`;
`CLICKUP_MISSING_CHANNEL_ID` overrides, `off` stops it), each with its own keys (`mmt|`, `mmc|`) so a failed send is
retried on the next run. System Health row "Missing meeting alerts".

**Missing video alerts (25 Oct 2026):** every 5 min `dispatchVideoAlerts` posts to
the ClickUp Chat group "Missing Videos" (`2kz0m0zv-12496`; `CLICKUP_VIDEO_CHANNEL_ID`
overrides, `off` stops it) once per meeting when its first race is 2 h, 1 h and
30 min away (`VIDEO_ALERT_MILESTONES`, keys `mv|` in `alerts-sent.json`; after a
restart only the latest milestone passed is sent), listing its races not run
yet with Missing Video. The race popup's **Ignore** next to "Videos not available"
(`POST /api/race/:raceId/video-ignore`, `video-ignores.json` in the data folder,
3 days, Undo in the popup) stops both the dashboard flag and the message.
System Health row "Missing video alerts".

**Snooze (25 Oct 2026):** pushed alerts carry `snooze: { kind: 'race' | 'mm', ids }`,
and sw.js adds "Snooze 10 min" / "Snooze 30 min" buttons (PC + Android; iPhone
shows none). A button posts to `/api/alerts/snooze-push` (public path: the login
cookie if there is one, else the push subscription's endpoint → `push.userOf`).
The bell has "Snooze all" (30 min / 1 h / 2 h, "Turn back on") and "Snooze 10 min"
per race / missing meeting (`POST /api/alerts/snooze`). `deliverSnoozed` (every
minute) brings an alert back to that user only if it's still open; snooze-all
users get no pushes or pop-ups meanwhile (the bell still lists everything).
`/api/alerts` returns `snoozedUntil`, `snoozed` and `reminders` (came back in the
last 15 min, popped up by the page when the device has no push). State in
`alert-snooze.json`.

**Comment fact check (27 Oct 2026, master admin only):** `comment-facts.js`
checks what the race comment and runner comments say about a horse's form
against its racecard FormLines / PerformanceStatistics / form figures: last-start
win, recent win, last-start placing ("close second" beaten > 2.5L), result at a
course, step up / drop in class (GB/IRE Class 1 = top; AUS/NZ BM, Class, Maiden;
Group/Listed everywhere; mixed scales aren't compared), first-up / after a break
(< 42 days = wrong), maiden / yet to win, debut, track / distance record.
Keyword rules only, no AI. Negated phrases ("lacks recent success") and
qualified ones ("yet to win over hurdles") are skipped, and one phrase gives one
finding. `commentFactsFor` (server.js) gives each race-comment claim to the
horse named before it in the sentence ("the former" → the earlier horse). The
popup shows a "Comment check · only you" box (`/api/race/:id` sends
`commentFacts` only to `isMasterAdmin`). `dispatchCommentFactAlerts` (every 10
min, T races in the next 12 h, today + tomorrow, rechecked when the comments
change or after an hour) pushes new findings to `MASTER_ADMINS` only (key
`cf|raceId|hash`, snooze kind `cf`), opening the **Comment Checks** page
(`/comment-checks`, `views/comment-checks.html`, data from `/api/comment-checks`;
an Admin tab when `access.commentChecks`: the `commentChecks` permission,
every admin, and users ticked "Comment Checks" on the Admin page since 28 Oct
2026 — master admins only before; the popup's Comment check box follows it,
Ignore needs a User (not View) login; 25 a page with the shared pager). Not in the bell (per Dinesh: on its own page). Each row has
its race, Open race and **Ignore** (28 Oct 2026): `POST /api/comment-checks/ignore`,
key `raceId|tab|where|claim|quote`, kept 3 days in `comment-check-ignores.json`;
an ignored finding stays greyed with Undo, isn't counted, isn't in the popup
box and is never pushed. System Health row "Comment fact check".
The findings are only as good as the form lines: a run missing from them can
make a correct comment look wrong.

### Runners check (`runners-check.js`)
Every 8 hours the server compares runners with ours, for today to 2 days
ahead, for meetings we have: AUS + NZ (all three codes) plus the Missing
Data countries (thoroughbred). Every run reads both sources at the same
time (since 8 Oct 2026; they used to take turns): the RAS API
(`http://nextdc.racingandsports.com:9542/api/v1/neds/meetings?date=`, one
request per day) and the nedsform.com.au website (one page per day + one
per race we have, two at a time, ~5 min). `mergeRunnerChecks` shows the
differences from both, each tagged with its source (`src`: ras / neds /
both; the same difference from both shows once) -- the two sometimes list
a race differently, and Dinesh's team checks and Ignores the ones that are
fine. Jockey Missing is always from Neds; the 3-hourly jockey check keeps a
race's RAS flags and replaces its Neds ones. If one source fails, the other
is used alone. "Check now" on
Missing Data > Missing / Mismatched Runners runs it at once (at most once
every 10 minutes). Races already resulted are skipped.
Flags: Runner Missing (in the source, not ours), Runner Mismatched (cut-off
name / not in the field / scratched there), Runner Count Mismatched, and a
whole field that doesn't match. Runners are matched by name (the API's tab
numbers can be shifted); its scratched flag lags, so "running there,
scratched in ours" is not flagged. Neds dates overseas meetings by the AUS
day, so for overseas Neds meetings the day is picked by start times (median
gap within 6 h), then races pair by number; AUS/NZ go by date + race
number. A track listed twice for one day (Neds had two "Globe Derby"
meetings on 7 Oct 2026, the second with its own R3 and a later R4) is
merged into one; when two source races share a number, ours pairs with the
one starting closest to it, and one over 3 h away is not ours and is
skipped. "Vacant Box" (an empty greyhound box, RAS only), "TBD"/"TBA" placeholders
and nameless runners are not runners: left out of every comparison and
count on both sides (`isVacantBox`). Names that differ only in spacing
("EMOZIONEDEFLORINAS" / "Emozione De Florinas") or by an "AA" (Anglo-Arab)
suffix count as the same horse. On the Neds
website a runner of ours that isn't listed is not an issue (Neds leaves
runners off its pages), so from Neds only extra runners, a Neds count
higher than ours, and a field that doesn't match are flagged -- "not in
field" and "Neds has fewer" come from RAS only. Shown in the runner's Issue column, the
grid flag/Issues filter, popup lines, the Runners column of Missing
Meetings and its own sub-tab. Result in `runners-check-state.json` in the
logs folder (restarts don't add runs; a run where both sources fail retries
hourly); System Health shows the source used and the next one.
**Ignore** on an issue in the runners list hides it from the grid, popup and
Runners column (saved in `runner-check-ignores.json` next to the other
ignore files, `RUNNER_CHECK_IGNORE_PATH`; keyed by race + kind + runner +
text, so a changed count/name shows again; Undo brings it back; entries
over a week old are dropped). Logged in User Activity as a confirm.

### Jockey check + Neds politeness (server.js)
When the Neds website is the source, jockeys (blank in ours / different)
give "Jockey Missing (name)" when ours is blank. Jockey names that differ are
not compared (Dinesh, 6 Oct 2026). The RAS API has no jockeys, barriers or
weights. Since 28 Oct 2026 the Neds race page's `Barrier` and `Weight.Total`
are compared too: **Barrier Missing (n)** when our `bp` is blank/0 and Neds
has one (a normal runner issue for everyone; Missing Data counts it with
Jockey Missing), and a **big weight difference** — ours blank, or
`WEIGHT_DIFF_KG` (2) kg or more off (`big: true` items). Weight items are
kept out of the runner issues and go to `MASTER_ADMINS` only (popup "Weight
check · only you" box via `doc.weightChecks`, push via
`dispatchWeightAlerts`, key `wt|raceId|tab|text`) until `WEIGHT_ISSUES=all`
makes them normal runner issues for everyone (Dinesh: "na soldre apram
ellarukku podunga"). A separate **jockey check** runs every
`JOCKEY_CHECK_EVERY_MS` (3 h; Dinesh may ask for 2 h): races starting in the
next 24 h that still have a running horse with no jockey, plus every T / H
race in the next `WEIGHT_CHECK_WINDOW_MS` (12 h) for barrier / weight, one
Neds page a second, updating those races' result. Every Neds request goes
through `fetchNeds()`: gaps between requests, and on a 429/403 all Neds
requests pause for 6 hours (`jockey-check-state.json`); the runners check
then uses RAS. System Health shows a "Jockey / barrier / weight check (Neds)"
row and any pause.

### Overview (`/overview`) + issue workflow (Oct 2026)
For admins and users given the **Overview** permission (Admin → Users →
Access; it does not add the Admin link). `/api/overview` builds today's
schedule (`fetchRaceDocs` + `buildSchedule`) and lists every issue with
raceView.js `collectIssues` — one entry per race + kind, keyed
`${raceId}|${code}`, the same `raceIssueList` the grid's warning icon uses.
Shows KPIs (quality % = races with no open issue, races, open / critical /
in progress, fixed today + average fix time, next 60 min), the **Next 60
minutes** queue (Critical ≤ 30 min, High ≤ 60 min, countdown), quality by
country, open issues by type, a 7-day trend and all open issues with
filters. Each issue can be **Start fixing** (In progress, you become the
owner) / **Mark fixed** / Reopen, with a note (`POST /api/issues/status`).
`issue-tracker.js` keeps it in the data folder: `issue-workflow.json`
(statuses) and `issue-history/<date>.json` (when each issue was first/last
seen and when it went away), recorded every 5 min for today — the trend
and fix times start the day this went live. Kept 40 days.

### Tickets (`/tickets` admins, `/my-tickets` everyone) — ClickUp (Oct 2026)
`clickup.js`. Off until the server has `CLICKUP_API_TOKEN` and
`CLICKUP_LIST_ID` (Portainer env; never in code/chat) — pages and the
popup then say "not connected". Race popup: a **ClickUp ticket** bar lists
the race's issues (from the grid cell's `data-issues`); a button opens a
prefilled form (title, `ticketDetails`: race + name, code / class /
distance, jump time local / Sri Lanka / UTC, status, runners, race ID, the
issue and the runners with it — no race link or "Raised from" line since 28
Oct 2026, per Dinesh; priority from the start time, optional developer) →
`POST /api/tickets`, assigned to the first admin with a ClickUp email (or
`CLICKUP_OWNER_EMAIL`), tags data-issue / issue / country. New tickets go to
the **"Support related tasks"** list (`901613174764`, `CLICKUP_TICKET_LIST_ID`
overrides; 28 Oct 2026); `CLICKUP_LIST_ID`'s list is still read for older
tickets. From the support list only the dashboard's tickets (tag `data-issue`
or in `tickets.json`) are listed and reminded — never the team's other tasks.
One open ticket per issue (duplicates link to the existing one).
**All tickets** (admin): tickets in the list assigned to them, To Do / In
Progress / Review / Done / Ignored, developer dropdown (adds the assignee in
ClickUp + a comment), Ignore (dashboard only), "Data now" (issue still in
the data or fixed). **My tickets**: tickets the user raised (dashboard) or
created in ClickUp (matched by the user's ClickUp email — Admin → Users →
Email). Reminders: a ClickUp comment (notify all) at 1, 2, 3, 6, 12, 24 h
while a ticket is To Do, then daily (checked every 10 min).
`tickets.json` (data folder) links tickets to issues, raisers, reminders,
ignores. The list (Quantum Data Group → Troyen Data → "Race Day Dashboard
Issues") has Backlog, To Do, In Progress, Need Update, On Hold, Review, Done:
new tickets start in To Do; Backlog/To Do count as To Do, Need Update/On
Hold as In Progress, and only a closed status as Done (ClickUp files Review
under its "done" group — `statusKey`).

### Comments from the racecard API (20 Oct 2026)
The comment warnings check the comments **as clients get them**: the Troyen racecard API
(`RACECARD_API_URL`, default `https://external.troyendata.com`, no key; the same API runs on
this host at :7503, swagger at /swagger). `GET /api/v1/Race/racecard/{raceId}?language=EN&style=AU&ignoreCache=true` (ignoreCache=true since 21 Oct 2026: each URL form has its own cached copy, Cloudflare too, and a re-scraped fix kept its old text in ours -- Mombetsu R6 "REDFEET (10)")
gives `raceComment` and `runners[].{number, comment}`; a runner's comment is the one with
`number` = its TAB (how the API matches them). `refreshRacecardApi` fetches today's and
tomorrow's Thoroughbred races (today's resulted ones too) every 10 min, 4 at a time (~1 s each, ~550 races), and the races jumping in the next 3 hours every 2 min (~45; 21 Oct 2026); a copy older than 25 min is not used -- the racecards copy can keep "HORSENAME (n)" after the API is fixed (Te Aroha R8). The popup returns its own `issues` (raceView popupIssues) and its ticket buttons use them, not the grid cell's copy;
a popup fetches its race fresh. `applyRacecardApi` swaps the comments in, then
`applyCommentChecks` runs every comment check. Races with no card (older dates, API down)
keep the racecards comments. After a restart, until the first full pass finishes (starts
15 s in, ~1 min; at most 15 min), today's and tomorrow's races raise **no comment warnings**
from the racecards copy (`racecardApiPending`) -- it showed a stale "Horse name missing" on
every deploy. System health row "Racecard API (comments)". The old
llmContent scan (19 Oct) is gone: the API is what clients see.

### Runner comment versions (AU / UK / US, 19 Oct 2026)
Racecards carry the runner comments in three Styles. The dashboard shows
the **AU** ones (any Style when a race has no AU card) and its warnings
(Missing Runner Comment, Comment Tab Wrong) are about those. UK and US are
checked too (`commentVersionIssues`: running horses with no comment, old tab
numbers) but only reach the **admins**: every 5 min `dispatchCommentVersionAlerts`
pushes one notification per race + Style for today's and tomorrow's races not
run yet, again only if the list changes (`cv|` keys in alerts-sent.json, kept
3 days). Admins get it on the devices where they turned alerts on in the bell.

### Time mismatch (RAS, 22 Oct 2026)
`refreshRasTimes` reads the RAS meetings API (`RUNNERS_API_URL?date=`, same as the runners
check) for today and tomorrow every 10 min. Its `start_time` is UTC. The reply for a date
**mixes the day before and after** (Healesville came twice: the 22nd's and the 23rd's), so
only meetings whose `local_race_dates` has the date are used, and of two with the same name
the one closest to our times. Matched on country (RAS `UK` = our `GB`) + course name
(letters/digits only; `RAS_COURSE_ALIAS` for Panama) + discipline, then race number.
`applyTimeMismatch` (in `applyAllIgnores`, so on every read) flags a race not started,
resulted or abandoned whose RAS time is more than `TIME_MISMATCH_MIN` (2) min from ours,
unless ignored: `POST /api/race/:raceId/time-mismatch-ignore` stores raceId + RAS time in
`time-mismatch-ignores.json` (`TIME_MISMATCH_IGNORE_PATH`), so a new RAS time warns again.
After the jump RAS shows the real start time, so run races aren't compared. Countries:
`TIME_CHECK_COUNTRIES`. System health row "Race times (RAS / Neds)".

**Neds fallback (22 Oct 2026):** production can't reach the RAS API ("fetch failed"), so when
RAS fails the times come from the Neds day pages (`NEDS_SITE_BASE/<date>`, `parseNedsSiteMeetings`)
for today, +1 and +2, at most every `NEDS_TIMES_EVERY_MS` (30 min), through `fetchNeds` (its
6 h pause on 429/403) with a 150 s timeout (a page takes 40-140 s). Neds dates overseas meetings
by the Australian day, so the pages are pooled and each of our meetings takes the one closest to
our times; a race over 3 h out (`MAX_RACE_START_GAP_MS`) is skipped (also for RAS). Neds has no
MEX/SPA/ARG/URU/BRZ/SAU. The warning says which source ("Neds 19:02"); the health row says
"N races via Neds". RAS and Neds don't always agree (22 Oct: RAS had all 7 Northam races out,
Neds only R2-R4).

### Open in Admin (22 Oct 2026)
A race with an issue links straight to it in the Troyen admin, where fixes go into
the DB: `https://troyendata.com/Race?raceId=<race _id>` (same id as ours). The race
popup header, right of the race name, on every race ("Open in Admin", not for view users), each Overview issue row and
each bell alert ("Admin"). The admin needs its own login.

### Race alerts (bell + browser pop-ups, Oct 2026)
For users with the **Overview** permission. `renderUserBlock` adds a bell
and `public/alerts.js`, which polls `/api/alerts` every 60 s. The API lists
races (today + tomorrow, Sri Lanka day) that jump within 3 h and still have
an issue not marked fixed, plus any late scratching not yet updated
(`missing-scratching`) whatever the time, and today's **Results missing**
(`missing-results`: a race run with no results while a later race at the
meeting has them), which pops up / pushes once straight away. Missing jockeys carry a source
hint from the Runners check state ("Source (Neds) has: …" / "Not on the
source (Neds) either"). Pop-ups fire once per race at **3 h, 2 h, 1 h,
30 min, 10 min** before the jump and once straight away for a late
scratching; more than 3 at once become one summary pop-up. Each race in the
panel has **Updated** (issue → fixed) and **Not at source yet** (new status
`waiting_source`; it then alerts only at 30 and 10 min). Per-browser
settings (localStorage): pop-ups (off until ticked; asks the browser for
permission) and sound (on). Pop-ups only work while a dashboard tab is open.

**Alerts with the app / tab closed (web push) + ClickUp Chat (14 Oct 2026).**
The server works out the same alerts itself every minute (`buildAlerts` →
`dispatchAlerts` in server.js) and sends them as web push (`push.js`, the
`web-push` package) to every device that ticked **Keep alerting when the
tab is closed** in the bell panel; `public/sw.js` shows them and opens the
race on click. A browser with push on doesn't pop up its own copy. VAPID
keys are generated on first start in `push-keys.json`, subscriptions per
user in `push-subscriptions.json`, what was sent in `alerts-sent.json` (all
in the data folder). Recipients: admins + USER logins with Overview. At 30
and 10 minutes to the jump, one message per race also goes to the ClickUp
Chat channel "Race day dashboard - Alert" (`clickup.postChat`, API v3;
`CLICKUP_CHAT_CHANNEL_ID` / `CLICKUP_WORKSPACE_ID` override the defaults,
`CLICKUP_CHAT_CHANNEL_ID=off` stops it). It shows as from the token's owner.

### Comment picks (`/comment-picks`, `picks-report.js`, 15 Oct 2026)
Asked for by Dinesh's boss: how the race comment's picks run. For every
resulted race (no trials) the popup's race comment (racecards
`RaceComment`, AU style first) is parsed for tab numbers in brackets —
"EAKLY (6) … COUNTRY CAPER (4)" — in the order first mentioned; runners
scratched in our race doc and numbers not in the field are removed; what's
left is the 1st, 2nd, 3rd… pick. The result string gives positions ("/" =
dead heat). Per pick: races, wins, win strike rate, places (always top 3),
place rate; which pick the winner was (or not picked); overall, by
discipline and by country, over a date range (Yesterday / 7 / 30 days /
custom, max ~3 months), with Excel (Summary, By discipline, By country,
Races) and CSV (races) downloads. Since 16 Oct 2026 the page itself is one
self-contained file (`views/comment-picks.html`, filled by the
`/comment-picks` route in `server.js`): CSS, logo, `public/pager.js` and the
chosen dates' races are baked in, so a plain right-click → Save as gives a
file anyone can open with no login or connection (the "Share as HTML"
button is gone; old `/comment-picks-offline.html` links redirect). New
dates reload the page (`?from&to`, slower the first time for a long range);
discipline / country / search / CSV run in the browser. In a saved copy
(`file://`) the date boxes only filter the dates inside it and the links go
to `PUBLIC_URL`. Same people as the Overview (a tab next to
"Data quality"). A past date is cached 6 h, today 5 min.

### Page size box (`public/pager.js`, 16 Oct 2026)
Long lists show 10 / 25 / 50 / 100 rows a page (default 25) with page
numbers: Comment picks races, Overview all open issues, All tickets, Admin
activity log, Data Changes, and both Missing Data lists. A page calls
`RddPager.create(el, render)`, renders `pager.slice(rows)` and calls
`pager.reset()` when a filter changes. Styles: `.rdd-pager*` in
`styles.css` (copied inline in the Comment picks page).

### Weekly report (`reports.js`, 14 Oct 2026)
Every Monday 8:00 AM Sri Lanka time, last week's (Mon–Sun) data-quality
report goes to the ClickUp Chat channel **"Weekly data report"**
(`2kz0m0zv-12556`, `CLICKUP_REPORT_CHANNEL_ID` overrides, `off` stops it) as
the headline numbers plus a link to the PDF (pdfkit): data quality %, races,
issues found / fixed / average fix time, races that ran with an issue still
open, by type, by country, who marked issues fixed, tickets, and a day-by-day
chart. No ClickUp task since 27 Oct 2026 (per Dinesh); before that it was a
task tagged `report` plus a link in "RDD - Weekly Update". Chat can't carry a
file, so the PDF is saved in the data folder (`reports/`, newest 26) and
served to admins at `/reports/<file>`. A failed Chat post is retried after 30
min. `REPORTS_DAILY=on` adds a daily report for the day before. Admins:
`GET /api/reports/preview?kind=weekly|daily&date=` downloads one,
`POST /api/reports/send` sends one now (System Health button). State in
`reports-state.json`; System Health shows the last one sent.

### Installable app (PWA, 14 Oct 2026)
`public/manifest.webmanifest`, icons in `public/icons/`, `public/sw.js`
(push, offline page `public/offline.html`) and `public/app.js` (registers
the worker; the header's **Install app** button, an Add to Home Screen
how-to on iPhone). Every template's head links them. Chrome / Edge on PC
and Android install it as its own window ("Start app when you sign in" in
the app's settings opens it at login); iPhone via Safari → Share → Add to
Home Screen (push only works there once installed).
**Logins:** sessions are kept in `sessions.json` in the data folder
(`session-store.js`), so a restart / deploy no longer logs everyone out; a
normal login still ends when the browser closes (server forgets it after
12 h unused). "Keep me signed in on this device" on the login page gives a
30-day cookie.

### System Health (`/system-health`, admins only)
Live checks, refreshed every 60 s (cached 60 s server-side): server uptime,
MongoDB ping, when a scrape was last seen (from the Data Changes tracker,
since the DB's `updatedAt` strings have no time zone), the Speed Map and
Scratchings feeds (warning over 20 s), the S3 video listing, the Data
Changes check (warning if over 6 min late), logins + whether the server
can write its folder, and deployed code, which warns when a code file was
uploaded after the server started (i.e. WinSW still needs a restart). The
bottom of the dashboard shows "Data last scraped / Changes checked / Page
updated" to everyone, plus the overall health status and a link for
admins. The public `/health` (DB ping only) stays for the uptime monitor.

### Admin page (`/admin`, admins only)
One login per person. Admins (e.g. `Dinesh`) see an **Admin** link in the
header: add users (username + password, optional admin role), reset a
password (logs that user out everywhere), make/remove admin, delete users,
and an activity log of logins, failed logins, page/race views, downloads
and confirms for the last 8 days. Normal users never see the link and get
"Admins only" on `/admin`. Users live in `auth-users.json` (created by the
server itself, because the service account can't modify an `auth.json`
uploaded by FTP); `auth.json` only seeds it. The activity log is one file
per month, `activity-log-YYYY-MM.jsonl`, in the same folder; the server
keeps the current month plus the 3 before it and deletes older files
automatically (`activity-log.js`). With no admin and no server
access, `node setup-auth.js --bootstrap` on any PC makes a hashed
`admin-bootstrap.json` to upload by FTP next to `server.js`.

### Login (`/login`)
One username/password per person (see Admin page above). Session cookie is
browser-session-only (no "remember me" — closing the browser fully logs
you out; this was deliberately fixed once, see the sessionStorage vs
localStorage note in dashboard.html's discipline-tab code).
Every page, `/api/*` call and report download requires this login (one
gate middleware in server.js). Only `/login`, `/logout`, `/health` and the
static files in `public/` are open. Logged out, `/api/*` returns 401 JSON
and everything else redirects to `/login`.
*(Google Authenticator 2FA was built and tested in this session, then
explicitly removed at Dinesh's request — the code paths no longer exist,
but the design is documented here in case it's wanted again later: opt-in
per-account via `setup-auth.js`, a second `/login/2fa` step using the
`otplib` + `qrcode-terminal` npm packages.)*

### Main Dashboard (`/`)
- Discipline tabs: Thoroughbred / Harness / Greyhound (each has its own
  race-count-per-meeting grid).
- Filters: search box (meeting name, live suggestions), Country (with a
  flag next to each country's SECTION HEADER row only — not repeated on
  every meeting row, per Dinesh's preference), TAB/Non-TAB, Issue (the
  full list from §4), Status (Upcoming/Running/Completed/Abandoned/
  Resulted), "Include trials" checkbox, "Show meeting downloads" toggle.
- **Global Search** (header, permanent): type a horse/jockey/trainer/
  meeting name, or a bare race number like `R5`, and get categorized
  results (Meetings/Races/Runners/Jockeys/Trainers) for the CURRENTLY
  selected date only (`GET /api/search?date=...&q=...`, server.js). Click
  a result to jump straight to that race.
- Per-meeting download widget (⬇ icon): CSV/Excel/JSON/PDF for just that
  meeting's full race+runner detail.
- Top-of-page "Download report" (CSV/Excel/JSON/PDF): every meeting/race
  with an issue, for the whole date.
- Auto-refresh: full page reload every 3 minutes (paused while a runner
  detail popup is open), with a live countdown pill.

### Race popup (click a race time)
Tabs: **Race Field** (runner table with the per-runner Issue column from
§4), **Speed Map** (Greyhound bar-chart pace visualisation — row height
auto-scales to field size, running-gait icon only shows for a runner with
actual pace data), **Race Card** (raw `racecards` documents, debug view),
**Data Dump** (raw `datadumps` documents, debug view). Plus "Watch race
video" (in-page overlay, not a new tab) when a video exists, and a
per-race Export Data menu.

**Spotlights** tab (only when the race has them): the 3 "horses to watch"
the company pipeline writes in `llmContent` (`contentType:
"RACE_CARD_COMMENTS"`, matched by `raceId`, one doc per style AU/UK/US,
newest `updatedAt` wins) — read in server.js's `attachSpotlights`, style
picked by race country in raceView.js's `pickSpotlights` (USA/CAN/MEX → US,
GB/IRE/Europe → UK, else AU). `llmContent` has no `raceId` index, so the
lookup is a ~0.4 s collection scan per popup. (A V1/V2 comments switch was
built and removed on 6 Oct 2026 at Dinesh's request.)

**Comments V2** tab (Thoroughbred only): race overview, 3 spotlights and a
comment per running horse, written by `comments-v2.js` from the race's
`racecards` doc (AU style preferred) — no AI, no API key, no cost; a few ms
on each popup load (server.js's `attachCommentsV2`), nothing saved. Facts
only: last run (position, field, distance, margin, winner, going), distance
change, spell, barrier, weight, track/distance record, past clashes between
runners, odds (for the order). AU/UK/US switch (units and terms only),
opening on the race country's style (`commentStyleFor` in raceView.js).
Runners scratched in ours are left out. Dinesh chose free over a paid AI
model on 7 Oct 2026.

### Standalone full-screen race view
Right-click (or ctrl/cmd/middle-click) any race time to open it in a new
tab at its readable link, e.g. `/race/thoroughbred/australia/kalgoorlie/2026-10-01/R1`
(discipline / country / meeting / date / race number) — same content as the popup above, but as a
genuine full page (no nested scrollboxes, race-number nav bar down the
right side, Home link instead of Logout). A plain click keeps the popup
behaviour instead, and the address bar still switches to that race's link.
`raceUrl()` in raceView.js builds the link; the `/race/...` route in
server.js finds the race by date + race number + discipline, then matches
the meeting and country slugs. Old `/?date=...&race=<id>` links still work
and get swapped for the readable one. A shared link opened while logged out
returns to that race after login.

### Runner detail (click a horse name)
Header detail grid: Trainer / Jockey / Colour / Sex / Age / Last Run
(most recent past race's date) / Sire / Dam / Weight. Runner's narrative
comment shown inline below that (always visible, not a tab). Then three
tabs: **Past Form** (full past-races table, click a row to open that old
race's own form page in a new tab), **Statistics** (Career/Win%/Place%/
Show% as bordered boxes with progress bars for the three percentages, plus
Last 10/Season/Track/Distance/etc. as smaller boxes), **Chart** (inline
SVG line chart of finishing position over time, oldest-to-newest,
1st place plotted at the TOP).

### Meetings List (`/meetings-list-view`)
A flat, no-grid list of meetings across a FROM/TO date range (not scoped to
one day like the main dashboard) — Country/Discipline/TAB filters, country
flags in its own Country column, CSV/Excel/JSON/PDF download of the range.

### "Site for check" links
Every race popup can show a link to the relevant real-world racing
authority's site for that country/discipline, for manually verifying a
flagged issue against the real source. A handful of countries (UAE, Saudi
Arabia, Bahrain, Hong Kong) get a DEEP link straight to that date+race;
every other country links to that authority's general racing/meetings
page (a deliberate choice — a working general link beats a guessed-wrong
or unpublished deep one). See `GENERAL_CHECK_SITE_BY_COUNTRY` and
`buildExternalCheckUrl` in raceView.js for the full per-country list.

---

## 7. Country code handling (a messy but important detail)

The upstream data feed uses INCONSISTENT country codes for the same
country (e.g. Great Britain appears as both `GB` and `GBR`, Ireland as
both `IRE` and `IRL`, South Africa as both `SAF` and `ZAF`). Two SEPARATE
normalization tables exist for two separate purposes — don't conflate
them:
- `COUNTRY_ALIASES` / `canonicalCountry()` (raceView.js) — used only to
  pick the right "Site for check" external link.
- `COUNTRY_FLAG_ISO` (duplicated in both raceView.js, server-side render,
  and dashboard.html, client-side render) — maps every code variant seen
  in the DB straight to its real ISO 3166-1 alpha-2 code for the flag CDN.

---

## 8. Deployment

**Not git-based.** Production is a Windows machine running the app as a
**WinSW-managed Windows Service** (listening on port 8996 behind an IIS
reverse proxy in front of the app's own port 3000). Deploys are manual:

1. Upload the changed files via FTP (FileZilla) to the production folder.
2. If `server.js`, `raceView.js`, or any `views/*.html` changed: **restart
   the WinSW service** (these are only read once at process startup).
   `public/styles.css` changes take effect on a plain browser refresh, no
   restart strictly required.
3. If `package.json` changed (a new npm dependency was added): SSH/RDP into
   the server and run `npm install` in the project folder BEFORE
   restarting the service, or the new `require(...)` will crash the
   process on startup.

Config files (never committed to git, live only on each machine):
- `C:\Thilina\Dinesh project\project - 1\db.json` — Mongo connection.
- `C:\Thilina\Dinesh project\project - 1\auth.json` — login.
- Same folder: the 4 ignore-override JSON files (§2).

> **Known inconsistency to be aware of:** `run.bat` (a convenience local
> launcher, NOT what production's WinSW service uses) defaults
> `DB_CONFIG_PATH`/`AUTH_CONFIG_PATH` to `C:\Users\Dinesh\projects-config\`
> if those env vars aren't set, while `server.js`'s own hardcoded fallback
> (used when nothing else sets the env var either) points at
> `C:\Thilina\Dinesh project\project - 1\`. Production has been confirmed
> all session to use the LATTER path. Worth reconciling at some point so
> `run.bat` can't silently point at the wrong config file.

---

## 9. Local development / testing

- Test login: `tduser` / `tduser123`.
- Start the dev server: use the project's `race-dashboard` launch config
  (`.claude/launch.json`), port 3000 — never run it via a bare terminal
  command when working in this Claude Code session, so the Browser pane
  tooling can track it.
- Reads the SAME production config files by default (same hardcoded paths
  in server.js) — there is no separate local/test database. Be careful
  with anything that writes (ignore-overrides, scratching sync state is
  read-only from our side so that's safe).
- MongoDB ad-hoc queries: use a throwaway Node script in the project root
  (`_tmp_*.js`) with `db-config.js` + the `mongodb` driver directly,
  connection name `mongodb-prod`, database `Troyen_Prod` — delete the
  script immediately after use. The MongoDB MCP tool has been unreliable
  for this in practice.

---

## 10. Utility scripts

- **`setup-auth.js`** — `node setup-auth.js`, interactive prompts for
  username + password (min 6 chars, hidden while typing, bcrypt-hashed
  before saving — the plaintext is never written anywhere or sent
  anywhere). Restart the server afterward.
- **`prune-ignores.js`** — a ONE-OFF cleanup utility (not part of the
  running app) that prunes the 4 ignore-override files down to only
  entries whose race is today-or-later, backing up the untouched
  originals into a timestamped zip first. Full run instructions are in
  its own header comment. Meant to be deleted after use, not kept around.
- **`run.bat`** — local convenience launcher only (see the config-path
  caveat in §8) — installs npm deps if missing, starts `server.js` in its
  own console window, opens the dashboard in Chrome.

---

## 11. Tech stack

Express 4, `express-session` (in-memory, browser-session cookies),
`bcryptjs` (password hashing), MongoDB driver 6.x, `exceljs` +`pdfkit`
(Excel/PDF report generation). No frontend framework or build step —
`views/dashboard.html` is one large template with plain inline
`<script>`/`<style>`, every dynamic bit (silks, Speed Map bars, the Chart
tab's line chart) hand-rendered as inline SVG rather than pulling in a
charting library.
