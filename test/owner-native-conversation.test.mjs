import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,symlinkSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerAgentHost} from '../src/owner-agent-host.mjs';
import {createOwnerAgentClient} from '../src/owner-agent-client.mjs';
import {createHarnessGateway} from '../src/harness-gateway.mjs';
import {createStore} from '../src/store.mjs';

const roots=[],conversationId='aa000000-0000-4000-8000-000000000001';
const requestId='bb000000-0000-4000-8000-000000000002';
const root=()=>{const path=mkdtempSync(join(tmpdir(),'family-owner-conversation-'));roots.push(path);return path;};
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const event=(seq,type,data)=>({type:'event',event:{seq,type,data}});
function nativeFixture(){
 const calls=[],intent={workspaceId:'control',cwd:'/projects/owner',sessionId:'family_owner_'+conversationId,requestId,prompt:'继续找',conversationId};
 const snapshot={type:'snapshot',header:{id:intent.sessionId,cwd:intent.cwd},records:[event(0,'turn/start',{turn:1}),event(1,'user/message',{source:{kind:'user',rpcId:'previous'}})],hasMore:false,cursor:100,projections:{values:{inbox:{'next-turn':[{source:{kind:'user',rpcId:'already-queued'}}]}}}};
 const remote={workspace:{async *follow(){yield{type:'baseline',value:{items:[{workspaceId:'control',title:'Owner',path:intent.cwd,sessionIds:[intent.sessionId]}]}};}},session:{async *follow(){yield snapshot;},async prompt(input){calls.push(input);snapshot.projections.values.inbox['next-turn'].push({source:{kind:'user',rpcId:input.requestId}});return{ok:true,value:{accepted:true}};}}};
 return{calls,intent,snapshot,client:createOwnerAgentClient({remote})};
}

