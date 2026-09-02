const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','functions','index.js'),'utf8');

// Pull the real source of the collection store out of the deployed file and run
// it against a fake bucket, so we're testing the shipped code, not a copy.
const collBlock = src.slice(src.indexOf('const COLLECTIONS = {'), src.indexOf('const NOTES_ORIGIN'));
const maxLine   = 'const MAX_COLLECTION_RECORDS = 20000;';
const handler   = src.slice(src.indexOf('async function readJsonArray'), src.indexOf('function parseToState'));

/* This slice reaches past handleCollection to handleSignIn, so it carries the
   REAL identityOf() and requireUser(). That is worth keeping: the permission
   gate below is the shipped one, not a stand-in. It needs the Admin SDK to
   verify a token and the account rules to interpret one. */
const { makeAuth, reqGet } = require('./fn-auth.js');
const auth = makeAuth();

let stored={};
const bucket={ file:(p)=>({ save:async(body)=>{stored[p]=body;} }) };
const NOTES_ORIGIN='https://geodis.ebtools.pro';
async function readJsonFile(path){ return stored[path]?JSON.parse(stored[path]):{}; }
function setKvCors(){}

const fn=new Function('bucket','NOTES_ORIGIN','readJsonFile','setKvCors','console','admin','Auth','MarketAccess',
  collBlock.replace(maxLine,'') + maxLine + '\n' + handler +
  '\nreturn {COLLECTIONS,handleCollection,sanitizeRecord,handleSignIn,bootstrapRoleFor};');
const {COLLECTIONS,handleCollection,sanitizeRecord,handleSignIn,bootstrapRoleFor}=
  fn(bucket,NOTES_ORIGIN,readJsonFile,setKvCors,console,auth.admin,auth.Auth,
    require('../functions/market-access-core.js'));

let pass=0,fail=0;
const t=(n,c)=>{ if(c)pass++; else {fail++;console.log('  FAIL: '+n);} };
const mkRes=()=>{ const r={code:null,body:null,set(){return r},status(c){r.code=c;return r},json(b){r.body=b;return r},send(){return r}}; return r; };
/* The account list IS a collection, so seeding it is how the gate learns who is
   calling -- exactly the path a real deployment takes. */
const signedInAs=(rec)=>{ auth.as(rec); stored['admin/users.json']=JSON.stringify(rec?[Object.assign({id:rec.email},rec)]:[]); };
const headers=(origin)=>({origin:origin===undefined?NOTES_ORIGIN:origin, authorization:'Bearer test-token'});
const post=async(coll,body,origin,token)=>{ const res=mkRes();
  const h=headers(origin);
  if(token!==undefined) h.authorization=token;
  await handleCollection({method:'POST',body,get:reqGet(h)}, res, COLLECTIONS[coll]); return res; };
const get=async(coll,token)=>{ const res=mkRes();
  const h=headers();
  if(token!==undefined) h.authorization=token;
  await handleCollection({method:'GET',get:reqGet(h)}, res, COLLECTIONS[coll]); return res; };
signedInAs({email:'tester@geodis.com',name:'Tester',role:'admin',enabled:true});

