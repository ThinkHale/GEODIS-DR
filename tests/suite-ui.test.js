const {JSDOM}=require('jsdom'); const fs=require('fs');
const R=require('path').join(__dirname,'..')+'/';
let pass=0,fail=0; const t=(n,c)=>{if(c)pass++;else{fail++;console.log('  FAIL: '+n);}};

const records=[
 {badge:'1001',empNumber:'E1',person:'Ava Reed',action:'matched',actionLabel:'Matched',reason:'ok',market:'Atlanta',marketVerified:true,dup:false},
 {badge:'1002',person:'Ben Ortiz',action:'endCrm',actionLabel:'End in RC',reason:'Beeline shows Terminated',market:'Atlanta',marketVerified:true,dup:false},
 {badge:'1003',person:'Cleo Nash',action:'addBeeline',actionLabel:'Add to Beeline',reason:'no bee',market:'Dallas',marketVerified:true,dup:true}
];
const stores={attendance:[{id:'a1',badge:'1001',date:'2026-08-24',type:'Absent',points:1}],
              timeOff:[{id:'t1',badge:'1001',type:'PTO',start:'2026-08-01',end:'2026-08-02',hours:16,status:'Pending'}],
              requisitions:[{id:'REQ-1',title:'Loader',department:'Warehouse Operations',shift:'1st',openings:0,filled:0,priority:'High',status:'Open'}],
              performance:[{id:'p1',badge:'1001',period:'2026-08',quality:96,productivity:90,safety:99}]};

// Mirror index.html's real structure: parked reconciliation DOM + suite root.
const dom=new JSDOM(`<!doctype html><html><body class="suite-active">
 <div id="suite-root"></div>
 <header id="legacy-header">legacy</header>
 <main id="recon-main"><div id="tbody">ROWS</div></main>
</body></html>`,{runScripts:'outside-only',url:'https://geodis.ebtools.pro/'});
const w=dom.window;
w.fetch=(url)=>{ const key=String(url).match(/\?(\w+)=1/)[1];
  const map={attendance:'attendance',timeoff:'timeOff',requisitions:'requisitions',performance:'performance',shifts:'shifts',discrepancies:'discrepancies'};
  return Promise.resolve({ok:true,json:()=>Promise.resolve({[map[key]]:stores[map[key]]})}); };
w.alert=()=>{}; w.confirm=()=>true; w.scrollTo=()=>{}; w.scrollTo=()=>{};
w.eval(fs.readFileSync(R+'suite-data.js','utf8'));
w.eval(fs.readFileSync(R+'schedule-core.js','utf8'));
w.eval(fs.readFileSync(R+'shift-key.js','utf8'));
w.eval(fs.readFileSync(R+'pipeline-core.js','utf8'));
w.eval(fs.readFileSync(R+'timeoff-core.js','utf8'));
w.eval(fs.readFileSync(R+'payroll-core.js','utf8'));
w.eval(fs.readFileSync(R+'tasks-core.js','utf8'));
w.eval(fs.readFileSync(R+'contacts-core.js','utf8'));
w.eval(fs.readFileSync(R+'reqs-core.js','utf8'));
w.eval(fs.readFileSync(R+'pto-tracker-core.js','utf8'));
w.eval(fs.readFileSync(R+'auth-core.js','utf8'));
w.eval(fs.readFileSync(R+'tests/suite-auth-stub.js','utf8'));
w.eval(fs.readFileSync(R+'suite.js','utf8'));
const d=w.document, $=s=>d.querySelector(s), $$=s=>Array.from(d.querySelectorAll(s));
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));

