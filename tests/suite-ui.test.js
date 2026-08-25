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
  const map={attendance:'attendance',timeoff:'timeOff',requisitions:'requisitions',performance:'performance'};
  return Promise.resolve({ok:true,json:()=>Promise.resolve({[map[key]]:stores[map[key]]})}); };
w.alert=()=>{}; w.confirm=()=>true; w.scrollTo=()=>{}; w.scrollTo=()=>{};
w.eval(fs.readFileSync(R+'suite-data.js','utf8'));
w.eval(fs.readFileSync(R+'suite.js','utf8'));
const d=w.document, $=s=>d.querySelector(s), $$=s=>Array.from(d.querySelectorAll(s));
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));

setTimeout(()=>{
console.log('— boot before the roster arrives —');
t('shell renders', !!$('.suite-nav'));
t('all six nav items present', $$('.suite-nav-btn').length===6);
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

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
});
},60);
