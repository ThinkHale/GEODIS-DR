/* Open requisitions and the candidates on them (reqs-core.js). */
const Q = require('../reqs-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + n); } };

/* ---------- values ---------- */
console.log('— dates —');
t('Beeline mm/dd/yyyy normalises', Q.isoDate('04/27/2026') === '2026-04-27');
t('a spreadsheet-shortened m/d/yy means the same day', Q.isoDate('4/27/26') === '2026-04-27');
t('an ISO string passes through', Q.isoDate('2026-04-27') === '2026-04-27');
t('a real Date uses the local calendar day', Q.isoDate(new Date(2026, 3, 27, 23, 30)) === '2026-04-27');
t('blank stays blank', Q.isoDate('') === '' && Q.isoDate(null) === '');
t('garbage is not a date', Q.isoDate('soon') === '');

console.log('— counts —');
t('a number reads as a number', Q.count('5') === 5 && Q.count('1,200') === 1200);
t('zero is zero, not blank', Q.count('0') === 0);
// The distinction the whole module rests on:
t('an ABSENT count is null, not 0', Q.count('') === null && Q.count(null) === null);
t('non-numeric is null', Q.count('n/a') === null);

console.log('— location —');
const loc = Q.parseLocation('4805 - 2202 Perimeter Rd,,Auburn,WA,US');
t('the site code splits off', loc.site === '4805' && loc.address === '2202 Perimeter Rd');
t('city and state are read from the end, past the empty address line 2',
  loc.city === 'Auburn' && loc.state === 'WA' && loc.country === 'US');
t('a blank location does not throw', Q.parseLocation('').city === '');

console.log('— market —');
t('the profit centre yields the market', Q.marketOf('LLC;South Central;St. Louis;1541-17543') === 'St. Louis');
t('the same rule the roster uses', Q.marketOf('LLC;West;Seattle;4805-60176') === 'Seattle');
t('blank profit centre is blank market', Q.marketOf('') === '');

/* ---------- parsing ----------
   Shaped like the real exports: one row per (req x candidate), req-level columns
   repeated down every row, and a req with no candidates still producing one row. */
console.log('— reqs export —');
const reqAoa = [
  ['Hiring Manager', 'Start Date - Start', 'Request-ID', 'Request Status', 'Candidates Requested',
   'Candidates Submitted', 'Candidates Declined', 'Candidates Offered', 'Candidates Hired',
   'Bill To Profit Center Name', 'Reports To'],
  ['Alva, Matthew', '04/27/2026', 'R-1', 'Open', '3', '2', '0', '1', '1', 'LLC;West;Seattle;4805-60176', ''],
  ['Alva, Matthew', '04/27/2026', 'R-1', 'Open', '3', '2', '0', '1', '1', 'LLC;West;Seattle;4805-60176', 'Cotto, Millie'],
  ['Black, Daryl', '05/01/2026', 'R-2', 'Open', '2', '0', '0', '0', '0', 'LLC;South Central;St. Louis;1541-17543', ''],
  ['Cerda, Lennox', '05/02/2026', 'R-3', 'Open', '4', '1', '1', '0', '0', 'LLC;North Central;Indy;1800-18465', '']
];
const A = Q.parseExport(reqAoa, 'reqs.csv');
t('rows collapse to distinct reqs', A.reqs.length === 3 && A.rowCount === 4);
t('the export is recognised as the reqs side', Q.describe(A) === 'reqs');
t('it names no candidates', A.candidates.length === 0);
const r1 = A.reqs.find(r => r.id === 'R-1');
t('counts are read', r1.requested === 3 && r1.hired === 1 && r1.offered === 1);
t('the start date normalises', r1.startDate === '2026-04-27');
t('the market comes off the profit centre', r1.market === 'Seattle');
// The bug the real data exposed: Reports To is written on one row of a req and
// left blank on the others. A blank is a gap, not a contradiction.
t('a sparse column fills from whichever row carries it', r1.reportsTo === 'Cotto, Millie');
t('and filling it is not reported as a conflict', A.warnings.length === 0);
t('a genuine disagreement IS reported', (() => {
  const clash = reqAoa.slice(0, 3).concat([
    ['Someone, Else', '04/27/2026', 'R-1', 'Open', '3', '2', '0', '1', '1', 'LLC;West;Seattle;4805-60176', '']
  ]);
  const p = Q.parseExport(clash, 'x');
  return p.warnings.some(w => w.indexOf('hiringManager') !== -1) &&
    p.reqs.find(r => r.id === 'R-1').hiringManager === 'Alva, Matthew';   // first row wins
})());
t('a file with no Request-ID column is reported, not silently empty',
  Q.parseExport([['a', 'b'], ['1', '2']], 'x').warnings.length === 1);

console.log('— candidate export —');
const candAoa = [
  ['Request-ID', 'Candidate', 'Job Position', 'Location Name', 'Status', 'Beeline ID', 'External ID', 'Name'],
  ['R-1', 'Isaiah Montoya', 'Warehouse - Operator 1', '4805 - 2202 Perimeter Rd,,Auburn,WA,US', 'Open', 'IMontoya0006', '', 'Cobb, Michael'],
  ['R-1', 'Maria A Albarran', 'Warehouse - Operator 1', '4805 - 2202 Perimeter Rd,,Auburn,WA,US', 'Open', 'MAlbarran6728', '21774830', 'Cobb, Michael'],
  ['R-2', '', 'Warehouse - Material Handler', '1541 - 1 Main St,,St. Louis,MO,US', 'Open', '', '', 'Duke, Justin'],
  ['R-3', 'Hank Holmes', 'Warehouse - Operator 2', '1800 - 2350 Progress Dr,,Hebron,KY,US', 'Open', 'HHolmes9810', '', 'Perez, Paola']
];
const B = Q.parseExport(candAoa, 'cands.csv');
t('the export is recognised as the candidate side', Q.describe(B) === 'candidates');
t('only rows that name somebody become candidates', B.candidates.length === 3);
t('a req with no candidates still registers as a req', B.reqs.length === 3);
t('the Beeline id is read', B.candidates[0].beelineId === 'IMontoya0006');
t('the external id is read when present', B.candidates[1].externalId === '21774830');
// The report's name promises a per-candidate status it does not carry.
t('the "Status" column is the REQUEST status, not a candidate status',
  B.reqs.every(r => r.status === 'Open'));
t('an export with no Internal Status column reports no candidate status',
  B.candidates.every(c => c.status === '' && c.stage === ''));
t('no count columns means no counts invented',
  B.reqs.every(r => r.requested === null && r.hired === null));

/* ---------- the board ---------- */
console.log('— merging the two exports —');
const board = Q.buildBoard({ sources: [A, B] });
const by = {}; board.reqs.forEach(r => { by[r.id] = r; });
t('every req appears once', board.reqs.length === 3);
t('candidates land on their req', by['R-1'].candidateCount === 2 && by['R-3'].candidateCount === 1);
t('a req with nobody on it is kept, not dropped', by['R-2'].candidateCount === 0);
t('req detail comes from the reqs export', by['R-1'].requested === 3 && by['R-1'].hiringManager === 'Alva, Matthew');
t('job and location come from the candidate export', by['R-1'].jobPosition === 'Warehouse - Operator 1');
t('the candidate file\'s "Name" is the supervisor', by['R-3'].reportsTo === 'Perez, Paola');
t('an explicit Reports To outranks it', by['R-1'].reportsTo === 'Cotto, Millie');
t('load order does not change the result',
  JSON.stringify(Q.buildBoard({ sources: [B, A] }).reqs) === JSON.stringify(board.reqs));

console.log('— derived figures —');
t('short-by is openings minus hired', by['R-1'].shortBy === 2 && by['R-2'].shortBy === 2);
t('fill percentage', by['R-1'].fillPct === 33 && by['R-2'].fillPct === 0);
t('somebody hired but not everybody -> partial', by['R-1'].health === 'partial');
t('nobody hired but candidates in flight -> submitted', by['R-3'].health === 'submitted');
t('nobody hired and nobody submitted -> empty', by['R-2'].health === 'empty');
t('a fully-hired req reads as filled', (() => {
  const full = Q.parseExport([reqAoa[0], ['A', '04/27/2026', 'R-9', 'Open', '2', '2', '0', '2', '2', 'LLC;W;Seattle;1', '']], 'x');
  const b = Q.buildBoard({ sources: [full] });
  return b.reqs[0].health === 'filled' && b.reqs[0].fillPct === 100 && b.reqs[0].shortBy === 0;
})());
t('the most short-handed req sorts first', board.reqs[0].shortBy >= board.reqs[board.reqs.length - 1].shortBy);

console.log('— the summary —');
const s = board.summary;
t('openings and hires total across reqs', s.requested === 9 && s.hired === 1);
t('total shortfall', s.shortBy === 8);
t('candidates are counted once', s.candidates === 3);
t('reqs with nobody attached are counted', s.noCandidates === 1);
t('overall fill percentage', s.fillPct === 11);

console.log('— a candidate-only load invents nothing —');
const solo = Q.buildBoard({ sources: [B] });
t('reqs still appear', solo.reqs.length === 3);
t('candidates still attach', solo.reqs.reduce((n, r) => n + r.candidateCount, 0) === 3);
// The point of the null-vs-zero rule: an unknown openings count must never read
// as a filled req or as 0% coverage.
t('no openings count means NO fill percentage, not 0%', solo.reqs.every(r => r.fillPct === null));
t('no openings count means NO shortfall, not 0', solo.reqs.every(r => r.shortBy === null));
t('health is unknown, not "filled"', solo.reqs.every(r => r.health === 'unknown'));
t('the summary reports null rather than a total of nothing',
  solo.summary.requested === null && solo.summary.fillPct === null);
t('submitted still stands in from the candidate roster',
  solo.reqs.find(r => r.id === 'R-1').submitted === 2);
t('the gap is reported as named columns', (() => {
  const miss = Q.missingColumns([B]).map(m => m.label);
  return miss.indexOf('Candidates Requested') !== -1 && miss.indexOf('Hiring Manager') !== -1 &&
    miss.indexOf('Bill To Profit Center Name') !== -1;
})());
t('with both files nothing is missing', Q.missingColumns([A, B]).length === 0);

console.log('— one combined export works with no second code path —');
const combined = [
  ['Request-ID', 'Candidate', 'Job Position', 'Location Name', 'Status', 'Beeline ID', 'Name',
   'Hiring Manager', 'Start Date - Start', 'Candidates Requested', 'Candidates Declined',
   'Candidates Offered', 'Candidates Hired', 'Bill To Profit Center Name'],
  ['R-1', 'Isaiah Montoya', 'Warehouse - Operator 1', '4805 - 2202 Perimeter Rd,,Auburn,WA,US', 'Open',
   'IMontoya0006', 'Cobb, Michael', 'Alva, Matthew', '04/27/2026', '3', '0', '1', '1', 'LLC;West;Seattle;4805-60176'],
  ['R-1', 'Maria A Albarran', 'Warehouse - Operator 1', '4805 - 2202 Perimeter Rd,,Auburn,WA,US', 'Open',
   'MAlbarran6728', 'Cobb, Michael', 'Alva, Matthew', '04/27/2026', '3', '0', '1', '1', 'LLC;West;Seattle;4805-60176']
];
const Cm = Q.parseExport(combined, 'combined.csv');
const cb = Q.buildBoard({ sources: [Cm] });
t('one file is recognised as combined', Q.describe(Cm) === 'combined');
t('it needs no second file', Q.missingColumns([Cm]).length === 0);
t('and produces the same req', cb.reqs[0].requested === 3 && cb.reqs[0].candidateCount === 2 &&
  cb.reqs[0].market === 'Seattle' && cb.reqs[0].fillPct === 33);

console.log('— nothing is dropped —');
// parseExport registers a req for every row it sees, so an export can never
// orphan its own candidates. The guard is for a source that supplies candidates
// WITHOUT reqs -- the shape a future workbook reconciliation would have.
t('a candidate whose req no source lists is surfaced, not discarded', (() => {
  const candidatesOnly = { reqs: [], candidates: [{ reqId: 'R-404', name: 'Ghost Person', beelineId: 'GP1' }], warnings: [] };
  const b = Q.buildBoard({ sources: [A, candidatesOnly] });
  return b.orphans.length === 1 && b.orphans[0].name === 'Ghost Person' &&
    b.warnings.some(w => w.indexOf('not in the requisition list') !== -1);
})());
t('a candidate export on its own creates the reqs it references', (() => {
  const stray = Q.parseExport([candAoa[0], ['R-404', 'Ghost Person', 'J', 'L', 'Open', 'GP1', '', 'N']], 'x');
  const b = Q.buildBoard({ sources: [A, stray] });
  return b.orphans.length === 0 && b.reqs.some(r => r.id === 'R-404');
})());
t('the same person on two reqs is listed on both', (() => {
  const two = Q.parseExport([candAoa[0],
    ['R-1', 'Hank Holmes', 'J', 'L', 'Open', 'HHolmes9810', '', 'N'],
    ['R-3', 'Hank Holmes', 'J', 'L', 'Open', 'HHolmes9810', '', 'N']], 'x');
  const b = Q.buildBoard({ sources: [A, two] });
  return b.reqs.find(r => r.id === 'R-1').candidateCount === 1 &&
    b.reqs.find(r => r.id === 'R-3').candidateCount === 1;
})());
t('the same person listed twice on ONE req is counted once', (() => {
  const dup = Q.parseExport([candAoa[0],
    ['R-1', 'Hank Holmes', 'J', 'L', 'Open', 'HHolmes9810', '', 'N'],
    ['R-1', 'Hank Holmes', 'J', 'L', 'Open', 'HHolmes9810', '', 'N']], 'x');
  return Q.buildBoard({ sources: [A, dup] }).reqs.find(r => r.id === 'R-1').candidateCount === 1;
})());

console.log('— candidate status (the "Internal Status" column) —');
const statusAoa = [
  ['Request-ID', 'Candidate', 'Job Position', 'Location Name', 'Status', 'Beeline ID', 'External ID', 'Name', 'Date', 'Internal Status'],
  ['R-1', 'Ann Hired',   'J', 'L', 'Open', 'AH1', '', 'Sup, Er', '04/27/2026', 'Offer Confirmed'],
  ['R-1', 'Bo Offered',  'J', 'L', 'Open', 'BO1', '', 'Sup, Er', '04/27/2026', 'Offer Pending'],
  ['R-1', 'Cy Rejected', 'J', 'L', 'Open', 'CR1', '', 'Sup, Er', '04/27/2026', 'Rejected'],
  ['R-1', 'Di Waiting',  'J', 'L', 'Open', 'DW1', '', 'Sup, Er', '04/27/2026', 'Pending'],
  ['R-2', '',            'J', 'L', 'Open', '',    '', 'Sup, Er', '05/01/2026', '']
];
const S = Q.parseExport(statusAoa, 'status.csv');
t('the per-candidate status is read', S.candidates[0].status === 'Offer Confirmed');
t('and mapped to a stage', S.candidates[0].stage === 'hired' && S.candidates[1].stage === 'offered');
t('Rejected is the declined stage', S.candidates[2].stage === 'declined');
t('Pending is its own review stage', S.candidates[3].stage === 'review');
t('the bare "Date" column is the req start date', S.reqs[0].startDate === '2026-04-27');
t('"Status" is still the REQUEST status, not the candidate one', S.reqs[0].status === 'Open');

const sb = Q.buildBoard({ sources: [S] });
const sr = sb.reqs.find(r => r.id === 'R-1');
// Verified against the reqs export: on every req where the two pulls agreed at
// all, Offer Confirmed == Candidates Hired and Rejected == Candidates Declined.
t('hired is derived from Offer Confirmed', sr.hired === 1 && sr.derived.hired === true);
t('declined is derived from Rejected', sr.declined === 1 && sr.derived.declined === true);
t('submitted is still the candidate count', sr.submitted === 4 && sr.derived.submitted === true);
// No candidate-status combination reproduces Candidates Offered reliably.
t('offered is NOT derived, because it cannot be derived exactly', sr.offered === null);
t('the exact breakdown is kept instead', sr.statusCounts['Offer confirmed'] === 1 &&
  sr.statusCounts['Offer pending'] === 1 && sr.statusCounts['Rejected'] === 1);
t('stage totals roll up', sb.summary.stages.hired === 1 && sb.summary.stages.declined === 1 &&
  sb.summary.stages.offered === 1 && sb.summary.stages.review === 1);
t('a request with statuses knows it has them', sr.hasCandidateStatus === true);
t('an unrecognised status is kept and reported, not forced into a bucket', (() => {
  const odd = Q.parseExport(statusAoa.slice(0, 2).concat([
    ['R-1', 'Ed Unknown', 'J', 'L', 'Open', 'EU1', '', 'S', '04/27/2026', 'Awaiting Drug Screen']
  ]), 'x');
  const c = odd.candidates.find(x => x.name === 'Ed Unknown');
  return c.stage === 'other' && c.statusLabel === 'Awaiting Drug Screen' &&
    odd.warnings.some(w => w.indexOf('Awaiting Drug Screen') !== -1);
})());
t('an explicit count column still outranks the derived one', (() => {
  const both = Q.buildBoard({ sources: [A, S] });
  const r = both.reqs.find(x => x.id === 'R-1');
  return r.hired === 1 && !r.derived.hired;   // A says Candidates Hired = 1 for R-1
})());
t('with Internal Status, the aggregate hire/decline columns are no longer needed', (() => {
  const miss = Q.missingColumns([S]).map(m => m.label);
  return miss.indexOf('Candidates Hired') === -1 && miss.indexOf('Candidates Declined') === -1 &&
    miss.indexOf('Candidates Requested') !== -1;   // openings still are
})());

console.log('— one key across Beeline and the PLX workbook —');
// Beeline writes "110642-1"; the workbook sync writes "REQ-110642". Same req.
t('the Request-ID reduces to the workbook key', Q.reqKey('110642-1') === 'REQ-110642');
t('a bare number reduces to the same key', Q.reqKey('110642') === 'REQ-110642');
t('blank in, blank out', Q.reqKey('') === '' && Q.reqKey(null) === '');

const recs = Q.toReqRecords(Q.buildBoard({ sources: [A, B] }));
t('a stored request is keyed the way the workbook keys it', recs[0].id.indexOf('REQ-') === 0);
t('the full Request-ID is kept alongside', recs[0].beelineReq === recs[0].id.replace('REQ-', ''));
t('a real Beeline number loses only its suffix', Q.reqKey('110642-1') === 'REQ-110642');
t('an id that is not <digits>-<digits> is kept whole, never merged with a sibling',
  Q.reqKey('R-1') !== Q.reqKey('R-2'));
t('Beeline fields are namespaced away from the workbook\'s', (() => {
  const r = recs[0];
  // The workbook sync owns title/openings/filled/building/shift/due/notes/source.
  return r.beelineOpenings != null && r.openings === undefined && r.filled === undefined &&
    r.title === undefined && r.building === undefined && r.source === undefined;
})());

console.log('— an import must not clobber the workbook —');
// The workbook sync keys a requisition exactly the way reqKey does, which is the
// whole point: both sources land on one record.
const wbRecord = { id: Q.reqKey(recs[0].beelineReq), source: 'PLX workbook',
  title: 'OPR 1', building: '1500', shift: '1st',
  // Agreeing with Beeline by default, so the disagreement case below is the only
  // thing that trips the flag. The board sorts most-short-handed first, so this
  // reads the count off the record rather than assuming which req landed first.
  openings: recs[0].beelineOpenings, filled: 1, notes: 'New Request' };
const handRecord = { id: 'HAND-1', title: 'Typed in by a person', openings: 1 };
const mergedRecs = Q.mergeForSave([wbRecord, handRecord], recs);
t('one record per requisition, not two', mergedRecs.filter(r => r.id === wbRecord.id).length === 1);
t('every workbook field survives the import', (() => {
  const m = mergedRecs.find(r => r.id === wbRecord.id);
  return m.building === '1500' && m.shift === '1st' && m.openings === recs[0].beelineOpenings &&
    m.filled === 1 && m.notes === 'New Request' && m.source === 'PLX workbook';
})());
t('and it gains the Beeline half', !!mergedRecs.find(r => r.id === wbRecord.id).beelineReq);
t('a hand-entered request is untouched', mergedRecs.find(r => r.id === 'HAND-1').title === 'Typed in by a person');
t('a request that left Beeline keeps its workbook half', (() => {
  const stale = Q.mergeForSave(mergedRecs, []);   // nothing imported this time
  const m = stale.find(r => r.id === wbRecord.id);
  return m && m.building === '1500' && !m.beelineReq;   // record kept, Beeline half cleared
})());

console.log('— reading it back apart again —');
const backBoard = Q.fromRecords(mergedRecs, Q.toCandidateRecords(Q.buildBoard({ sources: [A, B] })));
t('only Beeline rows become requests', backBoard.reqs.every(r => !!r.key));
t('a workbook-only request is listed separately', (() => {
  const withGhost = mergedRecs.concat([{ id: 'REQ-999999', source: 'PLX workbook', title: 'Ghost', openings: 4 }]);
  const b = Q.fromRecords(withGhost, []);
  return b.workbookOnly.length === 1 && b.workbookOnly[0].id === 'REQ-999999';
})());
t('a hand-entered request is listed separately again', backBoard.manual.some(r => r.id === 'HAND-1'));
t('nothing appears in two lists at once', (() => {
  const ids = new Set(backBoard.reqs.map(r => r.key));
  return !backBoard.workbookOnly.some(r => ids.has(String(r.id))) &&
    !backBoard.manual.some(r => ids.has(String(r.id)));
})());
t('the workbook openings sit beside Beeline\'s for comparison', (() => {
  const m = backBoard.reqs.find(r => r.key === wbRecord.id);
  return m.inWorkbook === true && m.workbookOpenings === recs[0].beelineOpenings;
})());
t('a disagreement on how many are wanted is flagged', (() => {
  const clash = mergedRecs.map(r => r.id === wbRecord.id ? Object.assign({}, r, { openings: 99 }) : r);
  const b = Q.fromRecords(clash, []);
  const m = b.reqs.find(r => r.key === wbRecord.id);
  return m.openingsDiffer === true && b.summary.openingsDiffer === 1;
})());
t('agreement is not flagged', backBoard.summary.openingsDiffer === 0);
t('requests the workbook has never heard of are counted', backBoard.summary.notInWorkbook > 0);
t('candidate statuses survive the round trip', (() => {
  // S is the fixture that HAS Internal Status; A and B predate the column.
  const b = Q.buildBoard({ sources: [S] });
  const round = Q.fromRecords(Q.toReqRecords(b), Q.toCandidateRecords(b));
  const r = round.reqs.find(x => x.key === Q.reqKey('R-1'));
  return r.statusCounts['Offer confirmed'] === 1 && r.hired === 1 &&
    r.candidates.some(c => c.stage === 'declined');
})());

console.log('— market from the work-location number —');
/* The daily candidate export carries no profit centre, so the market has to come
   from the work-location number. Every site observed maps to exactly one market,
   and the profit centre's own tail begins with that site number, so the mapping is
   a fact the data states rather than a guess. */
const seedBoard = Q.buildBoard({ sources: [A, B] });
const lessons = Q.learnSiteMarkets(seedBoard.reqs);
t('site → market pairs are learned from the merged requests', (() => {
  const m = {}; lessons.forEach(l => { m[l.code] = l.market; });
  return lessons.length === 3 && m['4805'] === 'Seattle' && m['1541'] === 'St. Louis' && m['1800'] === 'Indy';
})());
t('neither file states the pair alone, so a per-file read learns nothing',
  Q.learnSiteMarkets(A.reqs).length === 0 && Q.learnSiteMarkets(B.reqs).length === 0);
t('a site two rows disagree about is dropped, and the rest still learned', (() => {
  const clash = seedBoard.reqs.concat([{ profitCenter: 'LLC;West;Portland;4805-1',
    location: '4805 - x,,Auburn,WA,US' }]);
  const out = Q.learnSiteMarkets(clash);
  return out.length === 2 && !out.some(l => l.code === '4805');
})());

const locList = [{ code: '4805', name: 'Auburn', market: 'Seattle', active: true }];
const derived = Q.buildBoard({ sources: [B], locations: locList });
const d1 = derived.reqs.find(r => r.id === 'R-1');
t('with no profit centre, the market comes off the site number', d1.market === 'Seattle');
t('and says it was derived rather than reported', d1.marketFrom === 'site');
t('a profit centre still wins where there is one', (() => {
  const both = Q.buildBoard({ sources: [A, B], locations: locList });
  const r = both.reqs.find(x => x.id === 'R-1');
  return r.market === 'Seattle' && r.marketFrom === undefined;
})());
t('a site the Locations list does not know leaves the market blank, and says which site', (() => {
  const b = Q.buildBoard({ sources: [B], locations: [] });
  const r = b.reqs.find(x => x.id === 'R-1');
  return r.market === '' && r.marketUnknownSite === '4805';
})());
t('an empty Locations list derives nothing rather than guessing',
  Q.buildBoard({ sources: [B] }).reqs.every(r => !r.market));

console.log('— openings from the PLX workbook —');
/* The export no longer carries Candidates Requested. Where the workbook lists the
   same requisition, its Quantity IS the openings count. */
// S is the candidate fixture WITH Internal Status, so hires are derived and there
// is something for an openings count to be measured against.
const statusBoard = Q.buildBoard({ sources: [S], locations: locList });
const noOpenings = Q.toReqRecords(statusBoard);
t('the candidate export alone reports no openings', noOpenings.every(r => r.beelineOpenings == null));
const wbSupply = [{ id: Q.reqKey('R-1'), source: 'PLX workbook', title: 'OPR 1', openings: 6 }];
const filled = Q.fromRecords(Q.mergeForSave(wbSupply, noOpenings),
  Q.toCandidateRecords(statusBoard), locList);
const f1 = filled.reqs.find(r => r.key === Q.reqKey('R-1'));
t('the workbook quantity fills the gap', f1.requested === 6);
t('and says where it came from', f1.requestedFrom === 'workbook');
t('the figures that depend on it are recomputed',
  f1.hired === 1 && f1.shortBy === 5 && f1.fillPct === 17 && f1.health === 'partial');
t('a filled gap is not also reported as a disagreement', f1.openingsDiffer === false);
t('Beeline still wins where it says anything', (() => {
  const withBeeline = Q.fromRecords(Q.mergeForSave(wbSupply, Q.toReqRecords(Q.buildBoard({ sources: [A, B] }))), [], locList);
  const r = withBeeline.reqs.find(x => x.key === Q.reqKey('R-1'));
  return r.requested === 3 && r.requestedFrom === undefined && r.openingsDiffer === true;
})());
t('a request no source gives openings for stays unknown, not zero', (() => {
  const b = Q.fromRecords(noOpenings, Q.toCandidateRecords(statusBoard), locList);
  return b.reqs.every(r => r.requested === null && r.health === 'unknown' && r.fillPct === null);
})());

console.log('— a fill rate divides by a matching denominator —');
/* The bug this guards: hires are known for every request, openings for only some.
   Dividing every hire by a partial openings total produced a 499% fill rate. */
const mixed = filled;
t('only requests with a known openings count are counted into it',
  mixed.summary.reqsWithOpenings === 1 && mixed.summary.reqs === 2);
t('hires are split into the total and the ones with a denominator',
  mixed.summary.hiredAgainstRequested <= mixed.summary.hired);
t('the fill percentage cannot exceed what the openings allow',
  mixed.summary.fillPct === null || mixed.summary.fillPct <= 100 * mixed.summary.requested);
t('fill = hires against known openings / those openings',
  mixed.summary.fillPct === Math.round(mixed.summary.hiredAgainstRequested / mixed.summary.requested * 100));
t('no openings anywhere means no percentage at all',
  Q.fromRecords(noOpenings, Q.toCandidateRecords(statusBoard), locList).summary.fillPct === null);
t('every hire is still counted, including on requests with no openings figure',
  mixed.summary.hired >= mixed.summary.hiredAgainstRequested);

console.log('— the work-location number as a first-class field —');
/* The header scopes by market, so within a view the SITE is what distinguishes one
   request from another -- and several sites share a city (1502, 1517 and 1519 are
   all Romeoville), so the number is the identifier and a name only qualifies it. */
const siteBoard = Q.buildBoard({ sources: [B], locations: locList });
const siteReq = siteBoard.reqs.find(r => r.id === 'R-1');
t('the site number is parsed onto the request', siteReq.site === '4805');
t('so is the city and state', siteReq.city === 'Auburn' && siteReq.state === 'WA');
t('a request with no work location has no site rather than a bad one', (() => {
  const noLoc = Q.parseExport([candAoa[0], ['R-9', 'Someone', 'J', '', 'Open', 'S1', '', 'N']], 'x');
  return Q.buildBoard({ sources: [noLoc] }).reqs[0].site === '';
})());
t('learning a site picks up its city, which is what the site is called',
  lessons.every(l => l.city) && lessons.find(l => l.code === '4805').city === 'Auburn');
t('two sites in one city are still two sites', (() => {
  const twoAoa = [candAoa[0],
    ['R-7', 'A Person', 'J', '1502 - x,,Romeoville,IL,US', 'Open', 'AP1', '', 'N'],
    ['R-8', 'B Person', 'J', '1517 - y,,Romeoville,IL,US', 'Open', 'BP1', '', 'N']];
  const b = Q.buildBoard({ sources: [Q.parseExport(twoAoa, 'x')] });
  const sites = b.reqs.map(r => r.site).sort();
  return sites.length === 2 && sites[0] === '1502' && sites[1] === '1517' &&
    b.reqs.every(r => r.city === 'Romeoville');
})());

console.log('— roster link —');
const profiles = new Map([
  ['21774830', { badge: '21774830', name: 'Albarran, Maria', market: 'Seattle' }],
  ['HHolmes9810', { badge: 'HHolmes9810', name: 'Holmes, Hank', market: 'Indy' }]
]);
const linked = Q.buildBoard({ sources: [A, B] });
Q.linkRoster(linked.reqs, profiles, v => String(v || '').trim());
const cands = {}; linked.reqs.forEach(r => r.candidates.forEach(c => { cands[c.name] = c; }));
t('an external id reaches the roster', cands['Maria A Albarran'].badge === '21774830');
t('a Beeline id reaches the roster', cands['Hank Holmes'].badge === 'HHolmes9810');
// A candidate is not necessarily a placed associate, and this export writes
// "Maria A Albarran" where the roster writes "Albarran, Maria" -- so no name rule.
t('an unmatched candidate stays unmatched rather than being guessed by name',
  cands['Isaiah Montoya'].badge === undefined);
t('an empty roster is a no-op', Q.linkRoster(linked.reqs, new Map()).length === 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
