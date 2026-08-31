# GEODIS Management Suite data model

## One roster

The suite has no roster of its own. Every associate profile is derived from the
RC / Beeline assignment snapshot that already lands each morning, so there is
never a second list of people to keep in sync.

```text
Power Automate  ->  syncReport (Cloud Function)  ->  snapshots/latest.json
                                                          |
                                    index.html reconciles and renders it
                                                          |
                                          document event "geodis:records"
                                                          |
                                    suite-data.js buildProfiles() -> Map<badge, Profile>
```

`buildProfiles()` is the only place a profile is constructed. A profile exists
because an assignment exists; the suite offers no way to add one by hand.

**Badge is the primary key** throughout — it is already the join between Beeline
and RC, and it is what the timeclock, attendance, and scorecard reports key on.
Badges are normalized (`SuiteData.normBadge`) before every lookup, matching
`reconcile-core.js`, so `1005.0`, `1,005`, and `1005 ` are one person.

## Profile

| Group | Fields | Source |
| --- | --- | --- |
| Identity | `badge`, `empNumber`, `name`, `altName`, `initials` | snapshot |
| Assignment | `status`, `market`, `marketVerified`, `marketRaw`, `crmStart`, `beeStart`, `endDate`, `endReason` | snapshot |
| Reconciliation | `action`, `actionLabel`, `actionReason`, `overridden`, `reconciled`, `dup`, `newBadge`, `note` | snapshot + shared overrides/notes |
| Attendance | `attendance[]`, `points`, `standing`, `standingCls` | `attendance` collection (read-only — see below) |
| Time off | `timeOff[]` | `timeoff` collection |
| Performance | `performance`, `score` | `performance` collection |

### Status

Every record in the snapshot is someone with an active assignment in at least
one system — `indexSide()` in `reconcile-core.js` filters to active rows before
the two sides are compared. So a profile is `Ended` only on positive evidence
that the assignment stopped:

- an `endDate` from the RC "Ended Assignments" report, or
- action `endCrm` — Beeline shows the assignment non-active, or
- action `endBeeline` — RC ended them and Beeline is the stale side.

Everything else is `Active`. This is the assignment's status, not a
recommendation: `endCrm` / `endBeeline` mean the work already ended somewhere
and one system has not caught up.

### Score

`score` is the mean of whichever performance metrics exist for that badge
(`quality`, `productivity`, `safety`). It deliberately does **not** fold in
attendance points — converting an occurrence into a score is a policy decision,
not a math one, so attendance stays its own column with its own standing band.
No performance record means `score === null`, which renders as "Not scored"
rather than a number nobody measured.

Attendance bands (`SuiteData.POINT_BANDS`) are display only. **Confirm them
against the site's actual attendance policy before anyone acts on them.**

## Coverage: schedule vs. on premise

Two WFM reports answer one question — is the person who is supposed to be on the
floor actually here?

| Report | Cadence | Carries |
| --- | --- | --- |
| `employee_schedule_weekly` (.xlsx) | once a week | name, location, job, one shift per day |
| `On Premise - Simple` (.csv) | several times a day | name, **WFM employee id**, on-premise true/false, location, supervisor |

```text
schedule (name)  ->  on premise (name + WFM id)  ->  roster profile (badge)
```

The schedule export carries **no employee id at all**, only `Last, First`. So the
on-premise report is the bridge: it is what gives a scheduled name its WFM id, and
the WFM id is what reaches a badge. Name is a real join key here rather than a
fallback — both files come from the same WFM instance and format names identically.
It is only safe *within* a site, so the location path travels with every row and a
name that appears in two locations is reported instead of merged.

Reaching the roster from a WFM id (`80-CTHOMA4835`) is best-effort: the id is tried
whole, then with its site prefix stripped, then the name. Whichever key hit is
recorded on the row as `rosterMatch`, so a name-only match is never mistaken for an
id match by someone acting on it. An unmatched row still renders — it just shows the
WFM id instead of a badge.

### Status

For an as-of instant, each person lands in exactly one state:

| Status | Meaning | Severity |
| --- | --- | --- |
| `working` | On shift, on premise | ok |
| `missing` | On shift, not on premise, past the grace window | **exception** |
| `starting` | On shift, not on premise, still inside the grace window | info |
| `early` | On premise before the shift starts | info |
| `scheduled` | Scheduled later today, not yet on premise | info |
| `complete` | Shift is over, they have left | ok |
| `lingering` | Shift is over, still on premise — overtime or a missed punch out | warn |
| `unscheduled` | On premise with no shift covering now | **exception** |
| `off` | Not scheduled, not on premise | ok |

`coverage` = `working / onShift`, and is `null` rather than `0` when nobody is on
shift, so an empty third shift never renders as 0% coverage.

