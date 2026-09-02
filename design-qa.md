# Design QA — GEODIS Management Suite

Date: 2026-09-02

## Reference and evidence

- Approved visual target: `audit/ui-ux-2026-09-01/design-options/refined-calm-operations-v2-scaled.png`
- Side-by-side comparison: `audit/ui-ux-2026-09-01/qa-compare/overview-comparison.png`
- Fluid-width comparison: `audit/ui-ux-2026-09-01/qa-compare/02-overview-fluid-comparison.png`
- Fluid-width implementation: `audit/ui-ux-2026-09-01/qa-compare/02-overview-fluid.png`
- Normal-state implementation: `audit/ui-ux-2026-09-01/qa-compare/01-overview-normal.png`
- Stale-data implementation state: `audit/ui-ux-2026-09-01/qa-compare/01-overview.png`
- Full-page route captures: `audit/ui-ux-2026-09-01/qa-current/`
- Tablet captures: `audit/ui-ux-2026-09-01/qa-tablet/`
- Mobile captures: `audit/ui-ux-2026-09-01/qa-mobile-all/` and `audit/ui-ux-2026-09-01/qa-small/`

Verified at 1487×1058, 1440×1000, 768×1024, 390×844, and 320×568.

## Fluid-width follow-up — 2026-09-02

Source truth is the approved 1487×1058 compact target above plus the user's requirement that panels use the available desktop width. The implementation comparison is also 1487×1058 CSS pixels and image pixels at device scale factor 1, in the signed-in Administrator / All markets / normal-data state.

Initial P2 finding: the 1230 px content cap left a 482 px empty strip on the right at a 1920 px viewport. The content occupied only 1230 px of the 1712 px main region.

Fix: removed the fixed maximum width and made the desktop gutter fluid with `clamp(22px, 2vw, 38px)`. Card heights, type scale, internal spacing, color tokens, official logo asset, icons, and copy were intentionally unchanged.

Post-fix evidence:

- At 1920×1080, content occupies the full 1712 px main region; every tested route's rightmost panel aligns to the 38 px inner gutter.
- At 2560×1440, content occupies the full 2352 px main region without document overflow.
- At 1440×1000, 768×1024, and 390×844, document width exactly matches viewport width with no regression.
- All ten primary views were measured at 1920 px: Overview, Tasks, Associates, On-Premise, Attendance, Time Off, Payroll, Beeline Requests, Assignment Reconciliation, and Settings.
- The Action Summary → Assignment Reconciliation interaction still changes both page title and URL correctly.
- Browser capture reported no console or page errors.

The full-view comparison was sufficient for this single container-width change: all relevant panel edges, the top-grid ratio, type hierarchy, logo sharpness, timeline spacing, colors, and copy are legible together. No focused crop was needed because no internal component styling or asset changed.

Comparison history: the first pass found the P2 right-side dead space; the second pass verified the full-width fix at five breakpoints with no remaining actionable P0/P1/P2 visual finding.

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

## P3 — Follow-up polish

- At ultra-wide widths around 2560 px, controls and timeline events naturally sit farther apart. This is an acceptable tradeoff for the requested full-width panels; if the team later wants a denser scanning pattern, constrain only row interiors rather than restoring a page-level width cap.

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
