/* Round-trip the actual workbook so identity strings, shift grouping and row
 * completeness are verified at the downloaded file's boundary. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const Core = require('../roster-export-core.js');
let XLSX;
try { XLSX = require('xlsx'); } catch (err) { XLSX = require('../functions/node_modules/xlsx'); }

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  PASS: ' + name);
}
function person(badge, name, account, shift, extras) {
  return Object.assign({ badge, name, account, shift, empNumber: '00000007',
    status: 'Active', market: 'Chicago', location: '01519', shiftHours: '6am-4:30pm Sun-Wed' }, extras);
}
const people = [
  person('000003', 'Zoe LEGO', 'LEGO SAH', ' B '),
  person('000002', 'Ann Alpha', ' lego edu ', 'a'),
  person('000001', 'Ann Alpha', 'LEGO', ' A '),
  person('000004', 'Mia Missing', 'LEGO SAH', '  '),
  person('000005', 'Dan Ended', 'LEGO', 'A', { status: 'Ended' }),
  person('000006', 'LEGO name alone', 'CCM', 'A'),
  person('000007', 'Wrong client', 'LEGOLAND', 'A'),
  person('000008', 'Wrong prefix', 'Not LEGO', 'A'),
  person('000009', 'Account unknown', '', 'A', { location: 'LEGO', market: 'LEGO' }),
  person('000010', 'Shift Ten', 'LEGO', '10th'),
  person('000011', 'Shift Two', 'LEGO', '2nd')
];
const before = JSON.stringify(people);
const model = Core.build(people, { status: 'Active' });

test('matches LEGO accounts only, defaults to active, and keeps profile identity', () => {
  assert.equal(model.rows.length, 6);
  assert.equal(Core.build(people).rows.length, 6);
  assert.equal(Core.build(people, { status: 'Ended' }).rows[0].badge, '000005');
  assert.equal(Core.build(people, { status: 'all' }).rows.length, 7);
  assert(model.rows.every(row => people.includes(row)));
});
test('groups trimmed tags ignoring case, sorts naturally, and puts missing shift last', () => {
  assert.deepEqual(model.groups.map(group => group.shift), ['2nd', '10th', 'A', 'B', 'Unassigned']);
  assert.equal(model.groups[2].rows.length, 2);
  assert.equal(model.unassigned, 1);
  assert.deepEqual(model.groups[2].rows.map(row => row.badge), ['000001', '000002']);
  assert.equal(JSON.stringify(people), before);
});
test('empty input and missing tags produce usable models', () => {
  assert.deepEqual(Core.build([]), { rows: [], groups: [], unassigned: 0 });
  assert.deepEqual(Core.build([null, person('m', 'Missing', 'LEGO', null)]).groups[0].shift, 'Unassigned');
});
test('browser entry point exposes the same API without CommonJS', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'roster-export-core.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.RosterExportCore.build, 'function');
  assert.equal(typeof sandbox.window.RosterExportCore.workbook, 'function');
});

const longLabel = 'Very long shift label that exceeds Excel name length';
const workbookPeople = [
  person('00000012', '=HYPERLINK("https://example.invalid","Name")', 'LEGO SAH', 'Summary', {
    phone: 'DO NOT EXPORT PHONE', note: 'DO NOT EXPORT NOTE', points: 999, payroll: 'DO NOT EXPORT PAYROLL'
  }),
  person('00000013', '+Formula-looking name', 'LEGO', 'a/b'),
  person('00000014', '@Formula-looking name', 'LEGO', 'a:b'),
  person('00000015', '-Formula-looking name', 'LEGO', longLabel + ' one'),
  person('00000016', 'Names with accents: José', 'LEGO EDU', longLabel + ' two'),
  person('00000017', 'Blank shift', 'LEGO', ''),
  person('00000018', 'Literal tag', 'LEGO', 'Unassigned'),
  person('00000019', 'Quoted label', 'LEGO', "'Quoted*shift?'"),
  person('00000020', 'Only bad characters', 'LEGO', '[]:*?/\\')
];
for (let i = 0; i < 260; i++) workbookPeople.push(person(String(i).padStart(8, '0'), 'Associate ' + i, 'LEGO', 'A'));
workbookPeople.push(person('excluded', 'NON LEGO MUST NOT EXPORT', 'REDBULL', 'A'));
const workbookModel = Core.build(workbookPeople);
const wb = Core.workbook(workbookModel, XLSX, {
  market: 'Chicago', status: 'Active', exportedAt: '2026-09-11T12:00:00Z', rosterUpdatedAt: '2026-09-10T12:00:00Z'
});
const result = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });

test('round-trip creates a Summary and one unique legal worksheet per shift', () => {
  assert.equal(result.SheetNames[0], 'Summary');
  assert.equal(result.SheetNames.length, workbookModel.groups.length + 1);
  assert.equal(new Set(result.SheetNames.map(name => name.toLowerCase())).size, result.SheetNames.length);
  result.SheetNames.forEach(name => {
    assert(name.length > 0 && name.length <= 31);
    assert(!/[\\/\?\*\[\]:]/.test(name));
    assert(!/^'|'$/.test(name));
  });
  assert(result.SheetNames.includes('Summary (2)'));
  assert(result.SheetNames.some(name => /^a b \(2\)$/i.test(name)));
  assert(result.SheetNames.includes('Unassigned (2)'));
});
test('round-trip preserves every row beyond the UI cap and only the specified columns', () => {
  let rowCount = 0;
  result.SheetNames.slice(1).forEach(name => {
    const sheet = result.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    assert.deepEqual(rows[0], ['Associate', 'EID', 'Badge', 'Account', 'Site', 'Market', 'Shift', 'Shift hours', 'Status']);
    rowCount += rows.length - 1;
    assert.equal(sheet['!autofilter'].ref, 'A1:I' + rows.length);
  });
  assert.equal(rowCount, workbookModel.rows.length);
  assert.equal(XLSX.utils.sheet_to_json(result.Sheets.A).length, 260);
  assert(!JSON.stringify(result).includes('DO NOT EXPORT'));
  assert(!JSON.stringify(result).includes('NON LEGO MUST NOT EXPORT'));
});
test('round-trip retains leading-zero identifiers and formula-looking values as text', () => {
  const sheet = result.Sheets['Summary (2)'];
  assert.equal(sheet.A2.v, '=HYPERLINK("https://example.invalid","Name")');
  assert.equal(sheet.B2.v, '00000007');
  assert.equal(sheet.C2.v, '00000012');
  assert.equal(sheet.E2.v, '01519');
  result.SheetNames.slice(1).forEach(name => {
    const current = result.Sheets[name];
    Object.keys(current).filter(key => key[0] !== '!').forEach(key => {
      assert.equal(current[key].t, 's');
      assert.equal(current[key].f, undefined);
    });
  });
});
test('summary contains numeric counts, source metadata, and a correct total', () => {
  const summary = result.Sheets.Summary;
  assert.equal(summary.B2.v, 'Chicago');
  assert.equal(summary.B3.v, 'Active');
  assert.equal(summary.B4.v, '2026-09-11T12:00:00Z');
  assert.equal(summary.B5.v, '2026-09-10T12:00:00Z');
  assert.equal(summary.B8.t, 'n');
  assert.equal(summary['B' + (8 + workbookModel.groups.length)].v, workbookModel.rows.length);
  assert(wb.Sheets.A['!cols'].length === 9);
});
test('empty workbook retains summary and an unavailable library fails clearly', () => {
  const empty = Core.workbook(Core.build([]), XLSX, { market: 'all', status: 'all' });
  assert.deepEqual(empty.SheetNames, ['Summary']);
  assert.equal(empty.Sheets.Summary.B2.v, 'All markets');
  assert.equal(empty.Sheets.Summary.B3.v, 'All statuses');
  assert.equal(empty.Sheets.Summary.B8.v, 0);
  assert.throws(() => Core.workbook(model, null), /Excel export is unavailable/);
});

console.log('\n' + passed + ' passed, 0 failed');