**Overnight shifts are why this is not a same-day lookup.** A 9:30 PM shift is still
running at 5 AM the next morning, so `shiftsCovering()` considers today's shift *and*
yesterday's whenever yesterday's crossed midnight. Evaluating only the current day
would report the entire night crew as absent every morning. A shift is always
credited to the day it started.

An end time at or before the start means the shift crosses midnight — there is no
other reading of `9:30 PM - 6:00 AM`. That does mean a mistyped end time inflates a
shift rather than erroring, so anything over `LONG_SHIFT_HOURS` (16) is marked
`suspect` and surfaced: a 20-hour shift swallowed silently is a person who looks
covered all day when nobody is there.

Cells that are not time ranges (`PTO`, `Holiday`) are kept as a `code`, not dropped —
an approved day off must not read as an unexplained no-show.

### The schedule and every check are stored

Both reports are written to Firebase, partitioned by date, so a schedule and an
absence outlive the browser tab that produced them:

```text
schedule/weeks/{periodStart}.json   the plan   -- one document per week
coverage/days/{date}.json           the facts  -- every on-premise check that day
```

The date is part of the storage path, so it is validated as a strict `YYYY-MM-DD`
and never interpolated raw (`dateKeyOf()` in `functions/index.js`).

A **schedule document** holds every scheduled person with their shifts by date and
a roster `badge` resolved onto them where possible. `sessionStorage` is still used,
but only as a fast local restore — Firebase is the record, and it is what lets the
coverage view work on a fresh browser with only the on-premise CSV dropped in.

A **coverage document** holds that day's checks plus whatever a manager documented:

| Field | Holds |
| --- | --- |
| `checks[]` | one per on-premise pull: `asOf`, `summary`, `exceptions[]`, `presentKeys[]` |
| `documented{}` | person key -> `{ disposition, reason, name, badge }` |

Each check keeps **full detail for everyone who was not where they should be**, and
a **bare key list for everyone who was on premise**. That answers both "who was
missing and why" and "was this person here at 2pm" without writing a row per person
per pull. A check's `id` derives from its as-of instant, so re-uploading the same
export replaces that check instead of double-counting the day. Checks are capped at
24 per day; documentation survives every later check.

### Person keys

A person is identified by the best key available, prefixed so the namespaces cannot
collide and so a name-derived key is never mistaken for a badge:

```text
b:<badge>    resolved to the roster
w:<wfmId>    seen in the on-premise report but not on the roster
n:<name>     neither -- name only
```

`nameKey()` keeps the comma (`"reed,ava"`) so two WFM reports can never silently
unify a reversed name. That means it can **never** match a roster name, which reads
`"Ava Reed"`. `rosterKey()` is the cross-source key: it reduces either order to the
same sorted first+last pair and ignores middle names, which appear in one system and
not the other. The `n:` namespace uses `rosterKey()` on both sides, or a profile
could never find its own history.

### One attendance state per person per day

The on-premise report is pulled several times a day and every pull is stored, but
that must not become several attendance states for one person.
`resolveAttendance()` collapses them:

- **Presence wins.** Absent at 10:00 and on premise at 10:30 means they were here.
- **A pull that says nothing is not evidence.** Someone neither on premise nor an
  exception was off shift at that moment. Those pulls are skipped, so an evening
  pull cannot mark a 1st-shift associate absent.
- **`Present` overrides the reader.** Someone who punched *out* instead of in
  reads as absent to the badge reader; that disposition says they were here. It
  also corrects the `Onsite` / `Short` counts in the headcount export, or those
  would contradict the Comments cell beside them.

The individual pulls stay as supporting detail on the profile, not as separate
attendance records.

### Reviewing a stored check

Any pull can be reopened from the coverage view, including one somebody else
uploaded — which is why the review is offered *before* the "load both reports"
guard, not after it. A stored check keeps full detail on every exception and a
key list of who was on premise, but **not a row per person**, so the review shows
the exceptions and says as much rather than implying it can rebuild the whole
comparison. Documentation written while reviewing is filed against the day being
reviewed.

### Documenting an absence

A documented absence stores a disposition and a free-text reason. It never creates
an attendance occurrence: `DISPOSITION_OCCURRENCE` in `suite.js` maps a disposition
to what the **workbook** should end up carrying for that day, and the row states it
rather than writing it. A disposition of `Approved time off`, `Reassigned`, or
`Badge / system issue` maps to `null`, so a badge-reader gap can never become a
disciplinary record.

## Attendance is read-only

Attendance is logged on the attendance tab of the PLX workbook, and only there.
The tool **reads** that tab — `functions/attendance-import.js` turns it into the
`attendance` collection on every workbook upload — and offers no way to add,
edit, or remove an occurrence.

