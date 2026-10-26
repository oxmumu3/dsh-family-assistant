import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync,linkSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const subject=await import('../src/family-tool-executors.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;
});
function fixture(t,{maxBytes}={}){
  assert.equal(typeof subject.createFamilyToolExecutors,'function','bounded digest executor must be exported');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'family-tool-executors-'))),project=join(root,'project'),other=join(root,'other');
  mkdirSync(project);mkdirSync(other);mkdirSync(join(project,'daily'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const calls=[],rows=[{workspaceId:'digest',path:project,title:'合成日报',sessionIds:[]}];
  const ownerAgent={listWorkspaces:async options=>{calls.push(options);return rows;}};
  const executors=subject.createFamilyToolExecutors({ownerAgent,...(maxBytes===undefined?{}:{maxBytes})});
  const resource={workspaceId:'digest',relativePath:'daily/latest.md'};
  writeFileSync(join(project,resource.relativePath),'# 合成日报\n\n三条精选与七条摘要。\n');
  const read=patch=>executors.ai_digest({resource,...patch});
  return{root,project,other,calls,rows,ownerAgent,executors,resource,read};
}
const rejects=(run,code)=>assert.rejects(run,error=>{assert.equal(error.code,code);assert.equal(error.message,code);return true;});

test('fixed authorized digest returns UTF-8 text and relative attribution without Host tools',async t=>{
  const f=fixture(t),controller=new AbortController();
  const result=await f.read({signal:controller.signal});
  assert.deepEqual(result,{text:'# 合成日报\n\n三条精选与七条摘要。\n',source:{workspaceId:'digest',relativePath:'daily/latest.md'}});
  assert.deepEqual(Object.keys(f.executors),['ai_digest']);
  assert.equal(f.calls[0].signal,controller.signal);assert.doesNotMatch(JSON.stringify(result),/family-tool-executors-/);
});
test('request input cannot override the Owner configured resource',async t=>{
  const f=fixture(t);writeFileSync(join(f.other,'private.md'),'PRIVATE_OTHER_PROJECT');
  const result=await f.read({input:{relativePath:'../other/private.md',workspaceId:'other',path:join(f.other,'private.md')}});
  assert.match(result.text,/合成日报/);assert.doesNotMatch(result.text,/PRIVATE_OTHER_PROJECT/);
});
test('only an unambiguous official registered project may be read',async t=>{
  const f=fixture(t);
  await rejects(()=>f.read({resource:{...f.resource,workspaceId:'unknown'}}),'digest_unknown_workspace');
  f.rows.push({...f.rows[0]});await rejects(()=>f.read(),'digest_invalid_registry');
});
test('request identity and resource must be own fields of a plain request',async t=>{
  const f=fixture(t);
  for(const args of [null,[],Object.create({resource:f.resource}),{resource:f.resource,path:'other.md'}]){
    await rejects(()=>f.executors.ai_digest(args),'digest_invalid_argument');
  }
});
test('ambiguous registered filesystem paths are not normalized into a new source',async t=>{
  const f=fixture(t);f.rows[0].path=join(f.project,'daily')+'/../';
  await rejects(()=>f.read(),'digest_invalid_registry');
});
test('absolute, traversal, hidden, Windows and non-text resource paths are refused',async t=>{
  const f=fixture(t);
  for(const relativePath of ['/etc/passwd','../other/private.md','daily/../latest.md','.private.md','daily/.private.md','./daily/latest.md','C:\\private.txt','daily//latest.md','daily/latest.md/','daily/latest.json']){
    await rejects(()=>f.read({resource:{...f.resource,relativePath}}),'digest_unsafe_path');
  }
});
test('symlink files and intermediate directories never expose outside content',async t=>{
  const f=fixture(t);writeFileSync(join(f.other,'outside.md'),'PRIVATE_OUTSIDE');
  symlinkSync(join(f.other,'outside.md'),join(f.project,'linked.md'));
  symlinkSync(f.other,join(f.project,'linked-directory'));
  for(const relativePath of ['linked.md','linked-directory/outside.md'])await rejects(()=>f.read({resource:{...f.resource,relativePath}}),'digest_unsafe_path');
});
test('a symlink official project root is refused',async t=>{
  const f=fixture(t),linked=join(f.root,'linked-project');symlinkSync(f.project,linked);f.rows[0].path=linked;
  await rejects(()=>f.read(),'digest_unsafe_path');
});
test('hardlinks and directories masquerading as text files are refused',async t=>{
  const f=fixture(t);writeFileSync(join(f.other,'outside.md'),'PRIVATE_OUTSIDE');linkSync(join(f.other,'outside.md'),join(f.project,'hard.md'));
  await rejects(()=>f.read({resource:{...f.resource,relativePath:'hard.md'}}),'digest_unsafe_path');
  mkdirSync(join(f.project,'folder.md'));await rejects(()=>f.read({resource:{...f.resource,relativePath:'folder.md'}}),'digest_unsafe_path');
});
test('byte bounds enforce 64 KiB and configurable smaller limits',async t=>{
  const f=fixture(t);writeFileSync(join(f.project,f.resource.relativePath),'x'.repeat(65536));assert.equal((await f.read()).text.length,65536);
  writeFileSync(join(f.project,f.resource.relativePath),'x'.repeat(65537));await rejects(()=>f.read(),'digest_file_too_large');
  const small=fixture(t,{maxBytes:6});writeFileSync(join(small.project,small.resource.relativePath),'中文文');await rejects(()=>small.read(),'digest_file_too_large');
  assert.throws(()=>subject.createFamilyToolExecutors({ownerAgent:f.ownerAgent,maxBytes:65537}),{code:'digest_invalid_argument'});
});
test('invalid UTF-8 and binary control bytes never become replacement text',async t=>{
  const f=fixture(t);writeFileSync(join(f.project,f.resource.relativePath),Buffer.from([0xc3,0x28]));await rejects(()=>f.read(),'digest_invalid_utf8');
  writeFileSync(join(f.project,f.resource.relativePath),Buffer.from('hello\u0000world'));await rejects(()=>f.read(),'digest_invalid_text');
});
test('credential and private-key filenames are refused before their content is returned',async t=>{
  const f=fixture(t);
  for(const relativePath of ['token.txt','credentials.md','api-key.txt','private_key.md','私钥.txt']){
    writeFileSync(join(f.project,relativePath),'synthetic credential');await rejects(()=>f.read({resource:{...f.resource,relativePath}}),'digest_sensitive_source');
  }
});
test('credentials embedded in an innocent digest file are blocked without echoing secrets',async t=>{
  const f=fixture(t);
  for(const content of ['api_key = "SYNTHETIC_CREDENTIAL"','{"access_token":"SYNTHETIC_CREDENTIAL"}','{"secret":"SYNTHETIC_CREDENTIAL"}','Authorization: Bearer SYNTHETIC_CREDENTIAL','-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC_CREDENTIAL\n-----END OPENSSH PRIVATE KEY-----','密码：SYNTHETIC_CREDENTIAL','https://user:SYNTHETIC_CREDENTIAL@example.invalid/']){
    writeFileSync(join(f.project,f.resource.relativePath),content);await rejects(()=>f.read(),'digest_sensitive_source');
  }
});
test('normal discussion of tokens or keys is still readable',async t=>{
  const f=fixture(t);writeFileSync(join(f.project,f.resource.relativePath),'The article discusses token efficiency and keyboard design.\n模型使用 2048 tokens。');
  assert.match((await f.read()).text,/token efficiency/);
});
test('aborted calls never perform lookup or return file content',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await rejects(()=>f.read({signal:controller.signal}),'digest_aborted');assert.equal(f.calls.length,0);
  const another=new AbortController();f.ownerAgent.listWorkspaces=async()=>{another.abort();return f.rows;};
  await rejects(()=>f.read({signal:another.signal}),'digest_aborted');
});
test('source and registry failures expose bounded errors without paths or diagnostics',async t=>{
  const f=fixture(t);rmSync(join(f.project,f.resource.relativePath));await rejects(()=>f.read(),'digest_read_failed');
  f.ownerAgent.listWorkspaces=async()=>{throw new Error('PRIVATE_TOKEN /private/path https://private.invalid');};await rejects(()=>f.read(),'digest_source_unavailable');
});

