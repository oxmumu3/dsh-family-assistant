import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServiceProgress} from '../src/service-progress.mjs';
const people=[{id:'mom',label:'妈妈',role:'elder',shareWithOwner:'summary'},{id:'dad',label:'爸爸',role:'elder',shareWithOwner:'none'},{id:'owner',label:'我',role:'owner'}];
const at='2026-10-25T01:00:00.000Z';
test('brief progress uses real statuses and never includes summary-only or unshared task content',()=>{
 const text=buildServiceProgress({people,date:'2026-10-25',timeZone:'Asia/Shanghai',tasks:[{personId:'mom',state:'succeeded',updatedAt:at,text:'私密项目结果'},{personId:'mom',state:'needs_approval',updatedAt:at},{personId:'dad',state:'failed',updatedAt:at,text:'不分享的内容'}],presentations:[{personId:'mom',status:'api_accepted',updatedAt:at,title:'私密演示标题'},{personId:'mom',status:'uncertain',updatedAt:at}],toolRuns:[{personId:'mom',toolId:'weather',status:'succeeded',updatedAt:at},{personId:'dad',status:'failed',updatedAt:at}]});
 assert.match(text,/项目.{0,10}完成.{0,8}1/);assert.match(text,/PPT.{0,16}接口.{0,8}1/);assert.match(text,/结果.{0,8}待核对/);assert.match(text,/待审批/);
 for(const secret of['爸爸','不分享','私密','演示标题'])assert.equal(text.includes(secret),false);
 assert.equal(text.includes('已送达'),false);assert.equal(text.includes('已收到文件'),false);
});
test('explicitly forwarded requests remain visible even if the member does not share ordinary chats',()=>{
 const text=buildServiceProgress({people,date:'2026-10-25',timeZone:'Asia/Shanghai',requests:[{personId:'dad',status:'open',text:'仅转达这个请求'}],workflowRequests:[{personId:'mom',status:'pending',text:'帮我做个新工具'}]});
 assert.match(text,/爸爸.{0,12}1.{0,12}回应/);assert.match(text,/妈妈.{0,12}1.{0,12}工具/);assert.equal(text.includes('仅转达这个请求'),false);
});
test('only dated actual state changes are counted today and the output fits the brief budget',()=>{
 const prior='2026-10-24T01:00:00.000Z';
 assert.equal(buildServiceProgress({people,date:'2026-10-25',timeZone:'Asia/Shanghai',tasks:[{personId:'mom',state:'succeeded',updatedAt:prior}]}),'');
 const text=buildServiceProgress({people:Array.from({length:300},(_,i)=>({id:'person-'+i,role:'elder',label:'测试家人'+i,shareWithOwner:'summary'})),date:'2026-10-25',timeZone:'Asia/Shanghai',toolRuns:Array.from({length:300},(_,i)=>({personId:'person-'+i,status:'failed',updatedAt:at}))});
 assert.ok(text.length<=900);assert.match(text,/工作台/);
});