That is deliberate. An occurrence typed into the tool would never reach the sheet
the site actually runs on, so the two would disagree about somebody's point
balance, and a balance that exists in only one of the two systems is worse than
no balance at all. Every attendance surface (the Attendance tab, the profile's
attendance history, the coverage documentation row) links out to
`PLX_ATTENDANCE_URL` instead of offering a form.

`TYPE_POINTS` in `suite.js` survives as the policy scale the sheet is read by;
`attendance-import.js` must agree with it, which `tests/point-policy.test.js`
pins.

## The PLX workbook

The workbook lives in **another Microsoft tenant**, so nothing here can go and
fetch it — not the browser (different origin, and it needs Microsoft 365 auth
this tool does not have) and not a Power Automate flow either. Somebody uploads
it, on the On-Premise page, whenever they run attendance. There is no
refresh-from-SharePoint button, because there is nothing on this side to trigger.

Three things come out of it:

| Tab | Becomes |
| --- | --- |
| `Geodis Key` + `<site> - HC` | shift tags (`shifts` collection) |
| `2026 - Beeline Reqs` | open orders (`requisitions` collection) |
| `2026 Attendance` + `Attendance Tracker` | occurrences (`attendance` collection) |

`plx/sync.json` records when it last landed, what came out of it, and any
warnings, which is what the bar on the reconciliation page and the note on the
Attendance tab both read.

### An upload never wipes a person's work

The sheet does not track `filled` or where a requisition stands, so those are
carried over from whatever was already stored. A req that has **left** the sheet
is marked `Closed` rather than deleted, so its history and anything filled
against it survive.

### It refuses the wrong file

`XLSX.read` does not throw on a file that is not a workbook — it reads rubbish as
a single CSV-ish sheet. So the push is rejected unless at least one recognisable
tab is present, and the error names the tabs it did find. Without that, the wrong
file would record a perfectly successful-looking sync that produced nothing.

### `?plxRefresh=1` has no caller

The endpoint is still in `functions/index.js`: given the optional `PLX_FLOW_URL`
secret it calls a Power Automate **"When an HTTP request is received"** flow.
Nothing in the browser calls it any more. The workbook is in a tenant no flow
here can reach, so a button offering to fetch it promised something it could not
deliver — and, worse, sent whoever pressed it to a flow run history to debug a
flow that does not exist. Uploading is the only route in.

## Shift tags

The WFM weekly schedule only covers people who were rostered that week, so anyone
on the clock without a schedule row reads as `unscheduled` even though everyone
knows which shift they work. The PLX workbook already records that, in two places:

| Tab | Holds |
| --- | --- |
| `Geodis Key` | building + job + account -> shift label and its hours |
| `<site> - HC` | one row per associate, with an EID and a `Shift` column |

The HC tabs are the per-person assignment; the Key is the vocabulary saying which
shifts a building runs and when. `shift-key.js` parses both, with no DOM access.

### The EID is not a badge

WFM EIDs look like `80-LGRACH3897`; the RC/Beeline roster is keyed by numeric
badges like `215005`. Measured against the live snapshot, **1 of 1217** badges is
in WFM form — they are separate namespaces with effectively no overlap. So a
shift record carries both its EID (which matches the on-premise report directly)
and a `nameKey` (the only bridge to a roster profile). On real data the name
bridge resolves **116 of 117** on-premise rows to a profile; the EID resolves none.

A record's id is `eid:<EID>` when there is one and `name:<rosterKey>` otherwise,
so a new starter with no EID yet is still taggable.

### What is not assumed

- A building running the same shift label on different hours for different
  accounts is **ambiguous**: every window is kept, none is chosen, and it is
  reported. `windowFor()` returns `null` rather than guessing.
- A shift value the building does not run is a **typo, not a new shift**
  (`validateAgainstKey`). A mistyped tag puts someone in a headcount block
  nobody is looking for them in.
- A name carrying two different shifts is **poisoned**, not resolved.
- Compound schedules (`"Sun 11am-7:30pm / Mon-Thurs 1:30pm-10pm"`) keep the
  first window and set `compound`; unparseable ones keep their raw text with no
  hours at all.

### The tag decides the headcount block

`shiftOf()` prefers the profile's shift **tag** over the label derived from
today's scheduled hours. The tag is the standing assignment and uses each site's
own vocabulary — `1st`/`2nd` at most buildings, `A`/`B`/`C` at 1519 and 1559 —
whereas a derived label is only ever `1st`/`2nd`/`3rd` and exists only for people
the WFM schedule happened to cover. Preferring the tag is what puts everyone else
in the right block, and it removes the earlier need to rename A/B/C by hand.

Tags live in the `shifts` shared collection. Import the workbook once from the
Associates view; after that only new associates need a shift set, which is done
per profile and stored with `source: "Set in the suite"`.

### Export for the GEODIS headcount spreadsheet

