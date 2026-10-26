import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberPublicTools} from '../src/member-public-tools.mjs';
const context={authorize:()=>true,signal:new AbortController().signal};
test('weather can only use locations returned by the current public lookup',async()=>{
 const calls=[];const tools=createMemberPublicTools({weatherSearch:async()=>[{id:7,label:'合成城市'}],weatherExecute:async x=>{calls.push(x);return{text:'合成天气'};}});
 const find=tools.find(t=>t.name==='public_weather_locations'),forecast=tools.find(t=>t.name==='public_weather_forecast');
 await assert.rejects(()=>forecast.execute({locationId:8},context));await find.execute({query:'合成城市'},context);
 assert.equal((await forecast.execute({locationId:7},context)).text,'合成天气');assert.equal(calls[0].resource.locationId,7);
});
test('public search uses a fixed endpoint, bounds response and treats returned links as data',async()=>{
 let requested;const tools=createMemberPublicTools({fetchImpl:async(url,options)=>{requested={url:String(url),options};return new Response('<rss><channel><item><title>Example</title><link>https://example.com/a</link><description>Public &amp; bounded</description></item><item><title>Bad</title><link>http://127.0.0.1/private</link></item></channel></rss>');}});
 const value=await tools.find(t=>t.name==='public_web_search').execute({query:'公开资料'},context);
 assert.equal(new URL(requested.url).hostname,'www.bing.com');assert.equal(requested.options.redirect,'error');assert.equal(value.results.length,1);assert.equal(value.results[0].snippet,'Public & bounded');
});
test('public query rejects credentials, private URLs, PII and revoked authorization before network',async()=>{
 let calls=0;const tool=createMemberPublicTools({fetchImpl:async()=>{calls++;return new Response('');}}).find(t=>t.name==='public_web_search');
 for(const query of ['password=private','http://localhost/secret','a@example.com','身份证123456789012345678'])await assert.rejects(()=>tool.execute({query},context));
 await assert.rejects(()=>tool.execute({query:'普通查询'},{...context,authorize:()=>false}));assert.equal(calls,0);
});
