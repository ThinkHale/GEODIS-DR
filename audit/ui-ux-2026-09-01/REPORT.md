# GEODIS Management Suite — UI/UX Audit

Audited: September 1, 2026  
Scope: Sign-in, all ten primary routes, Associate Profile, both Payroll views, all six Settings tabs, task modal, desktop and mobile behavior.  
Method: Local Playwright capture with realistic fixture data, source review, state/role inventory, and existing test-suite review. No production data was accessed and no application code was changed.

Priority key: **P0** blocks access, can mislead operational decisions, or affects high-consequence changes; **P1** is a major workflow/accessibility improvement; **P2** is an important quality-of-life improvement; **P3** is polish.

## Overall verdict

The suite has a strong operational foundation. It is unusually transparent about source ownership, stale feeds, unmatched identities, and records it cannot confidently join. The desktop tables are consistent, the profile is a useful cross-module hub, and the application avoids inventing data in many important empty states.

Its largest weaknesses are mobile access, error-state trust, high-consequence save flows, and interaction accessibility. The UI also spends too much prime space explaining data plumbing before presenting the work users need to do. Several visual defects are visible in the captured build: clipped mobile navigation, literal HTML in PLX metadata, raw JavaScript dates on profiles, an unbalanced profile layout, and broken hierarchy on App Settings.

## Flow health

| Step | Surface | General health | Short assessment |
|---:|---|---|---|
| 1 | Sign in | Good foundation | Clear and reassuring, but account creation/reset need distinct modes and accessible feedback. |
| 2 | Overview | Good | Strong scan and honest metrics; action queue should be more prominent and fully drillable. |
| 3 | Tasks | Good, incomplete | Powerful unified queue; missing ownership, explicit due dates, and exact source deep-links. |
| 4 | Associates | Good on desktop | Useful roster and sorting; source setup and exception triage need refinement. |
| 5 | Associate Profile | Mixed | Excellent combined concept; poor space use, raw dates, and contradictory schedule wording hurt comprehension. |
| 6 | On-Premise | Mixed / overloaded | Deep workflow coverage, but too many simultaneous panels and several trust/feedback risks. |
| 7 | Attendance | Mixed | Clear source provenance; weak risk triage, filtering, and unmatched-record recovery. |
| 8 | Time Off | Mixed | Functional pipeline; actionable work is buried under source/automation content. |
| 9 | Payroll | Mixed / high consequence | Useful split between discrepancies and hours; close-time and missing-date states need immediate correction. |
| 10 | Beeline Requests | Mixed / source-heavy | Rich staffing view; the demand board appears too late and manual imports need review/rollback. |
| 11 | Assignment Reconciliation | Capable but inconsistent | Strong exception workflow; visually and behaviorally feels like a legacy app embedded in the suite. |
| 12 | Settings | Mixed / high consequence | Comprehensive role model; inline autosave and blank-record creation are risky. |
| 13 | Mobile | Broken | Four of ten destinations are clipped below the fixed bottom bar at 390×844. |

## Confirmed strengths

- Clear GEODIS visual identity, consistent desktop shell, and restrained color usage.
- Strong data-provenance copy: users are usually told which workbook or system owns a record.
- Unmatched people and missing source data are surfaced instead of silently discarded.
- Empty states usually explain the next action and avoid fabricated totals.
- Coverage defaults to exceptions; completed PTO is hidden by default; task urgency respects the source workflow.
- The Associate Profile successfully joins attendance, performance, time off, schedule, contact, and reconciliation context.
- Server-backed roles and the read-only explanation are a sound foundation.
- Existing automated tests cover a broad set of workflow and data-integrity rules and currently pass.

## Numbered recommendations

### Immediate trust, access, and policy issues

1. **P0 — Rebuild the mobile navigation and header.** Ten destinations are placed in a six-column, fixed-height bottom bar; Payroll, Beeline Requests, Reconciliation, and Settings form a clipped second row. Use five primary tabs plus **More**, or a labeled drawer. Move market, account, and sign-out controls into a compact mobile menu.

