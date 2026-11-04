import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnerTurn,ownerPolicyParagraphs,ownerPromptSection,OWNER_SECTION_NAME} from '../src/owner-prompt.mjs';

test('policy stays a fixed 13-paragraph block without per-turn content',()=>{
  const paragraphs=ownerPolicyParagraphs();
  assert.equal(paragraphs.length,13);
  assert.match(paragraphs[0],/乐乐对话交互版本/);
  assert.ok(paragraphs.every(row=>!row.includes('当前 Owner 请求原文')));
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
