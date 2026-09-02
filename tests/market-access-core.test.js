/* Pure contracts for fail-closed server-side market partitioning. */
const fs = require('fs');
const path = require('path');
const MarketAccess = require('../functions/market-access-core.js');

let pass = 0, fail = 0;
const t = (name, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
};

const chicago = { email: 'chi@geodis.com', markets: [' Chicago '] };
const unrestricted = { email: 'all@geodis.com', markets: [] };
const context = {
  snapshot: { records: [
    { badge: 'C1', empNumber: 'E-C1', market: 'Chicago' },
    { badge: 'C2', empNumber: 'E-C2', market: 'CHICAGO' },
    { badge: 'S1', empNumber: 'E-S1', market: 'St. Louis' },
    { badge: 'U1', empNumber: 'E-U1', market: '' },
    { badge: 'UNVER', market: 'Chicago', marketVerified: false },
    { badge: 'MIX', market: 'Chicago' },
    { badge: 'MIX', market: 'St. Louis' }
  ] },
  locations: [
    { id: 'loc-chi', code: '4805', name: 'Joliet', market: 'Chicago' },
    { id: 'loc-stl', code: '2201', name: 'St Louis', market: 'St. Louis' }
  ],
  requisitions: [
    { id: 'R-CHI', beelineReq: '100-1', market: 'Chicago' },
    { id: 'R-STL', market: 'St. Louis' },
    { id: 'R-SITE', market: '', location: '4805 - Perimeter Rd,Joliet,IL,US' },
    { id: 'R-CONFLICT', market: 'Chicago', location: '2201' },
    { id: 'R-NONE', market: '' }
  ],
  schedulePeople: [
    { name: 'Chi Name', badge: 'C1', wfmId: 'E-C1', location: 'GEODIS/US/IL/4805' },
    { name: 'Name Only', badge: '', wfmId: '', location: 'GEODIS/US/IL/4805' }
  ]
};

console.log('— restriction semantics —');
t('root and deployed policy modules are identical',
  fs.readFileSync(path.join(__dirname, '..', 'market-access-core.js'), 'utf8') ===
  fs.readFileSync(path.join(__dirname, '..', 'functions', 'market-access-core.js'), 'utf8'));
t('empty market list is unrestricted', !MarketAccess.hasRestriction(unrestricted));
t('non-empty market list is restricted', MarketAccess.hasRestriction(chicago));
t('matching ignores case and surrounding whitespace',
  MarketAccess.recordDecision(chicago, 'requisitions', { market: 'cHiCaGo' }, context).allowed);
t('an invalid non-empty restriction fails closed to no markets',
  MarketAccess.hasRestriction({ markets: ['Unassigned'] }) &&
  !MarketAccess.recordDecision({ markets: ['Unassigned'] }, 'requisitions', { market: 'Chicago' }, context).allowed);

console.log('— collection ownership joins —');
const attendance = [
  { id: 'chi', badge: 'C1' }, { id: 'stl', badge: 'S1' },
  { id: 'blank', badge: 'U1' }, { id: 'missing', badge: 'NOPE' },
  { id: 'unverified', badge: 'UNVER' }, { id: 'conflict', badge: 'MIX' }
];
t('badge-owned collections return only the authorized market',
  MarketAccess.filterRecords(chicago, 'attendance', attendance, context).map(r => r.id).join(',') === 'chi');
t('every badge-owned suite collection uses the same server-side scope',
  ['attendance', 'timeoff', 'associatePto', 'shifts', 'contacts', 'tasks',
    'discrepancies', 'timeclockLinks', 'performance', 'reqCandidates'].every(function (name) {
    return MarketAccess.recordDecision(chicago, name, { badge: 'C1' }, context).allowed &&
      !MarketAccess.recordDecision(chicago, name, { badge: 'S1' }, context).allowed;
  }));
t('unrestricted accounts retain blank and cross-market rows',
  MarketAccess.filterRecords(unrestricted, 'attendance', attendance, context).length === attendance.length);
t('EID joins to the roster when a badge is absent',
  MarketAccess.recordDecision(chicago, 'shifts', { eid: 'E-C1' }, context).allowed);
t('a conflicting direct and joined market is denied',
  !MarketAccess.recordDecision(chicago, 'tasks', { badge: 'S1', market: 'Chicago' }, context).allowed);
t('a candidate inherits its requisition market',
  MarketAccess.recordDecision(chicago, 'reqCandidates', { reqId: 'R-CHI' }, context).allowed);
t('a candidate outside the requisition market is denied',
  !MarketAccess.recordDecision(chicago, 'reqCandidates', { reqId: 'R-STL' }, context).allowed);
t('a candidate is denied when its parent requisition has conflicting ownership',
  !MarketAccess.recordDecision(chicago, 'reqCandidates', { reqId: 'R-CONFLICT' }, context).allowed);
