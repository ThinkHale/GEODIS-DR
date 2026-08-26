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
| Attendance | `attendance[]`, `points`, `standing`, `standingCls` | `attendance` collection |
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
an attendance occurrence on its own — `DISPOSITION_OCCURRENCE` in `suite.js` maps a
disposition to the occurrence a **one-click** action would create, and a disposition
of `Approved time off`, `Reassigned`, or `Badge / system issue` maps to `null`, so a
badge-reader gap can never become a disciplinary record.

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
```

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
