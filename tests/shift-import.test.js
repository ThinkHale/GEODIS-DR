/* Importing the PLX workbook through the UI: the roster picks up shift tags, an
   individual tag can be corrected, and a tagged-but-unscheduled person lands in
   the right headcount block. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

// Roster names are "First Last"; the workbook says "Last, First".
const records = [
  { badge: '215001', person: 'Luz Grachen', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '5/28/2026' },
  { badge: '215002', person: 'Abel Munoz', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '6/9/2026' },
  { badge: '215003', person: 'Uma Untagged', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '7/1/2026' }
];
const keyAoa = [
  ['CHI', '', '', '', '', '', '', 'Building', 'Job Title', 'Account Name', 'Account Num', 'Beeline Shift', 'Shift', 'Schedule', 'Rate', 'Supervisor'],
  ['', '', '', '', '', '', '', '1502', 'OPR2', 'REDBULL', '67510', '1', '1st', '6am-2:30pm Mon-Fri', '$19', 'P, C'],
  ['', '', '', '', '', '', '', '1502', 'MATH1', 'CCM', '18845', '4', '2nd', '3pm-11:30pm Mon-Fri', '$19', 'S, M'],
  /* A shift the Key lists but gives no hours for. Nobody on it can be
     scheduled, so they drop out of coverage entirely rather than reading as
     absent -- the quiet kind of missing this edit exists to fix. */
  ['', '', '', '', '', '', '', '1502', 'PACK1', 'LEGO', '19001', '2', '3rd', '', '$19', 'T, R']
];
const hcAoa = [
  ['PLX - 1ST SHIFT HEADCOUNT', '', '', '', '', '', '', '', 'Expected', 'Onsite', 'Short', '', 'PLX - 2ND SHIFT HEADCOUNT'],
  ['Transition', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments', '1', '1', '0', '',
    'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments'],
  ['', '1502-67510', 'Grachen, Luz', '80-LGRACH3897', '5/28/26', '1st', '2', '', '', '', '', '',
    '1502-18845', 'Munoz, Abel', '80-AMUNOZ8734', '6/9/26', '2nd', '0', '']
];