test('control workspace is created outside runtime data and registered idempotently through the plain Host method',async()=>{
 const path=join(root(),'owner-workspace'),calls=[];
 const workspaceController={async create(input){assert.equal(this,workspaceController);assert.equal(arguments.length,1);calls.push(input);return{workspace:{workspaceId:'control',title:'Owner',path:realpathSync(input.path),sessionIds:[]},created:calls.length===1};}};
 const host=createOwnerAgentHost({workspaceController,controlWorkspacePath:path});
 assert.equal(existsSync(path),false);
 const first=await host.ensureControlWorkspace(),second=await host.ensureControlWorkspace();
 assert.equal(first.workspaceId,'control');assert.deepEqual(second,first);assert.deepEqual(calls,[{path:realpathSync(path)},{path:realpathSync(path)}]);
});
test('control workspace refuses absent configuration, relative paths, symlinks and aborted creation',async()=>{
 const directory=root(),target=join(directory,'target'),linked=join(directory,'link');mkdirSync(target);symlinkSync(target,linked);
 for(const path of [undefined,'relative',linked]){
  const host=createOwnerAgentHost({controlWorkspacePath:path,workspaceController:{create(){assert.fail('must not register invalid path');}}});
  await assert.rejects(()=>host.ensureControlWorkspace(),error=>/^owner_agent_/.test(error.code));
 }
 const path=join(directory,'aborted'),controller=new AbortController();controller.abort();
 await assert.rejects(()=>createOwnerAgentHost({controlWorkspacePath:path}).ensureControlWorkspace({signal:controller.signal}),error=>error.code==='owner_agent_cancelled');assert.equal(existsSync(path),false);
});
test('control workspace rejects Remote envelopes and a registered path that does not match its canonical directory',async()=>{
 const path=join(root(),'owner');
 for(const value of [{ok:true,value:{workspace:{}}},{workspace:{workspaceId:'other',title:'Other',path:'/different',sessionIds:[]}}]){
  const host=createOwnerAgentHost({controlWorkspacePath:path,workspaceController:{async create(){return value;}}});
  await assert.rejects(()=>host.ensureControlWorkspace(),error=>/^owner_agent_/.test(error.code));
 }
});
test('trusted conversation queues behind an active turn and pending input without steering or changing the request',async()=>{
 const f=nativeFixture();assert.equal((await f.client.start(f.intent)).state,'queued');
 assert.deepEqual(f.calls,[{sessionId:f.intent.sessionId,requestId,mode:'queue',content:[{type:'text',text:'继续找'}]}]);
 assert.equal((await f.client.start(f.intent)).state,'queued');assert.equal(f.calls.length,1);
});
test('ordinary project requests still reject an active native turn and forged conversation identities',async()=>{
 const f=nativeFixture(),{conversationId:unused,...ordinary}=f.intent;
 await assert.rejects(()=>f.client.start(ordinary),error=>error.code==='owner_agent_busy');
 for(const value of ['not-uuid',requestId,null])await assert.rejects(()=>f.client.start({...f.intent,conversationId:value}),error=>error.code==='owner_agent_invalid_intent');assert.equal(f.calls.length,0);
});
test('sequential conversation turns remain attributed to their own rpcId and foreign same-turn input remains unknown',async()=>{
 const f=nativeFixture();f.snapshot.records.push(event(2,'assistant/message',{turn:1,message:{content:[{type:'text',text:'旧回答'}]}}),event(3,'turn/end',{turn:1,reason:{kind:'completed'}}),event(4,'turn/start',{turn:2}),event(5,'user/message',{source:{kind:'user',rpcId:requestId}}),event(6,'assistant/message',{turn:2,message:{content:[{type:'text',text:'新回答'}]}}),event(7,'turn/end',{turn:2,reason:{kind:'completed'}}));
 f.snapshot.projections.values.inbox={};const result=await f.client.observe(f.intent);assert.equal(result.state,'succeeded');assert.equal(result.text,'新回答');
 f.snapshot.records.splice(-1,0,event(8,'user/message',{source:{kind:'owner',rpcId:'foreign'}}));f.snapshot.records.at(-1).event.seq=9;
 assert.equal((await f.client.observe(f.intent)).state,'unknown');
});
test('a new conversation request queues with bounded recent history while result observation still requires its anchor',async()=>{
 const f=nativeFixture();f.snapshot.hasMore=true;f.snapshot.records[0].event.seq=90;f.snapshot.records[1].event.seq=91;let pages=0;
 f.client=createOwnerAgentClient({remote:{workspace:{async *follow(){yield{type:'baseline',value:{items:[{workspaceId:'control',title:'Owner',path:f.intent.cwd,sessionIds:[f.intent.sessionId]}]}};}},session:{async *follow(){yield f.snapshot;},async page(){pages++;return{ok:true,value:{records:[event(90-pages,'turn/start',{turn:0})],hasMore:true}};},async prompt(input){f.calls.push(input);return{ok:true,value:{accepted:true}};}}}});
 assert.equal((await f.client.start(f.intent)).state,'queued');assert.equal(f.calls.length,1);assert.equal(pages,0);
 await assert.rejects(()=>f.client.observe(f.intent),error=>error.code==='owner_agent_history_incomplete');
});
test('a native inbox entry is sufficient evidence of a queued request even when earlier history is paged',async()=>{
 const f=nativeFixture();f.snapshot.hasMore=true;f.snapshot.projections.values.inbox['next-turn'].push({source:{kind:'user',rpcId:requestId}});
 const result=await f.client.observe(f.intent);assert.equal(result.state,'queued');assert.equal(result.text,'');assert.equal(f.calls.length,0);
});