2. **P0 — Never translate a failed collection request into an authoritative empty state.** Several fetch failures become `[]`, after which pages say “No records.” Preserve the last successful data, mark it stale, show a clear error with Retry, and distinguish “empty” from “could not load.”

3. **P0 — Enforce and visibly reflect account market restrictions.** The UI exposes the global market picker and does not apply the available market-scope helpers. Verify server filtering, restrict the picker to authorized markets, and test that a market-limited user cannot view another market through any route or direct request.

4. **P0 — Make attendance-policy and performance outputs configurable and visibly sourced.** Disciplinary standing labels and the equal-weight performance score can affect people. Show the policy/formula name, version, effective date, site/market scope, and calculation details; do not show disciplinary labels when policy is unverified.

5. **P0 — Separate On-Premise report capture time from schedule evaluation time.** “Now” can compare a stale presence snapshot against a newer schedule instant. Show **Report captured at** as immutable source truth; make a different evaluation time an explicit, warned override.

6. **P0 — Confirm and support undo for Time Off status changes that alter attendance consequences.** Before an approval zeros points, state the effect, require confirmation, show who changed it, and provide a short undo window.

7. **P0 — Fix Payroll’s missing-date rendering.** A missing discrepancy date can display escaped markup instead of a styled “Not set” value. Render a real status element and make missing dates filterable.

8. **P0 — Do not prefill an unset Payroll close time with “now.”** A blank close currently looks configured. Show an explicit unset state, then use **Set close time**, confirmation, timezone, actor, and audit history.

9. **P0 — Add a review step before manual Beeline imports replace shared data.** Show parsed counts, affected requests, conflicts, missing fields, and source timestamps; require **Confirm import** and retain a rollback snapshot.

10. **P0 — Stop creating blank active Location or Shift records immediately.** Use a validated draft modal or row-level Edit/Save/Cancel flow; save only after required fields pass validation.

11. **P0 — Replace free-text user markets with a validated multiselect.** Make **All markets** explicit rather than representing it with a blank value, and only offer known markets.

12. **P0 — Confirm access-impacting user changes.** Role changes, enable/disable actions, and market changes should summarize the resulting access, require confirmation for demotion/disable, and offer undo.

### Platform-wide UI, UX, and accessibility

13. **P1 — Add real routing and browser history.** Put route, profile badge, Settings/Payroll tab, and useful filter state in the URL. Back/Forward, refresh, bookmarks, and shared links should restore the same view.

14. **P1 — Replace click-only text, rows, spans, and table headers with semantic controls.** This includes profile names, Overview action rows, shift chips, requisition expansion, and sortable headers. Use buttons/links, `aria-sort`, `aria-expanded`, and `aria-current`.

15. **P1 — Make every file import keyboard-operable.** Hidden file inputs currently sit inside non-focusable labels/drop zones. Keep the native input accessibly hidden rather than `display:none`, associate it with a real label/button, and describe accepted formats.

16. **P1 — Create one accessible dialog system.** Add `role="dialog"`, `aria-modal`, labelled titles, initial focus, focus trapping/restoration, an accessible Close name, and internal scrolling for long mobile forms. Replace browser prompts/alerts/confirms with the same pattern.

17. **P1 — Correct contrast, small type, and target sizes.** White on orange and several amber/green text combinations fall below 4.5:1 for normal text. Darken semantic colors, raise 10–12px operational copy, and use approximately 44px touch targets on mobile.

18. **P1 — Add consistent Saving, Saved, Error, and Undo feedback.** Inline status, reason, note, role, mapping, and settings changes currently rerender or alert with little local feedback. Keep feedback beside the changed control and roll back failed optimistic updates.

