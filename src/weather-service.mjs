// Fixed public Open-Meteo endpoints. No location tracking, provider key,
// arbitrary URLs, Host tools, or member-supplied coordinates are exposed.
const GEOCODING='https://geocoding-api.open-meteo.com/v1/';
const FORECAST='https://api.open-meteo.com/v1/forecast';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).every(key=>keys.includes(key));
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/u.test(value);
const validId=value=>Number.isSafeInteger(value)&&value>0;
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const checkpoint=signal=>{if(signal?.aborted)fail('weather_aborted');};
function location(row){
 if(!row||!validId(row.id)||!text(row.name,120)||!number(row.latitude,-90,90)||!number(row.longitude,-180,180)||!text(row.timezone,100))fail('weather_invalid_location');
 try{new Intl.DateTimeFormat('en',{timeZone:row.timezone});}catch{fail('weather_invalid_location');}
 const admin1=text(row.admin1,120)?row.admin1:'',country=text(row.country,120)?row.country:'';
 return{id:row.id,name:row.name,admin1,country,latitude:row.latitude,longitude:row.longitude,timeZone:row.timezone,label:[row.name,admin1,country].filter(Boolean).join('，')};
}
export function createWeatherService({fetchImpl=globalThis.fetch,now=()=>new Date().toISOString(),timeoutMs=12000}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('weather_invalid_argument');
 async function get(url,signal){
  checkpoint(signal);const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
   const response=await fetchImpl(url,{signal:combined,redirect:'error',headers:{Accept:'application/json'}});checkpoint(signal);
   if(!response.ok||Number(response.headers.get('Content-Length')??0)>131072)fail('weather_unavailable');
   const reader=response.body?.getReader();if(!reader)fail('weather_unavailable');
   const chunks=[];let count=0;
   try{for(;;){const{done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>131072){await reader.cancel();fail('weather_invalid_response');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
   checkpoint(signal);return JSON.parse(Buffer.concat(chunks,count).toString('utf8'));
  }catch(error){checkpoint(signal);if(typeof error.code==='string'&&error.code.startsWith('weather_'))throw error;fail('weather_unavailable');}
 }
 async function search(args={}){
  if(!object(args,['query','signal'])||!text(args.query,120))fail('weather_invalid_argument');
  const url=new URL('search',GEOCODING);url.search=new URLSearchParams({name:args.query.trim(),count:'8',language:'zh',format:'json'}).toString();
  const result=await get(url,args.signal);if(!result||typeof result!=='object'||result.results!==undefined&&!Array.isArray(result.results))fail('weather_invalid_response');
  return(result.results??[]).slice(0,8).filter(row=>!row.feature_code||row.feature_code.startsWith('PPL')).map(location);
 }
 async function execute(args={}){
  if(!object(args,['personId','resource','input','signal'])||args.personId!==undefined&&!/^[A-Za-z0-9_-]{1,80}$/u.test(args.personId)||!object(args.resource,['city','locationId'])||!text(args.resource.city,200)||args.resource.locationId!==undefined&&!validId(args.resource.locationId))fail('weather_invalid_argument');
  checkpoint(args.signal);let place;
  if(args.resource.locationId!==undefined){
   const url=new URL('get',GEOCODING);url.search=new URLSearchParams({id:String(args.resource.locationId),language:'zh'}).toString();
   place=location(await get(url,args.signal));if(place.id!==args.resource.locationId)fail('weather_invalid_location');
  }else{const matches=await search({query:args.resource.city,signal:args.signal});if(matches.length!==1)fail(matches.length?'weather_city_ambiguous':'weather_city_not_found');place=matches[0];}
  const url=new URL(FORECAST);url.search=new URLSearchParams({latitude:String(place.latitude),longitude:String(place.longitude),daily:'temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',timezone:place.timeZone,forecast_days:'1'}).toString();
  const result=await get(url,args.signal),daily=result?.daily,units=result?.daily_units;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:place.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));
  if(result?.timezone!==place.timeZone||daily?.time?.[0]!==day)fail('weather_not_current');
  const max=daily.temperature_2m_max?.[0],min=daily.temperature_2m_min?.[0],rain=daily.precipitation_probability_max?.[0],wind=daily.wind_speed_10m_max?.[0];
  if(!number(max,-100,70)||!number(min,-100,70)||min>max||!number(rain,0,100)||!number(wind,0,500)||units?.temperature_2m_max!=='°C'||units?.temperature_2m_min!=='°C'||units?.precipitation_probability_max!=='%'||units?.wind_speed_10m_max!=='km/h')fail('weather_invalid_response');
  checkpoint(args.signal);
  return{text:`${day} ${place.label}天气预报\n气温 ${min}–${max}°C，降水概率 ${rain}%，最大风速 ${wind} km/h。\n来源：Open-Meteo。预报可能变化，出门前可再问我。`,source:{provider:'Open-Meteo',locationId:place.id,city:place.label,timeZone:place.timeZone,date:day,retrievedAt:new Date(now()).toISOString()}};
 }
 return Object.freeze({search,execute});
}