const posts = [];
let stored = [];
let storedKey = [];
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>legacy</header><main id="recon-main"><div id="tbody">R</div></main>
</body></html>`, { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => posts.push({ alert: m });
w.confirm = () => true;
w.scrollTo = () => {};
w.prompt = () => null;
w.XLSX = {
  read: () => ({ SheetNames: ['Geodis Key', '1502 - HC', 'Pipeline'] }),
  utils: { sheet_to_json: (ws) => ws }
};
// XLSX.read returns names; Sheets is looked up by name, so fake that mapping.
w.XLSX.read = () => ({ SheetNames: ['Geodis Key', '1502 - HC', 'Pipeline'],
  Sheets: { 'Geodis Key': keyAoa, '1502 - HC': hcAoa, 'Pipeline': [['x']] } });

w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('shiftKey=1') !== -1 && Array.isArray(body.records)) storedKey = body.records;
    if (u.indexOf('shifts=1') !== -1) {
      if (Array.isArray(body.records)) stored = body.records;
      else if (body._delete) stored = stored.filter(r => r.id !== body.id);
      else {
        const i = stored.findIndex(r => r.id === body.id);
        if (i === -1) stored.push(body); else stored[i] = Object.assign({}, stored[i], body);
      }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  if (u.indexOf('shiftKey=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shiftKey: storedKey }) });
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: stored }) });
  // 1502 is a Chicago site, so the workbook shifts on it can be placed in a market.
  if (u.indexOf('locations=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({
    locations: [{ id: 'L1', code: '1502', name: 'Romeoville', market: 'Chicago', active: true }] }) });
  if (u.indexOf('users=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ users: [] }) });
  if (u.indexOf('shiftTypes=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shiftTypes: [] }) });
  if (u.indexOf('appConfig=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ appConfig: [] }) });
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: {} }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {} }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'reqs-core.js', 'pto-tracker-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
// Find the column by its header, not its position -- adding a column upstream
// should not silently point this at the wrong cell.
const colIndex = label => $$('.suite-table thead th')
  .findIndex(th => th.textContent.replace(/[▲▼]/g, '').trim() === label);
const shiftCellFor = name => {
  const row = $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf(name) !== -1);
  const i = colIndex('Shift');
  return row && i !== -1 ? row.querySelectorAll('td')[i].textContent.trim() : null;
};

(async () => {
  await settle(40);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  /* The source panel around the import control -- the counts, the last-import
     diff -- is a manager's view of the plumbing. The control itself is not, and
     is checked for a colleague at the end. */
  w.__setRole('manager');
  click($('[data-nav="associates"]'));

  console.log('— before any import —');
  t('roster has a Shift column', colIndex('Shift') !== -1);
  t('and a Site / account column', colIndex('Site / account') !== -1);
  t('nobody is tagged yet', shiftCellFor('Luz Grachen') === 'Set shift');
  const panel = $('.shift-import .perf-note').textContent;
  t('the panel says 0 of 3 are tagged', panel.indexOf('0 of 3 associates') === 0);
  t('an import control is offered', !!$('[data-shift-book]'));

  console.log('— importing the workbook —');
  const input = $('[data-shift-book]');
  Object.defineProperty(input, 'files', { value: [new w.File([new Uint8Array([1])], 'PLX.xlsx')], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(80);

  const post = posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1).pop();
  t('tags POSTed to the shared store', !!post);
  t('sent as a bulk replace', Array.isArray(post.body.records));
  t('both HC blocks read', post.body.records.length === 2);
  const luzRec = post.body.records.find(r => r.name === 'Grachen, Luz');
  t('EID carried', luzRec.eid === '80-LGRACH3897');
  t('id namespaced by EID', luzRec.id === 'eid:80-LGRACH3897');
  t('hours resolved from the Key tab', luzRec.hours === '6am-2:30pm Mon-Fri');
  t('name key is the cross-source form', luzRec.nameKey === w.ScheduleCore.rosterKey('Luz Grachen'));

  console.log('— the roster picks them up —');
  t('Luz is now 1st', shiftCellFor('Luz Grachen') === '1st');
  t('Abel is now 2nd', shiftCellFor('Abel Munoz') === '2nd');
  t('the untagged associate is untouched', shiftCellFor('Uma Untagged') === 'Set shift');
  t('a report is shown', d.body.textContent.indexOf('shift tags imported') !== -1);
  t('it says how many reached a profile', d.body.textContent.indexOf('matched a roster profile by name') !== -1);
  t('the profile carries the tag', w.GEODISSuite.profile('215001').shift === '1st');
  t('and its hours', w.GEODISSuite.profile('215001').shiftHours === '6am-2:30pm Mon-Fri');
  t('tags survive a rebuild', (w.GEODISSuite.state.stores.shifts || []).length === 2);

  console.log('— tagging a new associate by hand —');
  const setBtn = $$('.shift-chip.none')[0];
  t('an untagged associate offers "Set shift"', !!setBtn);
  click(setBtn);
  const shiftForm = $('[data-shift-form]');
  const shiftSelect = shiftForm && shiftForm.querySelector('[name="shift"]');
  t('it opens an explicit shift editor', !!shiftForm && !!shiftSelect);
  t('and offers the shifts already known', Array.from(shiftSelect.options).some(o => o.value === '1st') &&
    Array.from(shiftSelect.options).some(o => o.value === '2nd'));
  shiftSelect.value = '2nd';
  shiftForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  const manual = posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1 && p.body.id).pop();
  t('saved as a single record, not a bulk replace', !!manual && !Array.isArray(manual.body.records));
  t('keyed by name, since a new starter has no EID here', manual.body.id.indexOf('name:') === 0);
  t('records that it was set in the suite', manual.body.source === 'Set in the suite');
  t('the roster reflects it', shiftCellFor('Uma Untagged') === '2nd');

  console.log('— clearing a tag —');
  click($$('.shift-chip').find(el => el.textContent.trim() === '2nd' && el.closest('tr').textContent.indexOf('Uma') !== -1));
  const clearForm = $('[data-shift-form]');
  clearForm.querySelector('[name="shift"]').value = '';
  clearForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  t('cleared back to untagged', shiftCellFor('Uma Untagged') === 'Set shift');
  t('the stored record was removed', !stored.some(r => r.id.indexOf('uma') !== -1));

  console.log('— a cancelled prompt changes nothing —');
  promptReply = null;
  const before = posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1).length;
  click($$('.shift-chip.none')[0]);
  await settle(40);
  t('no write issued', posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1).length === before);

  /* The Key half of the workbook. It used to be parsed, used to stamp hours onto
     each person, and then dropped -- so the vocabulary lived only in the tab
     that did the import, and a shift with nobody on it was never recorded at
     all. Settings then showed a hand-maintained list under a note saying it
     "supplements the workbook", with no way on the page to see the workbook. */
  console.log('— the Geodis Key is kept, not just read —');
  const keyPost = posts.filter(p => p.url && p.url.indexOf('shiftKey=1') !== -1).pop();
  t('the Key is stored too', !!keyPost && Array.isArray(keyPost.body.records));
  t('one record per row of the Key', keyPost.body.records.length === 3);
  const redbull = keyPost.body.records.find(r => r.account === 'REDBULL');
  t('with the account it belongs to', !!redbull && redbull.accountNum === '67510');
  t('the building it runs at', redbull.building === '1502');
  t('the shift it is', redbull.shift === '1st');
  t('and the hours the Key gives it', redbull.hours === '6am-2:30pm Mon-Fri');
  t('under an id stable enough to re-import over',
    redbull.id === keyPost.body.records.find(r => r.account === 'REDBULL').id &&
    redbull.id.length <= 64);
  t('the import report says the Key was read',
    /shifts from the Geodis Key/.test(d.body.textContent));

  console.log('— and Settings shows them —');
  w.__setRole('admin');
  await settle(60);
  click($('[data-nav="settings"]'));
  await settle(120);
  click($('[data-settings-tab="shifts"]'));
  await settle(120);
  const keyTable = $$('.suite-table').filter(x => /Job titles/.test(x.querySelector('thead').textContent))[0];
  t('a workbook shift table is on the page', !!keyTable);
  const rowText = n => Array.from(keyTable.querySelectorAll('tbody tr'))
    .filter(r => r.textContent.indexOf(n) !== -1)[0];
  t('both accounts are listed', !!rowText('REDBULL') && !!rowText('CCM'));
  t('each with its site', /1502/.test(rowText('REDBULL').textContent));
  t('its account number', /67510/.test(rowText('REDBULL').textContent));
  t('its hours', /6am-2:30pm Mon-Fri/.test(rowText('REDBULL').textContent));
  t('its job title', /OPR2/.test(rowText('REDBULL').textContent));
  const lastCell = r => { const c = r.querySelectorAll('td'); return c[c.length - 1].textContent.trim(); };
  t('and how many associates are on it', lastCell(rowText('REDBULL')) === '1');
  t('the hand-maintained list is still offered beneath it',
    d.body.textContent.indexOf('Add here only') !== -1);

  console.log('— hours the Key does not give —');
  // The previous section left a shift dialog open; a second #suite-modal would
  // make every query below read the stale one.
  $$('#suite-modal [data-close]').forEach(click);
  await settle(40);
  const gapRow = () => Array.from(
    $$('.suite-table').filter(x => /Job titles/.test(x.querySelector('thead').textContent))[0]
      .querySelectorAll('tbody tr')).filter(r => r.textContent.indexOf('LEGO') !== -1)[0];
  t('the gap is named, not left blank', /Not stated in the Key/.test(gapRow().textContent));
  t('and says what it costs', /nobody on this shift can be scheduled/.test(gapRow().textContent));
  const addBtn = gapRow().querySelector('[data-shift-hours]');
  t('with a way to supply them', !!addBtn && /Add hours/.test(addBtn.textContent));

  click(addBtn);
  const hoursForm = $('[data-shift-hours-form]');
  t('a dialog opens', !!hoursForm);
  t('naming the account it is for', /LEGO/.test($('#suite-modal').textContent));
  t('and saying the workbook is the real fix', /fix is in the workbook/.test($('#suite-modal').textContent));

  /* Validated with the Key's own parser. Storing something the scheduler cannot
     read would leave the shift exactly as broken, but now looking answered. */
  const postsBefore = posts.filter(p => p.url && p.url.indexOf('shiftKey=1') !== -1).length;
  hoursForm.querySelector('[name="hours"]').value = 'mornings-ish';
  hoursForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  t('unreadable hours are refused',
    posts.filter(p => p.url && p.url.indexOf('shiftKey=1') !== -1).length === postsBefore);
  t('and say why', posts.some(p => p.alert && /could not be read/.test(p.alert)));

  $('[data-shift-hours-form]').querySelector('[name="hours"]').value = '10pm-6:30am Mon-Fri';
  $('[data-shift-hours-form]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(80);
  const keyWrite = posts.filter(p => p.url && p.url.indexOf('shiftKey=1') !== -1).pop();
  const saved = keyWrite.body.records.find(r => r.account === 'LEGO');
  t('the hours are stored on the Key record', saved.hoursOverride === '10pm-6:30am Mon-Fri');
  t('beside what the Key itself said, not over it', saved.hours === '');
  t('and attributed', !!saved.hoursSetBy && !!saved.hoursSetAt);
  t('the row now shows them', /10pm-6:30am Mon-Fri/.test(gapRow().textContent));
  t('and marks them as supplied here', /Set here/.test(gapRow().textContent));

  console.log('— and they survive the next import —');
  const input2 = $$('[data-shift-book]')[0];
  Object.defineProperty(input2, 'files', { value: [new w.File([new Uint8Array([1])], 'PLX.xlsx')], configurable: true });
  input2.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(120);
  const reKey = posts.filter(p => p.url && p.url.indexOf('shiftKey=1') !== -1).pop();
  const reSaved = reKey.body.records.find(r => r.account === 'LEGO');
  t('a re-import does not undo them', reSaved.hoursOverride === '10pm-6:30am Mon-Fri');
  t('while the Key half is still re-read', reSaved.hours === '');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
