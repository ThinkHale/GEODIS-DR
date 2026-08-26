const XLSX=require('xlsx');
const I=require('../functions/transition-import.js');
const S=require('../schedule-core.js');
let pass=0,fail=0; const t=(n,c)=>{if(c)pass++;else{fail++;console.log('  FAIL: '+n);}};
const wb=XLSX.utils.book_new();
function sheet(name,rows){XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),name);}
sheet('Transition Employees PTO Balanc', [['Account','First','Last','Phone','Balance','Date','Taken','Remaining'],['Lego','Ava','Reed','',10,'7/1/26',2,8]]);
sheet('PTO Request Off', [['Building','Employee','EID','Shift','Date','Hours','Comments','','','Balance','Approved','','Payroll'],['1519','Ava Reed','','A','7/5/26',8,'Vacation','','','','Yes','','']]);
sheet('Payroll Discrepencies', [['Name','Building','Shift','Paid','Claimed','Missing','Client','Beeline','OCP'],['Ava Reed','1519','A','30','38','Yes-8','Yes','No','7/19 processed']]);
const profile={badge:'1001',name:'Ava Reed',market:'Chicago'},byName=new Map([[S.rosterKey(profile.name),profile]]);
const out=I.build(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{byName,rosterKey:S.rosterKey,source:'test.xlsx',now:'2026-08-26T00:00:00Z'});
t('transition profile matched and balance retained',out.associatePto[0].badge==='1001'&&out.associatePto[0].transitionPtoBalance===8);
t('PTO request imported into workflow',out.timeOff.length===1&&out.timeOff[0].status==='Approved'&&out.timeOff[0].start==='2026-07-05');
t('historical request marked as already reflected in balance',out.timeOff[0].legacyBalanceApplied==='true');
t('multi-date ranges keep both endpoints', I.dateRange('7/16-7/18', 2026).start==='2026-07-16' && I.dateRange('7/16-7/18', 2026).end==='2026-07-18');
t('payroll discrepancy imported',out.discrepancies.length===1&&out.discrepancies[0].badge==='1001'&&out.discrepancies[0].status==='Submitted to Payroll');
console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0);