Each branch sheet (`1502 - HC`, `1559 - Post HC`) holds side-by-side shift blocks.
The columns to the *left* of the name vary by site — `Transition`, `Status`, `Dept`,
`Profit Center`, or nothing — but in all seven sheets these six are contiguous and
in this order:

```text
Employee  Name | EID | Start Date | Shift | Current Points | Comments
```

So the export emits exactly those six, to be pasted at the block's
`Employee  Name` cell. That aligns on every branch sheet without modelling each
site's leading columns, and leaves their `Transition` / `Dept` values untouched.
`tests/sheet-export.test.js` asserts this contract against the real workbook, so a
layout change there fails a test rather than producing a misaligned paste.

Values map as: `EID` = WFM id, `Start Date` = the roster assignment start as
`M/D/YY`, `Current Points` = attendance points, `Comments` = the documented reason
or, failing that, the exception's own label. Shift labels come from the scheduled
start (`1st` < 12:00, `2nd` < 20:00, else `3rd`), matching the "Geodis Key" sheet's
schedules. **Sites that label shifts A/B/C will need those renamed by hand** — the
grouping is right, only the label differs.

`Expected` / `Onsite` / `Short` are computed for the chosen block and shown beside
the copy button.

All of the matching and shaping lives in `schedule-core.js` with no DOM access, the
same arrangement `reconcile-core.js` has, so a scheduled Cloud Function can reuse it
verbatim when these reports are automated rather than uploaded.

## Payroll

Two jobs, both about hours that move after somebody thought they were final.

### Discrepancies

Raised by the team on the GEODIS Payroll Discrepancy Form, ingested at
`?discrepancyIntake=1` with the same contract as the PTO intake — the same
`x-sync-key`, the same raw-response + field-map payload, the same name-to-badge
resolution and the same Connect button for a name typed differently.

Question 3 is a date **picker**, so unlike the PTO dates field it only has to
cope with what Forms emits: an ISO date, an ISO timestamp, or `M/D/YYYY`.
Anything else leaves the date blank and says so rather than guessing. The date is
also normalised to its **week ending** (Sunday), which is what lines a
discrepancy up with the hours snapshot for the same period.

Its pipeline is its own — `Received → Researching → Submitted to Payroll →
Corrected`, plus `No Adjustment Needed` and `Cancelled`. **Submitted to Payroll
is not resolved**: it has been handed over, not yet fixed.

### Beeline hours

```text
payroll/periods/{weekEnding}.json
  { weekEnding, closesAt, snapshots: [...], changes: [...] }
```

An automation posts each pull of the hours report to `?payroll=1&week=…` with the
sync key. Every pull after the first is compared with the one before it, and what
moved is appended to the period. **The first pull is a baseline, not a set of
changes** — otherwise every person would read as newly added.

Only the latest snapshot keeps its rows; older ones keep their summary and the
changes they produced, so a period does not grow without bound.

`afterClose` is the point of the whole exercise: hours that changed once the
period was closed, which is money already out the door being changed behind it.
**It is only ever set when a close time has actually been recorded** — an unset
close date means no flag, not a guessed cutoff that would either cry wolf or stay
silent. Recording the close date is a person in the browser, so it takes the
origin check; posting hours is an automation, so it takes the sync key.

## Time-off status pipeline

A request moves through a pipeline, not a yes/no. The vocabulary lives in
`timeoff-core.js`, and the machinery underneath it — normalising, legacy aliases,
the change log, the actor — lives once in `pipeline-core.js` and is shared with
the payroll discrepancy pipeline. It so the browser, the Cloud Function, and the form intake cannot
disagree about what a status means.

| Status | Excuses the absence | Needs action |
| --- | --- | --- |
| `Received` | no | yes |
| `Sent for Client Approval` | no | yes |
| `Approved` | **yes** | no |
| `Submitted to Payroll` | **yes** | no |
| `Completed` | **yes** | no |
| `Denied` | no | no |
| `Cancelled` | no | no |

`excused` is the one that carries weight: it decides whether attendance points
apply. Being *sent* for approval is not the same as having it, so it does not
excuse. "Needs action" is not "not approved" — a denied request is finished, it
just did not end in time off, so the overview's pending count means *awaiting
attention*.

Requests written before the pipeline say `Pending`; that reads as `Received`. An
unrecognised status is shown as itself rather than coerced — silently relabelling
someone's data is worse than an oddity — and never excuses an absence.

### Who changed it, and when

There is no authentication yet, so the actor is a display name the user sets once
in their browser (`geodis.actorName`). Every write goes through `applyStatus()` or
`applyConnection()`, which stamp an actor and append to `statusHistory`:

```text
{ status, at, by, byId, source, note? }
```

