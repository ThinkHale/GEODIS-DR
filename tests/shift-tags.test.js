/* Shift tags from the PLX workbook: the "Geodis Key" vocabulary, the per-associate
   assignment on the HC tabs, and the tag winning over a schedule-derived label in
   the headcount export. */
const fs = require('fs');
const path = require('path');
const SK = require('../shift-key.js');
const SC = require('../schedule-core.js');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— the Key’s clock shorthand —');
t('6am', SK.parseLoose('6am') === 360);
t('2:30pm', SK.parseLoose('2:30pm') === 870);
t('12am is midnight', SK.parseLoose('12am') === 0);
t('12pm is noon', SK.parseLoose('12pm') === 720);
t('not a time', SK.parseLoose('Mon-Fri') === null);
t('minutes over 59 refused', SK.parseLoose('6:75am') === null);

console.log('— schedule strings, every format in the sheet —');
const w = s => SK.parseKeySchedule(s);
t('times then days', w('6am-2:30pm Mon-Fri').start === 360 && w('6am-2:30pm Mon-Fri').end === 870);
t('days then times', w('Mon - Fri 8am - 4:30pm').start === 480 && w('Mon - Fri 8am - 4:30pm').end === 990);
t('ends AT midnight, not next-day 00:00', w('3:30pm-12am Mon-Fri').end === 1440);
t('midnight end is not treated as overnight', w('3:30pm-12am Mon-Fri').overnight === false);
t('genuine overnight rolls forward', w('6pm-2:30am Mon-Fri').end === 1590);
t('overnight flagged', w('6pm-2:30am Mon-Fri').overnight === true);
t('day range captured', w('6am-2:30pm Sun-Thur').days === 'Sun-Thur');
t('compound flagged, first window used', w('12pm-6pm (Wed) & 6am-6pm (Thur-Sat)').compound === true);
t('slash compound flagged', w('Sun 11am - 7:30pm / Mon - Thurs 1:30pm - 10pm').compound === true);
t('empty is null, not a guess', w('') === null);
t('unparseable keeps its raw text and no hours', w('ask Kim').start === null && w('ask Kim').raw === 'ask Kim');

console.log('— the Key tab —');
const keyAoa = [
  ['CHICAGO CAMPUS', '', '', '', '', '', '', 'Building', 'Job Title', 'Account Name', 'Account Num', 'Beeline Shift', 'Shift', 'Schedule', 'Rate', 'Supervisor'],
  ['Building #', 'Address', '', '', '', '', '', '1502', 'OPR2', 'REDBULL', '67510', '1', '1st', '6am-2:30pm Mon-Fri', '$19', 'Pickett, Craig'],
  ['1502', '1101 Taylor', '', '', '', '', '', '1502', 'MATH1', 'CCM', '18845', '4', '2nd', '3pm-11:30pm Mon-Fri', '$19', 'Sotelo, Marco'],
  ['', '', '', '', '', '', '', '1519', 'OPR1', 'LEGO', '18109', '1', 'A', '6am-4:30pm Sun-Wed', '$17', 'Colon, Carlos'],
  // Same building + shift, different hours per account -- ambiguous on purpose.
  ['', '', '', '', '', '', '', '1517', 'MATH3', '32 DEGREES', '18611', '1', '1st', '6am-2:30pm Sun-Thur', '$17', 'X'],
  ['', '', '', '', '', '', '', '1517', 'MATH3', 'LEGO EDU', '18301', '1', '1st', '7am-3:30pm Mon-Fri', '$17', 'Y']
];
const key = SK.parseShiftKey(keyAoa);
t('right-hand table found by header, not position', key.entries.length === 5);
t('shift vocabulary per building', JSON.stringify(key.byBuilding['1502']) === '["1st","2nd"]');
t('non-numeric shift labels kept', JSON.stringify(key.byBuilding['1519']) === '["A"]');
t('unambiguous window resolves', SK.windowFor(key, '1502', '1st').start === 360);
t('ambiguous window refuses to pick without an account', SK.windowFor(key, '1517', '1st') === null);