test('a real toolbox invocation accepts the bounded executor person identity envelope',async t=>{
 const{createFamilyToolbox}=await import('../src/family-toolbox.mjs');
 const root=realpathSync(mkdtempSync(join(tmpdir(),'digest-toolbox-e2e-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'project'));writeFileSync(join(root,'project','daily.md'),'临时合成的三条精选。');
 const executors=subject.createFamilyToolExecutors({ownerAgent:{listWorkspaces:async()=>[{workspaceId:'digest',path:join(root,'project')}]}});
 const store={snapshot:()=>({people:[{id:'owner',role:'owner'},{id:'mom',role:'elder'}],bindings:[]})};
 const box=createFamilyToolbox({directory:join(root,'state'),store,executors});
 box.assign({actorId:'owner',personId:'mom',toolId:'ai_digest',resource:{workspaceId:'digest',relativePath:'daily.md'},allowInvoke:true});
 const result=await box.invoke({personId:'mom',toolId:'ai_digest',requestId:'actual-executor'});
 assert.equal(result.status,'succeeded');assert.match(result.result.text,/临时合成/);
});

test('Owner source browser lists real bounded text files without requiring manual paths or reading content',async t=>{
 const f=fixture(t);writeFileSync(join(f.project,'daily','latest.md'),'private synthetic content');writeFileSync(join(f.project,'daily','notes.txt'),'ordinary');
 const list=subject.createDigestSources({ownerAgent:{listWorkspaces:async()=>[{workspaceId:'digest',path:f.project}]}});
 const rows=await list({workspaceId:'digest',query:'latest'});assert.equal(rows.length,1);assert.equal(rows[0].relativePath,'daily/latest.md');assert.equal(rows[0].name,'latest.md');assert.doesNotMatch(JSON.stringify(rows),/private synthetic|\/Users\/|\/private\//);
});
test('Owner source browser hides linked, hidden, credential and dependency trees',async t=>{
 const f=fixture(t);mkdirSync(join(f.project,'.private'));writeFileSync(join(f.project,'.private','hidden.md'),'x');mkdirSync(join(f.project,'node_modules'));writeFileSync(join(f.project,'node_modules','x.md'),'x');writeFileSync(join(f.project,'secret-token.md'),'x');writeFileSync(join(f.other,'outside.md'),'x');symlinkSync(join(f.other,'outside.md'),join(f.project,'linked.md'));writeFileSync(join(f.project,'visible.md'),'x');
 const list=subject.createDigestSources({ownerAgent:{listWorkspaces:async()=>[{workspaceId:'digest',path:f.project}]}});const rows=await list({workspaceId:'digest'});
 assert(rows.some(row=>row.relativePath==='visible.md'));assert(!rows.some(row=>/hidden|node_modules|secret|linked/.test(row.relativePath)));
 await assert.rejects(()=>list({workspaceId:'missing'}));
});

test('source picker uses the same byte budget as its actual executor',async t=>{
 const f=fixture(t);writeFileSync(join(f.project,'large.md'),'x'.repeat(25000));writeFileSync(join(f.project,'small.md'),'small');
 const list=subject.createDigestSources({ownerAgent:{listWorkspaces:async()=>[{workspaceId:'digest',path:f.project}]},maxBytes:24000});const rows=await list({workspaceId:'digest'});
 assert(rows.some(row=>row.name==='small.md'));assert(!rows.some(row=>row.name==='large.md'));
});

test('latest digest grant resolves a new exact report on each source day without crossing format or directory',async t=>{
 const f=fixture(t);let instant='2026-10-26T01:00:00.000Z';
 const write=(path,text,at='2026-10-25T12:00:00.000Z')=>{writeFileSync(join(f.project,path),text);utimesSync(join(f.project,path),new Date(at),new Date(at));};
 write('daily/2026-10-25-wechat.txt','已生成的25日微信版');write('daily/2026-10-25.md','25日原文');
 const executors=subject.createFamilyToolExecutors({ownerAgent:f.ownerAgent,now:()=>instant,maxBytes:24000});
 const resource={workspaceId:'digest',relativePath:'daily/2026-10-24-wechat.txt',selection:'latest',sourceTimeZone:'America/Mexico_City'};
 const first=await executors.ai_digest({resource,input:{relativePath:'daily/2026-10-25.md',sourceTimeZone:'Asia/Shanghai'}});
 assert.equal(first.text,'已生成的25日微信版');assert.deepEqual(first.source,{workspaceId:'digest',relativePath:'daily/2026-10-25-wechat.txt'});
 instant='2026-10-26T13:00:00.000Z';write('daily/2026-10-26-wechat.txt','已生成的26日微信版',instant);
 const second=await executors.ai_digest({resource});assert.equal(second.text,'已生成的26日微信版');assert.equal(second.source.relativePath,'daily/2026-10-26-wechat.txt');
});

test('latest digest never falls back to an old or raw report and refuses aliases that make the current family ambiguous',async t=>{
 const f=fixture(t),instant='2026-10-25T12:00:00.000Z',resource={workspaceId:'digest',relativePath:'daily/2026-10-24-wechat.txt',selection:'latest',sourceTimeZone:'America/Mexico_City'};
 const write=(name,text='report',at=instant)=>{writeFileSync(join(f.project,'daily',name),text);utimesSync(join(f.project,'daily',name),new Date(at),new Date(at));};
 const executors=subject.createFamilyToolExecutors({ownerAgent:f.ownerAgent,now:()=>instant});
 write('2026-10-24-wechat.txt');write('2026-10-25.md');write('2026-10-26-wechat.txt');
 await rejects(()=>executors.ai_digest({resource}),'digest_no_current_report');
 write('2026-10-25-wechat.txt');write('latest-wechat.txt');
 await rejects(()=>executors.ai_digest({resource}),'digest_ambiguous_source');
});

test('latest digest rejects current symlink, credential content and a source changed during selection',async t=>{
 const instant='2026-10-25T12:00:00.000Z';
 for(const mode of ['symlink','credential','changed']){
  const f=fixture(t),path=join(f.project,'daily','2026-10-25-wechat.txt');
  if(mode==='symlink'){writeFileSync(join(f.other,'outside.txt'),'PRIVATE');symlinkSync(join(f.other,'outside.txt'),path);}
  else{writeFileSync(path,mode==='credential'?'api_key = SYNTHETIC_CREDENTIAL':'safe report');utimesSync(path,new Date(instant),new Date(instant));}
  const executors=subject.createFamilyToolExecutors({ownerAgent:f.ownerAgent,now:()=>{if(mode==='changed')writeFileSync(path,'changed source');return instant;}});
  const resource={workspaceId:'digest',relativePath:'daily/2026-10-24-wechat.txt',selection:'latest',sourceTimeZone:'America/Mexico_City'};
  await rejects(()=>executors.ai_digest({resource}),mode==='symlink'?'digest_unsafe_path':mode==='credential'?'digest_sensitive_source':'digest_source_changed');
 }
});
