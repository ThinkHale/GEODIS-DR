const { SuiteData } = require('../suite-data.js');
let pass=0, fail=0;
const t=(n,c)=>{ if(c){pass++;} else {fail++;console.log('  FAIL: '+n);} };

// Snapshot rows shaped exactly like functions/index.js emits them.
const records=[
  {badge:'1001', empNumber:'E1', person:'Ava Reed', action:'matched',    actionLabel:'Matched',       reason:'Badge is active in both systems.', market:'Atlanta', marketVerified:true, crmStart:'1/5/2025', beeStart:'1/5/2025', endDate:'', dup:false},
  {badge:'1002', empNumber:'',   person:'Ben Ortiz', action:'endCrm',    actionLabel:'End in RC',      reason:'Beeline shows Terminated.', market:'Atlanta', marketVerified:true, crmStart:'2/1/2025', beeStart:'', endDate:'', dup:false},
  {badge:'1003', empNumber:'E3', person:'Cleo Nash', action:'addBeeline',actionLabel:'Add to Beeline', reason:'No record in Beeline.', market:'Other', marketVerified:false, marketRaw:'MEMPHIS', crmStart:'3/3/2025', endDate:'', dup:true},
  {badge:'1004', empNumber:'E4', person:'Dev Patel', action:'endBeeline',actionLabel:'End in Beeline', reason:'RC ended them.', market:'Atlanta', marketVerified:true, endDate:'6/30/2025', endReason:'Voluntary', dup:false},
  {badge:'1005.0',empNumber:'E5',person:'Eve Kim',   action:'addCrm',    actionLabel:'Beeline Active / No RC Data', reason:'', market:'Dallas', marketVerified:true, endDate:'', dup:false}
];

const stores={
  attendance:[
    {id:'a1',badge:'1001',date:'2026-08-20',type:'Absent',points:1},
    {id:'a2',badge:'1001',date:'2026-08-21',type:'Late',points:0.5},
    {id:'a3',badge:'1001',date:'2026-08-22',type:'Present',points:0},
    {id:'a4',badge:'1002',date:'2026-08-22',type:'No Call / No Show',points:2},
    {id:'a5',badge:'9999',date:'2026-08-22',type:'Absent',points:1}   // not on roster
  ],
  timeOff:[{id:'t1',badge:'1001',type:'PTO',start:'2026-08-01',end:'2026-08-02',hours:16,status:'Pending'}],
  performance:[
    {id:'p1',badge:'1001',period:'2026-07',quality:90,productivity:80,safety:100},
    {id:'p2',badge:'1001',period:'2026-08',quality:96,productivity:90,safety:99},
    {id:'p3',badge:'1003',period:'2026-08',quality:70}                  // partial metrics
  ],
  notes:{'1003':{note:'Waiting on I-9'}}
  ,associatePto:[{id:'TP-1001',badge:'1001',transitionAssociate:'true',transitionPtoInitial:10,transitionPtoBalance:6}]
};

const P = SuiteData.buildProfiles(records, stores);

console.log('— roster —');
/* 5 from the snapshot, plus one former profile for badge 9999 -- an attendance
   row whose person has left the roster. Keeping them reachable is the point;
   see "former associates" below. */
t('all 5 records became profiles', P.size===6);
t('and every snapshot record is one of them',
  ['1001','1002','1003','1004','1005'].every(b=>P.has(b)));
t('badge 1005.0 normalized to 1005', P.has('1005') && !P.has('1005.0'));

console.log('— status (active vs ended) —');
t('matched            -> Active', P.get('1001').status==='Active');
t('endCrm             -> Ended',  P.get('1002').status==='Ended');
t('addBeeline         -> Active', P.get('1003').status==='Active');
t('endBeeline+endDate -> Ended',  P.get('1004').status==='Ended');
t('addCrm             -> Active', P.get('1005').status==='Active');

