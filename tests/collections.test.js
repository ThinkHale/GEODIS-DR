const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','functions','index.js'),'utf8');

// Pull the real source of the collection store out of the deployed file and run
// it against a fake bucket, so we're testing the shipped code, not a copy.
const collBlock = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const maxLine   = 'const MAX_COLLECTION_RECORDS = 20000;';
const handler   = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('function parseToState'));

let stored={};
const bucket={ file:(p)=>({ save:async(body)=>{stored[p]=body;} }) };
const NOTES_ORIGIN='https://geodis.ebtools.pro';
async function readJsonFile(path){ return stored[path]?JSON.parse(stored[path]):{}; }
function setKvCors(){}

const ctx={bucket,NOTES_ORIGIN,readJsonFile,setKvCors,console};
const fn=new Function('bucket','NOTES_ORIGIN','readJsonFile','setKvCors','console',
  collBlock.replace(maxLine,'') + maxLine + '\n' + handler + '\nreturn {COLLECTIONS,handleCollection,sanitizeRecord};');
const {COLLECTIONS,handleCollection,sanitizeRecord}=fn(bucket,NOTES_ORIGIN,readJsonFile,setKvCors,console);

let pass=0,fail=0;
const t=(n,c)=>{ if(c)pass++; else {fail++;console.log('  FAIL: '+n);} };
const mkRes=()=>{ const r={code:null,body:null,set(){return r},status(c){r.code=c;return r},json(b){r.body=b;return r},send(){return r}}; return r; };
const post=async(coll,body,origin)=>{ const res=mkRes();
  await handleCollection({method:'POST',body,get:()=>origin===undefined?NOTES_ORIGIN:origin}, res, COLLECTIONS[coll]); return res; };
const get=async(coll)=>{ const res=mkRes();
  await handleCollection({method:'GET',get:()=>NOTES_ORIGIN}, res, COLLECTIONS[coll]); return res; };

(async()=>{
console.log('— field whitelisting —');
const s=sanitizeRecord({badge:'1001',date:'2026-08-22',type:'Absent',points:'1.5',minutes:'30',
                        evil:'<script>',isAdmin:true,notes:'x'.repeat(900)}, COLLECTIONS.attendance.fields);
t('undeclared field dropped', s.evil===undefined && s.isAdmin===undefined);
t('numeric strings coerced', s.points===1.5 && s.minutes===30);
t('strings capped at 500', s.notes.length===500);
t('declared fields kept', s.badge==='1001' && s.type==='Absent');
t('non-numeric number rejected', sanitizeRecord({points:'abc'},COLLECTIONS.attendance.fields).points===undefined);

console.log('— origin gate —');
t('foreign origin rejected', (await post('attendance',{id:'x'},'https://evil.example')).code===403);
t('nothing was written', Object.keys(stored).length===0);

console.log('— upsert —');
let r=await post('attendance',{id:'a1',badge:'1001',type:'Absent',points:1});
t('insert ok', r.code===200 && r.body.count===1);
r=await post('attendance',{id:'a2',badge:'1002',type:'Late',points:0.5});
t('second insert appends', r.body.count===2);
r=await post('attendance',{id:'a1',points:2});
t('same id updates, does not duplicate', r.body.count===2);
let list=JSON.parse(stored['attendance/events.json']);
t('update merged onto existing record', list[0].points===2 && list[0].badge==='1001');
t('updatedAt stamped', !!list[0].updatedAt);

console.log('— read back —');
r=await get('attendance');
t('GET returns the collection', r.body.attendance.length===2);
t('GET uses the declared response key', r.body.attendance!==undefined);

console.log('— delete —');
r=await post('attendance',{id:'a2',_delete:true});
t('delete removes one', r.body.count===1);
r=await post('attendance',{id:'nope',_delete:true});
t('deleting a missing id is not an error', r.code===200 && r.body.deleted===false);

console.log('— validation —');
t('missing id rejected', (await post('attendance',{badge:'1'})).code===400);
t('overlong id rejected', (await post('attendance',{id:'x'.repeat(65)})).code===400);
t('collection survived bad writes', JSON.parse(stored['attendance/events.json']).length===1);

console.log('— bulk import (the report path) —');
r=await post('timeoff',{records:[
  {id:'t1',badge:'1001',type:'PTO',hours:'8',status:'Approved',junk:'no'},
  {badge:'1002',type:'VTO',hours:4,status:'Pending'}
]});
t('bulk replaces the list', r.body.count===2);
list=JSON.parse(stored['timeoff/requests.json']);
t('bulk coerces numbers', list[0].hours===8);
t('bulk strips undeclared fields', list[0].junk===undefined);
t('bulk generates missing ids', typeof list[1].id==='string' && list[1].id.length>0);
r=await post('timeoff',{records:[{id:'t9',badge:'1003',type:'Sick'}]});
t('bulk is a replace, not an append', r.body.count===1);
t('oversized bulk rejected', (await post('timeoff',{records:new Array(20001).fill({id:'x'})})).code===400);

console.log('— method gate —');
const res=mkRes();
await handleCollection({method:'DELETE',get:()=>NOTES_ORIGIN},res,COLLECTIONS.attendance);
t('DELETE method rejected', res.code===405);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
})();
