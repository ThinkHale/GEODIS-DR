/* The coverage workflow end to end in a DOM: upload the two reports, confirm the
   schedule and the on-premise check are written to Firebase, document an absence,
   and build the paste for a branch's headcount block. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const scheduleAoa = [
  ['Time Period :', '', '8/23/2026 - 8/29/2026'],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502'],
  ['Employee', 'Primary Job', 'Mon', 'Tue'],
  ['', '', '8/24/2026', '8/25/2026'],
  ['Grachen, Luz', 'OPR2', '6:00 AM - 2:30 PM', '6:00 AM - 2:30 PM'],
  ['Porras, Fernando', 'OPR2', '6:00 AM - 2:30 PM', '6:00 AM - 2:30 PM'],
  ['Munoz, Abel', 'MATH1', '3:00 PM - 11:30 PM', '3:00 PM - 11:30 PM']
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location', 'Reports To'],
  ['Grachen, Luz (80-LGRACH3897)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig'],
  ['Porras, Fernando (80-FPORRA4387)', 'false', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Pickett, Craig'],
  ['Munoz, Abel (80-AMUNOZ8734)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1502/1502', 'Sotelo, Marco']
];
// Roster names are "First Last"; the WFM reports say "Last, First".
const records = [
  { badge: '80-LGRACH3897', person: 'Luz Grachen', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '5/28/2026' },
  { badge: '80-FPORRA4387', person: 'Fernando Porras', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '6/4/2026' },
  { badge: '80-AMUNOZ8734', person: 'Abel Munoz', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '6/9/2026' }
];

/* The schedule is the workbook's shift tags, stored server-side, rather than a
   separate weekly upload. */
