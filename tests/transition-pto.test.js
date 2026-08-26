const T = require('../functions/transition-pto.js');
let pass=0,fail=0; const t=(n,c)=>{if(c)pass++;else{fail++;console.log('  FAIL: '+n);}};
const rows=[{badge:'1001',transitionAssociate:'true',transitionPtoBalance:6}];
const now='2026-08-26T12:00:00Z';

let request={badge:'1001',type:'PTO',hours:8,status:'Received'};
T.apply(null,request,rows,now);
t('received request does not deduct',rows[0].transitionPtoBalance===6&&request.transitionHours===0);
request.status='Approved'; T.apply({transitionHours:0},request,rows,now);
t('transition balance is used first',rows[0].transitionPtoBalance===0&&request.transitionHours===6&&request.accrualHours===2);
const prior={...request}; request.status='Submitted to Payroll'; T.apply(prior,request,rows,now);
t('later workflow status does not double deduct',rows[0].transitionPtoBalance===0&&request.transitionHours===6);
request.hours=4; T.apply(prior,request,rows,now);
t('editing hours releases the difference',rows[0].transitionPtoBalance===2&&request.transitionHours===4&&request.accrualHours===0);
T.release(request,rows,now);
t('deleting releases the allocation',rows[0].transitionPtoBalance===6);
const legacy={badge:'1001',type:'PTO',hours:3,status:'Approved',legacyBalanceApplied:'true'};
T.apply(null,legacy,rows,now);
t('historical imported PTO is not deducted twice',rows[0].transitionPtoBalance===6&&legacy.transitionHours===0);

console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0);
