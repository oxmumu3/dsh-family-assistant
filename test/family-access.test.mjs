import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,symlinkSync,unlinkSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const module=await import('../src/family-access.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const {createFamilyAccess}=module;
const now=()=> '2026-10-25T12:00:00.000Z';
function setup(t){
  assert.equal(typeof createFamilyAccess,'function','family access registry must be implemented');
  const directory=mkdtempSync(join(tmpdir(),'family-access-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const people=[{id:'owner',role:'owner',label:'我',notes:'private owner notes'},{id:'mom',role:'elder',label:'妈妈',notes:'private mom notes'},{id:'dad',role:'elder',label:'爸爸',notes:'private dad notes'}];
  const store={snapshot:()=>({people:structuredClone(people)}),person:id=>{const person=people.find(value=>value.id===id);if(!person)throw Error('Unknown person');return structuredClone(person);}};
  const options={directory,store,now};return{directory,store,people,options,access:createFamilyAccess(options)};
}
const permit={actorId:'owner',personId:'mom',workspaceIds:['workspace-family'],capabilities:['read','task']};

test('family access registry export exists',()=>assert.equal(typeof createFamilyAccess,'function'));
test('family members default to denied and get exposes no profile or message data',t=>{
  const{access}=setup(t),row=access.get('mom');
  assert.deepEqual(row,{personId:'mom',workspaceIds:[],capabilities:[],revision:0,updatedAt:null});
  const decision=access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read'});
  assert.equal(decision.allowed,false);assert.equal(decision.reason,'not_granted');
  assert.ok(!JSON.stringify(access.list({actorId:'owner'})).includes('private'));
});
test('only the current owner can list, grant and revoke',t=>{
  const{access}=setup(t);
  for(const actorId of ['mom','dad','missing']){
    assert.throws(()=>access.list({actorId}),{code:'FORBIDDEN'});
    assert.throws(()=>access.grant({...permit,actorId}),{code:'FORBIDDEN'});
    assert.throws(()=>access.revoke({actorId,personId:'mom'}),{code:'FORBIDDEN'});
  }
  assert.equal(access.get('mom').revision,0);
});
test('grant is per stable person id and isolates project and operation',t=>{
  const{access}=setup(t);const row=access.grant(permit);
  assert.equal(row.revision,1);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read'}).allowed,true);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'task'}).allowed,true);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'write'}).reason,'capability_denied');
  assert.equal(access.authorize({personId:'dad',workspaceId:'workspace-family',capability:'read'}).allowed,false);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family/private',capability:'read'}).reason,'workspace_denied');
  assert.equal(access.authorize({personId:'mom',workspaceId:'WORKSPACE-FAMILY',capability:'read'}).allowed,false);
});
test('owner authorization bypasses member project grants but keeps Host approval requirement',t=>{
  const{access}=setup(t);
  for(const capability of ['read','task','write']){
    const decision=access.authorize({personId:'owner',workspaceId:'any-official-workspace',capability});
    assert.equal(decision.allowed,true);assert.equal(decision.reason,'owner');assert.equal(decision.requiresHostApproval,true);
  }
  assert.equal(access.authorize({personId:'owner',workspaceId:'any',capability:'shell'}).allowed,false);
});
test('roles and membership are checked live rather than trusted from grant payloads',t=>{
  const{access,people}=setup(t);access.grant(permit);
  people.find(person=>person.id==='mom').label='爸爸';
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read'}).allowed,true);
  people.splice(people.findIndex(person=>person.id==='mom'),1);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read'}).reason,'unknown_person');
  people.find(person=>person.id==='owner').role='elder';
  assert.equal(access.authorize({personId:'owner',workspaceId:'workspace-family',capability:'write'}).allowed,false);
  assert.throws(()=>access.list({actorId:'owner'}),{code:'FORBIDDEN'});
});
test('revision changes invalidate queued decisions after a grant or revoke',t=>{
  const{access}=setup(t);const first=access.grant(permit);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'task',expectedRevision:first.revision}).allowed,true);
  const next=access.grant({...permit,capabilities:['read']});assert.equal(next.revision,2);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'task',expectedRevision:1}).reason,'revision_changed');
  const revoked=access.revoke({actorId:'owner',personId:'mom'});assert.equal(revoked.revision,3);assert.deepEqual(revoked.workspaceIds,[]);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read',expectedRevision:2}).reason,'revision_changed');
  assert.equal(access.revoke({actorId:'owner',personId:'mom'}).revision,4);
});
test('grant input validation blocks unknown capabilities, forged fields and empty-scope powers',t=>{
  const{access}=setup(t);
  for(const patch of [{capabilities:['shell']},{workspaceIds:[],capabilities:['read']},{workspaceIds:'workspace-family'},{capabilities:'read'},{workspaceIds:[' ']},{workspaceIds:['with\ncontrol']},{workspaceIds:Array.from({length:101},(_,index)=>'w-'+index)},{role:'owner'},{personId:'mom',actorId:'owner',permissions:{all:true}}]){
    assert.throws(()=>access.grant({...permit,...patch}),{code:'INVALID_ARGUMENT'});
  }
  assert.equal(access.get('mom').revision,0);
});
test('grant deduplicates bounded IDs and capabilities without altering exact project identity',t=>{
  const{access}=setup(t);const row=access.grant({...permit,workspaceIds:['workspace-family','workspace-family','workspace-A'],capabilities:['task','read','task']});
  assert.deepEqual(row.workspaceIds,['workspace-family','workspace-A']);assert.deepEqual(row.capabilities,['read','task']);
  row.workspaceIds.push('forged');row.capabilities.push('write');
  assert.equal(access.authorize({personId:'mom',workspaceId:'forged',capability:'write'}).allowed,false);
});
test('permissions persist privately, reload and observe revocation across registry instances',t=>{
  const{access,options,directory}=setup(t);access.grant(permit);
  const reloaded=createFamilyAccess(options);assert.deepEqual(reloaded.get('mom'),access.get('mom'));
  assert.equal(statSync(join(directory,'family-access.json')).mode&0o777,0o600);
  reloaded.revoke({actorId:'owner',personId:'mom'});
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read',expectedRevision:1}).reason,'revision_changed');
  assert.deepEqual(readdirSync(directory),['family-access.json']);
});
test('unknown schemas and malformed rows are rejected without overwriting evidence',t=>{
  const{directory,options}=setup(t),file=join(directory,'family-access.json');
  for(const value of [{version:99,policies:[]},{version:1,policies:[{personId:'mom',workspaceIds:['a'],capabilities:['shell'],revision:1,updatedAt:now()}]},{version:1,policies:[],ownerOverride:true}]){
    const data=JSON.stringify(value);writeFileSync(file,data);
    assert.throws(()=>createFamilyAccess(options),{code:'INVALID_STATE'});assert.equal(readFileSync(file,'utf8'),data);
  }
});
test('symlinked registry files and directories are refused without touching targets',t=>{
  const{directory,options}=setup(t),file=join(directory,'family-access.json'),target=join(directory,'target.json'),data=JSON.stringify({version:1,policies:[]});
  writeFileSync(target,data);unlinkSync(file);symlinkSync(target,file);
  assert.throws(()=>createFamilyAccess(options),{code:'UNSAFE_PATH'});assert.equal(readFileSync(target,'utf8'),data);
  const real=join(directory,'actual');mkdirSync(real);const link=join(directory,'alias');symlinkSync(real,link,'dir');
  assert.throws(()=>createFamilyAccess({...options,directory:link}),{code:'UNSAFE_PATH'});
});
test('registry path replacement after initialization fails closed',t=>{
  const{access,directory}=setup(t);access.grant(permit);const file=join(directory,'family-access.json'),target=join(directory,'target.json');
  writeFileSync(target,readFileSync(file));unlinkSync(file);symlinkSync(target,file);
  assert.throws(()=>access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read'}),{code:'UNSAFE_PATH'});
  assert.throws(()=>access.revoke({actorId:'owner',personId:'mom'}),{code:'UNSAFE_PATH'});
});
test('malformed authorization decisions and missing identities deny without widening scope',t=>{
  const{access}=setup(t);access.grant(permit);
  for(const input of [{personId:'mom',workspaceId:'',capability:'read'},{personId:'mom',workspaceId:'workspace-family',capability:'read',role:'owner'},{personId:'mom',workspaceId:'workspace-family',capability:'read',expectedRevision:-1},{personId:'mom',workspaceId:'workspace-family',capability:'read',expectedRevision:'1'},null]){
    const decision=access.authorize(input);assert.equal(decision.allowed,false);assert.equal(decision.reason,'invalid_request');
  }
  assert.throws(()=>access.grant({...permit,personId:'unknown'}),{code:'UNKNOWN_PERSON'});
  assert.throws(()=>access.get('unknown'),{code:'UNKNOWN_PERSON'});
});
test('inherited authority fields are not accepted as an explicit request',t=>{
  const{access}=setup(t);
  assert.throws(()=>access.list(Object.create({actorId:'owner'})),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>access.grant(Object.create(permit)),{code:'INVALID_ARGUMENT'});
  assert.equal(access.authorize(Object.create({personId:'owner',workspaceId:'workspace-family',capability:'write'})).allowed,false);
});
test('an undefined optional revision means no revision check',t=>{
  const{access}=setup(t);access.grant(permit);
  assert.equal(access.authorize({personId:'mom',workspaceId:'workspace-family',capability:'read',expectedRevision:undefined}).allowed,true);
});