console.log('— reconciliation state rides on the profile —');
t('matched flagged in sync', P.get('1001').reconciled===true);
t('exception keeps its label', P.get('1002').actionLabel==='End in RC');
t('exception keeps its reason', P.get('1002').actionReason.includes('Terminated'));
t('dup flag carried', P.get('1003').dup===true);
t('unverified market keeps raw location', P.get('1003').marketRaw==='MEMPHIS');
t('shared note joined', P.get('1003').note==='Waiting on I-9');

console.log('— attendance join —');
t('1001 points sum to 1.5', P.get('1001').points===1.5);
t('1001 has 3 events', P.get('1001').attendance.length===3);
t('events sort newest first', P.get('1001').attendance[0].date==='2026-08-22');
t('1002 points = 2', P.get('1002').points===2);
/* ---- former associates ----
   A badge the snapshot no longer carries still keeps a profile, so the records
   already against it stay reachable and more can be added. The snapshot is the
   CURRENT reconciliation: somebody ended in both systems drops out of it, and
   without this their notes and payroll issues would point at nothing. */
t('a departed badge still has a profile', P.has('9999'));
t('marked as former rather than pretending to be current', P.get('9999').former === true);
t('and shown as ended', P.get('9999').status === 'Ended');
t('their occurrence is attached to it', P.get('9999').attendance.length === 1);
t('it says why there is no assignment detail',
  P.get('9999').actionReason.indexOf('not in the current') !== -1);
t('somebody still on the roster is not marked former', !P.get('1001').former);
/* A row with no badge at all still reaches nobody, and is still reported --
   that is the case a silently dropped disciplinary record would hide in. */
t('a row with no badge is still an orphan',
  SuiteData.unmatched(P, [{badge:'',date:'2026-08-22',type:'Absent',points:1}]).length===1);
t('but one whose person merely left is not', SuiteData.unmatched(P, stores.attendance).length===0);

console.log('— standing bands —');
t('1.5 pts -> Good standing', P.get('1001').standing==='Good standing');
t('6 pts -> Written warning', SuiteData.bandFor(6).standing==='Written warning');
t('12 pts -> Termination review', SuiteData.bandFor(12).standing==='Termination review');

console.log('— scorecards —');
t('most recent period wins', P.get('1001').performance.period==='2026-08');
t('score = avg(96,90,99) = 95', P.get('1001').score===95);
t('partial metrics still score', P.get('1003').score===70);
t('no perf record -> null, not a fake number', P.get('1002').score===null);
t('attendance NOT blended into score', P.get('1002').points===2 && P.get('1002').score===null);

console.log('— time off join —');
t('1001 has the PTO request', P.get('1001').timeOff.length===1);
t('transition identifier and balance join to profile', P.get('1001').transitionAssociate===true && P.get('1001').transitionPtoBalance===6);
t('no time off elsewhere', P.get('1004').timeOff.length===0);

console.log('— misc —');
t('initials derived', P.get('1001').initials==='AR');
t('empty roster is safe', SuiteData.buildProfiles([], {}).size===0);
t('null stores are safe', SuiteData.buildProfiles(records, null).size===5);

console.log('— a site default names the account the Key does not —');
const locs = [{ code: '1559', name: 'Post', active: true },
              { code: '1536', name: 'Redbull', active: true },
              { code: '1519', name: 'Retired Site', active: false }];
const shiftRows = [
  { id: 's1', nameKey: 'ava reed', shift: 'B', building: '1559', account: '' },
  { id: 's2', nameKey: 'ben ortiz', shift: '2nd', building: '1536', account: 'REDBULL SPECIFIC' },
  { id: 's3', nameKey: 'cleo nash', shift: 'A', building: '1519', account: '' },
  { id: 's4', nameKey: 'eve kim', shift: '1st', building: '9999', account: '' }
];
/* The real key function, not a copy: these fixtures carry a stored nameKey and
   no name, which is exactly the shape a workbook imported before the wider
   matching existed leaves behind. It has to keep joining. */
