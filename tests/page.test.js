const {JSDOM}=require('jsdom'); const fs=require('fs');
const R=require('path').join(__dirname,'..')+'/';
let pass=0,fail=0; const t=(n,c)=>{if(c)pass++;else{fail++;console.log('  FAIL: '+n);}};

// The real page, minus <script src> (jsdom won't fetch them); the local ones are
// evaluated below in the same order the browser would.
let html=fs.readFileSync(R+'index.html','utf8').replace(/<script src="[^"]*"><\/script>/g,'');

const snapshot={updatedAt:'2026-08-24T11:30:00Z',counts:{total:3,matched:1},records:[
 {badge:'1001',empNumber:'E1',person:'Ava Reed',altName:'',action:'matched',actionLabel:'Matched',reason:'Badge is active in both systems.',market:'Atlanta',marketVerified:true,marketRaw:'',newBadge:null,crmStart:'1/5/2025',beeStart:'1/5/2025',endDate:'',endReason:'',dup:false},
 {badge:'1002',empNumber:'',person:'Ben Ortiz',altName:'',action:'endCrm',actionLabel:'End in RC',reason:'Beeline shows Terminated.',market:'Atlanta',marketVerified:true,marketRaw:'',newBadge:null,crmStart:'2/1/2025',beeStart:'',endDate:'',endReason:'',dup:false},
 {badge:'1003',empNumber:'E3',person:'Cleo Nash',altName:'',action:'addBeeline',actionLabel:'Add to Beeline',reason:'No record in Beeline.',market:'Dallas',marketVerified:true,marketRaw:'',newBadge:null,crmStart:'3/3/2025',beeStart:'',endDate:'',endReason:'',dup:false}
]};
const posted=[];
const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://geodis.ebtools.pro/'});
const w=dom.window, d=w.document;
w.XLSX={read(){},utils:{}};
w.alert=m=>{posted.push({alert:m})}; w.confirm=()=>true; w.scrollTo=()=>{};
w.fetch=(url,opt)=>{
  const u=String(url);
  if(opt&&opt.method==='POST'){ posted.push({url:u,body:JSON.parse(opt.body)});
    return Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,count:1})}); }
  /* The roster comes through the Cloud Function now, behind the same account
     check as everything else -- it used to be a public Storage URL that anybody
     with the link could read without signing in. */
  if(u.includes('snapshot=1')) return Promise.resolve({ok:true,json:()=>Promise.resolve(snapshot)});
  if(u.includes('notes=1'))     return Promise.resolve({ok:true,json:()=>Promise.resolve({notes:{'1003':{note:'Waiting on I-9'}}})});
  if(u.includes('overrides=1')) return Promise.resolve({ok:true,json:()=>Promise.resolve({overrides:{'1003':{action:'matched'}}})});
  const k=u.match(/\?(\w+)=1/); const map={attendance:'attendance',timeoff:'timeOff',requisitions:'requisitions',performance:'performance',shifts:'shifts',discrepancies:'discrepancies'};
  return Promise.resolve({ok:true,json:()=>Promise.resolve({[map[k[1]]]:[]})});
};
['auth-core.js','tests/suite-auth-stub.js','reconcile-core.js','suite-data.js','schedule-core.js','shift-key.js','pipeline-core.js','timeoff-core.js','payroll-core.js','tasks-core.js','contacts-core.js','reqs-core.js', 'pto-tracker-core.js'].forEach(f=>w.eval(fs.readFileSync(R+f,'utf8')));
w.eval(html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/)[1]);
w.eval(fs.readFileSync(R+'suite.js','utf8'));

const $=s=>d.querySelector(s), $$=s=>Array.from(d.querySelectorAll(s));
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));

