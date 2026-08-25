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

### Inputs are uploads, not collections

The on-premise rows carry no timestamp of their own. The export time in the file
name is the report's as-of, and it is shown and editable rather than assumed.

Coverage inputs are uploaded reports, so they are the one part of the suite that is
**not** a shared server collection. The parsed schedule is held in `sessionStorage`
so the second and third on-premise pull of the day only needs the CSV re-dropped;
session rather than `localStorage` so a stale week's schedule cannot quietly outlive
its period. The loaded period is also checked against the as-of date and reported
when it does not cover it.

All of the matching lives in `schedule-core.js` with no DOM access, the same
arrangement `reconcile-core.js` has, so a scheduled Cloud Function can reuse it
verbatim when these reports are automated rather than uploaded.

## Shared collections

Attendance, time off, requisitions, and performance live server-side, so every
manager sees the same data — the same way notes and status overrides already
work in the reconciliation view. Nothing is kept in `localStorage`.

```text
snapshots/latest.json              reconciled roster (computed, read-only)
notes/notes.json                   badge -> shared note
overrides/overrides.json           badge -> manual status override
attendance/events.json             [] occurrences
timeoff/requests.json              [] PTO / VTO / sick requests
requisitions/requisitions.json     [] open positions (not badge-keyed)
performance/metrics.json           [] scorecard metrics per badge per period
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