t('a configured site resolves a requisition with no direct market',
  MarketAccess.recordDecision(chicago, 'requisitions',
    { location: '4805 - Perimeter Rd,Joliet,IL,US' }, context).allowed);
t('locations and shift types resolve through the configured location market',
  MarketAccess.recordDecision(chicago, 'locations', { code: 'new', market: 'Chicago' }, context).allowed &&
  MarketAccess.recordDecision(chicago, 'shiftTypes', { location: 'loc-chi' }, context).allowed &&
  !MarketAccess.recordDecision(chicago, 'shiftTypes', { location: 'loc-stl' }, context).allowed);
t('a blank requisition remains unassigned and hidden',
  !MarketAccess.recordDecision(chicago, 'requisitions', { id: 'R-NONE', market: '' }, context).allowed);
t('global records with no ownership are hidden from restricted accounts',
  MarketAccess.filterRecords(chicago, 'appConfig', [{ id: 'rc', key: 'rcBaseUrl' }], context).length === 0);
t('a stray market property cannot grant access to a global collection',
  MarketAccess.filterRecords(chicago, 'appConfig', [{ id: 'rc', market: 'Chicago' }], context).length === 0);
t('schedule ownership resolves from a verified badge or configured WFM path',
  MarketAccess.recordDecision(chicago, 'schedule',
    { badge: 'C1', location: 'GEODIS/US/IL/4805' }, context).allowed &&
  MarketAccess.recordDecision(chicago, 'schedule',
    { name: 'Name Only', location: 'GEODIS/US/IL/4805' }, context).allowed);
t('conflicting schedule badge and location evidence is denied',
  !MarketAccess.recordDecision(chicago, 'schedule',
    { badge: 'C1', location: 'GEODIS/US/MO/2201' }, context).allowed);
t('restricted account administration is contained to wholly authorized users',
  MarketAccess.filterRecords({ markets: ['Chicago', 'St. Louis'] }, 'users', [
    { id: 'chi', markets: ['Chicago'] }, { id: 'both', markets: ['Chicago', 'St. Louis'] },
    { id: 'none', markets: [] }
  ], context).map(r => r.id).join(',') === 'chi,both');
t('a single-market manager cannot see a multi-market account',
  MarketAccess.filterRecords(chicago, 'users', [{ id: 'both', markets: ['Chicago', 'St. Louis'] }], context).length === 0);
t('an account row containing an unassigned market is denied as ambiguous',
  MarketAccess.filterRecords(chicago, 'users', [{ id: 'mixed', markets: ['Chicago', 'Unassigned'] }], context).length === 0);

console.log('— safe restricted bulk replacement —');
const current = [
  { id: 'chi-old', badge: 'C1' },
  { id: 'stl-keep', badge: 'S1' },
  { id: 'blank-keep', badge: 'NOPE' },
  { id: 'conflict-keep', badge: 'MIX' }
];
let merged = MarketAccess.mergeRestrictedReplace(chicago, 'attendance', current,
  [{ id: 'chi-new', badge: 'C2' }], context);
t('authorized partition replacement succeeds', merged.ok);
t('the old authorized partition is replaced',
  !merged.records.some(r => r.id === 'chi-old') && merged.records.some(r => r.id === 'chi-new'));
t('other-market, blank, and conflicting rows are preserved',
  ['stl-keep', 'blank-keep', 'conflict-keep'].every(id => merged.records.some(r => r.id === id)));
t('an out-of-market incoming row rejects the whole bulk write',
  !MarketAccess.mergeRestrictedReplace(chicago, 'attendance', current,
    [{ id: 'bad', badge: 'S1' }], context).ok);
t('an unresolved incoming row rejects the whole bulk write',
  !MarketAccess.mergeRestrictedReplace(chicago, 'attendance', current,
    [{ id: 'bad', badge: 'NOPE' }], context).ok);
t('an authorized row cannot reuse a preserved other-market id',
  !MarketAccess.mergeRestrictedReplace(chicago, 'attendance', current,
    [{ id: 'stl-keep', badge: 'C1' }], context).ok);
t('unrestricted bulk replacement keeps the existing full-replace contract',
  MarketAccess.mergeRestrictedReplace(unrestricted, 'attendance', current,
    [{ id: 'only' }], context).records.length === 1);

const scheduleCurrent = [
  { name: 'Chi Old', badge: 'C1', location: 'GEODIS/US/IL/4805' },
  { name: 'STL Keep', badge: 'S1', location: 'GEODIS/US/MO/2201' },
  { name: 'Unknown Keep', location: 'unknown' }
];
merged = MarketAccess.mergeRestrictedReplace(chicago, 'schedule', scheduleCurrent,
  [{ name: 'Chi New', badge: 'C2', location: 'GEODIS/US/IL/4805' }], context);
t('schedule replacement uses person identity and preserves inaccessible partitions',
  merged.ok && merged.records.map(r => r.name).join(',') === 'STL Keep,Unknown Keep,Chi New');

