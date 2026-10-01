/* The Meeting Prep page: the summary strip, open positions by building (the
   table Jared's prep email carries), headcount, the folds below it, the
   drill-down by customer, copying it as an email, the Excel export, and the
   header's market filter. */
const { JSDOM } = require('jsdom'); const fs = require('fs');
const XLSX = require('xlsx');
const R = require('path').join(__dirname, '..') + '/';
const H = require('../plx-history-core.js');
let pass = 0, fail = 0; const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

/* Two snapshots, built by hand. 1502: two starts and one removal, three WT List
   rows (one named green, one empty, one red -- not a fit). 1536: one new order,
   and three WT List rows of which one is Mia, who turned green. */
const before = { version: 3, takenAt: '2026-09-22T08:00:00Z', highlights: true,
  customers: { 1502: ['CCM', 'LEGO SAH'], 1536: ['REDBULL'] },
  sites: { 1502: { location: '1502', sheet: '1502 - HC', expected: 3, onsite: 2, short: 1 },
    1536: { location: '1536', sheet: '1536 - Redbull HC', expected: null } },
  roster: { 'E-1': { eid: 'E-1', name: 'Grachen, Luz', location: '1502', customer: 'CCM' },
    'E-9': { eid: 'E-9', name: 'Gone, Gary', location: '1502', customer: 'CCM' } },
  candidates: { 'mia ortiz': { key: 'mia ortiz', name: 'Ortiz, Mia', stage: 'openings', location: '1536',
    customer: 'REDBULL', position: 'Operator', wtDate: '', color: '', highlight: '' } },
  openSlots: { 1502: 2 }, slots: [], wtRows: [], orders: {}, attendance: {}, starts: [] };
const after = Object.assign({}, before, { takenAt: '2026-10-01T08:00:00Z',
  roster: { 'E-1': before.roster['E-1'],
    'E-2': { eid: 'E-2', name: 'Nuevo, Ana', location: '1502', site: '1502 - HC', shift: '1st', customer: 'LEGO SAH' },
    'E-3': { eid: 'E-3', name: 'Otro, Ben', location: '1502', site: '1502 - HC', shift: '1st', customer: 'LEGO SAH' } },
  candidates: { 'mia ortiz': Object.assign({}, before.candidates['mia ortiz'], { wtDate: '10/2 9am', color: 'green', highlight: 'accepted' }) },
  openSlots: { 1502: 1, 1536: 2 },
  wtRows: [
    { location: '1502', customer: 'LEGO SAH', position: 'Material Handler', name: 'Cand, Nuevo', key: 'cand nuevo', color: 'green' },
    { location: '1502', customer: 'LEGO SAH', position: 'Material Handler', name: '', key: '', color: '' },
    { location: '1502', customer: 'LEGO SAH', position: 'Material Handler', name: 'Red, Rob', key: 'rob red', color: 'red' },
    { location: '1536', customer: 'REDBULL', position: 'Operator', name: 'Ortiz, Mia', key: 'mia ortiz', color: 'green' },
    { location: '1536', customer: 'REDBULL', position: 'Operator', name: '', key: '', color: '' },
    { location: '1536', customer: 'REDBULL', position: 'Operator', name: '', key: '', color: '' }
  ],
  orders: { 111000: { req: '111000', location: '1536', account: 'Redbull', customer: 'REDBULL',
    position: 'Material Handler', openings: 4 } },
  starts: [{ week: '2026-09-21', location: '1502', count: 2 }, { week: '2026-09-28', location: '1536', count: 3 }] });
const comparison = { from: { id: 'a', takenAt: before.takenAt }, to: { id: 'b', takenAt: after.takenAt },
  partial: false, changes: H.diff(before, after) };
const uploads = [
  { id: 'a', takenAt: before.takenAt, fileName: 'PLX.xlsx', via: 'push', changes: null },
  { id: 'b', takenAt: after.takenAt, fileName: 'PLX.xlsx', uploadedBy: 'Cody', via: 'upload', changes: comparison.changes.counts }
];
const trend = H.weekly([H.seriesPoint(before, null), H.seriesPoint(after, comparison.changes)], { now: '2026-10-01' });
const profile = H.profile(after);
const asked = [];
let copied = null, saved = null;