`source` is `local` today, `import` for the seeded first entry. The log is capped
at 40 entries, shaped server-side rather than trusted, and seeded with where the
request started so a first change does not look like it arrived in that state.

**When sign-in arrives, only `currentActor()` in `suite.js` changes.** The record
shape, the change log, and every reader of it stay exactly as they are — which is
the reason for building it before the auth exists.

### Connecting an unmatched request

A form request arrives with a name and no badge when the name was typed
differently from the roster. Rather than guess, the Time Off page offers a
**Connect** button that searches the roster so a person picks — and records who
linked it in the same change log, because that is as much a decision as a status
change.

## PTO requests from Microsoft Forms

Two forms feed the time-off collection, English and Spanish. Power Automate posts
one canonical payload per submission to `?ptoIntake=1` — it does the per-form
field mapping, so a reworded question or a third form is a change in the flow, not
in the code.

The work happens server-side (`form-intake.js`) because the form cannot give:

1. **A badge.** It asks for a name, and the roster is badge-keyed, so the name is
   resolved against the current snapshot with `rosterKey()` — the same bridge the
   coverage view uses, so "Grachen, Luz" and "Luz Grachen" both land.
2. **Real dates.** "Which date(s)" is free text, arriving as anything from
   `08/25/26` to `8/25 and 8/26` to `8/25/26 - 8/27/26`. A bare `8/25` takes the
   submission's year unless that is more than 180 days past, when it rolls
   forward — someone asking in December for `1/2` means January.
3. **One row per stretch.** Consecutive days become one request; a gap splits it.

### Authentication

`x-sync-key`, the same shared secret as the report ingest. This is a
server-to-server call, so there is no browser origin to check.

### What is never silently dropped

- An **unresolved name** still produces a request, with the name on it and no
  badge, listed under a banner in the Time Off tab. A lost PTO request is
  somebody who shows up expecting to be off.
- A **duplicated name** on the roster is reported, not assigned to whichever came
  first.
- An **unreadable date** is reported and kept in the record's notes.
- A **backwards or absurd range** (over 60 days) is refused rather than creating
  hundreds of records.
- With **no roster snapshot** the whole call returns 503, because every request
  would otherwise file against nobody.

### Idempotency

The request id derives from the Forms `responseId`, so a flow re-run updates the
same request instead of creating a second one — and **an approval already made is
never overwritten** by a re-run. Without a response id the id falls back to a hash
of the submission, stable for the same answers and different for new ones.

## Beeline requests and the candidates on them

Two Beeline exports arrive by email each morning:

| Export | Carries |
| --- | --- |
| `GEODIS Open Reqs` | openings, the submitted/declined/offered/hired counts, hiring manager, start date, profit centre |
| `Candidate Status per Req` | who is attached to each request, their Beeline id, job position, location, supervisor |

**Both files carry one row per (request × candidate)**, with the request-level
columns repeated down every row of the same request. Neither file's row count is
a requisition count — 633 rows is 110 requests. `parseExport` dedupes by
Request-ID and hangs the candidates off their request.

### Two status columns that mean different things

`Status` is the **request's** status, identical to `Request Status` on every
request. `Internal Status` is the **candidate's**: Offer Confirmed, Offer Pending,
Rejected, Pending.

| Internal Status | Stage |
| --- | --- |
| Offer Confirmed | `hired` |
| Offer Pending | `offered` |
| Rejected | `declined` |
| Pending | `review` |
| anything else | `other` — kept, counted apart, and reported |

With `Internal Status` present the pipeline no longer has to come from the reqs
export. On the 108 requests where the two files were pulled closely enough to
agree at all, **Offer Confirmed equals Candidates Hired and Rejected equals
Candidates Declined, exactly** (108/108 each), and the named-candidate count
equals Candidates Submitted. Those three are derived when the column is absent and
flagged in `r.derived` so the UI can say they were.

`Candidates Offered` is deliberately **not** derived. No combination of candidate
statuses reproduces it on more than 104 of 108 requests, and a figure that is right
96% of the time is worse than an honest blank beside a breakdown that is exact.

### One file or two

`parseExport` reads whichever columns are present and records what it found, so
the two exports and a single combined export all go through the same code with no
second path. `missingColumns()` reports the gap by name, and knows what is
derivable: an export carrying `Internal Status` is not asked for Candidates Hired
or Candidates Declined.

With `Date` and `Internal Status` added, the candidate export alone still lacks
**Candidates Requested**, **Candidates Offered**, **Bill To Profit Center Name**,
and **Hiring Manager**. Those columns cannot be added, so two of the four are
covered from elsewhere and two are simply not reported.

### Market from the work-location number

`Location Name` begins with the site: `4805 - 2202 Perimeter Rd,,Auburn,WA,US` is
site 4805. Every one of the 29 sites observed maps to **exactly one** market, and
the profit centre's own tail begins with that same site number on all 110
requests — so site → market is a fact the exports state, not a guess.

