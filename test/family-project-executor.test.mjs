import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync,symlinkSync,linkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFamilyProjectExecutor} from '../src/family-project-executor.mjs';
const complete=text=>[{type:'text-delta',index:0,text},{type:'finish',reason:{kind:'stop'}}];
const tool=(name,args,id='call-1')=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
function fixture(t,steps=[complete('基于项目材料的回答')],extra={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'family-project-executor-'))),workspace=join(root,'project');mkdirSync(workspace);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const requests=[],checks=[],allowed=new Set(['task','read']),ownerAgent={listWorkspaces:async()=>[{workspaceId:'allowed',path:workspace,title:'Synthetic project'},{workspaceId:'other',path:join(root,'other'),title:'Other'}]};
 const llm={async *stream(options){requests.push(options);const step=steps[requests.length-1];if(typeof step==='function'){yield*await step(options);return;}if(!step)throw Error('unexpected model round');for(const chunk of step)yield chunk;}};
 const authorize=async({capability})=>{checks.push(capability);return allowed.has(capability);};
 const execute=createFamilyProjectExecutor({ownerAgent,llm,readConfig:()=>({provider:'synthetic',model:'fixture'}),now:()=> '2026-10-25T00:00:00.000Z',...extra});
 const input={personId:'mom',workspaceId:'allowed',prompt:'请读取项目资料后帮我整理。',authorize};return{root,workspace,requests,checks,allowed,ownerAgent,llm,execute,input};
}
test('the text agent exposes only its finite project tools and no Owner/default context',async t=>{
 const f=fixture(t);const result=await f.execute(f.input);assert.equal(result.state,'succeeded');assert.equal(result.text,'基于项目材料的回答');
 assert.deepEqual(f.requests[0].tools.map(row=>row.name),['list_project_files','read_project_file']);
 assert.deepEqual(Object.keys(f.requests[0]).sort(),['maxTokens','messages','model','provider','signal','system','tools']);
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/sessionId|AGENTS\.md|CLAUDE\.md/);
 assert.ok(f.checks.filter(cap=>cap==='task').length>=2);assert.ok(f.checks.filter(cap=>cap==='read').length>=2);
});
test('an actual confined file result is returned as one official tool-role message',async t=>{
 const f=fixture(t,[tool('read_project_file',{relativePath:'notes.md'}),complete('从材料整理的回答')]);writeFileSync(join(f.workspace,'notes.md'),'SYNTHETIC_PROJECT_MATERIAL');
 const result=await f.execute(f.input);assert.equal(result.state,'succeeded');const message=f.requests[1].messages.find(row=>row.role==='tool');assert.equal(message.toolCallId,'call-1');assert.match(JSON.stringify(message.content),/SYNTHETIC_PROJECT_MATERIAL/);assert.doesNotMatch(JSON.stringify(message),new RegExp(f.workspace));
});
test('listing omits hidden/context/credential/link files and another family output directory',async t=>{
 const f=fixture(t,[tool('list_project_files',{}),tool('list_project_files',{relativePath:'family-output'},'call-2'),complete('资料列表已整理')]);
 for(const name of ['readme.md','.hidden.md','AGENTS.md','credentials.md','source.js'])writeFileSync(join(f.workspace,name),'text');
 mkdirSync(join(f.workspace,'family-output','mom'),{recursive:true});mkdirSync(join(f.workspace,'family-output','dad'));symlinkSync(join(f.workspace,'readme.md'),join(f.workspace,'link.md'));
 await f.execute(f.input);const first=JSON.stringify(f.requests[1].messages.find(row=>row.role==='tool'));assert.match(first,/readme.md/);assert.doesNotMatch(first,/hidden|AGENTS|credentials|source.js|link.md/);
 const second=JSON.stringify(f.requests[2].messages.filter(row=>row.role==='tool').at(-1));assert.match(second,/mom/);assert.doesNotMatch(second,/dad/);
});
test('missing task or read authorization prevents model and filesystem access',async t=>{
 for(const capability of ['task','read']){const f=fixture(t);f.allowed.delete(capability);const result=await f.execute(f.input);assert.equal(result.state,'failed');assert.equal(f.requests.length,0);}
});
test('unknown project fails before asking the model and does not reveal registry paths',async t=>{
 const f=fixture(t);const result=await f.execute({...f.input,workspaceId:'missing'});assert.equal(result.state,'failed');assert.equal(f.requests.length,0);assert.doesNotMatch(result.text,/\/|Other/);
});
test('traversal, absolute paths, hidden/context sources and cross-person output are blocked',async t=>{
 for(const relativePath of ['../outside.md','/etc/passwd','.env','AGENTS.md','skills/example.md','family-output/dad/note.md','dir/../readme.md','dir\\file.md']){
  const f=fixture(t,[tool('read_project_file',{relativePath}),complete('must not run')]);const result=await f.execute(f.input);assert.equal(result.state,'failed',relativePath);assert.equal(f.requests.length,1);assert.doesNotMatch(JSON.stringify(result),/outside|passwd|dad|must not run/);
 }
});
test('symlink files, directories, root ancestors and hard links are rejected',async t=>{
 for(const kind of ['file','directory','hardlink','root']){
  const f=fixture(t,[tool('read_project_file',{relativePath:kind==='directory'?'linked/note.md':'note.md'}),complete('must not run')]);const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'note.md'),'SECRET_OUTSIDE');
  if(kind==='file')symlinkSync(join(outside,'note.md'),join(f.workspace,'note.md'));if(kind==='directory')symlinkSync(outside,join(f.workspace,'linked'));if(kind==='hardlink')linkSync(join(outside,'note.md'),join(f.workspace,'note.md'));
  if(kind==='root'){const alias=join(f.root,'alias');symlinkSync(f.workspace,alias);f.ownerAgent.listWorkspaces=async()=>[{workspaceId:'allowed',path:alias,title:'Alias'}];writeFileSync(join(f.workspace,'note.md'),'data');}
  const result=await f.execute(f.input);assert.equal(result.state,'failed',kind);assert.doesNotMatch(JSON.stringify(result),/SECRET_OUTSIDE|outside/);
 }
});
test('credential content, invalid UTF8, binary and oversized files never reach the model',async t=>{
 for(const bytes of [Buffer.from('api_key = sk-SYNTHETIC_PRIVATE_VALUE_12345'),Buffer.from('-----BEGIN PRIVATE KEY-----'),Buffer.from([0xff,0xfe]),Buffer.from('binary\0text'),Buffer.alloc(32769,65)]){
  const f=fixture(t,[tool('read_project_file',{relativePath:'notes.md'}),complete('must not run')]);writeFileSync(join(f.workspace,'notes.md'),bytes);const result=await f.execute(f.input);assert.equal(result.state,bytes.length>32768?'needs_input':'failed');assert.equal(f.requests.length,1);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|PRIVATE KEY|must not run/);
 }
});
test('write permission exposes one create-only output tool inside this family member directory',async t=>{
 const f=fixture(t,[tool('write_project_note',{name:'summary.md',content:'整理后的合成资料'}),complete('资料已整理')]);f.allowed.add('write');
 const result=await f.execute(f.input);assert.equal(result.state,'succeeded');assert.ok(f.requests[0].tools.some(row=>row.name==='write_project_note'));assert.deepEqual(result.files,[{relativePath:'family-output/mom/summary.md',name:'summary.md'}]);assert.equal(readFileSync(join(f.workspace,result.files[0].relativePath),'utf8'),'整理后的合成资料');
 assert.equal((await f.execute({...f.input,prompt:'again'})).state,'failed');
});
test('write tool cannot overwrite source files, use another member path, or create executable files',async t=>{
 for(const name of ['../source.md','family-output/dad/note.md','/tmp/note.md','.hidden.md','notes.js','note.sh','credentials.md']){
  const f=fixture(t,[tool('write_project_note',{name,content:'new'}),complete('must not run')]);f.allowed.add('write');writeFileSync(join(f.workspace,'source.md'),'ORIGINAL');const result=await f.execute(f.input);assert.equal(result.state,'failed',name);assert.equal(readFileSync(join(f.workspace,'source.md'),'utf8'),'ORIGINAL');assert.equal(existsSync(join(f.workspace,'family-output')),false);
 }
});
test('existing outputs and malicious output directory symlinks cannot be overwritten',async t=>{
 for(const mode of ['existing','symlink']){
  const f=fixture(t,[tool('write_project_note',{name:'summary.md',content:'NEW'}),complete('must not run')]);f.allowed.add('write');
  if(mode==='existing'){mkdirSync(join(f.workspace,'family-output','mom'),{recursive:true});writeFileSync(join(f.workspace,'family-output','mom','summary.md'),'OLD');}
  else{const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.workspace,'family-output'));}
  const result=await f.execute(f.input);assert.equal(result.state,'failed');if(mode==='existing')assert.equal(readFileSync(join(f.workspace,'family-output','mom','summary.md'),'utf8'),'OLD');
 }
});
test('revocation during a model response suppresses tool effects and private answer',async t=>{
 const f=fixture(t,[]);f.allowed.add('write');f.llm.stream=async function*(){f.allowed.clear();yield*tool('write_project_note',{name:'notes.md',content:'PRIVATE_ANSWER'});};const result=await f.execute(f.input);assert.equal(result.state,'failed');assert.equal(existsSync(join(f.workspace,'family-output')),false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ANSWER/);
});
test('write revocation between rounds prevents later writes',async t=>{
 const f=fixture(t,[tool('read_project_file',{relativePath:'notes.md'}),async()=>{f.allowed.delete('write');return tool('write_project_note',{name:'new.md',content:'PRIVATE_WRITE'});},complete('must not run')]);f.allowed.add('write');writeFileSync(join(f.workspace,'notes.md'),'source');const result=await f.execute(f.input);assert.equal(result.state,'failed');assert.equal(existsSync(join(f.workspace,'family-output','mom','new.md')),false);
});
test('model calls to unknown tools or malformed/incomplete streams cannot cause effects',async t=>{
 for(const chunks of [tool('bash',{command:'cat /etc/passwd'}),[...tool('write_project_note',{name:'note.md',content:'BAD'}).slice(0,-1)],[...tool('write_project_note',{name:'note.md',content:'BAD'}),{type:'text-delta',index:1,text:'late'}],[{type:'finish',reason:'length'}]]){
  const f=fixture(t,[chunks]);f.allowed.add('write');const result=await f.execute(f.input);assert.equal(result.state,'failed');assert.equal(existsSync(join(f.workspace,'family-output')),false);
 }
});
test('loop and aggregate file budgets are bounded',async t=>{
 const steps=Array.from({length:9},(_,i)=>tool('read_project_file',{relativePath:'note.md'},'call-'+i));const f=fixture(t,steps);writeFileSync(join(f.workspace,'note.md'),Buffer.alloc(20000,65));const result=await f.execute(f.input);assert.ok(['failed','needs_input'].includes(result.state));assert.ok(f.requests.length<=8);
});
test('abort prevents model, read, and write effects',async t=>{
 const f=fixture(t);const controller=new AbortController();controller.abort();const result=await f.execute({...f.input,signal:controller.signal});assert.equal(result.state,'failed');assert.equal(f.requests.length,0);
});
test('history is bounded caller-supplied context and cannot add tools or override identity',async t=>{
 const f=fixture(t);const result=await f.execute({...f.input,history:Array.from({length:5},()=>({prompt:'上次目标'.repeat(2000),text:'前次结果'.repeat(3000)}))});assert.equal(result.state,'succeeded');assert.ok(JSON.stringify(f.requests[0].messages).length<40000);assert.deepEqual(f.requests[0].tools.map(row=>row.name),['list_project_files','read_project_file']);
});
test('model errors are sanitized and sensitive generated output is refused',async t=>{
 for(const step of [async()=>{throw Error('secret https://private.example/PRIVATE_PROVIDER')},complete('api_key = sk-SYNTHETIC_SECRET_123456789')]){
  const f=fixture(t,[step]);const result=await f.execute(f.input);assert.equal(result.state,'failed');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER|SYNTHETIC_SECRET|private.example/);
 }
});


