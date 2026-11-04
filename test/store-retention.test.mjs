import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

const dir=()=>mkdtempSync(join(tmpdir(),'family-store-'));

function seeded(store){
  store.addPerson({id:'owner1',role:'owner',label:'我'});
  store.bindPerson('owner1',{accountId:'acct',peerId:'peer'});
  store.configure({paused:false});
  for(let i=0;i<12;i+=1){
    const row=store.enqueue({personId:'owner1',text:'消息'+i,kind:'manual',sourceKey:'s'+i});
    store.transition(row.id,'dispatching');
    store.transition(row.id,'api_accepted');
  }
}

test('prune keeps the newest rows per person and drops older terminal ones',()=>{
  const directory=dir();
  try{
    const store=createStore({directory,now:()=>'2026-09-01T07:00:00.000Z'});
    seeded(store);
    assert.equal(store.snapshot().outbox.length,12);
    const result=store.prune({outboxKeepPerPerson:10,outboxKeepDays:30,at:'2026-11-04T07:00:00.000Z'});
    assert.equal(result.kept,10);
    assert.equal(result.dropped,2);
    const texts=store.snapshot().outbox.map(row=>row.text);
    assert.ok(texts.includes('消息11'));
    assert.ok(!texts.includes('消息0'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('prune never drops pending rows',()=>{
  const directory=dir();
  try{
    const store=createStore({directory,now:()=>'2026-11-04T07:00:00.000Z'});
    store.addPerson({id:'owner1',role:'owner',label:'我'});
    store.bindPerson('owner1',{accountId:'acct',peerId:'peer'});
    store.enqueue({personId:'owner1',text:'待发',kind:'manual',sourceKey:'pending-1'});
    store.prune({outboxKeepPerPerson:1,outboxKeepDays:1});
    assert.equal(store.snapshot().outbox.length,1);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('startup clears crash leftovers of the atomic write',()=>{
  const directory=dir();
  try{
    writeFileSync(join(directory,'.family-abc123.tmp'),'{}');
    assert.ok(existsSync(join(directory,'.family-abc123.tmp')));
    createStore({directory});
    assert.equal(existsSync(join(directory,'.family-abc123.tmp')),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