setTimeout(()=>{
console.log('— page wiring —');
t('reconciliation body is parked on <body>', $('#recon-main').parentNode===d.body);
t('suite shell rendered', !!$('.suite-nav'));
t('body stays suite-active', d.body.classList.contains('suite-active'));

console.log('— snapshot -> suite handoff —');
t('roster built from the real snapshot', w.GEODISSuite.state.profiles.size===3);
t('profile keyed by badge', !!w.GEODISSuite.profile('1001'));
t('assignment status derived', w.GEODISSuite.profile('1002').status==='Ended');
t('sync time reached the suite', $('.suite-nav-footer').textContent.includes('Roster synced'));

console.log('— manual status override flows through to the profile —');
t('override applied (addBeeline -> matched)', w.GEODISSuite.profile('1003').reconciled===true);
t('shared note joined onto the profile', w.GEODISSuite.profile('1003').note==='Waiting on I-9');

console.log('— reconciliation still works inside the shell —');
click($('[data-nav="reconciliation"]'));
t('mounted into the suite', $('#recon-mount #recon-main')!==null);
t('results table rendered', $('#tbody').querySelectorAll('tr').length>0);
t('default filter hides in-sync rows (1 of 3 needs action)', $('#tbody').querySelectorAll('tr').length===1);
t('suite nav still visible alongside it', !!$('.suite-nav'));
t('legacy standalone header stays parked on body', $('body > header').parentNode===d.body);
t('suite renders its own header', $('.suite-top').closest('.suite-main')!==null);

/* Attendance is deliberately NOT the example here. It is logged on the PLX
   workbook and only read back, so the tool offers no way to add one -- a point
   balance the workbook never hears about is worse than no balance at all. */
console.log('— attendance is read-only —');
click($('[data-nav="attendance"]'));
t('nothing offers to log an occurrence', !$('[data-add="attendance"]'));
t('and the page says where they are logged', d.body.textContent.includes('Logged on the PLX workbook'));
const wb=$$('a[href*="sharepoint.com"]');
t('linking out to the sheet that owns them', wb.length>0);
t('opening in its own tab', wb[0].target==='_blank' && /noopener/.test(wb[0].rel));

/* Time off is raised on the shared IL PTO tracker, not here -- a request typed
   into this tool would be approved here and still leave the person marked absent
   by the sheet that gets paid from. So the page links out instead of offering a
   form, and the shared-write property is proved with a task, which this tool
   really does own. */
console.log('— time off is raised on the sheet that owns it —');
click($('[data-nav="timeoff"]'));
t('no form for a new request', !$('[data-add="timeoff"]'));
const ptoLink=$$('a[href*="sharepoint.com"]').filter(a=>/PTO spreadsheet/i.test(a.textContent));
t('the hero links to the tracker instead', ptoLink.length===1);
t('opening in its own tab', ptoLink[0].target==='_blank' && /noopener/.test(ptoLink[0].rel));

console.log('— writes go to the shared server store —');
click($('[data-add-task]'));
t('modal opened', !!$('#suite-modal'));
const form=$('[data-form="task"]');
form.querySelector('[name="title"]').value='End this assignment';
form.querySelector('[name="badge"]').value='1001';
form.querySelector('[name="detail"]').value='Left on Friday.';
form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
setTimeout(()=>{
  const p=posted.filter(x=>x.url&&x.url.includes('tasks=1'));
  t('one POST issued', p.length===1);
  t('POST carries the badge, not a fake associate id', p[0].body.badge==='1001');
  t('POST carries a stable id', typeof p[0].body.id==='string'&&p[0].body.id.length>0);
  t('nothing written to localStorage', w.localStorage.length===0);
  t('it landed in the shared task list', (w.GEODISSuite.state.stores.tasks||[]).length===1);
  t('with the detail it was saved with', w.GEODISSuite.state.stores.tasks[0].detail==='Left on Friday.');

  /* The reconciliation table is rendered by this page's own script, not by the
   suite, so it does not know about roles on its own. Both of its editable things
   have to refuse a read-only account -- and refuse BEFORE moving local state, or
   the change sits on screen for the rest of the session and nowhere else. */
console.log('— reconciliation is read-only for a read-only account —');
click($('[data-nav="reconciliation"]'));
w.__setRole('viewer');
t('the page is marked read-only', d.body.classList.contains('suite-readonly'));
t('and the suite answers for it', w.GEODISSuite.can('view') && !w.GEODISSuite.can('edit'));
const note = $('#tbody .note-input');
t('the note box is still there to read', !!note);
const roWrites = () => posted.filter(x=>x.url&&/notes=1|overrides=1/.test(x.url)).length;
const before2 = roWrites();
note.value = 'should not stick';
note.dispatchEvent(new w.Event('change', {bubbles:true}));
t('typing in it writes nothing', roWrites() === before2);
t('and it does not linger on screen as if it had',
  !$$('#tbody .note-input').some(n => n.value === 'should not stick'));
w.__setRole('colleague');
t('a colleague clears the mark', !d.body.classList.contains('suite-readonly'));
const note2 = $('#tbody .note-input');
note2.value = 'a real note';
note2.dispatchEvent(new w.Event('change', {bubbles:true}));
/* A refusal re-renders the table and the typed text disappears. Text that
   survives the dispatch means the guard let it through -- checked this way
   rather than on the POST, which is a tick away and this block is not async. */
t('and can write a note again', $('#tbody .note-input').value === 'a real note');

console.log('— one market across both views —');
  click($('[data-nav="overview"]'));
  const mp=$('#market-picker');
  t('header picker offers the snapshot markets', mp.textContent.indexOf('Atlanta')!==-1);
  mp.value='Atlanta'; mp.dispatchEvent(new w.Event('change',{bubbles:true}));
  t('suite scoped to Atlanta', w.GEODISSuite.state.market==='Atlanta');
  t("reconciliation's own select followed", $('#marketSelect').value==='Atlanta');
  t('its table re-rendered under that market',
    Array.from($('#tbody').querySelectorAll('tr')).every(tr=>tr.textContent.indexOf('Dallas')===-1));
  // Now drive it from the reconciliation side.
  const ms=$('#marketSelect'); ms.value='Dallas'; ms.dispatchEvent(new w.Event('change',{bubbles:true}));
  t('choosing there updates the suite', w.GEODISSuite.state.market==='Dallas');
  t('header picker followed', $('#market-picker').value==='Dallas');
  t('persisted once, under one key', w.localStorage.getItem('badgeCrosscheck.market')==='Dallas');
  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
},40);
},120);