const SC2 = require('../schedule-core.js');
const P2 = SuiteData.buildProfiles(records, { shifts: shiftRows, shiftKeysOf: SC2.rosterKeys, locations: locs });
t('a bare site gets the default name', P2.get('1001').account === 'Post');
t('and reads as site · account', P2.get('1001').locationLabel === '1559 · Post');
t('the Key still wins where it has one', P2.get('1002').account === 'REDBULL SPECIFIC');
t('an INACTIVE location supplies no default', P2.get('1003').account === '');
t('but the site number still shows', P2.get('1003').locationLabel === '1519');
t('a site with no entry at all is left alone', P2.get('1005').account === '');
t('no locations list is safe',
  SuiteData.buildProfiles(records, { shifts: shiftRows, shiftKeysOf: SC2.rosterKeys }).get('1001').account === '');

/* The roster spells a name "First Last"; the PLX workbook spells it
   "Last, First". One key could not span both once a surname had two words, so
   every compound surname joined to nothing -- no site, no shift, on a large
   share of a Chicago floor. */
console.log('— compound surnames reach their shift tag —');
const compound = [
  ['Alexander Gomez Amarales', 'Gomez Amarales, Alexander'],
  ['Anali De Leon campos', 'De Leon campos, Anali'],
  ['Angie Nuñez Garnica', 'Nunez Garnica, Angie'],
  ['Bryan Antonio Zapata Rodriguez', 'Zapata Rodriguez, Bryan Antonio'],
  ['Antwoin Gordon jr', 'Gordon jr, Antwoin'],
  ['Alexander Ramirez-Campos', 'Ramirez Campos, Alexander'],
  /* A real row from the PLX workbook: the suffix is on the wrong side of the
     comma, so stripping suffixes only from the surname half would file Herbert
     Brooks under "iii". */
  ['Herbert Brooks III', 'Brooks,III, Herbert'],
  ['Ahmad Willingham', 'Willingham, Ahmad']
];
const cRecords = compound.map(([person], i) => ({
  badge: 'C' + i, person, action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago'
}));
const cShifts = compound.map(([, book], i) => ({
  id: 'cs' + i, name: book, nameKey: SC2.rosterKey(book), shift: '1st', building: '150' + i, account: ''
}));
const CP = SuiteData.buildProfiles(cRecords, { shifts: cShifts, shiftKeysOf: SC2.rosterKeys });
compound.forEach(([person], i) => {
  t(person + ' finds a site', CP.get('C' + i).location === '150' + i);
});
t('and a shift with it', compound.every((x, i) => CP.get('C' + i).shift === '1st'));

/* Widening the keys widens the chance of a collision. Attaching the wrong
   building to somebody is worse than attaching none, so an ambiguous key is
   refused rather than guessed at. */
console.log('— but it still refuses to guess —');
const twoCarlos = [
  { id: 'x1', name: 'Garcia Hernandez, Carlos', nameKey: 'carlos garcia', shift: '1st', building: '1502', account: '' },
  { id: 'x2', name: 'Garcia Lopez, Carlos', nameKey: 'carlos garcia', shift: '2nd', building: '1519', account: '' }
];
/* Both answer to "carlos garcia", so that key is poisoned. But the roster name
   carries the second surname, and the candidate list is tried in order -- so the
   distinguishing key is reached first and settles it. Widening the keys does not
   only add matches; it lets a fuller name pick between two similar ones. */
const distinct = SuiteData.buildProfiles(
  [{ badge: 'D1', person: 'Carlos Garcia Hernandez', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }],
  { shifts: twoCarlos, shiftKeysOf: SC2.rosterKeys });
t('a fuller name picks the right one of two similar tags',
  distinct.get('D1').shift === '1st' && distinct.get('D1').location === '1502');

/* When the roster name genuinely cannot tell them apart, nothing is attached.
   Putting the wrong building and shift on somebody is worse than putting none. */
const twins = SuiteData.buildProfiles(
  [{ badge: 'T1', person: 'Carlos Garcia', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }],
  { shifts: twoCarlos, shiftKeysOf: SC2.rosterKeys });
