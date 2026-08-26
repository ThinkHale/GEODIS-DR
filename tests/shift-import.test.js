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
  ['', '', '', '', '', '', '', '1502', 'MATH1', 'CCM', '18845', '4', '2nd', '3pm-11:30pm Mon-Fri', '$19', 'S, M']
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
const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>legacy</header><main id="recon-main"><div id="tbody">R</div></main>
</body></html>`, { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.alert = m => posts.push({ alert: m });
w.confirm = () => true;
w.scrollTo = () => {};
let promptReply = null;
w.prompt = (msg, def) => { posts.push({ prompt: msg, def: def }); return promptReply; };
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
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: stored }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedule: {} }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {} }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['suite-data.js', 'schedule-core.js', 'shift-key.js', 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'suite.js'].forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const shiftCellFor = name => {
  const row = $$('.suite-table tbody tr').find(tr => tr.textContent.indexOf(name) !== -1);
  return row ? row.querySelectorAll('td')[3].textContent.trim() : null;
};

(async () => {
  await settle(40);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  click($('[data-nav="associates"]'));

  console.log('— before any import —');
  t('roster has a Shift column', $$('.suite-table thead th')[3].textContent.trim() === 'Shift');
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
  promptReply = '2nd';
  const setBtn = $$('.shift-chip.none')[0];
  t('an untagged associate offers "Set shift"', !!setBtn);
  click(setBtn);
  await settle(60);
  const asked = posts.filter(p => p.prompt).pop();
  t('it prompts for the shift', !!asked);
  t('and offers the shifts already known', asked.prompt.indexOf('1st') !== -1 && asked.prompt.indexOf('2nd') !== -1);
  const manual = posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1 && p.body.id).pop();
  t('saved as a single record, not a bulk replace', !!manual && !Array.isArray(manual.body.records));
  t('keyed by name, since a new starter has no EID here', manual.body.id.indexOf('name:') === 0);
  t('records that it was set in the suite', manual.body.source === 'Set in the suite');
  t('the roster reflects it', shiftCellFor('Uma Untagged') === '2nd');

  console.log('— clearing a tag —');
  promptReply = '';
  click($$('.shift-chip').find(el => el.textContent.trim() === '2nd' && el.closest('tr').textContent.indexOf('Uma') !== -1));
  await settle(60);
  t('cleared back to untagged', shiftCellFor('Uma Untagged') === 'Set shift');
  t('the stored record was removed', !stored.some(r => r.id.indexOf('uma') !== -1));

  console.log('— a cancelled prompt changes nothing —');
  promptReply = null;
  const before = posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1).length;
  click($$('.shift-chip.none')[0]);
  await settle(40);
  t('no write issued', posts.filter(p => p.url && p.url.indexOf('shifts=1') !== -1).length === before);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
