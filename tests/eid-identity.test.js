/* The EID as the identifier people work from.

   Three numbers follow these associates around and they are not
   interchangeable. The EID -- "Legacy Contact ID" in RC, 7-8 digits -- is what
   the team searches by. The badge is a 6-digit Beeline assignment number, which
   records are keyed by internally because every report carries it. The
   timeclock id is the WFM "80-XXXX" value, and the PLX workbook confusingly
   heads its column "EID" even though it is not one.

   Every search matches all three, and anywhere a person is named leads with
   the EID. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

const records = [
  { badge: '215005', empNumber: '20750899', person: 'Ada Away', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/2/2026' },
  { badge: '217261', empNumber: '21100616', person: 'Gus Gone', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/3/2026' },
  { badge: '224697', empNumber: '', person: 'Noeid Nora', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/4/2026' }
];
const shifts = [{ id: 's1', nameKey: 'ada away', name: 'Away, Ada', eid: '80-AAWAY1', shift: '1st', building: '1523', hours: '7am-3:30pm Mon-Fri' }];
let tasks = [];
/* A note against a badge the snapshot no longer carries. This is the case that
   used to lose the note: the profile vanished with the assignment. */
const notes = { '999111': { note: 'Owed four hours from the final week', updatedAt: '2026-08-01T00:00:00Z' } };
const posts = [];