/* A building running one shift on two sets of hours is not really ambiguous:
   the hours belong to the CLIENT, and an associate's dept code names it. */
t('the account settles it', SK.windowFor(key, '1517', '1st', '18611').start === 360);
t('a different account at the same site and shift differs',
  SK.windowFor(key, '1517', '1st', '18301').start === 420);
t('an account with no Key row falls back to the building answer',
  SK.windowFor(key, '1517', '1st', '99999') === null);
t('an account that does not disagree still resolves',
  SK.windowFor(key, '1502', '1st', '67510').start === 360);
t('the dept code yields the account number', SK.accountNumOf('1517-18611') === '18611');
t('a dept with no account number is empty', SK.accountNumOf('1517') === '');
t('and so is nothing at all', SK.accountNumOf('') === '' && SK.accountNumOf(null) === '');
t('and says why', key.warnings.some(x => x.indexOf('1517') !== -1 && x.indexOf('decided by the account') !== -1));
t('wrong tab is reported', SK.parseShiftKey([['a', 'b']]).warnings[0].indexOf('Geodis Key') !== -1);

console.log('— the HC tabs —');
const hcSheet = {
  name: '1502 - HC', aoa: [
    ['PLX - 1ST SHIFT HEADCOUNT', '', '', '', '', '', '', '', 'Expected', 'Onsite', 'Short', '', 'PLX - 2ND SHIFT HEADCOUNT'],
    ['Transition', 'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments', '2', '1', '1', '',
      'Dept', 'Employee  Name', 'EID', 'Start Date', 'Shift ', 'Current Points', 'Comments'],
    ['', '1502-18109', 'Grachen, Luz', '80-LGRACH3897', '5/28/26', '1st', '2', '', '', '', '', '',
      '1502-18845', 'Munoz, Abel', '80-AMUNOZ8734', '6/9/26', '2nd', '0', ''],
    ['Y', '1502-18109', 'Porras, Fernando', '80-FPORRA4387', '6/4/26', '1st', '0', '', '', '', '', '',
      '', '', '', '', '', '', ''],
    // No EID yet -- still taggable by name.
    ['', '1502-18109', 'Goitia, Albert', '', '8/26/26', '1st', '0', '', '', '', '', '', '', '', '', '', '', '', '']
  ]
};
const hc = SK.parseHeadcount([hcSheet, { name: 'Pipeline', aoa: [['x']] }], SC.rosterKey);
t('both shift blocks read', hc.people.length === 4);
t('non-HC sheets ignored', hc.sheets.length === 1);
t('building from the sheet name', hc.sheets[0].building === '1502');
t('two blocks detected', hc.sheets[0].blocks === 2);
const luz = hc.people.find(p => p.name === 'Grachen, Luz');
t('EID read', luz.eid === '80-LGRACH3897');
t('shift read despite the trailing space in the header', luz.shift === '1st');
t('dept read from the column before the name', luz.dept === '1502-18109');
t('name key is the cross-source form', luz.nameKey === SC.rosterKey('Luz Grachen'));
t('second block read', hc.people.some(p => p.name === 'Munoz, Abel' && p.shift === '2nd'));
t('a person with no EID is still tagged', hc.people.some(p => p.name === 'Goitia, Albert' && !p.eid));

console.log('— storage records —');
const recs = SK.toShiftRecords(hc, key);
t('id is the EID when there is one', recs.find(r => r.eid === '80-LGRACH3897').id === 'eid:80-LGRACH3897');
t('falls back to a name id', recs.find(r => r.name === 'Goitia, Albert').id.indexOf('name:') === 0);
t('hours denormalised from the Key', recs.find(r => r.eid === '80-LGRACH3897').hours === '6am-2:30pm Mon-Fri');
t('ambiguous hours left blank rather than guessed',
  SK.toShiftRecords({ people: [{ name: 'X', nameKey: 'x', eid: 'E', shift: '1st', building: '1517' }] }, key)[0].hours === '');
