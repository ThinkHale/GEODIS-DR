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