function gatewayFixture(){
 const directory=join(root(),'gateway'),store=createStore({directory:join(directory,'store')});
 for(const[id,role]of[['owner','owner'],['mom','elder']]){store.addPerson({id,role,label:id});store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}store.configure({paused:false});
 const starts=[],observes=[],deliveries=[],ownerAgent={listWorkspaces:async()=>[{workspaceId:'control',title:'Owner',path:'/projects/owner',sessionIds:[]}],start:async intent=>{starts.push(structuredClone(intent));return{state:'queued'};},observe:async intent=>{observes.push(structuredClone(intent));return{state:'succeeded',text:intent.prompt};}};
 const options={directory,store,ownerAgent,ownerTaskArtifacts:{collect:async()=>[]},onResult:async result=>{deliveries.push(result);}},gateway=createHarnessGateway(options);
 const request=patch=>({personId:'owner',route:store.route('owner'),workspaceId:'control',prompt:'帮我找旧稿',requestId:'source-1',conversationId,...patch});
 return{directory,store,starts,observes,deliveries,ownerAgent,options,gateway,request};
}
test('independent Owner request tasks share a conversation session but not request or delivery identity',async()=>{
 const f=gatewayFixture(),first=await f.gateway.submit(f.request()),second=await f.gateway.submit(f.request({requestId:'source-2',prompt:'继续找'}));await f.gateway.settled();
 assert.notEqual(first.id,second.id);assert.notEqual(first.requestId,second.requestId);assert.equal(first.sessionId,'family_owner_'+conversationId);assert.equal(second.sessionId,first.sessionId);assert.equal(f.starts.length,2);assert.ok(f.starts.every(intent=>intent.conversationId===conversationId));
 await f.gateway.tick();assert.deepEqual(f.deliveries.map(row=>row.text),['帮我找旧稿','继续找']);assert.equal(new Set(f.deliveries.map(row=>row.task.requestId)).size,2);await f.gateway.close();
});
test('conversation admission is deduplicated and changing its conversation identity conflicts',async()=>{
 const f=gatewayFixture(),rows=await Promise.all([f.gateway.submit(f.request()),f.gateway.submit(f.request())]);await f.gateway.settled();assert.equal(rows[0].id,rows[1].id);assert.equal(f.starts.length,1);
 await assert.rejects(()=>f.gateway.submit(f.request({conversationId:requestId})),error=>error.code==='gateway_request_identity_conflict');await f.gateway.close();
});
test('family callers cannot supply conversation identities and malformed Owner IDs never create tasks',async()=>{
 const f=gatewayFixture();await assert.rejects(()=>f.gateway.submit(f.request({personId:'mom',route:f.store.route('mom')})),error=>error.code==='gateway_conversation_forbidden');
 await assert.rejects(()=>f.gateway.submit(f.request({conversationId:'invalid'})),error=>error.code==='gateway_invalid_argument');assert.equal(f.starts.length,0);assert.deepEqual(f.gateway.snapshotForOwner(),[]);await f.gateway.close();
});
test('conversation provenance cannot be reused by a different entry binding or workspace',async()=>{
 const f=gatewayFixture();await f.gateway.submit(f.request());await f.gateway.settled();
 await assert.rejects(()=>f.gateway.submit(f.request({origin:'console',route:null,requestId:'source-console'})),error=>error.code==='gateway_conversation_identity_conflict');
 f.store.bindPerson('owner',{accountId:'new-account',peerId:'new-peer'});
 await assert.rejects(()=>f.gateway.submit(f.request({route:f.store.route('owner'),requestId:'source-rebind'})),error=>error.code==='gateway_conversation_identity_conflict');await f.gateway.close();
});
test('restart observes original conversation requests without re-prompting and legacy tasks retain their session identity',async()=>{
 const f=gatewayFixture(),first=await f.gateway.submit(f.request()),legacy=await f.gateway.submit(f.request({conversationId:undefined,requestId:'legacy'}));await f.gateway.settled();await f.gateway.close();
 const saved=JSON.parse(readFileSync(join(f.directory,'harness-tasks.json')));assert.equal(saved.tasks[0].conversationId,conversationId);assert.equal('conversationId'in saved.tasks[1],false);assert.equal(legacy.sessionId,'family_owner_'+legacy.id);
 const restarted=createHarnessGateway(f.options);await restarted.settled();assert.equal(f.starts.length,2);assert.equal(f.observes.length,2);assert.equal(f.observes.find(row=>row.id===first.id).conversationId,conversationId);assert.equal(restarted.snapshotForOwner().length,2);await restarted.close();
});
test('a new conversation turn never inherits a previous recipient, artifact scope, files or delivery outcome',async()=>{
 const f=gatewayFixture(),targeted=await f.gateway.submit(f.request({deliveryTarget:{personId:'mom',route:f.store.route('mom')}}));await f.gateway.settled();await f.gateway.tick();
 const own=await f.gateway.submit(f.request({requestId:'source-2',prompt:'先给我看下一份'}));await f.gateway.settled();await f.gateway.tick();
 assert.equal(targeted.deliveryTarget.personId,'mom');assert.equal(own.sessionId,targeted.sessionId);assert.equal('deliveryTarget'in own,false);assert.equal('artifactScope'in own,false);assert.equal('files'in own,false);assert.notEqual(own.requestId,targeted.requestId);
 assert.equal(f.deliveries.length,2);assert.equal(f.deliveries[0].task.deliveryTarget.personId,'mom');assert.equal('deliveryTarget'in f.deliveries[1].task,false);await f.gateway.close();
});
test('concurrent attempts cannot bind one conversation to different entry origins',async()=>{
 const f=gatewayFixture(),results=await Promise.allSettled([f.gateway.submit(f.request()),f.gateway.submit(f.request({origin:'console',route:null,requestId:'console-source'}))]);await f.gateway.settled();
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.code,'gateway_conversation_identity_conflict');assert.equal(f.starts.length,1);await f.gateway.close();
});