const dom = new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div><header>h</header><main id="recon-main"><div id="tbody">R</div></main></body></html>`,
  { runScripts: 'outside-only', url: 'https://geodis.ebtools.pro/' });
const w = dom.window;
w.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: { sheet_to_json: () => [] } };
w.alert = m => posts.push({ alert: m }); w.confirm = () => true; w.scrollTo = () => {}; w.prompt = () => 'Tester';
w.fetch = (url, opt) => {
  const u = String(url);
  if (opt && opt.method === 'POST') {
    const body = JSON.parse(opt.body);
    posts.push({ url: u, body });
    if (u.indexOf('tasks=1') !== -1) tasks = tasks.filter(x => x.id !== body.id).concat([body]);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, record: body }) });
  }
  if (u.indexOf('plx=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sync: {} }) });
  if (u.indexOf('schedule=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods: [] }) });
  if (u.indexOf('coverage=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ coverage: {}, dates: [] }) });
  if (u.indexOf('shifts=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ shifts }) });
  if (u.indexOf('tasks=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks }) });
  if (u.indexOf('notes=1') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ notes }) });
  const k = u.match(/\?(\w+)=1/)[1];
  const map = { attendance: 'attendance', timeoff: 'timeOff', requisitions: 'requisitions', performance: 'performance',
    discrepancies: 'discrepancies', associatePto: 'associatePto', locations: 'locations', appConfig: 'appConfig',
    timeclockLinks: 'timeclockLinks', contacts: 'contacts' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ [map[k]]: [] }) });
};
['auth-core.js', 'tests/suite-auth-stub.js', 'suite-data.js', 'schedule-core.js', 'shift-key.js',
 'pipeline-core.js', 'timeoff-core.js', 'payroll-core.js', 'tasks-core.js', 'contacts-core.js', 'suite.js']
  .forEach(f => w.eval(fs.readFileSync(R + f, 'utf8')));
const d = w.document, $ = s => d.querySelector(s), $$ = s => Array.from(d.querySelectorAll(s));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = ms => new Promise(r => setTimeout(r, ms));
const search = v => { const i = $('#suite-search'); i.value = v; i.dispatchEvent(new w.Event('input', { bubbles: true })); };
const names = () => $$('tbody tr').map(r => r.textContent);

(async () => {
  await settle(80);
  d.dispatchEvent(new w.CustomEvent('geodis:records', { detail: { records, notes } }));

  console.log('— the roster leads with the EID —');
  click($('[data-nav="associates"]'));
  t('the column is called EID, not "Employee #"',
    $$('th').some(h => h.textContent.trim() === 'EID') &&
    !$$('th').some(h => h.textContent.indexOf('Employee #') !== -1));
  t('and the number is shown', d.body.textContent.indexOf('20750899') !== -1);
  t('somebody with no EID is flagged rather than left blank',
    $$('tbody tr').filter(r => r.textContent.indexOf('Noeid Nora') !== -1)[0]
      .querySelector('.warn-text'));

  console.log('— searching by EID —');
  search('20750899');
  await settle(40);
  t('finds exactly that person', names().length === 1 && names()[0].indexOf('Ada Away') !== -1);
  search('215005');
  await settle(40);
  t('the badge still works, so an old habit is not punished',
    names().length === 1 && names()[0].indexOf('Ada Away') !== -1);
  search('80-AAWAY1');
  await settle(40);
  t('and so does the timeclock id', names().length === 1 && names()[0].indexOf('Ada Away') !== -1);
  search('21100616');
  await settle(40);
  t('another EID finds the other person', names()[0].indexOf('Gus Gone') !== -1);
  search('');
  await settle(40);

  console.log('— the profile names all three, and keeps them apart —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="215005"]'));
  await settle(40);
  const txt = d.body.textContent;
  t('the EID is labelled as such', txt.indexOf('EID') !== -1 && txt.indexOf('20750899') !== -1);
  t('and explained, because the workbook uses the word for something else',
    txt.indexOf('Legacy Contact ID in RC') !== -1);
  t('the badge is named as Beeline’s', txt.indexOf('Beeline badge') !== -1);
  t('and the WFM id is called the timeclock id',
    txt.indexOf('Timeclock id') !== -1 && txt.indexOf('80-AAWAY1') !== -1);

  console.log('— raising a task by EID —');
  click($('.suite-add'));
  const form = $('[data-form="task"]');
  form.querySelector('[name="title"]').value = 'Check Ada in TextUs';
  form.querySelector('[name="badge"]').value = '20750899';     // the EID, not the badge
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(80);
  const made = posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).pop();
  t('the task is saved against the right person', made && made.body.badge === '215005');
  t('resolved from the EID that was typed', made.body.name === 'Ada Away');
  t('with nothing to confirm, because it matched', !posts.some(p => p.alert));

  console.log('— a number that matches nothing is questioned, not assumed —');
  w.confirm = () => false;
  click($('.suite-add'));
  const f2 = $('[data-form="task"]');
  f2.querySelector('[name="title"]').value = 'Nowhere';
  f2.querySelector('[name="badge"]').value = '99999999';
  const before = posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).length;
  f2.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  t('declining the prompt saves nothing',
    posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).length === before);
  w.confirm = () => true;
  if ($('[data-close]')) click($('[data-close]'));

  console.log('— the task row shows the EID —');
  click($('[data-nav="tasks"]'));
  await settle(40);
  t('so the queue can be read without opening anything',
    d.body.textContent.indexOf('EID 20750899') !== -1);

  console.log('— an associate the roster has dropped —');
  click($('[data-nav="associates"]'));
  await settle(40);
  const former = w.GEODISSuite.profile('999111');
  t('still has a profile', !!former);
  t('marked former', former.former === true);
  t('and ended', former.status === 'Ended');
  t('their note survived', former.note === 'Owed four hours from the final week');
  search('999111');
  await settle(40);
  t('and they can be found', names().length === 1);
  t('shown as Former, not as active', names()[0].indexOf('Former') !== -1);
  search('');
  await settle(40);

  console.log('— and can still be worked with —');
  click($('[data-nav="associates"]'));
  click($('[data-profile="999111"]'));
  await settle(40);
  t('the profile opens', d.body.textContent.indexOf('Owed four hours') !== -1);
  t('saying why there is no assignment detail',
    d.body.textContent.indexOf('not in the current') !== -1);
  click($('.suite-add'));
  const tf = $('[data-form="task"]');
  tf.querySelector('[name="title"]').value = 'Chase final-week hours';
  tf.querySelector('[name="badge"]').value = '999111';
  tf.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(80);
  const t2 = posts.filter(p => p.url && p.url.indexOf('tasks=1') !== -1).pop();
  t('a task can still be raised against them', t2 && t2.body.badge === '999111');
  t('with no warning prompt, because they are a real person',
    !posts.some(p => p.alert && p.alert.indexOf('999111') !== -1));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