test('authorization is checked after file IO and can suppress a just-read result',async t=>{
 const f=fixture(t,[tool('read_project_file',{relativePath:'notes.md'}),complete('PRIVATE_AFTER_READ')]);writeFileSync(join(f.workspace,'notes.md'),'PRIVATE_AFTER_READ');
 const phases=[];const result=await f.execute({...f.input,authorize:async({capability,phase})=>{phases.push(phase);return phase!=='after_operation';}});
 assert.equal(result.state,'failed');assert.equal(f.requests.length,1);assert.ok(phases.includes('before_operation'));assert.ok(phases.includes('after_operation'));assert.doesNotMatch(JSON.stringify(result),/PRIVATE_AFTER_READ/);
});
test('authorization after a write can suppress delivery while leaving a known create-only effect',async t=>{
 const f=fixture(t,[tool('write_project_note',{name:'notes.md',content:'PRIVATE_CREATED'}),complete('must not run')]);f.allowed.add('write');
 const result=await f.execute({...f.input,authorize:async({capability,phase})=>phase!=='after_operation'});
 assert.equal(result.state,'failed');assert.equal(readFileSync(join(f.workspace,'family-output','mom','notes.md'),'utf8'),'PRIVATE_CREATED');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CREATED|notes.md/);assert.equal(f.requests.length,1);
});

