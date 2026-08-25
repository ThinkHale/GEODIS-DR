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
