/* Connecting a timeclock id to a profile.

   An on-premise row that reaches no profile used to be silently dropped -- the
   person was on the clock but invisible to attendance, points and their own
   record, with nothing saying so. */
const SC = require('../schedule-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };
const norm = v => String(v == null ? '' : v).trim();

const profiles = new Map([
  ['b1', { badge: 'b1', name: 'Ava Reed', market: 'Chicago' }],
  ['b2', { badge: 'b2', name: 'Ben Ortiz', market: 'Chicago' }]
]);
/* `inPresence` means the person is on the on-premise report at all; `present`
   means they actually punched in. Only the latter are worth connecting. */
const rows = () => [
  { name: 'Reed, Ava', nameKey: SC.nameKey('Reed, Ava'), wfmId: '80-AREED1', wfmIdSuffix: 'AREED1', badge: '', rosterMatch: '', inPresence: true, present: true },
  // Spelled differently in every system -- no rule will ever join this one.
  { name: 'Ortiz-Vega, Benjamin', nameKey: SC.nameKey('Ortiz-Vega, Benjamin'), wfmId: '80-BORTIZ9', wfmIdSuffix: 'BORTIZ9', badge: '', rosterMatch: '', inPresence: true, present: true },
  { name: 'Nobody, Here', nameKey: SC.nameKey('Nobody, Here'), wfmId: '80-NOBODY1', wfmIdSuffix: 'NOBODY1', badge: '', rosterMatch: '', inPresence: true, present: true }
];

console.log('— without a link —');
let r = SC.linkRoster(rows(), profiles, norm);
t('a name that matches resolves', r[0].badge === 'b1');
t('and says it was by name', r[0].rosterMatch === 'name');
t('a name spelled differently does NOT', r[1].badge === '');
t('nor does somebody absent from the roster', r[2].badge === '');
let un = SC.unlinkedRows(r);
t('both unresolved rows are reported', un.length === 2);
t('rather than silently dropped', un.map(x => x.name).indexOf('Ortiz-Vega, Benjamin') !== -1);

console.log('— with a link —');
const links = SC.linkIndex([{ eid: '80-BORTIZ9', badge: 'b2' }]);
r = SC.linkRoster(rows(), profiles, norm, links);
t('the linked row now resolves', r[1].badge === 'b2');
t('and is marked as connected by hand', r[1].rosterMatch === 'linked');
t('it takes the roster name, not the report spelling', r[1].rosterName === 'Ben Ortiz');
t('and the market comes with it', r[1].market === 'Chicago');
t('the still-unknown row is untouched', r[2].badge === '');
t('so one row remains to connect', SC.unlinkedRows(r).length === 1);

console.log('— a link beats an automatic match —');
// Somebody decided this timeclock id belongs to b2, even though the name says b1.
const override = SC.linkIndex([{ eid: '80-AREED1', badge: 'b2' }]);
r = SC.linkRoster(rows(), profiles, norm, override);
t('the human decision wins over the name', r[0].badge === 'b2');
t('and is labelled as such', r[0].rosterMatch === 'linked');

console.log('— a link that points nowhere is ignored, not obeyed —');
r = SC.linkRoster(rows(), profiles, norm, SC.linkIndex([{ eid: '80-AREED1', badge: 'GONE' }]));
t('a badge no longer on the roster falls back to matching', r[0].badge === 'b1');
t('rather than leaving the row broken', r[0].rosterMatch === 'name');

console.log('— the index —');
t('ids are matched case-insensitively', SC.linkIndex([{ eid: '80-borti Z9'.replace(' ', ''), badge: 'b2' }]).size === 1);
t('a link with no badge is not stored', SC.linkIndex([{ eid: '80-X', badge: '' }]).size === 0);
t('nor one with no id', SC.linkIndex([{ eid: '', badge: 'b1' }]).size === 0);
t('an empty list is safe', SC.linkIndex([]).size === 0 && SC.linkIndex(null).size === 0);
t('lowercase id in the report still finds an uppercase link',
  SC.linkRoster([{ name: 'X', nameKey: 'x', wfmId: '80-bortiz9', wfmIdSuffix: 'bortiz9', badge: '', inPresence: true, present: true }],
    profiles, norm, SC.linkIndex([{ eid: '80-BORTIZ9', badge: 'b2' }]))[0].badge === 'b2');

console.log('— only people actually on the clock are asked to be connected —');
t('a scheduled-but-absent row is not asked to be connected',
  SC.unlinkedRows([{ badge: '', inPresence: false, name: 'Scheduled only' }]).length === 0);
/* Someone unconnected and NOT punched in has nothing to attribute yet, and at
   Chicago most of them are GEODIS's own staff who will never have an agency
   profile. Listing them buries the ones worth acting on. */
const offClock = [
  { badge: '', inPresence: true, present: true, name: 'On, Clock' },
  { badge: '', inPresence: true, present: false, name: 'Off, Clock' },
  { badge: '', inPresence: true, name: 'Unknown, Punch' }
];
t('an unconnected person not on the clock is not offered',
  SC.unlinkedRows(offClock).map(x => x.name).join() === 'On, Clock');
t('a missing punch value is treated as not on the clock, not as present',
  SC.unlinkedRows(offClock).length === 1);
t('but they are counted, not dropped', SC.unlinkedAbsent(offClock).length === 2);
t('and the two sets do not overlap',
  SC.unlinkedRows(offClock).concat(SC.unlinkedAbsent(offClock)).length === 3);
t('somebody already connected is in neither',
  SC.unlinkedAbsent([{ badge: 'b1', inPresence: true, present: false }]).length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
