import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,symlinkSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createHarnessGateway} from '../src/harness-gateway.mjs';
const roots=[],gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const now=()=> '2026-10-25T08:00:00.000Z';
function fixture(options={}){
 const root=mkdtempSync(join(tmpdir(),'family-harness-gateway-'));roots.push(root);const directory=join(root,'gateway');
 const store=createStore({directory:join(root,'store'),now});
 for(const [id,role] of [['owner','owner'],['mom','elder'],['dad','elder']]){store.addPerson({id,role,label:id});store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 store.configure({paused:false});
 const starts=[],observes=[],deliveries=[],signals=[];
 const projects=[{workspaceId:'a',title:'AI 日报',path:'/projects/ai',sessionIds:[]},{workspaceId:'b',title:'家庭资料',path:'/private/family',sessionIds:[]}];
 const adapter={listWorkspaces:async()=>structuredClone(projects),start:async(intent,{signal})=>{starts.push(structuredClone(intent));signals.push(signal);return{state:'queued'};},observe:async(intent,{signal})=>{observes.push(structuredClone(intent));signals.push(signal);return{state:'running'};},...options.ownerAgent};
 const access={authorize:({workspaceId})=>({allowed:workspaceId==='a',revision:1})};
 const onResult=options.onResult??(async event=>{deliveries.push(event);});
 const gateway=createHarnessGateway({directory,store,access,ownerAgent:options.noAgent?undefined:adapter,now,onResult});
 const request=(patch={})=>({personId:'owner',route:store.route('owner'),workspaceId:'a',prompt:'读取项目并起草一期简报。',requestId:'request-1',...patch});
 return{root,directory,store,adapter,access,onResult,gateway,request,starts,observes,deliveries,signals,projects};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

test('submit persists the intent before native start and returns without waiting for the model',{timeout:1500},async()=>{
 const f=fixture(),pending=gate();let durable=false;
 f.adapter.start=async intent=>{f.starts.push(intent);durable=JSON.parse(readFileSync(join(f.directory,'harness-tasks.json'))).tasks.some(task=>task.sessionId===intent.sessionId&&task.requestId===intent.requestId);return pending.promise;};
 const task=await f.gateway.submit(f.request());assert.equal(task.state,'queued');
 await Promise.resolve();assert.equal(f.starts.length,1);assert.equal(durable,true);
 pending.resolve({state:'succeeded',text:'这一期内容已整理。'});await f.gateway.settled();
 const final=f.gateway.snapshot({personId:'owner'})[0];assert.equal(final.state,'succeeded');assert.equal(final.delivery.state,'accepted');assert.equal(f.deliveries.length,1);
 assert.match(f.starts[0].sessionId,/^family_owner_[a-f0-9-]{36}$/);assert.match(f.starts[0].requestId,/^[a-f0-9-]{36}$/);
 assert.equal(statSync(join(f.directory,'harness-tasks.json')).mode&0o777,0o600);
});
test('concurrent same request identity is idempotent and conflicts reject',async()=>{
 const f=fixture();const tasks=await Promise.all([f.gateway.submit(f.request()),f.gateway.submit(f.request()),f.gateway.submit(f.request())]);
 await f.gateway.settled();assert.equal(new Set(tasks.map(t=>t.id)).size,1);assert.equal(f.starts.length,1);
 await assert.rejects(()=>f.gateway.submit(f.request({prompt:'different'})),/request|identity|conflict/i);
 await assert.rejects(()=>f.gateway.submit(f.request({workspaceId:'b'})),/request|identity|conflict/i);
 assert.equal(f.gateway.snapshotForOwner().length,1);
});
test('Owner sees registered projects while family listing is filtered without hidden filesystem paths',async()=>{
 const f=fixture();assert.equal((await f.gateway.listProjects({personId:'owner'})).length,2);
 const visible=await f.gateway.listProjects({personId:'mom'});assert.equal(visible.length,1);assert.equal(visible[0].workspaceId,'a');
 assert.equal(JSON.stringify(visible).includes('/private'),false);assert.equal('sessionIds' in visible[0],false);
 await assert.rejects(()=>f.gateway.submit(f.request({personId:'mom',route:f.store.route('mom')})),/protected_executor_required/);
 await f.gateway.settled();assert.equal(f.starts.length,0);assert.equal(f.gateway.snapshotForOwner().length,0);
});
test('unknown workspace, forged route and paused submissions never create native work',async()=>{
 const f=fixture();await assert.rejects(()=>f.gateway.submit(f.request({workspaceId:'missing'})),/workspace|project/i);
 for(const patch of [{peerId:'foreign'},{accountId:'foreign'},{generation:2},{personId:'mom'}])await assert.rejects(()=>f.gateway.submit(f.request({route:{...f.store.route('owner'),...patch}})),/route|binding/i);
 f.store.configure({paused:true});await assert.rejects(()=>f.gateway.submit(f.request()),/paused/);
 assert.equal(f.starts.length,0);assert.equal(f.gateway.snapshotForOwner().length,0);
});
test('permission and paused state are checked after asynchronous project lookup',async()=>{
 const f=fixture(),pending=gate();f.adapter.listWorkspaces=()=>pending.promise;
 const admission=f.gateway.submit(f.request());f.store.configure({paused:true});pending.resolve(f.projects);
 await assert.rejects(()=>admission,/paused/);assert.equal(f.starts.length,0);assert.equal(f.gateway.snapshotForOwner().length,0);
});
test('pause during native execution preserves its result and permanently suppresses automatic callback',async()=>{
 const f=fixture(),pending=gate();f.adapter.start=async intent=>{f.starts.push(intent);return pending.promise;};
 const task=await f.gateway.submit(f.request());f.store.configure({paused:true});pending.resolve({state:'succeeded',text:'完成的内容'});await f.gateway.settled();
 assert.equal(f.gateway.snapshotForOwner()[0].state,'succeeded');assert.equal(f.gateway.snapshotForOwner()[0].delivery.state,'suppressed');assert.equal(f.deliveries.length,0);
 f.store.configure({paused:false});await f.gateway.tick();await f.gateway.check({personId:'owner',taskId:task.id});assert.equal(f.deliveries.length,0);
});
test('rebinding cannot deliver an old result or let the new route inspect it',async()=>{
 const f=fixture(),pending=gate();f.adapter.start=async()=>pending.promise;
 const task=await f.gateway.submit(f.request());f.store.bindPerson('owner',{accountId:'new-account',peerId:'new-peer'});
 pending.resolve({state:'succeeded',text:'旧绑定的结果'});await f.gateway.settled();
 assert.equal(f.gateway.snapshotForOwner()[0].delivery.state,'suppressed');assert.equal(f.deliveries.length,0);
 assert.deepEqual(f.gateway.snapshot({personId:'owner'}),[]);
 await assert.rejects(()=>f.gateway.check({personId:'owner',taskId:task.id}),/route|binding/);
 await assert.rejects(()=>f.gateway.check({personId:'mom',taskId:task.id}),/owner|person|forbidden/i);
});
test('success callback is durable and once-only across check, tick and restarts',async()=>{
 const f=fixture({ownerAgent:{start:async()=>({state:'succeeded',text:'结果'})}});
 const task=await f.gateway.submit(f.request());await f.gateway.settled();assert.equal(f.deliveries.length,1);
 await f.gateway.check({personId:'owner',taskId:task.id});await f.gateway.tick();assert.equal(f.deliveries.length,1);
 assert.equal(f.deliveries[0].task.id,task.id);assert.equal(f.deliveries[0].task.route.generation,1);assert.equal('cwd' in f.deliveries[0].task,false);
 await f.gateway.close();const restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now});await restarted.settled();await restarted.tick();assert.equal(f.deliveries.length,1);await restarted.close();
});
test('callback failure is unknown and never automatically retried',async()=>{
 let deliveries=0;const f=fixture({ownerAgent:{start:async()=>({state:'succeeded',text:'结果'})},onResult:async()=>{deliveries++;throw Error('unsafe token https://private.example/secret');}});
 const task=await f.gateway.submit(f.request());await f.gateway.settled();assert.equal(deliveries,1);assert.equal(f.gateway.snapshotForOwner()[0].delivery.state,'unknown');
 await f.gateway.check({personId:'owner',taskId:task.id});await f.gateway.tick();assert.equal(deliveries,1);
 assert.equal(JSON.stringify(f.gateway.snapshotForOwner()).includes('private.example'),false);
 await f.gateway.close();const restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now});await restarted.settled();assert.equal(deliveries,1);await restarted.close();
});
test('two restart cycles observe persisted request identity and never start it again',async()=>{
 const f=fixture();const task=await f.gateway.submit(f.request());await f.gateway.settled();assert.equal(f.starts.length,1);await f.gateway.close();
 f.adapter.observe=async intent=>{f.observes.push(intent);return{state:'unknown'};};
 let restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now});await restarted.settled();assert.equal(f.starts.length,1);assert.equal(f.observes.length,1);await restarted.close();
 f.adapter.observe=async intent=>{f.observes.push(intent);return{state:'succeeded',text:'原生任务完成'};};
 restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now});await restarted.settled();assert.equal(f.starts.length,1);assert.equal(f.observes.length,2);assert.equal(f.deliveries.length,1);
 assert.equal(restarted.snapshotForOwner()[0].id,task.id);assert.equal(f.observes[1].sessionId,f.starts[0].sessionId);assert.equal(f.observes[1].requestId,f.starts[0].requestId);await restarted.close();
});
test('unknown native admission is recovered by observe and pending approval is not a completed result',async()=>{
 const f=fixture({ownerAgent:{start:async()=>{throw Error('transport lost');}}});const task=await f.gateway.submit(f.request());await f.gateway.settled();assert.equal(f.gateway.snapshotForOwner()[0].state,'unknown');
 f.adapter.observe=async()=>({state:'needs_approval',pendingApprovals:1});await f.gateway.check({personId:'owner',taskId:task.id});assert.equal(f.gateway.snapshotForOwner()[0].state,'needs_approval');assert.equal(f.deliveries.length,0);
 f.adapter.observe=async()=>({state:'needs_input'});await f.gateway.tick();assert.equal(f.gateway.snapshotForOwner()[0].state,'needs_input');assert.equal(f.deliveries.length,0);
 f.adapter.observe=async()=>({state:'succeeded',text:'已核对完成'});await f.gateway.check({personId:'owner',taskId:task.id});assert.equal(f.deliveries.length,1);
});
test('missing adapter reports unavailable without manufacturing a task',async()=>{
 const f=fixture({noAgent:true});await assert.rejects(()=>f.gateway.submit(f.request()),/unavailable/);await assert.rejects(()=>f.gateway.listProjects({personId:'owner'}),/unavailable/);assert.deepEqual(f.gateway.snapshotForOwner(),[]);
});
test('close aborts native observers and never cancels a whole Host session',async()=>{
 const f=fixture();const task=await f.gateway.submit(f.request());await f.gateway.settled();let signal;
 f.adapter.observe=async(_intent,options)=>{signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
 const checking=f.gateway.check({personId:'owner',taskId:task.id});await Promise.resolve();await Promise.resolve();await f.gateway.close();await checking.catch(()=>{});
 assert.equal(signal.aborted,true);assert.equal(f.adapter.cancel,undefined);assert.equal(f.deliveries.length,0);
});
test('public snapshots are defensive and omit routes and local paths',async()=>{
 const f=fixture();await f.gateway.submit(f.request());await f.gateway.settled();
 const view=f.gateway.snapshot({personId:'owner'})[0];assert.equal('route' in view,false);assert.equal('cwd' in view,false);assert.equal(JSON.stringify(view).includes('account-owner'),false);
 view.prompt='mutation';assert.notEqual(f.gateway.snapshotForOwner()[0].prompt,'mutation');assert.deepEqual(f.gateway.snapshot({personId:'mom'}),[]);
});
test('invalid file schema is preserved and symlink targets are never read or overwritten',async()=>{
 const f=fixture();await f.gateway.close();const file=join(f.directory,'harness-tasks.json');writeFileSync(file,'{"version":999,"tasks":[]}');const original=readFileSync(file);
 assert.throws(()=>createHarnessGateway({...f,ownerAgent:f.adapter,now}),/schema|format|version/);assert.deepEqual(readFileSync(file),original);
 const target=join(f.root,'target.json');writeFileSync(target,'{"version":1,"tasks":[]}');rmSync(file);symlinkSync(target,file);
 assert.throws(()=>createHarnessGateway({...f,ownerAgent:f.adapter,now}),/symlink|storage/);assert.equal(readFileSync(target,'utf8'),'{"version":1,"tasks":[]}');
 const actual=join(f.root,'actual');mkdirSync(actual);const linked=join(f.root,'linked');symlinkSync(actual,linked);
 assert.throws(()=>createHarnessGateway({...f,directory:linked,ownerAgent:f.adapter,now}),/symlink|storage/);assert.equal(existsSync(join(actual,'harness-tasks.json')),false);
});
test('a recovered callback dispatch is uncertain and is never executed twice',async()=>{
 const f=fixture({ownerAgent:{start:async()=>({state:'succeeded',text:'完成'})}});await f.gateway.submit(f.request());await f.gateway.settled();await f.gateway.close();
 const file=join(f.directory,'harness-tasks.json'),saved=JSON.parse(readFileSync(file));saved.tasks[0].delivery={state:'dispatching',at:now()};writeFileSync(file,JSON.stringify(saved));
 const restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now});await restarted.settled();await restarted.tick();assert.equal(restarted.snapshotForOwner()[0].delivery.state,'unknown');assert.equal(f.deliveries.length,1);await restarted.close();
});
test('live Owner revocation suppresses a native result and further native observation',async()=>{
 const f=fixture(),pending=gate();let revoked=false;
 const store={snapshot:()=>{const state=f.store.snapshot();if(revoked)state.people.find(person=>person.id==='owner').role='elder';return state;}};
 f.adapter.start=async()=>pending.promise;await f.gateway.close();
 const gateway=createHarnessGateway({...f,store,ownerAgent:f.adapter,now});const task=await gateway.submit(f.request());revoked=true;pending.resolve({state:'succeeded',text:'权限撤销后的结果'});await gateway.settled();
 assert.equal(gateway.snapshotForOwner()[0].state,'succeeded');assert.equal(gateway.snapshotForOwner()[0].delivery.state,'suppressed');assert.equal(f.deliveries.length,0);assert.deepEqual(gateway.snapshot({personId:'owner'}),[]);
 await assert.rejects(()=>gateway.check({personId:'owner',taskId:task.id}),/protected_executor_required/);await gateway.close();
});
test('malformed request envelopes and corrupted persisted identities never reach native start',async()=>{
 const f=fixture();for(const patch of [{requestId:''},{prompt:'\u0000bad'},{workspaceId:42},{route:{...f.store.route('owner'),unexpected:true}},{unexpected:true}])await assert.rejects(()=>f.gateway.submit(f.request(patch)),/invalid_argument/);
 assert.equal(f.starts.length,0);await f.gateway.submit(f.request());await f.gateway.settled();await f.gateway.close();
 const file=join(f.directory,'harness-tasks.json'),saved=JSON.parse(readFileSync(file));saved.tasks[0].route.generation=42;writeFileSync(file,JSON.stringify(saved));
 assert.throws(()=>createHarnessGateway({...f,ownerAgent:f.adapter,now}),/schema/);assert.equal(f.starts.length,1);
});
test('a read-only adapter can list projects but cannot admit an unobservable task',async()=>{
 const f=fixture();await f.gateway.close();const gateway=createHarnessGateway({...f,ownerAgent:{listWorkspaces:f.adapter.listWorkspaces},now});
 assert.equal((await gateway.listProjects({personId:'owner'})).length,2);await assert.rejects(()=>gateway.submit(f.request()),/unavailable/);assert.deepEqual(gateway.snapshotForOwner(),[]);await gateway.close();
});
test('recovery can wait for explicit tick after the enclosing runtime connects its channels',async()=>{
 const f=fixture();await f.gateway.submit(f.request());await f.gateway.settled();await f.gateway.close();
 f.adapter.observe=async intent=>{f.observes.push(intent);return{state:'succeeded',text:'连接完成后恢复的结果'};};
 const restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now,recoverOnCreate:false});await restarted.settled();assert.equal(f.observes.length,0);assert.equal(f.deliveries.length,0);assert.equal(restarted.snapshotForOwner()[0].state,'queued');
 await restarted.tick();await restarted.settled();assert.equal(f.observes.length,1);assert.equal(f.deliveries.length,1);assert.equal(restarted.snapshotForOwner()[0].delivery.state,'accepted');assert.equal(f.starts.length,1);await restarted.close();
});
test('deferred recovery still durably marks interrupted callback delivery as unknown without retry',async()=>{
 const f=fixture({ownerAgent:{start:async()=>({state:'succeeded',text:'完成'})}});await f.gateway.submit(f.request());await f.gateway.settled();await f.gateway.close();
 const file=join(f.directory,'harness-tasks.json'),saved=JSON.parse(readFileSync(file));saved.tasks[0].delivery={state:'dispatching',at:now()};writeFileSync(file,JSON.stringify(saved));
 const restarted=createHarnessGateway({...f,ownerAgent:f.adapter,now,recoverOnCreate:false});await restarted.settled();assert.equal(JSON.parse(readFileSync(file)).tasks[0].delivery.state,'unknown');assert.equal(f.deliveries.length,1);assert.equal(f.observes.length,0);
 await restarted.tick();await restarted.settled();assert.equal(f.deliveries.length,1);assert.equal(f.observes.length,0);await restarted.close();
});
