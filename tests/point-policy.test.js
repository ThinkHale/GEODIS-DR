/* The attendance point scale.

   GEODIS policy: PTO 0, absence 1, no-call/no-show 2, late/early-out a half.
   It is defined in TWO places -- TYPE_POINTS in suite.js for a hand-logged
   occurrence, and kind() in attendance-import.js for an imported one. They were
   once double each other, which meant the same absence was worth 1 or 2 points
   depending only on how it reached the system. This keeps them identical. */
const fs = require('fs');
const path = require('path');
const A = require('../functions/attendance-import.js');
let pass = 0, fail = 0;
const t = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n); } };

// Read the manual scale out of suite.js rather than restating it here: a copy
// would drift exactly like the two originals did.
const suite = fs.readFileSync(path.join(__dirname, '..', 'suite.js'), 'utf8');
const block = suite.slice(suite.indexOf('var TYPE_POINTS = {'));
const TYPE_POINTS = new Function('return ' + block.slice(block.indexOf('{'), block.indexOf('};') + 1))();

console.log('— the policy —');
t('PTO / excused is 0', TYPE_POINTS['Excused'] === 0);
t('an absence is 1', TYPE_POINTS['Absent'] === 1);
t('a no-call/no-show is 2', TYPE_POINTS['No Call / No Show'] === 2);
t('present is 0', TYPE_POINTS['Present'] === 0);
t('late is half an absence', TYPE_POINTS['Late'] === 0.5);
t('early out likewise', TYPE_POINTS['Early Out'] === 0.5);

console.log('— import and manual entry must agree —');
[['called off', 'Absent'], ['NCNS', 'No Call / No Show'], ['ran late', 'Late'],
 ['left early', 'Early Out'], ['PTO approved', 'Excused']].forEach(([comment, type]) => {
  const k = A.kind(comment);
  t(JSON.stringify(comment) + ' imports as ' + type, k.type === type);
  t('  and scores the same as a manual ' + type + ' (' + TYPE_POINTS[type] + ')', k.points === TYPE_POINTS[type]);
});

console.log('— every importable type exists in the manual list —');
['Absent', 'No Call / No Show', 'Late', 'Early Out', 'Excused'].forEach(type => {
  t(type + ' is offered when logging by hand', TYPE_POINTS[type] !== undefined);
});

console.log('— an NCNS must outweigh an absence, which must outweigh a late —');
t('NCNS > absence', TYPE_POINTS['No Call / No Show'] > TYPE_POINTS['Absent']);
t('absence > late', TYPE_POINTS['Absent'] > TYPE_POINTS['Late']);
t('late > excused', TYPE_POINTS['Late'] > TYPE_POINTS['Excused']);

console.log('— the standing bands read against that scale —');
const SD = require('../suite-data.js').SuiteData;
t('two absences is still good standing', SD.bandFor(2).standing === 'Good standing');
t('four absences is a verbal warning', SD.bandFor(4).standing === 'Verbal warning');
t('two NCNS plus two absences is a written warning', SD.bandFor(6).standing === 'Written warning');
t('the top band is termination review', SD.bandFor(12).standing === 'Termination review');
t('a boundary lands in the lower band', SD.bandFor(3).standing === 'Good standing');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
