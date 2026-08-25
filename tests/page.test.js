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
  if(u.includes('snapshots')) return Promise.resolve({ok:true,json:()=>Promise.resolve(snapshot)});
  if(u.includes('notes=1'))     return Promise.resolve({ok:true,json:()=>Promise.resolve({notes:{'1003':{note:'Waiting on I-9'}}})});
  if(u.includes('overrides=1')) return Promise.resolve({ok:true,json:()=>Promise.resolve({overrides:{'1003':{action:'matched'}}})});
  const k=u.match(/\?(\w+)=1/); const map={attendance:'attendance',timeoff:'timeOff',requisitions:'requisitions',performance:'performance'};
  return Promise.resolve({ok:true,json:()=>Promise.resolve({[map[k[1]]]:[]})});
};
['reconcile-core.js','suite-data.js'].forEach(f=>w.eval(fs.readFileSync(R+f,'utf8')));
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

console.log('— writes go to the shared server store —');
click($('[data-nav="attendance"]'));
click($('[data-add="attendance"]'));
t('modal opened', !!$('#suite-modal'));
const form=$('[data-form="attendance"]');
form.querySelector('[name="badge"]').value='1001';
form.querySelector('[name="date"]').value='2026-08-24';
form.querySelector('[name="points"]').value='1';
form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
setTimeout(()=>{
  const p=posted.filter(x=>x.url&&x.url.includes('attendance=1'));
  t('one POST issued', p.length===1);
  t('POST carries the badge, not a fake associate id', p[0].body.badge==='1001');
  t('POST carries a stable id', typeof p[0].body.id==='string'&&p[0].body.id.length>0);
  t('nothing written to localStorage', w.localStorage.length===0);
  t('point landed on the profile', w.GEODISSuite.profile('1001').points===1);
  t('standing recomputed', w.GEODISSuite.profile('1001').standing==='Good standing');
  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
},40);
},120);