19. **P1 — Add refresh and shared-state awareness.** Shared collections load once, so another manager’s edits can remain invisible. Add global refresh, last-successful-refresh, and preferably polling/realtime messaging such as “New data available.”

20. **P1 — Match permissions to visible affordances.** Read-only users should not see active upload, import, close-time, New Request, Fill, Remove, or editing controls that fail only after interaction. Hide them or disable them with a concise explanation.

21. **P1 — Create a compact source-health center.** Consolidate roster, PLX, PTO tracker, requisition export, payroll, and coverage freshness into one reusable status component. Show expanded technical troubleshooting only to roles that can fix it.

22. **P1 — Make global market scope impossible to miss.** Label the picker, show the selected scope in page summaries/exports, and handle unassigned records explicitly. “Chicago + unassigned” must not silently read as Chicago.

23. **P1 — Standardize filter bars.** Give every search/filter a persistent label, result count, active-filter chips, Clear all, and page-level state restoration. Use the same patterns across Tasks, Associates, Coverage, Attendance, Time Off, Payroll, Requests, and Connections.

24. **P1 — Improve large-table navigation.** Add sticky headers and identity/action columns, visible row ranges, pagination or virtualization, keyboard-focusable scroll regions, a horizontal-scroll cue, and prioritized card layouts on mobile.

25. **P2 — Simplify the information architecture and page chrome.** Group the ten destinations into Operations, People, Staffing, and Administration. Remove duplicate top-bar/content titles and collapse healthy import/source panels.

26. **P2 — Standardize vocabulary and state labels.** Use one term for Market/Region, one consistent status vocabulary, and consistent meanings for Open, Received, In Review, Complete, Remove, and Archive.

27. **P1 — Add browser-level regression coverage.** Test keyboard traversal, accessible names, focus traps/restoration, Back/Forward, 320/390/680/1050 breakpoints, table/modal overflow, color contrast, and automated accessibility checks.

### Sign in

28. **P1 — Separate Sign in, Create account, and Reset password into explicit modes.** Reset should not require a password; account creation should add confirm/show-password and mode-specific instructions. Announce errors and focus the first invalid field.

### Overview

29. **P1 — Turn metric tiles and queue rows into drill-downs.** Opening PTO pending, reconciliation exceptions, unfilled seats, or high-point associates should navigate with the relevant filter already applied.

30. **P1 — Promote “Needs attention” above passive reporting.** Put the severity-sorted operational queue immediately after the metrics; keep the trend and upcoming PTO secondary.

31. **P2 — Make the attendance trend inspectable and accessible.** Add point values/tooltips, an accessible figure label, and a compact table/list alternative.

32. **P1 — Exclude Denied and Cancelled requests from Upcoming PTO.** The current date-only filter can display future rejected requests as upcoming.

33. **P1 — Make unmatched PTO actionable from Overview.** Replace the ambiguous “Badge”/question-mark row with the submitted name/source and a **Connect** action.

### Tasks

34. **P1 — Add assignee/team, explicit due date, priority, and location.** A unified work queue needs ownership, not only age-based urgency.

35. **P1 — Deep-link derived tasks to the exact source record.** “Open” should highlight the originating PTO or Payroll record and preserve a return path to the filtered task queue.

36. **P2 — Add the hidden-completed count and undo after Complete.** Match the clearer Time Off toggle pattern and avoid making one-click completion feel irreversible.

37. **P2 — Refine the task modal.** Use **Create task** instead of generic **Save record**, make Detail a real textarea, show the resolved associate before save, and expose assignee/due fields.

### Associates

38. **P1 — Collapse the Shift Tags import panel after setup.** Show “6 of 8 tagged · last imported…” with a Manage action so roster search and exceptions stay above setup prose.

39. **P1 — Add action-oriented quick filters.** Include reconciliation exceptions, attendance threshold, missing EID, missing shift, former associates, and unscored associates.

40. **P1 — Replace editable shift chips and browser prompts with an explicit editor.** Use a keyboard-operable button/select, valid shift choices, Save/Cancel, and local feedback.