test('artifact reader returns only actual same-person safe output bytes and matching MIME',async t=>{
 const f=fixture(t);mkdirSync(join(f.workspace,'family-output','mom'),{recursive:true});writeFileSync(join(f.workspace,'family-output','mom','result.json'),'{}');
 const value=await f.execute.readArtifact({personId:'mom',workspaceId:'allowed',relativePath:'family-output/mom/result.json',authorize:f.input.authorize});
 assert.equal(value.name,'result.json');assert.equal(value.relativePath,'family-output/mom/result.json');assert.match(value.mimeType,/application\/json/);assert.ok(Buffer.isBuffer(value.bytes));assert.equal(value.bytes.toString(),'{}');assert.equal(f.requests.length,0);
});
test('artifact reader rejects another member, source documents, links, credentials and oversize',async t=>{
 const f=fixture(t);mkdirSync(join(f.workspace,'family-output','mom'),{recursive:true});mkdirSync(join(f.workspace,'family-output','dad'));writeFileSync(join(f.workspace,'notes.md'),'source');writeFileSync(join(f.workspace,'family-output','dad','notes.md'),'PRIVATE_OTHER');
 writeFileSync(join(f.workspace,'family-output','mom','secrets.md'),'api_key = sk-PRIVATE_MATERIAL_1234567890');symlinkSync(join(f.workspace,'notes.md'),join(f.workspace,'family-output','mom','link.md'));writeFileSync(join(f.workspace,'family-output','mom','large.md'),Buffer.alloc(131073,65));
 for(const relativePath of ['notes.md','family-output/dad/notes.md','family-output/mom/secrets.md','family-output/mom/link.md','family-output/mom/large.md'])await assert.rejects(()=>f.execute.readArtifact({personId:'mom',workspaceId:'allowed',relativePath,authorize:f.input.authorize}),error=>!error.message.includes(f.workspace)&&!error.message.includes('PRIVATE'));
});
test('artifact post-read revocation and missing authorization do not return bytes',async t=>{
 const f=fixture(t);mkdirSync(join(f.workspace,'family-output','mom'),{recursive:true});writeFileSync(join(f.workspace,'family-output','mom','notes.md'),'PRIVATE_ARTIFACT');
 const request={personId:'mom',workspaceId:'allowed',relativePath:'family-output/mom/notes.md'};
 await assert.rejects(()=>f.execute.readArtifact(request));
 await assert.rejects(()=>f.execute.readArtifact({...request,authorize:async({phase})=>phase!=='after_operation'}),error=>!error.message.includes('PRIVATE_ARTIFACT'));
 assert.equal(f.requests.length,0);
});

test('case variants of the reserved family output directory cannot bypass member isolation',async t=>{
 const f=fixture(t,[tool('read_project_file',{relativePath:'FAMILY-OUTPUT/dad/notes.md'}),complete('PRIVATE_CROSS_PERSON')]);
 mkdirSync(join(f.workspace,'FAMILY-OUTPUT','dad'),{recursive:true});writeFileSync(join(f.workspace,'FAMILY-OUTPUT','dad','notes.md'),'PRIVATE_CROSS_PERSON');
 const result=await f.execute(f.input);assert.equal(result.state,'failed');assert.equal(f.requests.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CROSS_PERSON/);
});
