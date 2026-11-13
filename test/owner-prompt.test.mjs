import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnerTurn,ownerPolicyParagraphs,ownerPromptSection,OWNER_SECTION_NAME} from '../src/owner-prompt.mjs';

test('policy stays a short fixed block without per-turn content',()=>{
  const paragraphs=ownerPolicyParagraphs();
  assert.equal(paragraphs.length,3);
  assert.match(paragraphs[0],/family_assistant/);
  assert.match(paragraphs[1],/统一发回微信/);
  assert.match(paragraphs[2],/乐乐推送背景/);
  assert.ok(paragraphs.every(row=>!row.includes('当前 Owner 请求原文')));
  assert.ok(paragraphs.every(row=>!row.includes('你就是乐乐')),'不再要求冒充乐乐');
  assert.ok(paragraphs.every(row=>!row.includes('ask_user_question')),'不再禁止向主人提问');
});

test('the push background sits between the policy and the verbatim request',()=>{
  const background='<<<乐乐推送背景：开始>>>\n- 要你转\n<<<乐乐推送背景结束>>>';
  const prompt=buildOwnerTurn({text:'转过了',background});
  assert.ok(prompt.indexOf(background)>prompt.indexOf('family_assistant'));
  assert.ok(prompt.indexOf(background)<prompt.indexOf('当前 Owner 请求原文：\n转过了'));
  assert.equal(buildOwnerTurn({text:'转过了',background:null}).includes('<<<乐乐推送背景：开始'),false,'没有推送就不加背景块');
});

test('the turn ends with the verbatim Owner request',()=>{
  const text='把妈妈今天的日报改成短一点';
  const prompt=buildOwnerTurn({text});
  assert.ok(prompt.endsWith('当前 Owner 请求原文：\n'+text));
  assert.ok(!prompt.includes('升级前的对话背景'));
  assert.throws(()=>buildOwnerTurn({text:''}));
});

test('legacy history is inserted only for pre-upgrade continuations',()=>{
  const prompt=buildOwnerTurn({text:'继续那件事',legacyHistory:[{role:'user',text:'上次'}]});
  assert.match(prompt,/升级前的对话背景/);
  assert.ok(prompt.endsWith('当前 Owner 请求原文：\n继续那件事'));
});

test('the section form carries the same policy text for a future flip',()=>{
  const section=ownerPromptSection(7);
  assert.equal(section.name,OWNER_SECTION_NAME);
  assert.equal(section.order,7);
  assert.equal(section.text,ownerPolicyParagraphs().join('\n\n'));
});
