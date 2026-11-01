import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateCompatibility} from '../scripts/compatibility.mjs';
const metadata=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
for(const version of ['0.2.1-rc.4','0.2.1-rc.5'])test('validated official SDK '+version,()=>assert.equal(validateCompatibility(metadata,version),version));
test('unknown official SDK fails closed',()=>assert.throws(()=>validateCompatibility(metadata,'0.2.1-rc.6'),/absent/));
test('drifting SDK peers fail closed',()=>{const altered=structuredClone(metadata);altered.peerDependencies['@deepseek-ai/dsh']='*';assert.throws(()=>validateCompatibility(altered,'0.2.1-rc.5'),/exactly match/);});
