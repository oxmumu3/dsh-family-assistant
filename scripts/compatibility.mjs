import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
const matrixVersions=JSON.parse(readFileSync(new URL('../compatibility.json',import.meta.url),'utf8'));
const sdkPeers=['@deepseek-ai/dsh'];
const registry='https://registry.npmjs.org/@deepseek-ai%2fdsh';
const desktopFeed='https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml';
// A Desktop prerelease can ship before its exact SDK appears on npm. The
// signed Desktop feed remains the release source; verify its exact package
// manifest from the corresponding official source tag instead of guessing.
const releaseTag='https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// These contracts intentionally enumerate validated prereleases. Never bypass
// Host admission or silently widen compatibility after an upstream release.
export function validateCompatibility(metadata,version,verified=matrixVersions){
 if(!Array.isArray(verified)||!verified.length||verified.length>20||new Set(verified).size!==verified.length||verified.some(v=>typeof v!=='string'||!/^0\.\d+\.\d+-(?:rc|alpha)\.\d+$/.test(v)))throw Error('Invalid SDK matrix');
 const listed=range=>typeof range==='string'?range.split(/\s*\|\|\s*/).sort():[];
 const exact=range=>JSON.stringify(listed(range))===JSON.stringify([...verified].sort());
 if(!exact(metadata.engines?.dsh)||sdkPeers.some(name=>!exact(metadata.peerDependencies?.[name])))throw Error('Host and all SDK peers must exactly match the tested matrix');
 // Development dependencies are intentionally single-version pins: they are
 // the local snapshot used by tests, not a second compatibility declaration.
 // Requiring them to equal the whole matrix would make every added prerelease
 // unbuildable, so only require an exact version that remains in the matrix.
 for(const [name,range] of Object.entries(metadata.devDependencies??{})){
  if(!name.startsWith('@deepseek-ai/dsh-'))continue;
  if(typeof range!=='string'||!/^0\.\d+\.\d+-(?:rc|alpha)\.\d+$/.test(range))throw Error('SDK development dependencies must pin one exact version: '+name);
  if(!verified.includes(range))throw Error('SDK development dependency is outside the tested matrix: '+name+' '+range);
 }
 if(!verified.includes(version))throw Error('Official version is absent from the tested matrix: '+version);
 if(!/^0\.\d+\.\d+-(?:rc|alpha)\.\d+$/.test(version))throw Error('Invalid exact SDK version');
 const admits=range=>typeof range==='string'&&range.split(/\s*\|\|\s*/).includes(version);
 if(!admits(metadata.engines?.dsh))throw Error('Latest official SDK is outside validated host compatibility: '+version);
 for(const [name,range] of Object.entries(metadata.peerDependencies??{}))if(name.startsWith('@deepseek-ai/dsh-')&&!admits(range))throw Error('Required peer is outside validated compatibility: '+name+' '+version);
 return version;
}
function desktopVersion(text){
 const versions=[];
 for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!line.trim()||/^[ \t#]/.test(line))continue;
  const field=/^(?:([A-Za-z_][A-Za-z0-9_-]*)|(["'])(version)\2)[ \t]*:[ \t]*(.*)$/.exec(line);
  if(!field)throw Error('Unsupported Desktop feed top-level syntax');
  if((field[1]??field[3])==='version')versions.push(field[4]);
 }
 if(versions.length!==1)throw Error('Desktop feed needs exactly one top-level version');
 const scalar=/^(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:[ \t]+#[^\r\n]*)?[ \t]*$/.exec(versions[0]);
 const version=scalar?.slice(1).find(value=>value!==undefined);
 if(!/^0\.\d+\.\d+-(?:rc|alpha)\.\d+$/.test(version??''))throw Error('Invalid exact Desktop version');
 return version;
}
export async function checkOfficialVersions(metadata,{fetchImpl=fetch}={}){
 const read=async(url,limit)=>{
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok){
   const error=Error('Official version lookup failed: '+response.status);
   error.status=response.status;
   throw error;
  }
  let text='';
  if(response.body?.getReader){
   const reader=response.body.getReader();let bytes=0;const decoder=new TextDecoder();
   try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw Error('Official metadata exceeds size limit');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
   finally{await reader.cancel().catch(()=>{});}
  }else{text=await response.text();if(Buffer.byteLength(text)>limit)throw Error('Official metadata exceeds size limit');}
  return text;
 };
 const [npmText,feed]=await Promise.all([read(registry,16*1024*1024),read(desktopFeed,256*1024)]);
 const sdkLatest=JSON.parse(npmText)['dist-tags']?.latest;
 const desktop=desktopVersion(feed);
 validateCompatibility(metadata,sdkLatest);validateCompatibility(metadata,desktop);
 let exact,desktopSdkSource='npm';
 try{
  exact=JSON.parse(await read(registry+'/'+encodeURIComponent(desktop),1024*1024));
 }catch(error){
  if(error.status!==404)throw error;
  desktopSdkSource='github-release-tag';
  exact=JSON.parse(await read(releaseTag+encodeURIComponent(desktop)+'/apps/cli/package.json',1024*1024));
 }
 if(exact.name!=='@deepseek-ai/dsh'||exact.version!==desktop)throw Error('Desktop SDK metadata mismatch');
 if(typeof exact.engines?.node!=='string'||!exact.engines.node)throw Error('Desktop SDK Node requirement missing');
 return {sdkLatest,desktopVersion:desktop,desktopSdkVersion:exact.version,desktopNodeRequirement:exact.engines.node,desktopSdkSource,desktopFeed,compatibilityOverride:false};
}
async function main(){
 const metadata=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
 let version=process.argv[2];
 if(version==='--matrix'){validateCompatibility(metadata,matrixVersions.at(-1));console.log(JSON.stringify({sdk:matrixVersions}));return;}
 if(version==='--latest'){
  console.log(JSON.stringify(await checkOfficialVersions(metadata)));return;
 }
 validateCompatibility(metadata,version);console.log(JSON.stringify({supportedOfficialVersion:version,compatibilityOverride:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
