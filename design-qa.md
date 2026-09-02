# Design QA — GEODIS Management Suite

Date: 2026-09-02

## Reference and evidence

- Approved visual target: `audit/ui-ux-2026-09-01/design-options/refined-calm-operations-v2-scaled.png`
- Side-by-side comparison: `audit/ui-ux-2026-09-01/qa-compare/overview-comparison.png`
- Normal-state implementation: `audit/ui-ux-2026-09-01/qa-compare/01-overview-normal.png`
- Stale-data implementation state: `audit/ui-ux-2026-09-01/qa-compare/01-overview.png`
- Full-page route captures: `audit/ui-ux-2026-09-01/qa-current/`
- Tablet captures: `audit/ui-ux-2026-09-01/qa-tablet/`
- Mobile captures: `audit/ui-ux-2026-09-01/qa-mobile-all/` and `audit/ui-ux-2026-09-01/qa-small/`

Verified at 1487×1058, 1440×1000, 768×1024, 390×844, and 320×568.

## P0 — Blocking

None.

## P1 — Major

None open.

Resolved during QA:

- Removed an oversized empty band in Assignment Reconciliation caused by a fixed flex basis on the search control.
- Corrected inline metric layout that could collide on the Time Off page.
- Contained the Associate Profile stack at tablet width; the final 768 px check reports document and body widths of exactly 768 px.
- Confirmed the Action Summary attendance shortcut opens the risk view with the high-points filter encoded in the URL.

## P2 — Minor / accepted behavior

- Wide operational tables use contained horizontal scrolling at narrow widths so columns and source context are preserved instead of hidden.
- Stale-source warnings intentionally add vertical space only when a feed is late or unavailable. The normal state stays aligned with the approved compact composition.

## Functional and accessibility verification

- Overview priority cards, timeline events, Action Summary counts, Back navigation, and shareable route filters work.
- Add Task opens with focus in the title field, traps keyboard focus, closes with Escape, and returns focus to the trigger.
- The mobile navigation drawer moves and traps focus, closes with Escape, and returns focus to the menu button.
- Account menu dismissal, tab keyboard behavior, visible focus styles, skip navigation, status announcements, read-only states, and signed-out states are covered.
- Market restrictions are enforced on both UI and server paths, including schedule, coverage, payroll, snapshots, collections, and restricted writes.
- Payroll review notes and attribution persist through the server API.
- Browser captures reported no console or page errors.
- `node tests/run.js`: all suites passed.
- JavaScript syntax checks, mirrored-module parity checks, and `git diff --check` passed.

final result: passed