t('a name that cannot tell them apart attaches nothing', !twins.get('T1').shift);
t('and no site either', !twins.get('T1').location);

// Tags that agree on everything shown are not a collision: either is the same answer.
const same = SuiteData.buildProfiles(
  [{ badge: 'S1', person: 'Carlos Garcia Hernandez', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }],
  { shifts: [
    { id: 'y1', name: 'Garcia Hernandez, Carlos', nameKey: 'carlos garcia', shift: '1st', building: '1502', account: '' },
    { id: 'y2', name: 'Garcia Herrera, Carlos', nameKey: 'carlos garcia', shift: '1st', building: '1502', account: '' }
  ], shiftKeysOf: SC2.rosterKeys });
t('duplicates that say the same thing still match', same.get('S1').shift === '1st');

/* Some workbook rows are not a different FORM of the name, they are a different
   name: "Wilingham, Ahmad" with one L will never meet "Ahmad Willingham" by any
   rule about surnames, and widening keys until it does would start attaching
   the wrong building to people. That is what Settings → Connections is for --
   somebody looks at the 0.95 suggestion and says yes.

   The connection stores a timeclock id against a badge. Until now that fixed
   the person's attendance and left their site and shift blank, which reads as
   the Connect button not having worked. */
console.log('— a connection made by hand outranks every name rule —');
const misspelt = [{ id: 'w1', eid: '80-AWILLI3693', name: 'Wilingham, Ahmad',
  nameKey: SC2.rosterKey('Wilingham, Ahmad'), shift: '1st', building: '1536', account: '' }];
const ahmad = [{ badge: '234379', person: 'Ahmad Willingham', action: 'matched',
  actionLabel: 'M', reason: '', market: 'Chicago' }];
const unlinked = SuiteData.buildProfiles(ahmad, { shifts: misspelt, shiftKeysOf: SC2.rosterKeys });
t('a misspelt row does not match on the name alone', !unlinked.get('234379').shift);
t('and no site is invented for them', !unlinked.get('234379').location);

const linkedUp = SuiteData.buildProfiles(ahmad, { shifts: misspelt, shiftKeysOf: SC2.rosterKeys,
  timeclockLinks: [{ eid: '80-AWILLI3693', badge: '234379', linkedBy: 'Tester' }] });
t('connecting them attaches the shift', linkedUp.get('234379').shift === '1st');
t('and the site with it', linkedUp.get('234379').location === '1536');
t('and the timeclock id stays on the profile', linkedUp.get('234379').timeclockId === '80-AWILLI3693');

// The connection wins even when a name would have matched something else.
const decoy = SuiteData.buildProfiles(ahmad, {
  shifts: misspelt.concat([{ id: 'w2', eid: '80-OTHER0001', name: 'Willingham, Ahmad',
    nameKey: SC2.rosterKey('Willingham, Ahmad'), shift: '3rd', building: '9999', account: '' }]),
  shiftKeysOf: SC2.rosterKeys,
  timeclockLinks: [{ eid: '80-AWILLI3693', badge: '234379', linkedBy: 'Tester' }] });
t('a hand-made connection beats a name that happens to match',
  decoy.get('234379').location === '1536');

/* The fix has to reach data already stored. Shift records written before it
   existed carry a nameKey computed by the OLD rule and no widened keys, so the
   candidates are derived from the stored name instead. */
console.log('— and it works on a workbook imported before the fix —');
const legacy = SuiteData.buildProfiles(
  [{ badge: 'L1', person: 'Alexander Gomez Amarales', action: 'matched', actionLabel: 'M', reason: '', market: 'Chicago' }],
  { shifts: [{ id: 'z1', name: 'Gomez Amarales, Alexander',
      nameKey: 'alexander gomez', shift: '3rd', building: '1541', account: '' }],
    shiftKeysOf: SC2.rosterKeys });
t('no re-import needed', legacy.get('L1').shift === '3rd' && legacy.get('L1').location === '1541');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
