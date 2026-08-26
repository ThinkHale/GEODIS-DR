const XLSX=require('xlsx');
const A=require('../functions/attendance-import.js');
const S=require('../schedule-core.js');
let pass=0,fail=0;const t=(n,c)=>{if(c)pass++;else{fail++;console.log('  FAIL: '+n);}};
function book(sheets){const wb=XLSX.utils.book_new();Object.entries(sheets).forEach(([n,r])=>XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(r),n));return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});}
const plx=book({
  '2026 Attendance':[[null,null,null,null,null,null,null,null,null,null,null,null,null,null,'TRANSITION EMPLOYEES'],['Agency','Building','Employee Name','EID','Start','Shift','Date','Points','Comments',null,null,null,null,null,'Agency','Building','Employee Name','EID','Start','Shift','Date','Points','Comments'],['PLX','1536','Reed, Ava','80-A','1/1/26','1st','8/1/26',1,'Late']],
  '1536 - Redbull HC':[['HEADCOUNT',null,null,null,null,null,null,null],['Transition?','Dept','Employee Name','EID','Start Date','Shift','Current Points','Comments'],['Y','1536','Reed, Ava','80-A','1/1/26','1st',3,null]],
  'Attendance Tracker':[['Building','Date','Employee Name','Shift','Hours','Approved?','Notes','Current Points'],['1536','8/2/26','Reed, Ava','1st',8,'Approved','PTO',3]]
});
const red=book({'8.1-8.7':[['Employee Name','Phone','8/1/26','8/2/26','8/3/26'],['Reed, Ava','','Late','Called Off','On-Time']]});
const p={badge:'1001',name:'Ava Reed'},byName=new Map([[S.rosterKey(p.name),p]]);
const out=A.build(plx,red,{byName,rosterKey:S.rosterKey,asOf:'2026-08-26',plxSource:'PLX',redbullSource:'Redbull'});
t('same dated late is deduplicated across workbooks',out.events.filter(e=>e.type==='Late').length===1);
t('approved exception is retained',out.events.some(e=>e.type==='Excused'));
t('headcount Y becomes a transition flag',out.transitions.length===1&&out.transitions[0].badge==='1001');

/* The PLX sheet's Current Points is the balance of record, so history is kept
   for its dates and reasons but contributes nothing to the total. */
t('history is imported but not scored',out.events.filter(e=>e.historical).every(e=>e.points===0));
t('and says so on the record',out.events.filter(e=>e.historical).every(e=>/not scored/.test(e.notes)));
t('an opening balance carries the sheet total',out.events.some(e=>e.type==='Opening Balance'&&e.points===3));
t('the total equals Current Points exactly',out.events.reduce((n,e)=>n+e.points,0)===3);
t('one balance per associate',out.events.filter(e=>e.type==='Opening Balance').length===1);
t('the balance id is stable, so a re-import replaces it',
  A.build(plx,red,{byName,rosterKey:S.rosterKey,asOf:'2026-08-27',plxSource:'PLX',redbullSource:'Redbull'})
    .events.filter(e=>e.type==='Opening Balance')[0].id ===
  out.events.filter(e=>e.type==='Opening Balance')[0].id);

console.log('— the scale, which import and manual entry must share —');
t('an absence is one point',A.kind('called off').points===1);
t('an NCNS is two',A.kind('NCNS').points===2);
t('PTO is zero',A.kind('PTO approved').points===0);
t('a late is half an absence',A.kind('late').points===0.5);
t('an early out likewise',A.kind('left early').points===0.5);
console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