(async()=>{
console.log('— field whitelisting —');
const s=sanitizeRecord({badge:'1001',date:'2026-08-22',type:'Absent',points:'1.5',minutes:'30',
                        evil:'<script>',isAdmin:true,notes:'x'.repeat(900)}, COLLECTIONS.attendance.fields);
t('undeclared field dropped', s.evil===undefined && s.isAdmin===undefined);
t('numeric strings coerced', s.points===1.5 && s.minutes===30);
t('strings capped at 500', s.notes.length===500);
t('declared fields kept', s.badge==='1001' && s.type==='Absent');
t('non-numeric number rejected', sanitizeRecord({points:'abc'},COLLECTIONS.attendance.fields).points===undefined);
const taskFields=sanitizeRecord({assignee:'Cody',due:'2026-09-05',priority:'high'},COLLECTIONS.tasks.fields);
t('task assignment, due date, and priority are persisted fields',
  taskFields.assignee==='Cody' && taskFields.due==='2026-09-05' && taskFields.priority==='high');

console.log('— origin gate —');
t('foreign origin rejected', (await post('attendance',{id:'x'},'https://evil.example')).code===403);
t('nothing was written', !stored['attendance/events.json']);

/* The gate. The origin check above is not a security control -- anything that
   is not a browser sends whatever origin it likes -- and it says nothing about
   WHO is asking. The token does both. */
console.log('— every read and write needs an account —');
t('a GET with no token is refused', (await get('attendance','')).code===401);
t('and says to sign in', (await get('attendance','')).body.signIn===true);
t('a forged token is refused', (await get('attendance','Bearer nonsense')).code===401);
t('a POST with no token is refused', (await post('attendance',{id:'x'},undefined,'')).code===401);
t('and wrote nothing', !stored['attendance/events.json']);

signedInAs({email:'ro@geodis.com',name:'Reader',role:'viewer',enabled:true});
t('read-only may read', (await get('attendance')).code===200);
t('read-only may NOT write', (await post('attendance',{id:'x'})).code===403);
t('and is told which role refused it', (await post('attendance',{id:'x'})).body.forbidden===true);

signedInAs({email:'gone@geodis.com',name:'Gone',role:'admin',enabled:false});
t('a disabled admin cannot read', (await get('attendance')).code===403);
t('nor write', (await post('attendance',{id:'x'})).code===403);

signedInAs({email:'outside@gmail.com',name:'Outsider',role:'admin',enabled:true});
t('an off-domain account is nobody, whatever role its record claims',
  (await get('attendance')).code===401);

signedInAs({email:'tester@geodis.com',name:'Tester',role:'admin',enabled:true});

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

/* Accounts are the one collection where the permission is not the whole answer.
   'roles' says a manager may open the door; WHICH change they may make depends
   on the row in front of them and the role they are reaching for. A <select> is
   not a permission, so all of it is decided here. */
console.log('— changing somebody else\'s access —');
stored['admin/users.json']=JSON.stringify([
  {id:'mgr@geodis.com',email:'mgr@geodis.com',name:'Mgr',role:'manager',enabled:true},
  {id:'col@geodis.com',email:'col@geodis.com',name:'Col',role:'colleague',enabled:true},
  {id:'boss@geodis.com',email:'boss@geodis.com',name:'Boss',role:'admin',enabled:true}
]);
auth.as({email:'mgr@geodis.com',name:'Mgr',role:'manager',enabled:true});
t('a manager may promote a colleague to manager',
  (await post('users',{id:'col@geodis.com',email:'col@geodis.com',role:'manager'})).code===200);
t('and it stuck',
  JSON.parse(stored['admin/users.json']).find(u=>u.id==='col@geodis.com').role==='manager');
let r2=await post('users',{id:'col@geodis.com',email:'col@geodis.com',role:'admin'});
t('a manager may NOT make anybody an admin', r2.code===403);
t('and is told why', /cannot grant/i.test(r2.body.error||''));
t('the role did not move',
  JSON.parse(stored['admin/users.json']).find(u=>u.id==='col@geodis.com').role==='manager');
t('a manager may not touch an admin at all',
  (await post('users',{id:'boss@geodis.com',email:'boss@geodis.com',role:'viewer'})).code===403);
r2=await post('users',{id:'mgr@geodis.com',email:'mgr@geodis.com',role:'admin'});
t('and may not promote themselves', r2.code===403);
t('which is said plainly', /your own/i.test(r2.body.error||''));
t('nor delete an account above them',
  (await post('users',{id:'boss@geodis.com',_delete:true})).code===403);
t('and the admin is still there',
  JSON.parse(stored['admin/users.json']).some(u=>u.id==='boss@geodis.com'));
/* A bulk replace would rewrite the whole list in one write and walk straight
   past every check above -- including the one stopping self-promotion. */
t('the bulk path is closed for accounts',
  (await post('users',{records:[{id:'mgr@geodis.com',email:'mgr@geodis.com',role:'admin'}]})).code===403);
t('and changed nothing',
  JSON.parse(stored['admin/users.json']).find(u=>u.id==='mgr@geodis.com').role==='manager');

auth.as({email:'col2@geodis.com',name:'Col2',role:'colleague',enabled:true});
stored['admin/users.json']=JSON.parse(stored['admin/users.json']).concat(
  [{id:'col2@geodis.com',email:'col2@geodis.com',name:'Col2',role:'colleague',enabled:true}]);
stored['admin/users.json']=JSON.stringify(stored['admin/users.json']);
t('a colleague cannot reach accounts at all',
  (await post('users',{id:'col@geodis.com',email:'col@geodis.com',role:'viewer'})).code===403);
t('and cannot change settings either',
  (await post('appConfig',{id:'rcBaseUrl',key:'rcBaseUrl',value:'https://evil'})).code===403);
auth.as({email:'boss@geodis.com',name:'Boss',role:'admin',enabled:true});
t('an admin can change settings',
  (await post('appConfig',{id:'rcBaseUrl',key:'rcBaseUrl',value:'https://rc'})).code===200);
t('and can make somebody an admin',
  (await post('users',{id:'col@geodis.com',email:'col@geodis.com',role:'admin'})).code===200);

/* Somebody has to be able to grant the first role, and nobody can grant one
   until an administrator exists. This is the way out of that, and it is the
   mechanism a real deployment leans on, so it gets tested rather than trusted. */
console.log('— the first administrator —');
const signIn = async (email, body) => {
  const res = mkRes();
  auth.as({ email, name: 'Whoever', role: 'admin', enabled: true });
  await handleSignIn({ method:'POST', body: body||{},
    get: reqGet({ origin: NOTES_ORIGIN, authorization: 'Bearer test-token' }) }, res);
  return res;
};
const usersNow = () => { try { return JSON.parse(stored['admin/users.json']); } catch(e) { return []; } };

delete process.env.ADMIN_EMAILS;
stored['admin/users.json'] = JSON.stringify([]);
let r3 = await signIn('first@geodis.com');
t('on an empty deployment the first account becomes the administrator',
  r3.code===200 && r3.body.user.role==='admin');
t('because otherwise the tool installs itself into a state nobody can leave',
  bootstrapRoleFor('anyone@geodis.com', []) === 'admin');
t('and the door shuts as soon as one account exists',
  bootstrapRoleFor('second@geodis.com', usersNow()) === '');
r3 = await signIn('second@geodis.com');
t('so the second person is an ordinary colleague', r3.body.user.role==='colleague');
t('which is the default, not a special case', r3.body.user.role===auth.Auth.DEFAULT_ROLE);

/* The case that actually applies here: accounts already exist, all of them
   ordinary, and none of them can promote anybody. */
process.env.ADMIN_EMAILS = 'cody.hale@employbridge.com';
stored['admin/users.json'] = JSON.stringify([
  {id:'cody.hale@employbridge.com',email:'cody.hale@employbridge.com',name:'Cody Hale',
   role:'viewer',enabled:true,markets:[],createdAt:'2026-08-01T00:00:00Z'},
  {id:'other@geodis.com',email:'other@geodis.com',name:'Other',role:'colleague',enabled:true,markets:[]}
]);
r3 = await signIn('cody.hale@employbridge.com');
t('a listed address is raised to admin even though the account already existed',
  r3.body.user.role==='admin');
t('and it is written to the stored record, not just returned',
  usersNow().find(u=>u.id==='cody.hale@employbridge.com').role==='admin');
t('the account is not recreated -- its history is kept',
  usersNow().find(u=>u.id==='cody.hale@employbridge.com').createdAt==='2026-08-01T00:00:00Z');
t('nobody else is touched',
  usersNow().find(u=>u.id==='other@geodis.com').role==='colleague');
r3 = await signIn('other@geodis.com');
t('an address not on the list is left exactly as it is', r3.body.user.role==='colleague');

/* Taking somebody's access away has to stay final, or the back door becomes a
   way to undo a decision somebody made deliberately. */
stored['admin/users.json'] = JSON.stringify([
  {id:'cody.hale@employbridge.com',email:'cody.hale@employbridge.com',name:'Cody Hale',
   role:'viewer',enabled:false,markets:[]}
]);
r3 = await signIn('cody.hale@employbridge.com');
t('a DISABLED account is not resurrected by the list',
  usersNow()[0].enabled===false && usersNow()[0].role==='viewer');

/* Left set on purpose on this deployment, which makes the pin permanent -- so
   it has to be VISIBLE. A role change that appears to work and reverts at the
   next sign-in is the worst outcome: whoever made it has already moved on. */
console.log('— a pinned account says so, and refuses the change —');
process.env.ADMIN_EMAILS = 'cody.hale@employbridge.com';
stored['admin/users.json'] = JSON.stringify([
  {id:'cody.hale@employbridge.com',email:'cody.hale@employbridge.com',role:'admin',enabled:true,markets:[]},
  {id:'boss@geodis.com',email:'boss@geodis.com',role:'admin',enabled:true,markets:[]}
]);
auth.as({email:'boss@geodis.com',role:'admin',enabled:true});
let pinnedList = (await get('users')).body.users;
t('the pinned account is flagged on read',
  pinnedList.find(u=>u.id==='cody.hale@employbridge.com').pinnedRole==='admin');
t('and nobody else is', !pinnedList.find(u=>u.id==='boss@geodis.com').pinnedRole);
let r4 = await post('users',{id:'cody.hale@employbridge.com',email:'cody.hale@employbridge.com',role:'viewer'});
t('even a full admin cannot demote it', r4.code===409);
t('and is told why, not just refused', /ADMIN_EMAILS/.test(r4.body.error||''));
t('the stored role is untouched',
  usersNow().find(u=>u.id==='cody.hale@employbridge.com').role==='admin');
t('other fields on that account still save',
  (await post('users',{id:'cody.hale@employbridge.com',email:'cody.hale@employbridge.com',markets:['Chicago']})).code===200);

delete process.env.ADMIN_EMAILS;
pinnedList = (await get('users')).body.users;
t('unset the variable and the pin is gone -- it is a property of the deploy, not the account',
  !pinnedList.find(u=>u.id==='cody.hale@employbridge.com').pinnedRole);
stored['admin/users.json'] = JSON.stringify([
  {id:'cody.hale@employbridge.com',email:'cody.hale@employbridge.com',role:'admin',enabled:true,markets:[]}
]);
r3 = await signIn('cody.hale@employbridge.com');
t('with the list emptied the granted role simply stays', r3.body.user.role==='admin');

console.log('— method gate —');
const res=mkRes();
await handleCollection({method:'DELETE',get:()=>NOTES_ORIGIN},res,COLLECTIONS.attendance);
t('DELETE method rejected', res.code===405);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
})();