41. **P2 — Separate active and ended associates more clearly.** Preserve ended records, but default operational work to Active and show an obvious Ended/Former segment with counts.

### Associate Profile

42. **P1 — Preserve roster context and add a true breadcrumb.** Returning to the roster should restore search, filters, sort, and scroll position; profiles should have shareable URLs.

43. **P1 — Rebalance the layout.** The current narrow right rail extends far below a mostly empty main column. Use responsive sections/tabs or a balanced grid so Schedule and Reconciliation are readable without excessive whitespace.

44. **P1 — Format assignment dates as human dates.** Replace strings such as `Sun Jan 05 2025 00:00:00 GMT-0600` with locale date/time and an explicit timezone only when needed.

45. **P2 — Clarify partial-data states.** Rename “No schedule on file” to “No weekly schedule uploaded” when a shift tag exists, and hide or explain empty Performance tiles such as Units and Hours.

46. **P1 — Put actionable identity details in the profile header.** Surface site/account, shift, mobile, reconciliation exception, and source freshness with direct actions to resolve, contact, or raise a task.

### On-Premise

47. **P1 — Collapse healthy source panels after both reports are available.** Keep a compact freshness row and let users expand Replace/Import details only when needed.

48. **P1 — Make metric tiles filter the exception table.** Not clocked in, Unscheduled, Not in timeclock, and On PTO should each open the corresponding queue.

49. **P1 — Show row-level save and undo for dispositions/reasons.** These edits affect attendance consequences and need visible ownership, progress, and recovery.

50. **P1 — Rename and correct “Clear files.”** It clears the current presence upload, not all shared files/schedules. Use **Clear current on-premise upload** and state what remains.

51. **P1 — Render PLX upload progress, success, and failure.** The code updates upload state, but the page does not display it. Disable retriggering while busy and offer retry after failure.

52. **P1 — Fix the visible PLX metadata markup.** The source card currently shows literal `<b>0</b>` strings because preformatted metadata is escaped. Render structured text/components, not HTML embedded in a string.

53. **P2 — Reduce warning overload.** Merge overlapping unmatched/setup warnings into a prioritized action summary with counts, severity, and direct actions.

### Attendance

54. **P1 — Add an associate-risk view beside the occurrence ledger.** Group by current balance/standing with last occurrence and profile link so managers can answer “who needs review?”

55. **P1 — Add date range, type, site, standing/points, unmatched, and excused filters plus filtered export.** Search alone will not scale to hundreds of records.

56. **P1 — Provide direct recovery for unmatched attendance rows.** A blank badge currently renders as “Badge” and offers no row action. Show available name/source identifiers and Connect or Correct at source.

57. **P2 — Replace hover-only column explanations.** Minutes and Balance explanations should be visible in a legend/help popover accessible on touch and keyboard.

### Time Off

58. **P1 — Put the action queue before tracker/import explanations.** Lead with counts and filters for needs action, awaiting client, awaiting payroll, unmatched, and upcoming; move source administration under Data source.

59. **P1 — Add status, type, date-window, and “Needs action” filters.** Default sort should prioritize actionable/overdue requests rather than only newest start date.

60. **P1 — Clarify Remove versus correction at source.** Imported tracker rows may return on the next sync. Use **Dismiss local copy** only when appropriate, or direct users to fix the owning tracker.

61. **P2 — Make technical sync diagnostics role-aware.** Operators need “Tracker is late” and next steps; admins can expand Power Automate/401 troubleshooting details.

### Payroll

62. **P1 — Add high-value filters and export.** Discrepancies need status/date/site/unmatched filters; Hours needs After close only, associate search, acknowledgement state, and an audit export.

63. **P1 — Rename “Seen” to “Detected” and add review state.** System detection is not human acknowledgement. Record Reviewed by/at and allow notes on resolution.