const shiftTags = [
  { id: 'eid:80-LGRACH3897', eid: '80-LGRACH3897', name: 'Grachen, Luz', nameKey: 'grachen luz',
    shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri', source: 'PLX workbook' },
  { id: 'eid:80-FPORRA4387', eid: '80-FPORRA4387', name: 'Porras, Fernando', nameKey: 'fernando porras',
    shift: '1st', building: '1502', hours: '6am-2:30pm Mon-Fri', source: 'PLX workbook' },
  { id: 'eid:80-AMUNOZ8734', eid: '80-AMUNOZ8734', name: 'Munoz, Abel', nameKey: 'abel munoz',
    shift: '2nd', building: '1502', hours: '3pm-11:30pm Mon-Fri', source: 'PLX workbook' }
];

const posts = [];
let storedDay = {}, storedWeek = {};
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>legacy</header><main id="recon-main"><div id="tbody">R</div></main>
</body></html>`, { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
let copied = '';

let nextAoa = scheduleAoa;
w.XLSX = { read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }), utils: { sheet_to_json: () => nextAoa } };
w.alert = m => posts.push({ alert: m });
w.confirm = () => true;
w.scrollTo = () => {};
Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: v => { copied = v; return Promise.resolve(); } }, configurable: true });
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('coverage=1') !== -1) {
      if (body.check) { storedDay.checks = (storedDay.checks || []).concat([body.check]); }
      if (body.document) { storedDay.documented = storedDay.documented || {}; storedDay.documented[body.document.key] = body.document; }
    }
    if (u.indexOf('schedule=1') !== -1) storedWeek = body;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: storedWeek }) });
  if (u.indexOf('coverage=1') !== -1) {
    // Bare ?coverage=1 is the index of stored days; ?coverage=1&date=... is one day.
    const payload = u.indexOf('date=') !== -1
      ? { coverage: storedDay }
      : { dates: (storedDay.checks || []).length ? ['2026-08-25'] : [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  }
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: shiftTags }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance', discrepancies: 'discrepancies' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const upload = (kind, aoa, name) => {
  nextAoa = aoa;
  const input = d.querySelector('[data-cov="' + kind + '"]');
  Object.defineProperty(input, 'files', { value: [new w.File([new Uint8Array([1])], name)], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
};
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await settle(40);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  click($('[data-nav="coverage"]'));

  console.log('— the schedule comes from the workbook, with no second upload —');
  t('only the workbook and the on-premise export are asked for',
    $$('[data-cov]').map(x => x.dataset.cov).sort().join() === 'presence,workbook');
  t('nothing is POSTed to the schedule endpoint any more',
    !posts.some(p => p.url && p.url.indexOf('schedule=1') !== -1));

  console.log('— uploading on-premise saves a check —');
  upload('presence', onPremAoa, 'On Premise - Simple_2026-08-25T09_00_00.123.csv');
  await settle(80);
  const chk = posts.filter(p => p.url && p.url.indexOf('coverage=1') !== -1 && p.body.check).pop();
  t('a coverage POST was issued', !!chk);
  t('filed under the as-of date', chk.url.indexOf('date=2026-08-25') !== -1);
  t('as-of taken from the file name', chk.body.check.asOf === '2026-08-25T09:00:00');
  t('summary stored', chk.body.check.summary.onShift === 2);
  t('the absent person is an exception', chk.body.check.exceptions.some(e => e.name === 'Porras, Fernando'));
  t('the present people are recorded', chk.body.check.presentKeys.length === 2);
  t('badge resolved despite reversed name order', chk.body.check.exceptions[0].badge === '80-FPORRA4387');

  /* The status filter is one field shared by the live view and the stored-check
     review, and it rides in the URL. "Everyone on the report" exists only in the
     review -- so the live view has to have an answer for it, or choosing it once
     leaves every later visit looking at an empty table under a dropdown still
     claiming to be on "Exceptions only". */
  console.log('— "Everyone on the report" does not wedge the live view —');
  click($('[data-nav="coverage"]'));
  const reviewPick = $('#review-date');
  t('a stored check can be reopened', !!reviewPick);
  reviewPick.value = '2026-08-25';
  reviewPick.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  const revStatus = $('#cov-status');
  t('the review offers the whole report',
    !!revStatus && Array.from(revStatus.options).some(o => o.value === 'everyone'));
  revStatus.value = 'everyone';
  revStatus.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(40);
  t('the review shows more than the exceptions',
    $$('.suite-table tbody tr').length > (storedDay.checks[0].exceptions || []).length);
  click($('[data-review-exit]'));
  await settle(60);
  t('the live table still has rows', $$('.suite-table tbody tr').length > 0);
  t('and the filter says what is actually in force', $('#cov-status').value === 'all');
  $('#cov-status').value = 'exceptions';
  $('#cov-status').dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(40);

  console.log('— documenting an absence —');
  click($('[data-nav="coverage"]'));
  const disp = $('.cov-disp');
  t('a documentation control is offered on the exception', !!disp);
  disp.value = 'Called in';
  disp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  const docPost = posts.filter(p => p.body && p.body.document).pop();
  t('documentation POSTed', !!docPost);
  t('keyed to the person', docPost.body.document.key === 'b:80-FPORRA4387');
  t('disposition saved', docPost.body.document.disposition === 'Called in');
  await settle(40);
  /* The occurrence is NOT logged from here. Attendance lives on the PLX
     workbook, and a point balance the workbook never hears about is worse than
     none -- so the row says what the day is worth and leaves the logging there. */
  t('what the day costs is stated', !!$('.cov-occ'));
  t('with the policy points, not zero', $('.cov-occ').textContent.indexOf('1 pt') !== -1);
  t('and named as the workbook\u2019s job', $('.cov-occ').textContent.indexOf('workbook') !== -1);
  t('nothing offers to log it here', !$('[data-log-badge]'));
  t('and nothing was written to attendance',
    !posts.some(p => p.url && p.url.indexOf('attendance=1') !== -1));

  console.log('— an excused disposition costs nothing —');
  const disp2 = $('.cov-disp');
  disp2.value = 'Badge / system issue';
  disp2.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('no occurrence at all for a reader fault', !$('.cov-occ'));
  t('shown as excused instead', d.body.textContent.indexOf('Excused') !== -1);

  console.log('— building the spreadsheet paste —');
  click($('[data-export-toggle]'));
  t('export panel opened', !!$('#export-shift'));
  const loc = $('#export-loc');
  loc.value = '1502'; loc.dispatchEvent(new w.Event('change', { bubbles: true }));
  t('branch options come from the report', loc.value === '1502');
  t('Expected / Onsite / Short shown', d.body.textContent.indexOf('Expected') !== -1 && d.body.textContent.indexOf('Onsite') !== -1);
  const preview = d.querySelectorAll('.export-preview thead th');
  t('preview shows the six sheet columns', preview.length === 6);
  t('first column is the name', preview[0].textContent.trim() === 'Employee  Name'.trim());

  click($('[data-copy-sheet]'));
  await settle(40);
  const lines = copied.split('\n');
  t('TSV copied to the clipboard', copied.length > 0);
  t('one line per 1st-shift person', lines.length === 2);
  t('six tab-separated cells', lines[0].split('\t').length === 6);
  const cells = lines[0].split('\t');
  t('name in "Last, First"', cells[0] === 'Grachen, Luz');
  t('EID is the WFM id', cells[1] === '80-LGRACH3897');
  t('start date in sheet format', cells[2] === '5/28/26');
  t('shift label', cells[3] === '1st');
  t('present person has a blank comment', cells[5] === '');
  const absent = lines[1].split('\t');
  t('documented reason lands in Comments', absent[5].indexOf('Badge / system issue') !== -1);
  t('no header row in the paste', copied.indexOf('Employee  Name') === -1);

  console.log('— the profile now shows schedule and presence —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="80-FPORRA4387"]'));
  const txt = d.body.textContent;
  t('schedule panel present', txt.indexOf('Schedule & presence') !== -1);
  // From the workbook's shift tag, in the workbook's own notation -- the WFM
  // week grid only appears for weeks that were uploaded before that went away.
  t("that person's shift is shown", txt.indexOf('6am-2:30pm Mon-Fri') !== -1);
  t('and which building it is at', txt.indexOf('Building 1502') !== -1);
  t('the on-premise check is shown', txt.indexOf('Not on premise') !== -1 || txt.indexOf('Not clocked in') !== -1);
  t('the documentation is shown', txt.indexOf('Badge / system issue') !== -1);

  /* Searching for somebody who is on the floor, working their shift, used to
     answer "Nothing matches those filters" -- because the status filter starts
     on Exceptions only and drops them before the search box ever runs. Read as
     "that person is not on the report", which is the one thing it does not
     mean, and the reason a present associate was reported missing. */
  console.log('— searching for somebody the filter is hiding —');
  click($('[data-nav="coverage"]'));
  const status = $('#cov-status');
  status.value = 'exceptions';
  status.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(40);
  const search = $('#suite-search');
  search.value = 'Grachen';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(200);

  t('the table has nothing to show under that filter', $$('.suite-table:not(.export-preview) tbody tr').length === 0);
  t('but the page names the person it is hiding',
    d.body.textContent.indexOf('Grachen, Luz') !== -1);
  t('and says she is on the report rather than absent from it',
    d.body.textContent.indexOf('is on this report, but not in this filter') !== -1);
  t('it does not claim nothing matches', d.body.textContent.indexOf('Nothing matches those filters') === -1);
  const widen = $('[data-cov-widen]');
  t('and offers to widen the filter', !!widen);

  click(widen);
  await settle(60);
  t('which shows her', $$('.suite-table:not(.export-preview) tbody tr').some(tr => tr.textContent.indexOf('Grachen, Luz') !== -1));
  t('by putting the status filter on everyone', $('#cov-status').value === 'all');

  /* The same trap one step worse on a stored check: it shows its exceptions, so
     a search for somebody who was working answers "no exceptions in this check"
     while the full report, still held, has them on the floor. */
  console.log('— and the same search against a stored check —');
  const pick = $('#review-date');
  pick.value = '2026-08-25';
  pick.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  const revStatus2 = $('#cov-status');
  revStatus2.value = 'all';
  revStatus2.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(40);
  const revSearch = $('#suite-search');
  revSearch.value = 'Grachen';
  revSearch.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(200);
  t('the stored check names her too', d.body.textContent.indexOf('Grachen, Luz') !== -1);
  t('rather than reporting no exceptions',
    d.body.textContent.indexOf('No exceptions in this check') === -1);
  const revWiden = $('[data-cov-widen]');
  t('with the same way out', !!revWiden);
  click(revWiden);
  await settle(60);
  t('which shows her in the stored report',
    $$('.suite-table:not(.export-preview) tbody tr').some(tr => tr.textContent.indexOf('Grachen, Luz') !== -1));
  t('with the review on the whole report', $('#cov-status').value === 'everyone');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
