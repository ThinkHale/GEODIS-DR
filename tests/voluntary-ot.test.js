/* Somebody on the clock that nothing scheduled.
 *
 * The ordinary cause is voluntary overtime: a supervisor asked for cover, the
 * associate came in, and no shift was ever entered for it. They are standing on
 * the floor being paid, so the one thing that must never happen is that they go
 * unnoticed -- which is what happens if they are only visible behind a filter
 * somebody has to think to change. This pins them to the DEFAULT view.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const p2 = n => String(n).padStart(2, '0');
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + p2(d0.getMonth() + 1) + '-' + p2(d0.getDate());

const records = [
  { badge: 'b1', empNumber: '900001', person: 'Ada Onshift', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/2/2026' },
  { badge: 'b2', empNumber: '900002', person: 'Vic Volunteer', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/3/2026' },
  { badge: 'b3', empNumber: '900003', person: 'Sam Skipped', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/4/2026' },
  // Scheduled, but with no row in the on-premise export at all -- the state that
  // used to occupy the one shared tile and hide the unscheduled count.
  { badge: 'b4', empNumber: '900004', person: 'Nel Notimeclock', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/5/2026' }
];

/* Only Ada and Sam carry hours, so only they are ever scheduled. Vic has a
   profile and a timeclock record but nothing that says when they work -- which
   is exactly the shape of a voluntary OT shift. */
const shiftTags = [
  { id: 's1', name: 'Onshift, Ada', nameKey: 'ada onshift', shift: '1st', building: '1523',
    hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
  { id: 's3', name: 'Skipped, Sam', nameKey: 'sam skipped', shift: '1st', building: '1523',
    hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' },
  { id: 's4', name: 'Notimeclock, Nel', nameKey: 'nel notimeclock', shift: '1st', building: '1523',
    hours: '12am-11:59pm Sun-Sat', source: 'PLX workbook' }
];
const onPremAoa = [
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Onshift, Ada (80-AONSHI1)', 'true', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B'],
  ['Volunteer, Vic (80-VVOLUN2)', 'true', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B'],
  ['Skipped, Sam (80-SSKIPP3)', 'false', 'GEODIS/US/CL/CLNCEN/CLCHI/CL1523/1523', 'Boss, B']
];

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.XLSX = { read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }), utils: { sheet_to_json: () => onPremAoa } };
w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => 'Tester';
const posts = [];
let storedDay = {};
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('coverage=1') !== -1 && body.document) {
      storedDay.documented = storedDay.documented || {};
      storedDay.documented[body.document.key] = body.document;
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: [] }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: storedDay, dates: [] }) });
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts: shiftTags }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions',
    performance: 'performance', discrepancies: 'discrepancies', associatePto: 'associatePto',
    locations: 'locations', appConfig: 'appConfig', timeclockLinks: 'timeclockLinks',
    tasks: 'tasks', contacts: 'contacts', reqCandidates: 'reqCandidates' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js',
 'reqs-core.js', 'pto-tracker-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const rowFor = name => $$('.cov-row').filter(r => r.textContent.indexOf(name) !== -1)[0];
const tile = label => {
  const m = $$('.metric').filter(x => x.querySelector('.metric-label').textContent.trim() === label)[0];
  return m ? m.querySelector('.metric-value').textContent.trim() : null;
};

(async () => {
  await settle(80);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records } }));
  click($('[data-nav="coverage"]'));
  const input = d.querySelector('[data-cov="presence"]');
  Object.defineProperty(input, 'files', {
    value: [new w.File([new Uint8Array([1])], 'On Premise - Simple_' + TODAY + 'T09_00_00.000.csv')],
    configurable: true
  });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(160);

  console.log('— nobody has touched a filter —');
  t('the page opens on Exceptions only', $('#cov-status').value === 'exceptions');
  const vic = rowFor('Volunteer, Vic');
  t('the unscheduled associate is on screen anyway', !!vic);
  t('read as Unscheduled, not as an absence',
    vic.textContent.indexOf('Unscheduled') !== -1 && vic.textContent.indexOf('Not clocked in') === -1);
  t('and shown as on premise', vic.textContent.indexOf('Yes') !== -1);
  t('the row names the likely reason', /voluntary OT/i.test(vic.textContent));
  t('somebody working their shift is not dragged into the exceptions',
    !rowFor('Onshift, Ada'));

  console.log('— and the count is on the strip, not behind another tile —');
  t('it has a tile of its own', tile('On the clock, unscheduled') === '1');
  t('the tile says what to check for',
    $$('.metric-note').some(n => /voluntary OT/i.test(n.textContent)));
  /* The tile used to be the third alternative in one shared slot, so any day
     with somebody missing from the timeclock hid it completely. */
  t('even with a not-in-timeclock count competing for the same slot',
    tile('Not in timeclock') !== null && tile('On the clock, unscheduled') !== null);

  console.log('— asking who is actually on the floor —');
  const opts = Array.from($('#cov-status').options).map(o => o.value);
  t('"On the clock now" is offered', opts.indexOf('onclock') !== -1);
  t('separately from "On shift now"', opts.indexOf('onshift') !== -1);
  $('#cov-status').value = 'onclock';
  $('#cov-status').dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('it lists the person working OT', !!rowFor('Volunteer, Vic'));
  t('alongside the person on shift', !!rowFor('Onshift, Ada'));
  t('and leaves out whoever is not here', !rowFor('Skipped, Sam'));

  /* "On shift now" is the filter a supervisor reaches for by name, and it used
     to answer the narrower question of who was EXPECTED -- so Vic, standing on
     the floor on voluntary OT, was the one person it left out. */
  $('#cov-status').value = 'onshift';
  $('#cov-status').dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  t('"On shift now" keeps the person on the floor with no shift', !!rowFor('Volunteer, Vic'));
  t('alongside the person working theirs', !!rowFor('Onshift, Ada'));
  t('and still names whoever was expected but never arrived', !!rowFor('Skipped, Sam'));

  /* Widening the filter must not widen the denominator: somebody picking up
     voluntary OT cannot make the floor read as short-staffed. */
  t('coverage still counts only who was expected',
    $$('.metric-note').some(n => /\b1 of 2 on-shift associates present\b/.test(n.textContent)));

  console.log('— documenting it costs nothing —');
  $('#cov-status').value = 'exceptions';
  $('#cov-status').dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(60);
  const vicRow = rowFor('Volunteer, Vic');
  const disp = vicRow.querySelector('select.cov-disp');
  t('a disposition can be recorded on the row', !!disp);
  const choices = disp ? Array.from(disp.options).map(o => o.value) : [];
  t('"Voluntary OT" is one of them', choices.indexOf('Voluntary OT') !== -1);
  disp.value = 'Voluntary OT';
  disp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(80);
  const again = rowFor('Volunteer, Vic');
  t('choosing it records the day as excused',
    !!again.querySelector('.cov-excused'));
  t('and never as an occurrence worth points',
    !again.querySelector('.cov-occ') && again.textContent.indexOf('on the workbook') === -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
