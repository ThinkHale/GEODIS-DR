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
t('all 5 records became profiles', P.size===5);
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
t('roster-less row not attached', !P.has('9999'));
t('orphan reported by unmatched()', SuiteData.unmatched(P, stores.attendance).length===1);

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
const rosterKey = n => String(n||'').toLowerCase().replace(/[^a-z\s,]/g,'')
  .replace(/,/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');
const P2 = SuiteData.buildProfiles(records, { shifts: shiftRows, shiftKeyOf: rosterKey, locations: locs });
t('a bare site gets the default name', P2.get('1001').account === 'Post');
t('and reads as site · account', P2.get('1001').locationLabel === '1559 · Post');
t('the Key still wins where it has one', P2.get('1002').account === 'REDBULL SPECIFIC');
t('an INACTIVE location supplies no default', P2.get('1003').account === '');
t('but the site number still shows', P2.get('1003').locationLabel === '1519');
t('a site with no entry at all is left alone', P2.get('1005').account === '');
t('no locations list is safe',
  SuiteData.buildProfiles(records, { shifts: shiftRows, shiftKeyOf: rosterKey }).get('1001').account === '');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
