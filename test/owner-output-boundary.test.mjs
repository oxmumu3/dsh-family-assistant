// 最小输出边界：只去内部引用行/固定说明，以及同 Owner 同会话已展示过的 draft ID。
// 业务摘要、可读版本标记、普通文本和相似用户输入必须逐字保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import {stripOwnerServiceReference} from '../src/harness-gateway.mjs';

const marker='[family_assistant:service_draft]';
const draftId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const wire=id=>`${marker} ${JSON.stringify({action:'service_confirm',draftId:id,revision:1})}`;
const instruction='（内部引用：主人下一轮明确说“确认”时，原样用上面的 draftId 和 revision 调用 service_confirm；不要把这一行写进给主人的回复。）';
const reply='给小禾开通PPT 制作服务；使用已有 PPT 制作工作流。\n确认后保存。\n（草稿第 1 版）';

test('a known reference line and the fixed instruction are removed; business text stays',()=>{
 const before=`${reply}\n\n${wire(draftId)}\n${instruction}`;
 const after=stripOwnerServiceReference(before,{draftIds:[draftId]});
 assert.equal(after,reply);
 assert.ok(!after.includes(marker));assert.ok(!after.includes(draftId));
 assert.match(after,/草稿第 1 版/);
});

test('a reference to another session draft or an unrelated look-alike id is kept',()=>{
 const other='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
 for(const ids of [[],[other]]){
  const text=`进度：${wire(draftId)}`;
  const after=stripOwnerServiceReference(text,{draftIds:ids});
  assert.ok(after.includes(draftId),'未知 session 的标识不当内部引用删掉');
  assert.ok(after.includes(marker));
 }
});

test('ordinary text keeps everything except an exact known draft id',()=>{
 const text=`你说的是 ${draftId} 这件事吗？\n我记下了，晚点回你。`;
 assert.equal(stripOwnerServiceReference(text,{draftIds:[draftId]}),text.replace(draftId,''));
 // No marker and no instruction: only the exact known id may be removed.
 const plain='草稿第 2 版已经好了，随时可确认。';
 assert.equal(stripOwnerServiceReference(plain,{draftIds:[draftId]}),plain);
});

test('a mid-line reference keeps the surrounding model text',()=>{
 const text=`工具原文如下，我只说重点：${wire(draftId)} 这句之后还在。`;
 const after=stripOwnerServiceReference(text,{draftIds:[draftId]});
 assert.match(after,/工具原文如下，我只说重点/);
 assert.match(after,/这句之后还在/);
 assert.ok(!after.includes(marker));assert.ok(!after.includes(draftId));
});

test('a reply that is only internal wiring becomes empty',()=>{
 assert.equal(stripOwnerServiceReference(`${wire(draftId)}\n${instruction}`,{draftIds:[draftId]}),'');
 assert.equal(stripOwnerServiceReference(instruction,{draftIds:[draftId]}),'');
});

test('a marker with a known id but an unexpected payload is treated as model text',()=>{
 const text=`${marker} {"note":"manual"} 收尾`;
 assert.equal(stripOwnerServiceReference(text,{draftIds:[draftId]}),text);
});
