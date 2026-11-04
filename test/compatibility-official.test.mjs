import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as compatibility from '../scripts/compatibility.mjs';

const metadata=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
const registry='https://registry.npmjs.org/@deepseek-ai%2fdsh';
const desktop='https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml';
const response=value=>({ok:true,status:200,text:async()=>typeof value==='string'?value:JSON.stringify(value)});
function fetchFixture({version='0.2.2-rc.1',exact=version,feed=`version: ${version}\nfiles:\n  - url: fixture.zip\n`}={}){
 const calls=[];
 const fetch=async url=>{calls.push(url);if(url===registry)return response({'dist-tags':{latest:'0.2.1-rc.5',next:version,alpha:'0.2.2-alpha.3'}});if(url===desktop)return response(feed);if(url===registry+'/'+encodeURIComponent(version))return response({name:'@deepseek-ai/dsh',version:exact,engines:{node:'>=24.9.0'}});throw Error('Unexpected source '+url);};
 return {fetch,calls};
}
function check(...args){assert.equal(typeof compatibility.checkOfficialVersions,'function','official guard must check the independent Desktop feed and exact corresponding SDK');return compatibility.checkOfficialVersions(...args);}

test('validated official rc1 is admitted by exact Host, peer and internal matrix',()=>assert.equal(compatibility.validateCompatibility(metadata,'0.2.2-rc.1'),'0.2.2-rc.1'));
test('official guard reads Desktop independently when npm latest still names rc5',async()=>{
 const fixture=fetchFixture();const result=await check(metadata,{fetchImpl:fixture.fetch});
 assert.deepEqual(fixture.calls,[registry,desktop,registry+'/0.2.2-rc.1']);
 assert.equal(result.sdkLatest,'0.2.1-rc.5');assert.equal(result.desktopVersion,'0.2.2-rc.1');assert.equal(result.desktopSdkVersion,'0.2.2-rc.1');assert.equal(result.compatibilityOverride,false);
});
test('a new Desktop outside the verified matrix blocks even while npm latest is known',async()=>{
 const fixture=fetchFixture({version:'0.2.2-rc.2'});
 await assert.rejects(()=>check(metadata,{fetchImpl:fixture.fetch}),/absent from the tested matrix/);
});
test('exact corresponding SDK metadata must match the independently observed Desktop',async()=>{
 const fixture=fetchFixture({exact:'0.2.1-rc.5'});
 await assert.rejects(()=>check(metadata,{fetchImpl:fixture.fetch}),/Desktop SDK metadata mismatch/);
});
test('an experimental alpha does not enter support through an official tag or Desktop',async()=>{
 const fixture=fetchFixture({version:'0.2.2-alpha.3'});
 await assert.rejects(()=>check(metadata,{fetchImpl:fixture.fetch}),/absent from the tested matrix/);
});
test('ambiguous Desktop versions fail closed before exact SDK lookup',async()=>{
 const fixture=fetchFixture({feed:'version: 0.2.2-rc.1\nversion: 0.2.1-rc.5\n'});
 await assert.rejects(()=>check(metadata,{fetchImpl:fixture.fetch}),/exactly one top-level version/);
 assert.equal(fixture.calls.length,2);
});

for(const key of [`"version'`,`'version"`])test('mixed Desktop key quotes fail closed: '+key,async()=>{
 const fixture=fetchFixture({feed:key+': 0.2.2-rc.1\n'});
 await assert.rejects(()=>check(metadata,{fetchImpl:fixture.fetch}),/Unsupported Desktop feed top-level syntax/);
 assert.equal(fixture.calls.length,2);
});
for(const key of ['"version"',"'version'"])test('paired Desktop key quotes are accepted: '+key,async()=>{
 const fixture=fetchFixture({feed:key+': 0.2.2-rc.1\nfiles:\n  - url: fixture.zip\n'});
 const result=await check(metadata,{fetchImpl:fixture.fetch});assert.equal(result.desktopSdkVersion,'0.2.2-rc.1');assert.equal(fixture.calls.length,3);
});
test('duplicate quoted Desktop version keys fail closed before exact SDK lookup',async()=>{
 const fixture=fetchFixture({feed:'"version": 0.2.2-rc.1\n\'version\': 0.2.2-rc.1\n'});
 await assert.rejects(()=>check(metadata,{fetchImpl:fixture.fetch}),/exactly one top-level version/);assert.equal(fixture.calls.length,2);
});