64. **P2 — Clarify the relationship between Payroll tasks and discrepancies.** They are two work models on one page. Use clearer source labels or a unified queue while retaining the record type and owning workflow.

65. **P2 — Remove endpoint jargon from empty states.** Describe the expected automation/cadence and provide Retry or role-appropriate troubleshooting instead of exposing `?payroll=1&week=...`.

### Beeline Requests

66. **P0 — Add and expose a sortable “Short by” column.** The page sorts by shortfall by default but does not show that column or active sort, so the order appears arbitrary.

67. **P1 — Put staffing demand before data plumbing.** Show metrics, filters, and the request board first; collapse healthy emailed/manual import details into a source-health disclosure.

68. **P1 — Rename “New request” to “Add off-board request.”** Explain that it does not create a Beeline record and apply a persistent Local source chip.

69. **P1 — Make candidate expansion a real disclosure control.** Use a labeled button with candidate count, `aria-expanded`, and `aria-controls`; do not make the whole row an unlabeled click target.

70. **P2 — Unify the Beeline, workbook-only, and local tables.** A single table with Source and Reconciliation state will scan better than three separate tables with different columns.

### Assignment Reconciliation

71. **P1 — Bring Reconciliation into the shared design system.** Reuse suite buttons, panels, filters, type scale, status tokens, and table behavior so it no longer feels embedded from another product.

72. **P1 — Remove duplicate scope controls and the orphaned “02” step label.** Keep the global Market picker, use Market consistently instead of Region, and only show step numbering when the full sequence is visible.

73. **P1 — Link rows to Associate Profiles and make stat cards filters.** Users should move directly from an exception to the combined person record or click an action count to filter the table.

74. **P1 — Clarify exports and inline edit feedback.** Combine exports under a menu that states scope/row count; show Saved/Error, actor/time, history, and Revert for notes and manual overrides.

### Settings

75. **P1 — Fix App Settings field hierarchy.** Labels and hints currently render as oversized body text because the field selector does not match the markup. Apply the shared field pattern, spacing, and compact help style.

76. **P1 — Validate and test App Settings before saving.** Add explicit Save, URL/domain/API-name validation, normalized preview, Test link, and local success/error feedback.

77. **P1 — Structure Connections around decisions.** Group Ready to connect, Contested, No near match, and Connected; show the differing names/IDs and consequences before Connect or Disconnect.

78. **P2 — Make Settings and Payroll sub-tabs real, routable tabs.** Add tab semantics, arrow-key behavior, URL state, and persistent selection.

79. **P2 — Clarify Deactivate versus Remove.** Explain whether records remain referenced, prevent unsafe removal when in use, and prefer Archive where history must remain intact.

80. **P2 — Remove duplicate Sign out and use the Account panel for session/security details.** Keep Sign out in one predictable account menu and use the page for role, market scope, recent activity, and support/contact information.

## Recommended implementation order

Start with **1–12**, then **13–20**, followed by the most operationally valuable page fixes: **43–44, 47–52, 54–56, 58–63, 66–69, 71–76**. That sequence addresses broken access, misleading data states, policy-sensitive actions, and editing trust before broad visual polish.

## Evidence limits

- Screenshots were captured locally from the current code with realistic fixture data and inspected after capture.
- Production authentication, live backend latency/failures, real report files, and real customer data were not exercised.
- Source review identifies likely accessibility risks; this is not a claim of WCAG conformance. Screen-reader output, 200% zoom, and physical touch-device testing remain to be completed.
- Test-suite success confirms existing coded expectations, not the absence of UX problems.

## Evidence set

- [Core workforce views](evidence-core.png)
- [Operational workflows](evidence-operations.png)
- [Staffing, reconciliation, and entry states](evidence-staffing.png)
- [Settings panels](evidence-settings.png)
- [Mobile viewport](evidence-mobile.png)
- Individual screenshots `01` through `20`, capture metadata, and the reproducible local capture script are saved in this folder.
