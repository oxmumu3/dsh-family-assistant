import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exclusiveLock} from '../src/runtime.mjs';

const fresh=()=>mkdtempSync(join(tmpdir(),'family-lock-'));
const lockFile=dir=>join(dir,'runtime.lock');
const writeLock=(dir,value)=>writeFileSync(lockFile(dir),JSON.stringify(value));
const actualStart=pid=>execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8'}).trim();

test('acquire writes an owner record and release removes it',()=>{
  const dir=fresh();
  try{
    const release=exclusiveLock(dir);
    const record=JSON.parse(readFileSync(lockFile(dir),'utf8'));
    assert.equal(record.pid,process.pid);
    assert.match(record.id,/^[0-9a-f-]{36}$/);
    assert.equal(typeof record.processStart,'string');
    release();
    assert.equal(existsSync(lockFile(dir)),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('release is idempotent and never throws',()=>{
  const dir=fresh();
  try{
    const release=exclusiveLock(dir);
    release();
    assert.doesNotThrow(()=>release());
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('release leaves a lock that another owner now holds',()=>{
  const dir=fresh();
  try{
    const release=exclusiveLock(dir);
    writeLock(dir,{pid:process.pid,id:'someone-else',processStart:actualStart(process.pid)});
    release();
    assert.equal(JSON.parse(readFileSync(lockFile(dir),'utf8')).id,'someone-else');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a dead owner pid is treated as stale and taken over',()=>{
  const dir=fresh();
  try{
    writeLock(dir,{pid:2_147_483_600,id:'dead'});
    const release=exclusiveLock(dir);
    assert.notEqual(JSON.parse(readFileSync(lockFile(dir),'utf8')).id,'dead');
    release();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a recycled pid with a different start time is treated as stale',()=>{
  const dir=fresh();
  try{
    writeLock(dir,{pid:process.pid,id:'recycled',processStart:'Thu Jan  1 00:00:00 1970'});
    const release=exclusiveLock(dir);
    assert.notEqual(JSON.parse(readFileSync(lockFile(dir),'utf8')).id,'recycled');
    release();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a live owner with a matching start time keeps the lock',()=>{
  const dir=fresh();
  try{
    writeLock(dir,{pid:process.pid,id:'live',processStart:actualStart(process.pid)});
    assert.throws(()=>exclusiveLock(dir),error=>error.code==='family_runtime_locked');
    assert.equal(JSON.parse(readFileSync(lockFile(dir),'utf8')).id,'live');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
