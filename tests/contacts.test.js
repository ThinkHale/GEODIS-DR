/* Associate phone numbers.

   The workflow: somebody is not on the floor, so you look them up in TextUs and
   Vonage to see whether they reached out. Both are searched by number, so the
   number has to be on the row that says they are missing, and it has to be the
   RIGHT number -- a wrong one still reaches somebody, just not the person whose
   absence is being chased. That is why anything that is not a clean ten-digit
   US number is refused rather than repaired. */
const C = require('../contacts-core.js');
const SC = require('../schedule-core.js');
const { SuiteData: SD } = require('../suite-data.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

console.log('— reading a number —');
const same = ['(773) 639-5639', '773-639-5639', '773.639.5639', ' 7736395639 ',
  '1 773 639 5639', '+1 (773) 639-5639', '17736395639'];
t('every spelling of one number normalises to the same thing',
  new Set(same.map(C.normalize)).size === 1);
t('and that thing is ten digits', C.normalize(same[0]) === '7736395639');
t('displayed the way people read it', C.format('7736395639') === '(773) 639-5639');
t('and dialled the way a link needs', C.e164('7736395639') === '+17736395639');

console.log('— what is refused —');
[['', 'nothing'], ['123', 'too short'], ['773 639 563', 'nine digits'],
 ['77363956399', 'eleven that do not start with 1'], ['0736395639', 'area code starting 0'],
 ['1736395639', 'area code starting 1'], ['7730395639', 'exchange starting 0'],
 ['n/a', 'a word'], ['see notes', 'a note']].forEach(function (c) {
  t(c[1] + ' is refused', C.normalize(c[0]) === '');
});
t('an extension glued on is refused rather than truncated', C.normalize('7736395639x204') === '');
t('and nothing invalid is ever formatted', C.format('123') === '' && C.e164('123') === '');

console.log('— reading numbers out of a sheet —');
const sheet = [
  ['Redbull attendance', '', ''],
  ['Employee Name', 'Phone Number', '8/24/26'],
  ['Villamar, Yessimar ', '(773) 639-5639', 'On-Time'],
  ['Govea, Yarely R', '(630) 380-0838 ', 'On-Time'],
  ['Broken, Bob', 'n/a', 'On-Time'],
  ['', '(312) 555-1212', ''],              // no name: cannot be attached to anyone
  ['Nophone, Nora', '', 'On-Time']
];
const got = C.fromSheet(sheet, SC.rosterKey);
t('the header is found below a title row', got.rows.length === 2);
t('names come back keyed for matching', got.rows[0].nameKey === SC.rosterKey('Villamar, Yessimar'));
t('numbers come back normalised', got.rows[0].phone === '7736395639');
t('an unreadable number is skipped, not stored', !got.rows.some(r => r.name === 'Broken, Bob'));
t('and reported rather than swallowed', got.warnings.length === 1 && /1 row/.test(got.warnings[0]));
t('a number with nobody attached is dropped', !got.rows.some(r => !r.name && !r.eid));
t('a person with no number is simply absent', !got.rows.some(r => r.name === 'Nophone, Nora'));
t('a sheet with no phone column gives nothing',
  C.fromSheet([['Employee Name', 'Shift'], ['A', '1st']], SC.rosterKey).rows.length === 0);
t('nor does a phone column with nobody to attach it to',
  C.fromSheet([['Phone'], ['7736395639']], SC.rosterKey).rows.length === 0);
t('an EID column is enough on its own',
  C.fromSheet([['EID', 'Mobile'], ['80-X1', '7736395639']], SC.rosterKey).rows.length === 1);

console.log('— which key a stored number is filed under —');
t('a badge when there is one', C.record({ badge: 'b1', phone: '7736395639' }).id === 'PH-b1');
t('the EID when there is not', C.record({ eid: '80-X1', phone: '7736395639' }).id === 'PH-eid-80-X1');
t('the name key as a last resort',
  C.record({ nameKey: 'ada away', phone: '7736395639' }).id === 'PH-name-ada-away');
t('so re-reading the same sheet updates rather than duplicates',
  C.record({ nameKey: 'ada away', phone: '7736395639' }).id ===
  C.record({ nameKey: 'ada away', phone: '6303800838' }).id);

console.log('— reaching a number from a profile —');
const ix = C.index([
  C.record({ badge: 'b1', phone: '7736395639', source: 'Entered by hand' }),
  C.record({ eid: '80-BEID2', phone: '6303800838', source: 'PLX workbook' }),
  C.record({ nameKey: SC.rosterKey('Cara Came'), phone: '3315751033', source: 'PLX workbook' }),
  C.record({ badge: 'b1', eid: '80-AEID1', phone: '3125551212', source: 'PLX workbook' })
]);
const look = p => C.lookup(ix, p, SC.rosterKey);
t('by badge', look({ badge: 'b1', name: 'Ada Away' }).phone === '3125551212');
t('by employee id when there is no badge match',
  look({ badge: 'zz', timeclockId: '80-BEID2', name: 'Ben Been' }).phone === '6303800838');
t('by name as the last resort',
  look({ badge: 'zz', name: 'Cara Came' }).phone === '3315751033');
t('and nothing when no key reaches one', look({ badge: 'zz', name: 'Nobody Here' }) === null);
t('where it came from is kept, so a name match can be read with less confidence',
  look({ badge: 'zz', name: 'Cara Came' }).source === 'PLX workbook');

console.log('— a name two people share cannot pick between them —');
const shared = C.index([
  C.record({ nameKey: SC.rosterKey('John Smith'), phone: '7736395639' }),
  C.record({ nameKey: SC.rosterKey('John Smith'), phone: '6303800838' })
]);
t('so it resolves to nothing rather than to whichever came first',
  C.lookup(shared, { badge: 'zz', name: 'John Smith' }, SC.rosterKey) === null);
t('but one person listed twice with the SAME number is not a conflict',
  C.lookup(C.index([
    C.record({ nameKey: SC.rosterKey('Jane Doe'), phone: '7736395639' }),
    C.record({ nameKey: SC.rosterKey('Jane Doe'), phone: '773-639-5639' })
  ]), { badge: 'zz', name: 'Jane Doe' }, SC.rosterKey).phone === '7736395639');

console.log('— on the profile —');
const records = [
  { badge: 'b1', empNumber: '80-AEID1', person: 'Ada Away', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/2/2026' },
  { badge: 'b2', person: 'Gus Gone', action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago', crmStart: '1/3/2026' }
];
const contacts = [C.record({ badge: 'b1', phone: '7736395639', source: 'Entered by hand' })];
const cix = C.index(contacts, SD.normBadge);
const profiles = SD.buildProfiles(records, {
  phoneOf: p => C.lookup(cix, p, SC.rosterKey)
});
t('the number lands on the profile', profiles.get('b1').phone === '7736395639');
t('with its source', profiles.get('b1').phoneSource === 'Entered by hand');
t('somebody with no number has an empty one, not undefined', profiles.get('b2').phone === '');
t('and without the lookup nothing is invented',
  SD.buildProfiles(records, {}).get('b1').phone === '');

console.log('— the timeclock id reaches a profile —');
{
  /* The workbook's column headed "EID" is the WFM timeclock id, NOT the RC
     Legacy Contact ID the team searches by. A number harvested under one must
     not be looked up under the other. */
  const recs = [{ badge: 'b9', empNumber: '20750899', person: 'Ada Away',
    action: 'matched', actionLabel: 'Matched', reason: '', market: 'Chicago' }];
  const withShift = SD.buildProfiles(recs, {
    shifts: [{ nameKey: SC.rosterKey('Ada Away'), eid: '80-AAWAY1', shift: '1st' }],
    shiftKeysOf: SC.rosterKeys
  });
  t('it comes off the shift tag', withShift.get('b9').timeclockId === '80-AAWAY1');
  t('and is kept apart from the EID', withShift.get('b9').empNumber === '20750899');
  const linked = SD.buildProfiles(recs, {
    shifts: [{ nameKey: SC.rosterKey('Ada Away'), eid: '80-WRONG', shift: '1st' }],
    shiftKeysOf: SC.rosterKeys,
    timeclockLinks: [{ badge: 'b9', eid: '80-BYHAND' }]
  });
  t('a link made by hand beats one inferred from a name',
    linked.get('b9').timeclockId === '80-BYHAND');
  const phones = C.index([C.record({ eid: '80-AAWAY1', phone: '7736395639', source: 'PLX workbook' })]);
  t('so a harvested number reaches the profile',
    C.lookup(phones, withShift.get('b9'), SC.rosterKey).phone === '7736395639');
  t('and the EID is never mistaken for it',
    C.lookup(C.index([C.record({ eid: '20750899', phone: '6303800838' })]),
      withShift.get('b9'), SC.rosterKey) === null);
}

console.log('— matching harvested rows onto the roster —');
const profs = [
  { badge: 'b1', timeclockId: '80-AEID1', name: 'Ada Away' },
  { badge: 'b2', timeclockId: '80-BEID2', name: 'Gus Gone' },
  { badge: 'b3', timeclockId: '80-C1', name: 'Sam Same' },
  { badge: 'b4', timeclockId: '80-C2', name: 'Sam Same' }
];
const m = C.matchToProfiles([
  { name: 'Away, Ada', nameKey: SC.rosterKey('Away, Ada'), eid: '', phone: '1' },
  { name: 'x', nameKey: 'x', eid: '80-BEID2', phone: '2' },
  { name: 'Same, Sam', nameKey: SC.rosterKey('Same, Sam'), eid: '', phone: '3' },
  { name: 'Nobody, No', nameKey: SC.rosterKey('Nobody, No'), eid: '', phone: '4' }
], profs, { nameKeyOf: SC.rosterKey });
t('a name that reaches one profile matches', m.matched.some(x => x.profile.badge === 'b1'));
t('an employee id matches exactly', m.matched.some(x => x.profile.badge === 'b2'));
t('a duplicated name is held back rather than guessed', m.ambiguous.length === 1);
t('and somebody not on the roster is reported', m.unmatched.length === 1);
t('nothing is lost between the three piles',
  m.matched.length + m.ambiguous.length + m.unmatched.length === 4);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
