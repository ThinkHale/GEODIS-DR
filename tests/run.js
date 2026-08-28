/* Test runner:  node tests/run.js
 *
 * spine + collections need nothing installed. The two DOM tests need jsdom and
 * skip themselves cleanly when it is not present:  npm install --no-save jsdom
 */
const { execFileSync } = require('child_process');
const path = require('path');

let hasJsdom = true;
try { require.resolve('jsdom'); } catch (e) { hasJsdom = false; }

const SUITES = [
  { file: 'spine.test.js', name: 'associate spine (suite-data.js)', dom: false },
  { file: 'collections.test.js', name: 'shared collections (functions/index.js)', dom: false },
  { file: 'coverage.test.js', name: 'schedule vs. on-premise coverage (schedule-core.js)', dom: false },
  { file: 'persistence.test.js', name: 'schedule + coverage persistence', dom: false },
  { file: 'sheet-export.test.js', name: 'GEODIS headcount spreadsheet export', dom: false },
  { file: 'shift-tags.test.js', name: 'shift tags from the PLX workbook', dom: false },
  { file: 'attendance-state.test.js', name: 'one attendance state per day + Present override', dom: false },
  { file: 'form-intake.test.js', name: 'PTO requests from Microsoft Forms', dom: false },
  { file: 'pto-endpoint.test.js', name: 'PTO intake endpoint (functions/index.js)', dom: false },
  { file: 'timeoff-status.test.js', name: 'time-off status pipeline + change log', dom: false },
  { file: 'payroll.test.js', name: 'payroll discrepancies + Beeline hours changes', dom: false },
  { file: 'tasks.test.js', name: 'standing tasks: the queue and its clock', dom: false },
  { file: 'payroll-endpoint.test.js', name: 'payroll endpoints (functions/index.js)', dom: false },
  { file: 'pto-override.test.js', name: 'approved PTO clears an infraction', dom: false },
  { file: 'transition-pto.test.js', name: 'transition PTO allocation', dom: false },
  { file: 'transition-import.test.js', name: 'transition workbook import', dom: false },
  { file: 'attendance-import.test.js', name: 'attendance workbook import', dom: false },
  { file: 'plx-sync.test.js', name: 'live PLX workbook sync + open orders', dom: false },
  { file: 'auth.test.js', name: 'accounts, roles and permissions', dom: false },
  { file: 'point-policy.test.js', name: 'attendance point scale (import == manual)', dom: false },
  { file: 'contacts.test.js', name: 'associate phone numbers', dom: false },
  { file: 'timeclock-link.test.js', name: 'connecting a timeclock id to a profile', dom: false },
  { file: 'rc-links.test.js', name: 'RC record ids for deep links', dom: false },
  { file: 'derived-schedule.test.js', name: 'schedule derived from the workbook', dom: false },
  { file: 'schedule-source.test.js', name: 'which schedule the floor is measured against (DOM)', dom: true },
  { file: 'report-pairing.test.js', name: 'pairing the two WFM reports', dom: false },
  { file: 'shift-import.test.js', name: 'PLX workbook import + per-associate shift (DOM)', dom: true },
  { file: 'coverage-review.test.js', name: 'reviewing a stored check (DOM)', dom: true },
  { file: 'timeoff-ui.test.js', name: 'Time Off page: status + connect (DOM)', dom: true },
  { file: 'payroll-ui.test.js', name: 'Payroll tab (DOM)', dom: true },
  { file: 'tasks-ui.test.js', name: 'Tasks page + the raise-a-task button (DOM)', dom: true },
  { file: 'eid-identity.test.js', name: 'EID as the identifier people work from (DOM)', dom: true },
  { file: 'pto-ui.test.js', name: 'PTO, phone numbers and no-timeclock rows on the floor (DOM)', dom: true },
  { file: 'location-sort.test.js', name: 'site / account column + sorting (DOM)', dom: true },
  { file: 'settings-ui.test.js', name: 'Settings page (DOM)', dom: true },
  { file: 'staleness.test.js', name: 'stale feed warnings (DOM)', dom: true },
  { file: 'market-filter.test.js', name: 'market filter across every view (DOM)', dom: true },
  { file: 'coverage-ui.test.js', name: 'coverage persistence + spreadsheet paste (DOM)', dom: true },
  { file: 'suite-ui.test.js', name: 'suite modules + reconciliation mount', dom: true },
  { file: 'page.test.js', name: 'index.html end to end', dom: true }
];

let failed = 0, skipped = 0;
SUITES.forEach(s => {
  console.log('\n=== ' + s.name + ' ===');
  if (s.dom && !hasJsdom) {
    console.log('  skipped - jsdom not installed (npm install --no-save jsdom)');
    skipped++;
    return;
  }
  try {
    // jsdom logs "Not implemented: window.scrollTo" to stderr; the assertions
    // themselves all go to stdout, so only stdout is inherited.
    execFileSync(process.execPath, [path.join(__dirname, s.file)], { stdio: ['ignore', 'inherit', 'ignore'] });
  } catch (e) {
    failed++;
  }
});

console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'all suites passed') +
  (skipped ? ' (' + skipped + ' skipped)' : ''));
process.exit(failed ? 1 : 0);
