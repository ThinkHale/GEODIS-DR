/* The "Import PLX workbook" control writes whole collections from the browser,
   so it is where another market's workbook could most easily wipe Chicago's.
   With St. Louis chosen in the picker, importing St. Louis's workbook must carry
   every Chicago shift tag and Geodis Key row over untouched; with Chicago chosen,
   Chicago's import must leave St. Louis's alone; and a workbook for the wrong
   market must write nothing at all. (DOM) */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };
const settle = ms => new Promise(r => setTimeout(r, ms));

const LOCATIONS = [
  { id: 'L1', code: '1502', market: 'Chicago', active: true },
  { id: 'L2', code: '1523', market: 'St. Louis', active: true }
];
const key = (site, acct, num) => [
  ['', '', '', '', '', '', '', 'Building', 'Job Title', 'Account Name', 'Account Num', 'Beeline Shift', 'Shift', 'Schedule'],
  ['', '', '', '', '', '', '', site, 'OPR1', acct, num, '1', '1st', '6am-2:30pm Mon-Fri']
];
const hc = (site, num, people) => [
  ['PLX - 1ST SHIFT HEADCOUNT'],
  ['Transition', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments'],
  ...people.map(p => ['', site + '-' + num, p[0], p[1], '9/1/26', '1st', '0', ''])
];
const BOOKS = {
  stl: { 'Geodis Key': key('1523', 'ACME', '15230'), '1523 - HC': hc('1523', '15230', [['Lou, Sam', '80-SLOU0003']]) },
  chi: { 'Geodis Key': key('1502', 'CCM', '18845'), '1502 - HC': hc('1502', '18845', [['Chi, New', '80-NCHI0009']]) }
};

// What Chicago has stored before St. Louis ever imports anything.
const CHICAGO_SHIFTS = [
  { id: 'eid:80-ACHI0001', eid: '80-ACHI0001', nameKey: 'ann chi', name: 'Chi, Ann', shift: '1st', building: '1502', source: 'PLX workbook' },
  { id: 'name:hand', nameKey: 'hand set', name: 'Set, Hand', shift: '2nd', building: '1502', source: 'Set in the suite' }
];
const CHICAGO_KEY = [{ id: 'KEY-1502-18845-1st', building: '1502', shift: '1st', account: 'CCM', accountNum: '18845', hours: '6am-2:30pm' }];

function boot(market, book, shiftsStore, keyStore, oldServer) {
  const posts = [];
  const store = { shifts: shiftsStore.slice(), shiftKey: keyStore.slice() };
  const dom = new JSDOM('<!doctype html><html><body class="suite-active"><div id="suite-root"></div>' +
    '<header>legacy</header><main id="recon-main"><div id="tbody">R</div></main></body></html>',
    { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/?view=associates&market=' + encodeURIComponent(market) });
  const w = dom.window;
  w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => null;
  w.XLSX = { read: () => ({ SheetNames: Object.keys(BOOKS[book]), Sheets: BOOKS[book] }), utils: { sheet_to_json: ws => ws } };
  w.fetch = (url, opt) => {
    const u = String(url);
    if (opt && opt.method === 'POST') {
      const body = JSON.parse(opt.body);
      posts.push({ url: u, body });
      if (u.indexOf('shiftKey=1') !== -1 && Array.isArray(body.records)) store.shiftKey = body.records;
      else if (u.indexOf('shifts=1') !== -1 && Array.isArray(body.records)) store.shifts = body.records;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    const reply = x => Promise.resolve({ ok: true, json: () => Promise.resolve(x) });
    if (u.indexOf('shiftKey=1') !== -1) return reply({ shiftKey: store.shiftKey });
    if (u.indexOf('shifts=1') !== -1) return reply({ shifts: store.shifts });
    if (u.indexOf('locations=1') !== -1) return reply({ locations: LOCATIONS });
    // The updated server names the market whose sync it answers for; an old one did not.
    if (u.indexOf('plx=1') !== -1) {
      const m = (u.match(/[?&]market=([^&]+)/) || [])[1];
      return reply({ sync: oldServer ? {} : { market: m ? decodeURIComponent(m) : 'Chicago' } });
    }
    return reply({});
  };
  ['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js',
    'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js',
    'plx-history-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
  return { w, d: w.document, posts, store };
}
async function importBook(env) {
  await settle(60);
  env.d.dispatchEvent(new env.w.CustomEvent('geodis:records', { detail: { records: [
    { badge: '1', person: 'Ann Chi', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago' },
    { badge: '2', person: 'Sam Lou', action: 'matched', actionLabel: 'Matched', reason: '', market: 'St. Louis' }] } }));
  env.w.__setRole('manager');
  await settle(30);
  const input = env.d.querySelector('[data-shift-book]');
  Object.defineProperty(input, 'files', { value: [new env.w.File([new Uint8Array([1])], 'book.xlsx')], configurable: true });
  input.dispatchEvent(new env.w.Event('change', { bubbles: true }));
  await settle(120);
}
const sameRecords = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  console.log('— St. Louis imports its workbook —');
  let env = boot('St. Louis', 'stl', CHICAGO_SHIFTS, CHICAGO_KEY);
  await importBook(env);
  const chiAfter = env.store.shifts.filter(r => !r.workbookMarket);
  t('every Chicago shift tag is carried over, byte for byte', sameRecords(chiAfter, CHICAGO_SHIFTS));
  t('the hand-set Chicago tag included', chiAfter.some(r => r.source === 'Set in the suite'));
  t('St. Louis\'s tags are tagged with its market', env.store.shifts.some(r => r.eid === '80-SLOU0003' && r.workbookMarket === 'St. Louis'));
  t('the Chicago Key rows are carried over', sameRecords(env.store.shiftKey.filter(r => !r.workbookMarket), CHICAGO_KEY));
  t('St. Louis\'s Key rows are its own', env.store.shiftKey.some(r => r.building === '1523' && r.workbookMarket === 'St. Louis'));
  t('the message says whose', /for St\. Louis/.test(env.d.body.textContent));
  const stlShifts = env.store.shifts, stlKey = env.store.shiftKey;

  console.log('— Chicago imports its workbook afterwards —');
  env = boot('Chicago', 'chi', stlShifts, stlKey);
  await importBook(env);
  t('St. Louis tags are left alone', sameRecords(env.store.shifts.filter(r => r.workbookMarket), stlShifts.filter(r => r.workbookMarket)));
  t('St. Louis Key rows are left alone', sameRecords(env.store.shiftKey.filter(r => r.workbookMarket), stlKey.filter(r => r.workbookMarket)));
  t('Chicago\'s import replaces Chicago\'s workbook tags, as it always did', env.store.shifts.some(r => r.eid === '80-NCHI0009') &&
    !env.store.shifts.some(r => r.eid === '80-ACHI0001'));
  t('and its records stay untagged', env.store.shifts.filter(r => r.eid === '80-NCHI0009').every(r => !('workbookMarket' in r)));

  console.log('— with no other market stored, Chicago\'s import saves exactly what it did before —');
  env = boot('all', 'chi', CHICAGO_SHIFTS, CHICAGO_KEY);
  await importBook(env);
  t('only the new workbook\'s tags, as before', env.store.shifts.length === 1 && env.store.shifts[0].eid === '80-NCHI0009');

  console.log('— the wrong workbook for the market —');
  env = boot('St. Louis', 'chi', CHICAGO_SHIFTS, CHICAGO_KEY);
  await importBook(env);
  t('is refused, saying why', /St\. Louis/.test(env.d.body.textContent) && /Chicago/.test(env.d.body.textContent));
  t('and nothing is written', !env.posts.some(p => /shifts=1|shiftKey=1/.test(p.url)));
  env = boot('Chicago', 'stl', CHICAGO_SHIFTS, CHICAGO_KEY);
  await importBook(env);
  t('St. Louis\'s workbook with Chicago chosen is refused too', !env.posts.some(p => /shifts=1|shiftKey=1/.test(p.url)));

  console.log('— before the server is updated —');
  env = boot('St. Louis', 'stl', CHICAGO_SHIFTS, CHICAGO_KEY, true);
  await importBook(env);
  t('St. Louis\'s import is refused against an old server', /not been updated/.test(env.d.body.textContent));
  t('and writes nothing', !env.posts.some(p => /shifts=1|shiftKey=1/.test(p.url)));
  env = boot('Chicago', 'chi', CHICAGO_SHIFTS, CHICAGO_KEY, true);
  await importBook(env);
  t('Chicago\'s import still works against it, as today', env.posts.some(p => /shifts=1/.test(p.url)));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