function boot(url) {
  const dom = new JSDOM('<!doctype html><html><body class="suite-active"><div id="suite-root"></div></body></html>',
    { runScripts: 'outside-only', url: url });
  const w = dom.window;
  w.fetch = (u) => {
    u = String(u);
    if (/plxChanges=1/.test(u)) {
      asked.push(u);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
        { ok: true, retentionDays: 7, uploads, comparison, profile, trend }) });
    }
    if (/locations=1/.test(u)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
        { locations: [{ id: 'LOC-1502', code: '1502', market: 'Chicago' }, { id: 'LOC-1536', code: '1536', market: 'Joliet' }] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: x => { copied = x; return Promise.resolve(); } } });
  // The real library, with the download caught instead of written to disk.
  w.XLSX = Object.assign({}, XLSX, { writeFile: (wb, name) => { saved = { wb, name }; } });
  ['suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js',
    'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'plx-history-core.js', 'auth-core.js',
    'tests/suite-auth-stub.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
  return w.document;
}
const d = boot('https://geodis.ebtools.pro/?view=meeting'), w = d.defaultView;
const $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const tick = () => new Promise(r => setTimeout(r, 60));
const tileIn = (doc, label) => {
  const el = Array.from(doc.querySelectorAll('.meeting-tile')).find(x => x.querySelector('.metric-label').textContent === label);
  return el ? el.querySelector('.metric-value').textContent : null;
};
const tile = label => tileIn(d, label);
const noteOf = label => $$('.meeting-tile').find(x => x.querySelector('.metric-label').textContent === label).textContent;
const panel = title => $$('.meeting-section').find(x => { const h = x.querySelector('h2'); return h && h.textContent === title; });
const fold = word => $$('details.meeting-fold').find(x => x.querySelector('summary').textContent.indexOf(word) !== -1);

