import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../index.js';

test('native Owner project discovery is a real tool bound to a current persisted Owner session',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'lele-owner-project-tool-')),tools=[],routes=[],sessions=new Map();
  t.after(()=>{rmSync(directory,{recursive:true,force:true});rmSync(directory+'-owner-workspace',{recursive:true,force:true});});
  const workspaces=[{workspaceId:'reports',path:join(directory,'synthetic-reports'),title:'合成资料',sessionIds:[]}];
  const workspaceController={
    async *follow(){yield{type:'baseline',value:{items:workspaces}};},
    async create({path}){let workspace=workspaces.find(row=>row.path===path);if(!workspace){workspace={workspaceId:'owner-control',path,title:'乐乐主对话',sessionIds:[]};workspaces.push(workspace);}return{workspace,created:true};},
  };
  const sessionController={
    async create({workspaceId,sessionId}){const w=workspaces.find(row=>row.workspaceId===workspaceId);w.sessionIds.push(sessionId);sessions.set(sessionId,{cwd:w.path,records:[]});return{sessionId};},
    async prompt(){return{accepted:true};},
    async *follow({address}){const s=sessions.get(address.sessionId);yield{type:'snapshot',header:{id:address.sessionId,cwd:s.cwd},records:s.records,hasMore:false,cursor:0,projections:{values:{}}};},
    async page(){return{records:[],hasMore:false};},
  };
  const services={workspaceController,sessionController,tools:{register:tool=>tools.push(tool)},connection:{fetch:{register:route=>{routes.push(route);return()=>{};}}},llm:{listProviders:()=>[]}};
  const dispose=apply({get:name=>services[name],tools:services.tools,effect:()=>{}},{storageDir:directory});t.after(dispose);
  const discovery=tools.find(tool=>tool.name==='family_owner_projects');assert.ok(discovery,'Owner native model must have a real projects tool');
  assert.equal(discovery.parameters.additionalProperties,false);
  await assert.rejects(discovery.execute({},{agent:{id:'family_owner_11111111-1111-4111-8111-111111111111'},signal:new AbortController().signal}),/Owner|会话|权限|session/);
  const invoke=async input=>{const r=await routes[0].fetch(new Request('http://fixture/api/family/control',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Action':'1'},body:JSON.stringify(input)}));assert.equal(r.status,200);return r.json();};
  await invoke({action:'add_person',role:'owner',label:'我'});
  const state=await invoke({action:'owner_chat',text:'帮我查一下以前准备的学习资料',requestId:'native-project-tool-check'});
  const task=state.harness.tasks.at(-1);assert.ok(task?.conversationId);
  for(let n=0;n<80&&!sessions.has(task.sessionId);n++)await new Promise(resolve=>setTimeout(resolve,5));
  const output=await discovery.execute({},{agent:{id:task.sessionId},signal:new AbortController().signal});
  assert.ok(output.projects.some(row=>row.workspaceId==='reports'&&row.path===workspaces[0].path));
  // Native turn/start can precede its correlated user/message journal record.
  // Progress may temporarily be unknown; the authenticated Owner/session
  // relationship has not changed and must not lose project discovery access.
  let observed;for(let n=0;n<40;n++){observed=await invoke({action:'harness_task_status',taskId:task.id});if(observed.state==='unknown')break;await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(observed.state,'unknown');
  const duringGap=await discovery.execute({},{agent:{id:task.sessionId},signal:new AbortController().signal});
  assert.ok(duringGap.projects.some(row=>row.workspaceId==='reports'));
  workspaces.push({workspaceId:'new-project',title:'刚登记的项目',path:join(directory,'new-project'),sessionIds:[]});
  const refreshed=await discovery.execute({},{agent:{id:task.sessionId},signal:new AbortController().signal});
  assert.ok(refreshed.projects.some(row=>row.workspaceId==='new-project'),'Directory discovery must refresh live projects');
  await assert.rejects(discovery.execute({personId:'another-person'},{agent:{id:task.sessionId}}),/参数|操作/);
  await dispose();
  await assert.rejects(discovery.execute({},{agent:{id:task.sessionId}}),/关闭|Owner|会话|session/);
});
