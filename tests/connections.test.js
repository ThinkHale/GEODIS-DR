/* Connecting the workbook roster to profiles (ShiftKey.connectionReview).

   The gap this closes: the workbook states an EID, the roster states a badge,
   and nothing states both — so a profile only learns its EID when the two
   systems spell the name identically. One letter is enough to lose somebody. */
const ShiftKey = require('../shift-key.js');
const Core = require('../reconcile-core.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + n); } };
const sim = Core.nameSimilarity;

// The real case: the workbook drops an L, and the person vanishes.
const shifts = [
  { eid: '80-AWILLI3693', name: 'Wilingham, Ahmad', nameKey: 'ahmad wilingham', shift: '1st', building: '1536', dept: '1536-607510' },
  { eid: '80-YREYES9524', name: 'Reyes, Yoisi', nameKey: 'yoisi reyes', shift: '1st', building: '1536' },
  { eid: '80-NOBODY0001', name: 'Ghost, Gary', nameKey: 'gary ghost', shift: '2nd', building: '1536' },
  { eid: '', name: 'Noeid, Nora', nameKey: 'nora noeid', shift: '1st', building: '1536' }
];
const profiles = [
  { badge: 'B1', name: 'Willingham, Ahmad', empNumber: 'E1', timeclockId: '' },
  { badge: 'B2', name: 'Reyes, Yoisi', empNumber: 'E2', timeclockId: '80-YREYES9524' },  // already connected
  { badge: 'B3', name: 'Entirely Different, Person', empNumber: 'E3', timeclockId: '' }
];
const rev = ShiftKey.connectionReview({ shifts: shifts, profiles: profiles, similarity: sim });

console.log('— what is and is not connected —');
t('every workbook row with an EID is counted', rev.summary.total === 3);
t('an EID already on a profile counts as connected', rev.summary.connected === 1);
t('the rest are listed to be connected', rev.summary.unconnected === 2);
t('a workbook row with no EID cannot be connected this way, and says so',
  rev.summary.noEid === 1 && rev.noEid[0].name === 'Noeid, Nora');
t('an already-connected person is not offered again',
  !rev.unconnected.some(u => u.eid === '80-YREYES9524'));

console.log('— the suggestion —');
const ahmad = rev.unconnected.find(u => u.eid === '80-AWILLI3693');
t('the person lost to one letter is listed', !!ahmad);
t('with the right roster name suggested', ahmad.suggestions[0].name === 'Willingham, Ahmad');
t('at a score that reads as obvious', ahmad.suggestions[0].score > 0.9);
t('the workbook detail travels with them, so a human can check',
  ahmad.building === '1536' && ahmad.shift === '1st' && ahmad.dept === '1536-607510');
t('the roster EID is offered too, since that is what people search by',
  ahmad.suggestions[0].empNumber === 'E1');

const ghost = rev.unconnected.find(u => u.eid === '80-NOBODY0001');
t('somebody with no near match says so rather than guessing', ghost.suggestions.length === 0);
t('and is counted apart from the ones ready to click', rev.summary.noMatch === 1);
t('closest first, so the easy ones do not sit behind the hard ones',
  rev.unconnected[0].eid === '80-AWILLI3693');

console.log('— a connected profile is spoken for —');
t('a profile that already has an EID is never suggested for another', (() => {
  const r = ShiftKey.connectionReview({
    shifts: [{ eid: '80-OTHER0001', name: 'Reyes, Yoisi', nameKey: 'yoisi reyes' }],
    profiles: profiles, similarity: sim
  });
  // B2 holds 80-YREYES9524 already; an identical name must not be offered again.
  return !r.unconnected[0].suggestions.some(s => s.badge === 'B2');
})());

console.log('— two rows wanting the same person —');
/* The dangerous case. Two workbook spellings both point at one profile; only one
   can be right, so neither may be a one-click. */
const contested = ShiftKey.connectionReview({
  shifts: [
    { eid: '80-A0001', name: 'Willingham, Ahmad', nameKey: 'ahmad willingham' },
    { eid: '80-A0002', name: 'Wilingham, Ahmad', nameKey: 'ahmad wilingham' }
  ],
  profiles: [{ badge: 'B1', name: 'Willingham, Ahmad', timeclockId: '' }],
  similarity: sim
});
t('both are flagged as contested', contested.unconnected.every(u => u.contested));
t('and counted as needing a decision', contested.summary.contested === 2);
t('so neither is counted as ready to connect', contested.summary.withSuggestion === 0);

console.log('— nothing is decided automatically —');
t('the review only reports; it writes no connection', (() => {
  const before = JSON.stringify(profiles);
  ShiftKey.connectionReview({ shifts: shifts, profiles: profiles, similarity: sim });
  return JSON.stringify(profiles) === before;
})());
t('a low-scoring name is not offered at all', (() => {
  const r = ShiftKey.connectionReview({
    shifts: [{ eid: '80-X', name: 'Zzz, Qqq', nameKey: 'qqq zzz' }],
    profiles: [{ badge: 'B9', name: 'Smith, John', timeclockId: '' }],
    similarity: sim, min: 0.6
  });
  return r.unconnected[0].suggestions.length === 0;
})());
t('the threshold is the caller\'s to set', (() => {
  const r = ShiftKey.connectionReview({
    shifts: [{ eid: '80-X', name: 'Zzz, Qqq', nameKey: 'qqq zzz' }],
    profiles: [{ badge: 'B9', name: 'Smith, John', timeclockId: '' }],
    similarity: sim, min: 0
  });
  return r.unconnected[0].suggestions.length === 1;
})());

console.log('— a person with more than one timeclock id —');
/* A profile holds ONE timeclock id, but a person can genuinely have several: the
   same associate under two agencies (80- and 87-), or a workbook row carrying an
   id that belongs to somebody else. Checking only the profile's single slot meant
   such a person could be connected over and over and never leave the list. */
const twoIdShifts = [{ eid: '80-EPASQU7641', name: 'Ahmad Mullilkhil, Naseer', nameKey: 'naseer ahmad mullilkhil' }];
const twoIdProfiles = [{ badge: '238498', name: 'Naseer ahmad Mullilkhil', timeclockId: '80-NAHMAD9750' }];
t('without the links the row never clears', ShiftKey.connectionReview({
  shifts: twoIdShifts, profiles: twoIdProfiles, similarity: sim
}).summary.unconnected === 1);
t('a stored link counts as connected even when the profile holds a different id', (() => {
  const r = ShiftKey.connectionReview({
    shifts: twoIdShifts, profiles: twoIdProfiles, similarity: sim,
    links: [{ eid: '80-EPASQU7641', badge: '238498' }]
  });
  return r.summary.unconnected === 0 && r.summary.connected === 1;
})());
t('and the double id is disclosed rather than assumed to be fine', (() => {
  const r = ShiftKey.connectionReview({
    shifts: twoIdShifts, profiles: twoIdProfiles, similarity: sim,
    links: [{ eid: '80-EPASQU7641', badge: '238498' }, { eid: '80-NAHMAD9750', badge: '238498' }]
  });
  return r.summary.multiLinked === 1 && r.multiLinked[0].eids.length === 2 &&
    r.multiLinked[0].name === 'Naseer ahmad Mullilkhil';
})());
t('one id per person is not reported as a conflict', ShiftKey.connectionReview({
  shifts: twoIdShifts, profiles: twoIdProfiles, similarity: sim,
  links: [{ eid: '80-EPASQU7641', badge: '238498' }]
}).summary.multiLinked === 0);
t('a link pointing at nobody on the roster connects nothing', (() => {
  const r = ShiftKey.connectionReview({
    shifts: twoIdShifts, profiles: twoIdProfiles, similarity: sim,
    links: [{ eid: '80-EPASQU7641', badge: 'GONE' }]
  });
  return r.summary.unconnected === 1 && r.summary.multiLinked === 0;
})());

console.log('— degenerate input —');
t('no shifts is not a crash', ShiftKey.connectionReview({ profiles: profiles, similarity: sim }).summary.total === 0);
t('no profiles means everyone is unconnected with no suggestions', (() => {
  const r = ShiftKey.connectionReview({ shifts: shifts, similarity: sim });
  return r.summary.unconnected === 3 && r.unconnected.every(u => !u.suggestions.length);
})());
t('no similarity function offers nothing rather than throwing',
  ShiftKey.connectionReview({ shifts: shifts, profiles: profiles }).unconnected.every(u => !u.suggestions.length));
t('the same EID twice in the workbook is counted once', (() => {
  const dup = shifts.concat([{ eid: '80-AWILLI3693', name: 'Wilingham, Ahmad', nameKey: 'ahmad wilingham' }]);
  return ShiftKey.connectionReview({ shifts: dup, profiles: profiles, similarity: sim }).summary.total === 3;
})());
t('EID case does not create a second person', (() => {
  const mixed = [{ eid: '80-yreyes9524', name: 'Reyes, Yoisi', nameKey: 'yoisi reyes' }];
  return ShiftKey.connectionReview({ shifts: mixed, profiles: profiles, similarity: sim }).summary.connected === 1;
})());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