setTimeout(async () => {
  console.log('— the page —');
  const nav = $$('.suite-nav-btn').find(b => /Meeting Prep/.test(b.textContent));
  t('a nav item', !!nav);
  t('under Workforce admin, after Beeline Requests', !!nav && /Beeline Requests/.test((nav.previousElementSibling || {}).textContent || ''));
  t('asks for the newest against the one before', asked.length >= 1 && !/since=|from=/.test(asked[0]));

  console.log('— the strip —');
  t('open positions: every WT List row', tile('Open positions') === '6');
  t('identified: named, not red', tile('Identified') === '2');
  t('still needed, by position', tile('Still needed') === '4' && /2 Material Handler · 2 Operator/.test(noteOf('Still needed')));
  t('on roster against expected', tile('On roster') === '3' && /3 expected/.test(noteOf('On roster')));
  t('this week', tile('This week') === '+1' && /\+2 added/.test(noteOf('This week')));

  console.log('— open positions by building —');
  const open = panel('Open positions by building');
  t('the table', !!open);
  const row = loc => Array.from(open.querySelectorAll('tbody tr')).find(r => r.cells[0].textContent.indexOf(loc) === 0);
  t('1502: 3 MH openings, 1 identified, 2 needed', row('1502').cells[1].textContent === '3' &&
    row('1502').cells[2].textContent === '1' && row('1502').cells[3].textContent === '2');
  t('1536: 3 Op openings, 1 identified, 2 needed', row('1536').cells[4].textContent === '3' &&
    row('1536').cells[5].textContent === '1' && row('1536').cells[6].textContent === '2');
  t('the building is named', /Redbull/.test(row('1536').cells[0].textContent));
  const total = open.querySelector('tfoot tr');
  t('a total row', total.cells[7].textContent === '6' && total.cells[8].textContent === '4');
  const needs = open.querySelector('.meeting-needs').textContent;
  t('Jared\'s opening sentence', /There are 6 total open positions, with 2 candidates identified and 4 still needing candidates\./.test(needs));
  t('the largest needs, one group', /1502: 2 Material Handlers still needed/.test(needs) && /1536: 2 Operators still needed/.test(needs));
  t('the recruiting need across buildings', /remaining recruiting need is 2 Material Handlers and 2 Operators\./.test(needs));
  t('says what was not counted, and why', /1 not a fit \(red\)/.test(needs));

  console.log('— headcount —');
  const hc = panel('Headcount');
  const h1502 = Array.from(hc.querySelectorAll('tbody tr')).find(r => /^1502/.test(r.cells[0].textContent));
  t('the people behind the net: 2 added, 1 removed, net +1', h1502.cells[4].textContent === '+2' &&
    h1502.cells[5].textContent === '−1' && h1502.cells[6].textContent === '+1');
  t('the gap to expected', h1502.cells[3].textContent === '0');
  const wow = fold('Week over week');
  t('week over week folds under it', !!wow && !wow.open && wow.querySelectorAll('tbody tr').length === 2);
  t('newest week first, with its change and starts', /Sep 28/.test(wow.querySelector('tbody tr').cells[0].textContent) &&
    wow.querySelector('tbody tr').cells[2].textContent === '+1' && wow.querySelector('tbody tr').cells[5].textContent === '3');
  t('and open positions that week', wow.querySelector('tbody tr').cells[6].textContent === '6');

  console.log('— what changed —');
  const changed = fold('What changed');
  t('folded, with a one-line summary', !!changed && !changed.open && /2 started/.test(changed.querySelector('summary').textContent));
  t('the detail is inside', tile('Started') === '2' && tile('Created') === '1');
  t('newly green is listed', $$('.meeting-detail').some(x => /newly green/.test(x.textContent) && /Ortiz, Mia/.test(x.textContent)));
  t('an empty list is marked empty', $$('.meeting-detail.is-empty').some(x => /Orders filled/.test(x.textContent)));

  console.log('— by building and customer —');
  const b1536 = $$('details.meeting-building').find(x => /^\s*1536/.test(x.querySelector('summary').textContent));
  t('one fold per building', $$('details.meeting-building').length === 2 && !!b1536);
  t('its summary line', /3 open · 1 identified · 2 needed/.test(b1536.querySelector('summary').textContent));
  const red = Array.from(b1536.querySelectorAll('tbody tr')).find(r => /REDBULL/.test(r.textContent));
  t('the customer row', !!red && red.cells[3].textContent === '1 / 3');
  t('a workbook order Beeline does not have says so', !!red && /Not in Beeline/.test(red.textContent));
  const b1502 = $$('details.meeting-building').find(x => /^\s*1502/.test(x.querySelector('summary').textContent));
  const sah = Array.from(b1502.querySelectorAll('tbody tr')).find(r => /LEGO SAH/.test(r.textContent));
  t('the red row is counted as not counted', !!sah && sah.cells[7].textContent === '1');

  console.log('— uploads kept —');
  const kept = fold('Uploads kept');
  t('folded at the bottom, newest first', !!kept && kept.querySelectorAll('tbody tr').length === 2 &&
    /Cody/.test(kept.querySelector('tbody tr').textContent));
  t('a push is named as one', /Scheduled push/.test(kept.querySelectorAll('tbody tr')[1].textContent));
  t('an unrestricted importer may download', $$('[data-meeting-download]').length === 2);

  console.log('— copy as email —');
  click($('[data-meeting-email]'));
  await tick();
  t('copied', typeof copied === 'string');
  t('Jared\'s columns', /Building\tMaterial Handler Openings\tMH Identified\tMH Still Needed\tOperator Openings/.test(copied));
  t('a building row, named', /1536\/Redbull\t0\t0\t0\t3\t1\t2\t3/.test(copied));
  t('the total row', /TOTAL\t3\t1\t2\t3\t1\t2\t6/.test(copied));
  t('the sentences', /There are 6 total open positions/.test(copied) && /largest remaining needs/.test(copied));
  t('and headcount', /Headcount: 3 on roster vs 3 expected; \+1 this week/.test(copied));
  t('says it worked', /Copied/.test($('.meeting-window').textContent));

  console.log('— download Excel —');
  click($('[data-meeting-excel]'));
  t('a workbook', !!saved && /^Meeting Prep \d{4}-\d{2}-\d{2}\.xlsx$/.test(saved.name));
  t('one sheet per section', saved && saved.wb.SheetNames.join() === 'Open positions,By customer,Headcount,Week over week');
  const sheet = saved && XLSX.utils.sheet_to_json(saved.wb.Sheets['Open positions'], { header: 1 });
  t('the same totals', sheet && sheet[sheet.length - 1][0] === 'TOTAL' && sheet[sheet.length - 1][9] === 6);

  console.log('— choosing a window —');
  click($('[data-meeting-range="7d"]'));
  await tick();
  t('a 7-day window asks from a week back', /since=/.test(asked[asked.length - 1]));
  t('and is shown as chosen', $('[data-meeting-range="7d"]').getAttribute('aria-pressed') === 'true');
  t('and the fold stays open', fold('What changed').open);
  click($('[data-meeting-range="pick"]'));
  await tick();
  t('picking an upload offers the older ones', $$('#meeting-from option').length === 2);
  const sel = $('#meeting-from');
  sel.value = 'a';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();
  t('and asks from that one', /from=a/.test(asked[asked.length - 1]));

  console.log('— the header market narrows it —');
  const j = boot('https://geodis.ebtools.pro/?view=meeting&market=Joliet');
  await new Promise(r => setTimeout(r, 200));
  t('only 1536 openings', tileIn(j, 'Open positions') === '3');
  t('the 1502 starts drop out', tileIn(j, 'Started') === '0');
  t('and its headcount', tileIn(j, 'On roster') === '0');
  t('the market is named', /Joliet/.test(j.querySelector('.meeting-top').textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}, 200);