`learnSiteMarkets()` reads those pairs off **merged** requisitions (the profit
centre arrives in the reqs export, the work location in the candidate export, so
no single file states both) and the import offers to write them to the **Locations
admin list**, which already keys a site number to a name and a market. From then
on `applyMarket()` fills the market from the site number and marks it
`marketFrom: 'site'`.

This is one-way and time-limited: the export that names the profit centre is the
only thing that knows which market a site belongs to. **Seed the list while that
export still exists** — afterwards an unseeded site is a request with no market for
good. A site the list does not know is reported by number rather than silently
left blank, and a site two rows disagree about is not learned at all.

### Openings from the PLX workbook

Where the workbook lists the same requisition, its `Quantity` **is** the openings
count. `fromRecords()` uses it only where Beeline said nothing — this fills a gap,
it never overrides — and marks it `requestedFrom: 'workbook'`. A gap filled that
way is not also reported as a disagreement.

Today that covers 21 of 110 requests, which is the Chicago buildings: enough to
run Chicago from, and honestly blank everywhere else.

### A fill rate needs a matching denominator

Hires are known for every request; openings for only some. Dividing every hire by a
partial openings total produced a **499% fill rate**. So the summary keeps them
apart: `hired` is every hire, `hiredAgainstRequested` counts only hires on requests
whose openings are known, `reqsWithOpenings` says how many that is, and `fillPct`
divides the matched pair. The metric strip names the scope rather than implying the
figure covers everything.

### Absent is not zero

A count column that is not in the loaded export is `null`, never `0`. Every
derived figure — `fillPct`, `shortBy`, `health` — guards on it and renders "—"
rather than a number nobody measured. An unknown openings count must not read as a
filled request or as 0% coverage.

### Health

| Health | Meaning |
| --- | --- |
| `filled` | every requested seat is hired |
| `partial` | some hired, some still open |
| `submitted` | nobody hired yet, but candidates are in flight |
| `empty` | nobody hired and nobody submitted |
| `unknown` | the loaded export carried no openings count |

### Identity

The market comes from `Bill To Profit Center Name` through the same `regionOf()`
the roster uses, so requests and associates land in one market vocabulary and the
header market picker filters both.

Candidates are matched to roster profiles **by id only** — External ID, then
Beeline ID. A candidate is not necessarily a placed associate, so a low match rate
is expected. Name matching is deliberately not attempted: this export writes
"Maria A Albarran" where the roster writes "Albarran, Maria", and any name rule
would be guessing which of two similar people it had found. Wrong is worse than
unlinked when the row is somebody's employment record.

The candidate export's bare `Name` column is the **supervisor** the position
reports to (confirmed with the site). It is request-level and is *not* the hiring
manager — it differs from it on 17 of 110 requests. The reqs export's own sparse
`Reports To` column outranks it where present; the two are parsed separately and
resolved in `finish()`, so load order cannot change which supervisor a request
shows.

### One requisition, two sources

The PLX workbook's "Beeline Reqs" tab is already synced into the same
`requisitions` collection by `ShiftKey.parseRequisitions`, keyed `REQ-<number>`.
Beeline names the same requisition `110642-1`. `reqKey()` reduces the Beeline
Request-ID to that key — only when it is `<digits>-<digits>`, so an id of another
shape is never merged with a sibling that merely shares a prefix — and both
sources land on **one record** instead of two rows for the same job.

They never fight over a field. The workbook sync owns `title`, `department`,
`shift`, `building`, `openings`, `filled`, `due`, `reportTo`, `notes`, `source`,
`status`. Beeline writes a namespaced set beside them — `beelineReq`,
`beelineOpenings`, `hired`, `submitted`, `declined`, `offered`, `jobPosition`,
`startDate`, `hiringManager`, `supervisor`, `market`, `location`, `profitCenter`.
No field has two writers, so whichever syncs last cannot clobber the other and a
disagreement stays visible instead of being silently overwritten.

That makes reconciliation a straight comparison, read off the record:

- `openingsDiffer` — the workbook and Beeline disagree on how many are wanted
- `workbookOnly` — in the workbook, not in Beeline (added there early, or left
  open after Beeline filled it)
- `notInWorkbook` — Beeline has it, the workbook has not caught up

Beeline is the system of record, so none of these is auto-resolved; they are
surfaced for a person to settle.

A record belongs to exactly one list: `beelineReq` set → a Beeline request;
otherwise `source === 'PLX workbook'` → workbook-only; otherwise hand-entered.
Nothing appears twice.

`mergeForSave()` updates only the Beeline half of each record and leaves every
other field as it was. A request that has left Beeline has its Beeline half
cleared rather than the record dropped — the workbook or a person may still be the
only record of it.