console.log('— date-partitioned document shaping —');
const visibleSchedule = MarketAccess.filterSchedule(chicago, {
  periodStart: '2026-08-23', fileName: 'mixed.xlsx', people: scheduleCurrent
}, context);
t('schedule reads expose only the authorized people partition',
  visibleSchedule.people.map(r => r.name).join(',') === 'Chi Old');
t('a schedule with no visible people exposes no document metadata',
  Object.keys(MarketAccess.filterSchedule(chicago, {
    fileName: 'stl-secret.xlsx', people: [{ badge: 'S1' }]
  }, context)).length === 0);

const coverage = MarketAccess.filterCoverage(chicago, {
  date: '2026-08-25', checks: [{ id: 'mixed', summary: { total: 99, coverage: 100 },
    exceptions: [{ key: 'b:C1', badge: 'C1', status: 'missing' },
      { key: 'b:S1', badge: 'S1', status: 'missing' }],
    presentKeys: ['b:C2', 'b:S1', 'n:name only'] }],
  documented: {
    'b:C1': { badge: 'C1', reason: 'Chicago' },
    'b:S1': { badge: 'S1', reason: 'St Louis' }
  }
}, context);
t('coverage reads filter exceptions, present keys, and documentation',
  coverage.checks[0].exceptions.length === 1 &&
  coverage.checks[0].presentKeys.join(',') === 'b:C2,n:name only' &&
  Object.keys(coverage.documented).join(',') === 'b:C1');
t('coverage summary is recomputed without the global aggregate',
  coverage.checks[0].summary.total === 3 && coverage.checks[0].summary.present === 2 &&
  coverage.checks[0].summary.coverage === null);
t('a mixed-market check cannot be replaced by a restricted caller',
  !MarketAccess.coverageCheckDecision(chicago, {
    exceptions: [{ key: 'b:C1' }, { key: 'b:S1' }], presentKeys: []
  }, context).allowed);

const payroll = MarketAccess.filterPayroll(chicago, {
  weekEnding: '2026-08-30',
  snapshots: [
    { takenAt: 'old', summary: { people: 500 } },
    { takenAt: 'new', summary: { people: 3 }, rows: [
      { badge: 'C1', hours: 40 }, { badge: 'S1', hours: 38 }, { badge: 'NOPE', hours: 8 }
    ] }
  ],
  changes: [
    { badge: 'C1', kind: 'changed', delta: 2, at: 'new' },
    { badge: 'S1', kind: 'changed', delta: 3, at: 'new' }
  ]
}, context);
t('payroll reads omit unpartitionable historical aggregates and filter row detail',
  payroll.snapshots.length === 1 && payroll.snapshots[0].rows.length === 1 &&
  payroll.snapshots[0].rows[0].badge === 'C1' && payroll.changes.length === 1);
t('payroll summary is recomputed from authorized rows and changes',
  payroll.snapshots[0].summary.people === 1 && payroll.snapshots[0].summary.totalHours === 40 &&
  payroll.snapshots[0].summary.touched === 1);

console.log('— snapshot isolation —');
const snapshot = {
  updatedAt: '2026-09-01T12:00:00Z',
  counts: { matched: 2, addBeeline: 4, dups: 2, total: 7, needsAction: 5 },
  records: [
    { badge: 'C1', market: 'Chicago', action: 'matched', dup: true },
    { badge: 'C1', market: 'Chicago', action: 'addBeeline', dup: true },
    { badge: 'S1', market: 'St. Louis', action: 'addBeeline', dup: true },
    { badge: 'U1', market: '', action: 'matched' },
    { badge: 'U2', market: 'Unassigned', action: 'addBeeline' },
    { badge: 'U3', market: 'Other', marketVerified: false, action: 'addBeeline' },
    { badge: 'U4', market: 'Chicago', marketVerified: false, action: 'addBeeline' }
  ]
};
const scoped = MarketAccess.filterSnapshot(chicago, snapshot);
t('snapshot records are market scoped and blank records are excluded', scoped.records.length === 2);
t('the reconciliation Other bucket is treated as unassigned',
  MarketAccess.filterSnapshot({ markets: ['Other'] }, snapshot).records.length === 0);
t('an explicitly unverified market is denied even when its label matches',
  scoped.records.every(record => record.badge !== 'U4'));
t('snapshot action counts are recomputed without aggregate leakage',
  scoped.counts.total === 2 && scoped.counts.matched === 1 && scoped.counts.addBeeline === 1 && scoped.counts.needsAction === 1);
t('duplicate count is recomputed from visible badges', scoped.counts.dups === 1);
t('snapshot metadata is retained', scoped.updatedAt === snapshot.updatedAt);
t('unrestricted snapshot retains every record',
  MarketAccess.filterSnapshot(unrestricted, snapshot).records.length === snapshot.records.length);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
