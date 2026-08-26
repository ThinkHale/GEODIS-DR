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
w.eval(fs.readFileSync(R+'auth-core.js','utf8'));
w.eval(fs.readFileSync(R+'tests/suite-auth-stub.js','utf8'));
w.eval(fs.readFileSync(R+'suite.js','utf8'));
const d=w.document, $=s=>d.querySelector(s), $$=s=>Array.from(d.querySelectorAll(s));
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));

setTimeout(()=>{
console.log('— boot before the roster arrives —');
t('shell renders', !!$('.suite-nav'));
t('all nine nav items present', $$('.suite-nav-btn').length===9);
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
t('Ended profile filtered out by default', !d.body.textContent.includes('Ben Ortiz'));
t('reconciliation state shown inline', d.body.textContent.includes('In sync'));
t('roster cannot be added to by hand', !$('[data-add="associate"]'));
$('#status-filter').value='all'; $('#status-filter').dispatchEvent(new w.Event('change',{bubbles:true}));
t('status filter reveals Ended', d.body.textContent.includes('Ben Ortiz'));
t('exception label shown on the row', d.body.textContent.includes('End in RC'));

console.log('— search —');
const inp=$('#suite-search'); inp.value='cleo'; inp.dispatchEvent(new w.Event('input',{bubbles:true}));
t('search narrows the roster', $$('.suite-table tbody tr').length===1);
t('search keeps focus', d.activeElement.id==='suite-search');

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
stores.attendance.push({id:'a9',badge:'7777',date:'2026-08-24',type:'Absent',points:1});
w.GEODISSuite.reload().then(()=>{
  click($('[data-nav="attendance"]'));
  t('orphaned import row surfaced, not dropped', d.body.textContent.includes('could not be matched'));

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
  t('both file pickers are offered', $$('[data-cov]').length===2);
  t('it asks for both reports before showing numbers',
    d.body.textContent.includes('Load both reports'));
  t('no coverage figure is invented from nothing', !$('.cov-status'));

  console.log('— coverage: both reports loaded —');
  // The parsed shapes schedule-core.js produces, injected the way readCoverageFile
  // would after a real upload.
  const SC=require('../schedule-core.js');
  const cs=w.GEODISSuite.state.coverage;
  cs.schedule=SC.parseSchedule([
    ['Time Period :','','8/23/2026 - 8/29/2026'],
    ['GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523'],
    ['Employee','','','Primary Job','','Sun','','','Mon','','Tue'],
    ['','','','','','8/23/2026','','','8/24/2026','','8/25/2026'],
    ['Reed, Ava','','','Loader','','','','','7:30 AM - 4:00 PM','','7:30 AM - 4:00 PM'],
    ['Nash, Cleo','','','Picker','','','','','7:30 AM - 4:00 PM','','7:30 AM - 4:00 PM'],
    ['Vale, Vic','','','Loader','','','','','9:30 PM - 6:00 AM','','']
  ]);
  cs.presence=SC.parseOnPremise([
    ['Employee Full Name & ID','On Premises','Primary location (path)','Reports To'],
    ['Reed, Ava (1001)','true','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea'],
    ['Nash, Cleo (80-CNASH1)','false','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea'],
    ['Vale, Vic (80-VVALE1)','false','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea'],
    ['Extra, Eli (80-EELI1)','true','GEODIS/US/CL/CLSCEN/CLSL/CL1523/1523','Boss, Bea']
  ]);
  cs.asOf=new Date(2026,7,25,11,12);
  cs.scheduleFile='schedule.xlsx'; cs.presenceFile='onprem.csv';
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
  t('the finished night shift is not called an exception', !d.body.textContent.includes('Vale, Vic'));

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

  console.log('— coverage: a stale schedule is called out —');
  click($('[data-nav="coverage"]'));
  cs.asOf=new Date(2026,8,10,11,12);
  click($('[data-nav="coverage"]'));
  t('a schedule that does not cover the as-of date is flagged',
    d.body.textContent.includes('does not include 2026-09-10'));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
});
},60);
