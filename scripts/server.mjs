#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {startLocalServer} from '../src/server.mjs';
const{values}=parseArgs({options:{port:{type:'string',default:'3891'},state:{type:'string'}}});
const port=Number(values.port);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('无效端口');
const runtime=createRuntime({directory:resolve(values.state??join(homedir(),'.local','share','dsh-family-assistant'))});
const local=await startLocalServer({runtime,port});
console.log('家庭助手本地工作台（模型请在 Harness 插件内使用）');console.log(local.url);
let closing=false;const close=async()=>{if(closing)return;closing=true;await local.close();await runtime.close();};
process.once('SIGINT',()=>close().then(()=>process.exit()));process.once('SIGTERM',()=>close().then(()=>process.exit()));