t('source recorded', recs[0].source === 'PLX workbook');

console.log('— lookup from either namespace —');
const idx = SK.indexShifts(recs);
t('by EID', idx.find('80-LGRACH3897', '').record.shift === '1st');
t('EID match is reported as such', idx.find('80-LGRACH3897', '').how === 'eid');
t('EID is case-insensitive', idx.find('80-lgrach3897', '').record.shift === '1st');
t('by name when there is no EID', idx.find('', SC.rosterKey('Albert Goitia')).how === 'name');
t('EID wins over name', idx.find('80-LGRACH3897', SC.rosterKey('Albert Goitia')).how === 'eid');
t('unknown person', idx.find('nope', 'nobody').record === null);
const conflicted = SK.indexShifts([
  { eid: '', nameKey: 'a b', shift: '1st' }, { eid: '', nameKey: 'a b', shift: '2nd' }
]);
t('a name with two shifts is poisoned, not guessed', conflicted.find('', 'a b').record === null);

console.log('— a shift the building does not run —');
const bad = SK.validateAgainstKey({
  people: [{ name: 'Typo, T', building: '1502', shift: '5' }, { name: 'Fine, F', building: '1502', shift: '1st' }]
}, key);
t('flagged', bad.length === 1);
t('names the building’s real shifts', bad[0].indexOf('1st, 2nd') !== -1);
t('names who', bad[0].indexOf('Typo, T') !== -1);
t('valid tags are silent', SK.validateAgainstKey({ people: [{ name: 'F', building: '1502', shift: '2nd' }] }, key).length === 0);
t('a building absent from the Key is not second-guessed',
  SK.validateAgainstKey({ people: [{ name: 'F', building: '9999', shift: 'Z' }] }, key).length === 0);

console.log('— the tag decides the headcount block —');
const schedule = SC.parseSchedule([
  ['Time Period :', '', '8/23/2026 - 8/29/2026'],
  ['GEODIS/US/CL/CLSCEN/CLSL/CL1519/1519'],
  ['Employee', 'Primary Job', 'Tue'],
  ['', '', '8/25/2026'],
  ['Scheduled, Sam', 'Job', '6:00 AM - 4:30 PM']
]);
const presence = SC.parseOnPremise([
  ['Employee Full Name & ID', 'On Premises', 'Primary location (path)', 'Reports To'],
  ['Scheduled, Sam (80-SSAM1)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1519/1519', 'B, B'],
  ['Untagged, Uma (80-UUMA2)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1519/1519', 'B, B'],
  ['Tagged, Tom (80-TTOM3)', 'true', 'GEODIS/US/CL/CLSCEN/CLSL/CL1519/1519', 'B, B']
]);
// Sam is scheduled (would derive "1st") but tagged "A"; Tom is only tagged.
const profiles = new Map([
  ['b1', { badge: 'b1', name: 'Sam Scheduled', shift: 'A', crmStart: '1/2/2026', points: 0 }],
  ['b2', { badge: 'b2', name: 'Uma Untagged', shift: '', crmStart: '1/3/2026', points: 1 }],
  ['b3', { badge: 'b3', name: 'Tom Tagged', shift: 'A', crmStart: '1/4/2026', points: 2 }]
]);
const res = SC.buildCoverage({ schedule, presence, asOf: new Date(2026, 7, 25, 9, 0) });
SC.linkRoster(res.rows, profiles, v => String(v || '').trim());
t('all three reached a profile by name', res.rows.filter(r => r.badge).length === 3);
t('derived label alone would have said 1st', SC.shiftLabelFor(res.rows.find(r => r.name === 'Scheduled, Sam')) === '1st');
t('but the tag wins', SC.shiftOf(res.rows.find(r => r.name === 'Scheduled, Sam'), profiles).label === 'A');
t('and is reported as coming from the tag', SC.shiftOf(res.rows.find(r => r.name === 'Scheduled, Sam'), profiles).source === 'tag');
t('an unscheduled but tagged person gets a block',
  SC.shiftOf(res.rows.find(r => r.name === 'Tagged, Tom'), profiles).label === 'A');
