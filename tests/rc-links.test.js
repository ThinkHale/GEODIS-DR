/* RC record ids. RC is Salesforce, so every record has an 18-character id; those
   are what a deep link needs. The columns are found by the SHAPE of the values
   rather than the header text, because "Assignment ID" already means the badge
   in this export and a renamed column must not silently stop working. */
const Core = require('../reconcile-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— what a Salesforce id looks like —');
t('18 characters', Core.looksLikeSfId('0035f00000ABCDEfGH'));
t('15 characters', Core.looksLikeSfId('0035f00000ABCDE'));
// The object prefix is usually numeric (003 = Contact), so it must not be
// required to start with a letter -- that was my first mistake here.
t('a numeric object prefix is fine', Core.looksLikeSfId('0035f00000ABCDEfGH'));
t('a custom-object prefix is fine', Core.looksLikeSfId('a0B5f00000ABCDEfGH'));
t('but a long pure number is NOT an id', !Core.looksLikeSfId('123456789012345678'));
t('a badge number is not one', !Core.looksLikeSfId('215005'));
t('nor is a name', !Core.looksLikeSfId('Reed, Ava'));
t('nor a WFM id', !Core.looksLikeSfId('80-AREED1001'));
t('nor a date', !Core.looksLikeSfId('8/25/2026'));
t('nor empty', !Core.looksLikeSfId('') && !Core.looksLikeSfId(null));
t('wrong length is refused', !Core.looksLikeSfId('a035f00000ABCD'));

console.log('— finding the columns —');
const id = (p, n) => p + String(n).padStart(18 - p.length, '0');
const aoa = [
  ['Person Placed: Legacy Contact ID', 'Person Placed Name', 'Badge Number', 'Assignment Status',
   'Person Placed: Record ID', 'Assignment: Record ID', 'Start Date'],
  ['20750899', 'Ava Reed', '215005', 'Active', id('003A', 1), id('a0BA', 1), '1/5/2025'],
  ['21100616', 'Ben Ortiz', '217261', 'Active', id('003A', 2), id('a0BA', 2), '2/1/2025'],
  ['14872570', 'Cleo Nash', '217642', 'Active', id('003A', 3), id('a0BA', 3), '3/3/2025'],
  ['18452416', 'Dev Patel', '220427', 'Active', id('003A', 4), id('a0BA', 4), '4/4/2025']
];
let cols = Core.detectRecordIdCols(aoa, 0);
t('the contact id column is found', cols.contactIdCol === 4);
t('the assignment id column is found', cols.assignmentIdCol === 5);
t('the LEGACY contact id is not mistaken for it', cols.contactIdCol !== 0 && cols.assignmentIdCol !== 0);
t('the badge column is not mistaken for it', cols.contactIdCol !== 2 && cols.assignmentIdCol !== 2);

console.log('— it survives a rename —');
const renamed = aoa.map(r => r.slice());
renamed[0][4] = 'Associate 18 Digit ID';
renamed[0][5] = 'Assignment 18 Digit ID';
cols = Core.detectRecordIdCols(renamed, 0);
t('still finds both', cols.contactIdCol === 4 && cols.assignmentIdCol === 5);

console.log('— it refuses to guess —');
t('no id columns at all', JSON.stringify(Core.detectRecordIdCols([
  ['Badge Number', 'Person Placed Name'], ['215005', 'Ava Reed'], ['217261', 'Ben Ortiz'], ['1', 'C']
], 0)) === '{"contactIdCol":-1,"assignmentIdCol":-1}');
const mixed = [['Notes'], ['0035f00000ABCDEfGH'], ['some free text here'], ['0035f00000ABCDEfGI'], ['x']];
t('a column of mostly-text is not an id column', Core.detectRecordIdCols(mixed, 0).assignmentIdCol === -1);
const tooFew = [['Maybe'], ['0035f00000ABCDEfGH'], [null], [null]];
t('too few values to be sure is not enough', Core.detectRecordIdCols(tooFew, 0).assignmentIdCol === -1);
const lone = [['Record ID'], [id('a0BA', 1)], [id('a0BA', 2)], [id('a0BA', 3)]];
t('a single unlabelled id column reads as the assignment',
  Core.detectRecordIdCols(lone, 0).assignmentIdCol === 0);

console.log('— the ids reach a reconciled record —');
const bee = Core.buildState([
  ['Assignment ID', 'Contractor Name', 'Assignment Status', 'Profit Center Name'],
  ['215005', 'Ava Reed', 'Active', 'LLC;North Central;Chicago;1519-18109'],
  // Only in Beeline, so RC has no record of it and no ids to give.
  ['999999', 'Only Inbeeline', 'Active', 'LLC;North Central;Chicago;1519-18109']
], 'beeline');
const crm = Core.buildState(aoa, 'crm');
t('buildState records the contact column', crm.contactIdCol === 4);
t('and the assignment column', crm.assignmentIdCol === 5);
const out = Core.reconcile(bee, crm, null);
const ava = out.records.filter(r => r.badge === '215005')[0];
t('the record carries the contact id', ava.contactId === id('003A', 1));
t('and the assignment id', ava.assignmentId === id('a0BA', 1));
const beeOnly = out.records.filter(r => r.badge === '999999')[0];
t('a Beeline-only badge is still reconciled', !!beeOnly);
t('and carries no ids, because RC has no record of it',
  beeOnly.contactId === '' && beeOnly.assignmentId === '');
const rcOnly = out.records.filter(r => r.badge === '217261')[0];
t('an RC-only badge DOES carry its ids', rcOnly.contactId === id('003A', 2));

console.log('— an export without the columns still works —');
const old = Core.buildState([
  ['Person Placed: Legacy Contact ID', 'Person Placed Name', 'Badge Number', 'Assignment Status'],
  ['20750899', 'Ava Reed', '215005', 'Active'],
  ['21100616', 'Ben Ortiz', '217261', 'Active'],
  ['14872570', 'Cleo Nash', '217642', 'Active']
], 'crm');
t('no id columns detected', old.contactIdCol === -1 && old.assignmentIdCol === -1);
const outOld = Core.reconcile(bee, old, null);
t('reconciliation is unaffected', outOld.records.length > 0);
t('and the ids are simply empty', outOld.records.every(r => r.contactId === '' && r.assignmentId === ''));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