Candidates go to `reqCandidates`, one record per (request, person), because the
same person legitimately sits on several requests.

Imports accumulate in the session before saving: the candidate file alone knows
nothing about openings, so saving it on its own would blank the previous day's
counts. Once the loaded files between them carry every column the board saves
itself; until then the tab names the missing column and offers to save anyway.

## Connecting the workbook roster to profiles

Three identifiers, and no single source states more than two of them:

| Number | Stated by | On a profile |
| --- | --- | --- |
| Badge | RC / Beeline | `badge` |
| RC Legacy Contact ID (the "EID" the team searches by) | RC | `empNumber` |
| Timeclock id, `80-AWILLI3693` (the workbook's "EID" column, and WFM's) | PLX workbook, on-premise report | `timeclockId` |

The Beeline export cannot carry the timeclock id, so a profile only ever learns
one by **matching on name** — and the workbook and RC disagree about surnames
often enough that people fall through. One letter is enough: the workbook's
`Wilingham, Ahmad` against RC's `Willingham, Ahmad` and that associate reaches no
profile at all, so their attendance, points and time off go nowhere.

`ShiftKey.connectionReview()` lists every workbook row whose timeclock id is on no
profile, and searches the roster for the closest name **not already spoken for**.
Settings → Connections shows the list; accepting a suggestion writes a
`timeclockLinks` record keyed by timeclock id, which outlives every upload. So it
is a job done once, then only when somebody new starts.

### One person, several timeclock ids

A profile holds a single `timeclockId`, filled from a badge-keyed map that keeps
one value. People legitimately have more than one: the same associate converted
from another agency appears under `80-` for one and `87-` for the other. So
`connectionReview` consults the stored **links** as well as the profile — a link
pointing at somebody on the roster connects that id, whichever one the profile's
single slot happens to hold. Without that, such a person could be connected any
number of times and never leave the list.

Two ids on one badge are reported rather than assumed to be fine. Where they read
as the same person it is an agency conversion; where they do not, the workbook has
somebody else's id on that row and every report keyed on it is being attributed to
the wrong person. Telling those apart means reading the ids, which is a person's
job, not a rule's.

### Disconnecting

A connection is a decision, and decisions are sometimes wrong. Every link is
listed with who made it and when, and can be removed.

Disconnecting does **not** change the workbook. If the row there still carries the
wrong id, that person returns to the unconnected list on the next look — which is
correct: the tool should keep asking until the source is fixed rather than
remembering a decision that papers over a data error. The confirmation says so.

Connections are shown even when no workbook has been imported this session,
because a connection made in one session has to be correctable in the next.

### It suggests; it never decides

A high score is a reason to look, not a decision. Two guards keep it that way:

- A profile that already holds a timeclock id is **never suggested again** — it is
  spoken for, and offering it twice invites two people onto one record.
- When two workbook rows share a best suggestion, **both are marked contested** and
  neither gets a one-click button. This is not hypothetical: "Arias Velasquez,
  Lina" at 1536 and "Arias, Lina" at 1519 both score 100% against one roster
  profile and are two different people with two different timeclock ids.

Below `CONNECT_CONFIDENT` (0.88) the suggestion is still shown, but the button
opens the roster search instead of connecting. A wrong connection files one
person's attendance against another, so nothing is ever connected automatically.

The building, shift and department travel with each row so a person can tell two
similar names apart before clicking. A workbook row with no timeclock id at all
cannot be connected this way and is reported separately — that one is fixed in the
workbook.

## The shared IL PTO tracker

One workbook, shared with another branch. GEODIS PTO sits on three tabs that do
not share a shape, and the tab a row is on is what says where the request stands:

| Tab | Meaning | Status |
| --- | --- | --- |
| `30080` | St. Louis | `Submitted to Payroll` |
| `GEODIS - 20062` | Chicago, with payroll | `Submitted to Payroll` |
| `20062 Geodis Processed` | Chicago, processed | `Completed` |

Both working tabs carry a banner about the payroll deadline, so a row on one has
been approved *and* handed over. `Completed` comes from the processed tab and
nowhere else — except that `Processed = Yes` completes a row wherever it is
written, and an explicit denial or cancellation outranks the tab.

`30080` keeps every client on one sheet. Of its 26 rows, 24 are Crescent Park,
Fed Ex and Kraft; those are counted and named in the import report, never
imported. A row vanishing without explanation is how an importer loses trust.

Tabs are matched loosely, because a shared workbook gets renamed — and the
processed test runs first, since "20062 Geodis Processed" matches the pending
pattern too. Columns are found by header text and the header row by looking for
"Associate Name", never by position: two of the three tabs carry a banner above
the header and the third does not.

### Typed by hand, and it shows