t('nobody with neither is placed', SC.shiftOf(res.rows.find(r => r.name === 'Untagged, Uma'), profiles).label === '');

const blockA = SC.spreadsheetExport(res, { location: '1519', shift: 'A', profiles, documented: {} });
t('the A block holds both tagged people', blockA.rows.length === 2);
t('the untagged person is not invented into it', !blockA.rows.some(r => r.name === 'Untagged, Uma'));
t('previously this person had no block at all',
  blockA.rows.some(r => r.name === 'Tagged, Tom'));
t('shift column shows the tag', blockA.rows[0].shift === 'A');
t('pickers offer the labels present, not a hardcoded 1st/2nd/3rd',
  JSON.stringify(SC.shiftLabelsIn(res, profiles)) === '["A"]');

console.log('— against the real PLX workbook, when present —');
const book = path.join(__dirname, '..', 'PLX - Geodis Spreadsheet.xlsx');
if (!fs.existsSync(book)) {
  console.log('  skipped - workbook not in the repo');
} else {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(book);
  const rd = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
  const realKey = SK.parseShiftKey(rd('Geodis Key'));
  const realHc = SK.parseHeadcount(wb.SheetNames.map(n => ({ name: n, aoa: rd(n) })), SC.rosterKey);
  t('Key parses', realKey.entries.length === 102);
  t('all eight buildings mapped', Object.keys(realKey.byBuilding).length === 8);
  t('sites using A/B/C are captured', JSON.stringify(realKey.byBuilding['1559']) === '["A","B","C"]');
  t('every HC tab read', realHc.sheets.length === 7);
  t('314 associates tagged', realHc.people.length === 314);
  const realRecs = SK.toShiftRecords(realHc, realKey);
  t('303 carry an EID', realRecs.filter(r => r.eid).length === 303);
  /* 313 of 314 once the account narrows the hours and the two mistyped dept
     codes are read through ACCOUNT_ALIASES; it was 277 on building+shift alone.
     The one left is the row with a bad shift value, which has no dept either. */
  t('the account resolves all but one', realRecs.filter(r => r.hours).length === 313);
  t('the rest cannot be reached from the Key',
    realRecs.filter(r => !r.hours).length === 1);
  t('the sheet’s one bad shift value is caught',
    SK.validateAgainstKey(realHc, realKey).some(x => x.indexOf('"5"') !== -1));
  t('no duplicate ids', new Set(realRecs.map(r => r.id)).size === realRecs.length);
}

console.log('— dept codes the Key does not list —');
const aliased = { people: [
  { name: 'A', building: '1517', dept: '1517-18070', shift: '1st' },
  { name: 'B', building: '1517', dept: '1517-18070', shift: '1st' },
  { name: 'C', building: '1517', dept: '1517-18270', shift: '1st' }
] };
const aw = SK.aliasWarnings(aliased);
t('a known transposition is reported, with a count', aw.length === 1 && aw[0].indexOf('2 associate') === 0);
t('it names both the typed code and the real one',
  aw[0].indexOf('1517-18070') !== -1 && aw[0].indexOf('1517-18270') !== -1);
t('and says the workbook is where to fix it', aw[0].indexOf('workbook') !== -1);
t('a correct code is silent',
  SK.aliasWarnings({ people: [{ name: 'C', building: '1517', dept: '1517-18270' }] }).length === 0);
t('the alias resolves for scheduling', SK.resolveAccount('1517', '18070') === '18270');
t('an unaliased code is left alone', SK.resolveAccount('1517', '99999') === '99999');
t('the second known transposition resolves too', SK.resolveAccount('1517', '18873') === '18773');
t('an alias is scoped to its building', SK.resolveAccount('1519', '18070') === '18070');
t('validateAgainstKey surfaces it too, so both callers get it',
  SK.validateAgainstKey(aliased, key).some(w => w.indexOf('1517-18070') !== -1));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
