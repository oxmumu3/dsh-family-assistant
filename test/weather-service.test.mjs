import test from 'node:test';
import assert from 'node:assert/strict';
import {createWeatherService} from '../src/weather-service.mjs';
const now=()=> '2026-10-25T05:00:00.000Z';
const city={id:1808926,name:'杭州',latitude:30.29,longitude:120.16,timezone:'Asia/Shanghai',country:'中国',admin1:'浙江',feature_code:'PPLA'};
const forecast={timezone:'Asia/Shanghai',daily_units:{temperature_2m_max:'°C',temperature_2m_min:'°C',precipitation_probability_max:'%',wind_speed_10m_max:'km/h'},daily:{time:['2026-10-25'],temperature_2m_max:[24.3],temperature_2m_min:[16.8],precipitation_probability_max:[55],wind_speed_10m_max:[21.3]}};
function fixture(overrides={}){const requests=[];const fetchImpl=async(url,options)=>{requests.push({url:new URL(url),options});return Response.json(new URL(url).pathname.endsWith('/search')?{results:[city]}:new URL(url).pathname.endsWith('/get')?city:forecast);};return{requests,service:createWeatherService({fetchImpl,now,...overrides})};}
test('city search has fixed public endpoints and exposes explicit location choices',async()=>{
 const{service,requests}=fixture();const rows=await service.search({query:'杭州'});assert.equal(rows[0].id,city.id);assert.match(rows[0].label,/杭州.*浙江/);
 assert.equal(requests[0].url.origin,'https://geocoding-api.open-meteo.com');assert.equal(requests[0].url.searchParams.get('name'),'杭州');assert.equal(requests[0].options.redirect,'error');
});
test('weather reads only a selected public location and produces a dated attributed forecast',async()=>{
 const{service,requests}=fixture();const result=await service.execute({personId:'mom',resource:{city:'杭州，浙江，中国',locationId:city.id},input:{url:'https://private.invalid'}});
 assert.match(result.text,/2026-10-25/);assert.match(result.text,/16.8.*24.3/);assert.match(result.text,/55%/);assert.match(result.text,/预报/);assert.equal(result.source.provider,'Open-Meteo');
 assert.equal(requests.length,2);assert.equal(requests[0].url.pathname,'/v1/get');assert.equal(requests[1].url.origin,'https://api.open-meteo.com');assert.equal(requests[1].url.searchParams.get('latitude'),'30.29');
});
test('legacy city-only assignments work only with one unambiguous location',async()=>{
 const{service}=fixture();assert.match((await service.execute({resource:{city:'杭州'}})).text,/杭州/);
 const ambiguous=createWeatherService({now,fetchImpl:async()=>Response.json({results:[city,{...city,id:123,admin1:'四川'}]})});
 await assert.rejects(()=>ambiguous.execute({resource:{city:'杭州'}}),{code:'weather_city_ambiguous'});
});
test('unavailable, stale, malformed and incomplete data cannot become a successful brief',async()=>{
 for(const value of [{...forecast,daily:{...forecast.daily,time:['2020-01-01']}},{...forecast,daily:{...forecast.daily,temperature_2m_max:[null]}},{...forecast,daily_units:{...forecast.daily_units,temperature_2m_max:'°F'}}]){
 const{service}=fixture({fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/get')?city:value)});await assert.rejects(()=>service.execute({resource:{city:'杭州',locationId:city.id}}));}
 const{service}=fixture({fetchImpl:async()=>{throw Error('secret https://private.invalid');}});await assert.rejects(()=>service.search({query:'杭州'}),error=>error.code==='weather_unavailable'&&!error.message.includes('private'));
});
test('bounds, aborts, invalid zones and forged resource fields fail closed',async()=>{
 const{service,requests}=fixture();const abort=new AbortController();abort.abort();await assert.rejects(()=>service.search({query:'杭州',signal:abort.signal}));assert.equal(requests.length,0);
 for(const resource of [{city:'杭州',url:'https://private.invalid'},{city:'杭州',locationId:-1},{city:'x'.repeat(201)}])await assert.rejects(()=>service.execute({resource}));
 await assert.rejects(()=>fixture({fetchImpl:async()=>Response.json({...city,timezone:'Invalid/Zone'})}).service.execute({resource:{city:'杭州',locationId:city.id}}));
});
test('response bodies and public coordinate bounds are checked before formatting',async()=>{
 const{service}=fixture({fetchImpl:async()=>new Response('x'.repeat(140000))});await assert.rejects(()=>service.search({query:'杭州'}));
 const bad=fixture({fetchImpl:async()=>Response.json({...city,latitude:999})}).service;await assert.rejects(()=>bad.execute({resource:{city:'杭州',locationId:city.id}}));
});