`8/24/26`, `13-Jul` with no year anywhere in the cell, `N/A`, and two dates
crammed into one as `6/15/2026 & 6/16/2026` for a single 16-hour request. Each is
read for what it plainly says. A missing year comes from the submission date on
the same row — the only other date the row states — and a date that cannot be read
is reported and falls back to the week ending rather than invented.

### Identity

The tracker's `EID` is the **RC Legacy Contact ID**, matched against a profile's
`empNumber`. It is *not* the WFM timeclock id that the PLX workbook also calls
"EID" — see [Connecting the workbook roster to profiles](#connecting-the-workbook-roster-to-profiles).
Against the live roster that reaches 45 of 56 requests; the rest are past
assignments off the active roster, imported with no badge so the existing
unmatched-request flow can connect them. Dropping an approved day off is worse
than showing one that needs connecting.

### Nothing is deleted

The record id is the EID plus the days it covers, deliberately **not** the hours: a
request that moves from a working tab to the processed one, or has its hours
corrected, is the same request and must update rather than leave a stale twin. All
56 GEODIS rows produce 56 distinct ids and none appears on two tabs.

A request that disappears from the sheet is not evidence it did not happen — it is
a shared spreadsheet somebody edited. So:

- its record **stays exactly as it was**, and
- if payroll still had it, a `pto` task is raised asking whether it was paid,
  cancelled, or removed by mistake.

A request that had already completed goes quietly: the processed tab is trimmed as
it grows, and that is housekeeping, not a decision. The task id is derived from the
request, so re-importing updates one task rather than asking again every morning.

An import touches only its own rows. The other PTO workbook, the Forms intake and
anything entered by hand are not this tracker's to change.

## Shared collections

Attendance, time off, requisitions, and performance live server-side, so every
manager sees the same data — the same way notes and status overrides already
work in the reconciliation view. Nothing is kept in `localStorage`.

```text
snapshots/latest.json              reconciled roster (computed, read-only)
notes/notes.json                   badge -> shared note
overrides/overrides.json           badge -> manual status override
attendance/events.json             [] occurrences
timeoff/requests.json              [] PTO / VTO / sick requests (manual + form intake)
requisitions/requisitions.json     [] open positions (not badge-keyed)
performance/metrics.json           [] scorecard metrics per badge per period
shifts/assignments.json            [] shift tag per associate (EID- or name-keyed)
associates/pto.json                 [] transition-associate flag and remaining transition PTO
payroll/discrepancies.json          [] payroll discrepancy workflow records
```

Transition PTO is stored separately from the daily roster because the roster is
rebuilt from RC / Beeline. When an approved PTO request belongs to a transition
associate, the time-off write allocates hours against `transitionPtoBalance`
first and records the split on the request as `transitionHours` and
`accrualHours`. Editing, cancelling, or deleting the request releases and
recomputes that allocation, so a request is not deducted twice.

Attendance workbook imports retain dated infractions and approved exceptions as
individual profile events. Point values follow the policy embedded in the
source tables (absence 2, late/early-out 1, NCNS 4, approved exceptions 0).
The headcount tab's `Current Points` value is authoritative: an explicitly
labeled balance-adjustment event reconciles imported history to that value.
Rows marked `Y` or `Transition` in a headcount transition column also update the
associate's transition identifier without overwriting an existing PTO balance.

### Collection API

`syncReport` serves each collection at `?<name>=1`:

| Method | Body | Effect |
| --- | --- | --- |
| `GET` | — | `{ ok, <responseKey>: [...] }` |
| `POST` | `{ id, ...fields }` | upsert one record by `id` |
| `POST` | `{ id, _delete: true }` | remove one record |
| `POST` | `{ records: [...] }` | replace the whole list — **the report-import path** |

Writes are whitelisted per collection (`COLLECTIONS[name].fields` in
`functions/index.js`): undeclared fields are dropped, `num` fields are coerced
and rejected if not finite, strings are capped at 500 characters, and the list
is capped at `MAX_COLLECTION_RECORDS`. Adding a field to a report importer means
adding it to that whitelist first.

### Unmatched rows

`SuiteData.unmatched()` reports imported rows whose badge is not on the roster.
They are surfaced in the UI rather than dropped — a silently dropped attendance
point is a disciplinary record that quietly went missing.

## Security

There is no per-user auth: the tool is unauthenticated and internal. Reads are
public; writes are gated by CORS plus an `Origin` check against
`https://geodis.ebtools.pro`, plus the per-field limits above. That is
acceptable for internal, low-sensitivity operational data and **not** acceptable
if this ever holds anything that needs an audit trail of who changed what.

Attendance points and time-off approvals are closer to HR records than the
reconciliation notes this pattern was built for. Adding Firebase Auth, so writes
carry an identity, is the natural next hardening step — the collection handler
already isolates every write behind one function.