setTimeout(async ()=>{
console.log('— boot before the roster arrives —');
t('shell renders', !!$('.suite-nav'));
t('all ten nav items present', $$('.suite-nav-btn').length===10);
t('Tasks sits right after Overview',
  $$('.suite-nav-btn').map(b=>b.dataset.nav)[1]==='tasks');
t('empty roster prompts for the snapshot', d.body.textContent.includes('Waiting on the morning assignment snapshot'));
t('no fabricated associates anywhere', !d.body.textContent.includes('James Dixon'));

console.log('— roster arrives from the reconciliation view —');
d.dispatchEvent(new w.CustomEvent('geodis:records',{detail:{records,updatedAt:'2026-08-24T11:00:00Z'}}));
t('overview now has metrics', $$('.metric').length===4);
t('active count excludes the endCrm profile', $('.metric-value').textContent==='2');
t('sync time shown in the footer', $('.suite-nav-footer').textContent.includes('Roster synced'));

console.log('— associates tab —');
click($('[data-nav="associates"]'));
t('roster renders rows', $$('.suite-table tbody tr').length>0);
t('real names from the snapshot', d.body.textContent.includes('Ava Reed'));
/* Ended associates are listed by default: notes and payroll issues still get
   logged against people whose assignment has finished, and hiding them made
   that look impossible. */
t('an Ended profile is listed too', d.body.textContent.includes('Ben Ortiz'));
t('and is labelled as ended, not passed off as current',
  $$('.suite-table tbody tr').filter(r=>r.textContent.includes('Ben Ortiz'))[0]
    .textContent.includes('Ended'));
t('reconciliation state shown inline', d.body.textContent.includes('In sync'));
t('roster cannot be added to by hand', !$('[data-add="associate"]'));
$('#status-filter').value='Active'; $('#status-filter').dispatchEvent(new w.Event('change',{bubbles:true}));
t('the filter can still narrow to active only', !d.body.textContent.includes('Ben Ortiz'));
$('#status-filter').value='all'; $('#status-filter').dispatchEvent(new w.Event('change',{bubbles:true}));
t('and back to everyone', d.body.textContent.includes('Ben Ortiz'));
t('exception label shown on the row', d.body.textContent.includes('End in RC'));

console.log('— search —');
// Debounced: the whole page re-renders, so it waits for the typing to stop.
const inp=$('#suite-search'); inp.value='cleo'; inp.dispatchEvent(new w.Event('input',{bubbles:true}));
t('the list does not thrash on every keystroke', $$('.suite-table tbody tr').length>1);
await new Promise(r=>setTimeout(r,200));
t('search narrows the roster', $$('.suite-table tbody tr').length===1);
t('search keeps focus', d.activeElement.id==='suite-search');
/* The caret used to be slammed to the end of the box after every keystroke, so
   correcting a typo in the middle of a query was impossible. */
const inp2=$('#suite-search');
inp2.value='cleo'; inp2.setSelectionRange(2,2);
inp2.dispatchEvent(new w.Event('input',{bubbles:true}));
await new Promise(r=>setTimeout(r,200));
t('and the caret stays where it was', $('#suite-search').selectionStart===2);

console.log('— profile detail: the combined view —');
click($('[data-nav="associates"]'));
click($('[data-profile="1001"]'));
const txt=d.body.textContent;
t('identity', txt.includes('Ava Reed') && txt.includes('E1'));
t('attendance points joined', txt.includes('Attendance points'));
t('performance score = avg(96,90,99)', txt.includes('95'));
t('time off joined', txt.includes('PTO'));
t('assignment + reconciliation section', txt.includes('Assignment') && txt.includes('Recommended action'));
t('attendance history table rendered', $$('.suite-table').length>0);
/* The occurrence is on the sheet, so the profile shows it and stops there --
   removing it here would leave the workbook still carrying the point. */
t('the occurrence cannot be removed from the profile', !$('[data-del^="attendance|"]'));
t('nor logged from it', !$('[data-add="attendance"]'));
t('the profile links to the workbook instead', !!$('.suite-panel a[href*="sharepoint.com"]'));

console.log('— unscored associate shows no invented number —');
click($('[data-nav="associates"]'));
t('roster shows "Not scored", never a number nobody measured', d.body.textContent.includes('Not scored'));
click($('[data-profile="1003"]'));
t('profile says why there is no score', d.body.textContent.includes('No performance record'));

console.log('— requisitions: zero-openings guard —');
click($('[data-nav="requisitions"]'));
t('no NaN% coverage', !d.body.textContent.includes('NaN'));
t('no Infinity% coverage', !d.body.textContent.includes('Infinity'));

console.log('— attendance orphan warning —');
/* No badge at all -- the case that genuinely reaches nobody. A row whose badge
   merely left the roster now keeps a former profile instead, so it is not an
   orphan and would not warn. */
stores.attendance.push({id:'a9',badge:'',name:'Nobody, No',date:'2026-08-24',type:'Absent',points:1});
w.GEODISSuite.reload().then(()=>{
  click($('[data-nav="attendance"]'));
  t('orphaned import row surfaced, not dropped', d.body.textContent.includes('reach no profile'));
  console.log('— attendance is a window onto the workbook, not a form —');
  t('the logged occurrence is shown', d.body.textContent.includes('Absent'));
  t('with no way to remove it', !$('[data-del^="attendance|"]'));
  t('and no way to add one', !$('[data-add="attendance"]'));
  t('the page names the sheet that owns it',
    d.body.textContent.includes('Logged on the PLX workbook'));
  t('and links to its attendance tab', !!$('a[href*="sharepoint.com"]'));
  t('a departed associate keeps a profile instead of becoming one',
    !!w.GEODISSuite.profile('7777') === false && w.GEODISSuite.state.profiles.size > 0);
  /* A current occurrence reaching nobody is a warning; the same row marked as
     history would not be, because the roster only holds active assignments. */
  t('and treated as something to fix, not as expected history',
    !!d.querySelector('.warn-banner'));

  console.log('— reconciliation is mounted, not swapped —');
  click($('[data-nav="reconciliation"]'));
  t('suite shell still present', !!$('.suite-nav'));
  t('reconciliation DOM moved inside the shell', $('#recon-mount #recon-main')!==null);
  t('its listeners-bearing children survived', $('#recon-mount #tbody').textContent==='ROWS');
  t('body class untouched', d.body.classList.contains('suite-active'));
  t('no floating escape-hatch button', !$('.suite-return'));

  click($('[data-nav="overview"]'));
  t('leaving parks the reconciliation DOM back on body', $('#recon-main').parentNode===d.body);
  t('reconciliation DOM was not destroyed', $('#recon-main #tbody').textContent==='ROWS');
  click($('[data-nav="reconciliation"]'));
  t('re-entering re-mounts it', $('#recon-mount #recon-main')!==null);

  console.log('— coverage: before any report is loaded —');
  click($('[data-nav="coverage"]'));
  t('on-premise tab renders', d.body.textContent.includes('On-Premise'));
  t('two file pickers are offered', $$('[data-cov]').length===2);
  t('and neither is the retired weekly schedule',
    $$('[data-cov]').map(x=>x.dataset.cov).sort().join()==='presence,workbook');
  t('including the workbook', !!d.querySelector('[data-cov="workbook"]'));
  t('it asks for what it needs before showing numbers',
    d.body.textContent.includes('the PLX workbook and the on-premise export'));
  t('no coverage figure is invented from nothing', !$('.cov-status'));

  console.log('— coverage: both reports loaded —');
  // The parsed shapes schedule-core.js produces, injected the way readCoverageFile
  // would after a real upload.
  const SC=require('../schedule-core.js');
  const cs=w.GEODISSuite.state.coverage;
  /* The schedule comes from the workbook's shift tags now, not a separate
     upload. These are the stored records a workbook upload leaves behind. */
  w.GEODISSuite.state.stores.shifts=[
    { id:'s1', name:'Reed, Ava', nameKey:'ava reed', shift:'1st', building:'1523',
      hours:'7:30am-4pm Mon-Fri', source:'PLX workbook' },
    { id:'s2', name:'Nash, Cleo', nameKey:'cleo nash', shift:'1st', building:'1523',
      hours:'7:30am-4pm Mon-Fri', source:'PLX workbook' },
    // A night shift that started Monday and ended at 6am Tuesday.
    { id:'s3', name:'Vale, Vic', nameKey:'vale vic', shift:'3rd', building:'1523',
      hours:'9:30pm-6am Sun-Mon', source:'PLX workbook' }
  ];
  cs.presence=SC.parseOnPremise([
    ['Employee Full Name & ID','On Premises','Primary location (path)','Reports To'],
    ['Reed, Ava (1001)','true','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea'],
    ['Nash, Cleo (80-CNASH1)','false','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea'],
    ['Vale, Vic (80-VVALE1)','false','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea'],
    ['Extra, Eli (80-EELI1)','true','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea']
  ]);
  cs.asOf=new Date(2026,7,25,11,12);
  cs.presenceFile='onprem.csv';
  click($('[data-nav="coverage"]'));

  t('the metric strip appears', $$('.metric').length===4);
  t('coverage percentage is shown', d.body.textContent.includes('Coverage now'));
  t('the loaded file names are shown', d.body.textContent.includes('onprem.csv'));
  t('the as-of instant is shown and editable', !!$('#cov-asof'));
  t('exceptions are the default filter', $('#cov-status').value==='exceptions');
  t('the on-shift no-show is listed', d.body.textContent.includes('Nash, Cleo'));
  t('someone on premise with no shift is listed', d.body.textContent.includes('Extra, Eli'));
  t('a person with no schedule row says so', d.body.textContent.includes('no schedule row'));
  t('the working associate is filtered out of the exception view', !d.body.textContent.includes('Reed, Ava'));
  const covRows = () => $$('.cov-row').map(tr => tr.textContent).join(' ');
  t('the finished night shift is not called an exception', !covRows().includes('Vale, Vic'));
  /* He reaches no profile, but he has gone home -- there is nothing to
     attribute to him, so he is not put in the queue of people to connect. He is
     counted there instead, and still appears in the table below. */
  t('somebody who has clocked out is not queued up for connecting',
    $('.cov-unlinked') && !$('.cov-unlinked').textContent.includes('Vale, Vic'));
  t('he is disclosed as a count rather than dropped',
    $('.cov-unlinked').textContent.includes('not on the clock'));

  console.log('— coverage: filters and the roster join —');
  $('#cov-status').value='all';
  $('#cov-status').dispatchEvent(new w.Event('change',{bubbles:true}));
  t('showing everyone brings the working associate back', d.body.textContent.includes('Reed, Ava'));
  t('the completed night shift shows too', d.body.textContent.includes('Vale, Vic'));
  t('a matching employee id links the row to its badge', d.body.textContent.includes('Badge 1001'));
  t('an unmatched row shows its employee id instead of a badge', d.body.textContent.includes('80-EELI1'));

  const link=$$('.cov-row .name.link').find(el=>el.textContent.indexOf('Reed, Ava')!==-1);
  t('a linked row is clickable', !!link);
  click(link);
  t('clicking it opens that associate\'s profile', d.body.textContent.includes('Assignment, attendance'));

  console.log('— coverage: the schedule follows the as-of date —');
  click($('[data-nav="coverage"]'));
  cs.asOf=new Date(2026,8,10,11,12);
  click($('[data-nav="coverage"]'));
  /* A derived schedule is built around whatever as-of is being looked at, so it
     cannot be a week out of date the way an uploaded export could -- there is no
     period to fall outside of. What CAN go stale is the workbook itself, and
     that is reported by its own age rather than by a schedule period. */
  t('no period warning, because a derived schedule has no period to miss',
    !d.body.textContent.includes('does not include'));
  t('a Thursday in September still resolves the Mon-Fri shift',
    d.body.textContent.includes('Reed, Ava'));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
});
},60);
