import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import PptxGenJS from 'pptxgenjs';
import {zipSync,strToU8} from 'fflate';
import {createOwnerTaskArtifacts,createOwnerTaskArtifactScope,sanitizeOwnerTaskText} from '../src/owner-task-artifacts.mjs';
const taskId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'owner-task-artifacts-')));t.after(()=>rmSync(root,{recursive:true,force:true}));const ownerAgent={listWorkspaces:async()=>[{workspaceId:'project',path:root,title:'Synthetic project'}]};const reader=createOwnerTaskArtifacts({ownerAgent});const scope=createOwnerTaskArtifactScope({personId:'mom',taskId,requestId,cwd:root});mkdirSync(join(root,scope.relativeDirectory),{recursive:true});return{root,reader,scope,options:{workspaceId:'project',scope,authorize:()=>true}};}
test('only the per-request recipient output namespace is collected, read back and fingerprinted',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'source.md'),'Owner source');writeFileSync(join(f.root,f.scope.relativeDirectory,'稿件.md'),'合成稿件');
 const files=await f.reader.collect(f.options);assert.equal(files.length,1);assert.equal(files[0].name,'稿件.md');assert.equal(files[0].sha256,createHash('sha256').update('合成稿件').digest('hex'));assert.ok(files[0].relativePath.startsWith('family-output/mom/owner-task-'+taskId+'/'+requestId+'/'));
 const file=await f.reader.readArtifact({...f.options,relativePath:files[0].relativePath,expectedSha256:files[0].sha256});assert.equal(file.bytes.toString(),'合成稿件');assert.equal(file.mimeType,'text/markdown');assert.doesNotMatch(JSON.stringify(files),new RegExp(f.root));
});
test('plain recipient/source paths and arbitrary parent files cannot become native artifacts',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'secret.md'),'private source');
 for(const relativePath of ['secret.md','../secret.md','/etc/passwd','family-output/dad/result.md','family-output/mom/result.md'])await assert.rejects(f.reader.readArtifact({...f.options,relativePath}));
 await assert.rejects(f.reader.collect({...f.options,scope:{...f.scope,relativeDirectory:'family-output/mom'}}));
 await assert.rejects(f.reader.collect({...f.options,scope:{...f.scope,personId:'dad'}}));
});
test('links, credential content, binary text and oversized outputs reject without reading arbitrary data',async t=>{
 for(const mode of ['symlink','secret','binary','large']){const f=fixture(t),file=join(f.root,f.scope.relativeDirectory,'result.md');if(mode==='symlink'){writeFileSync(join(f.root,'outside.md'),'secret');symlinkSync(join(f.root,'outside.md'),file);}else writeFileSync(file,mode==='secret'?'api_key=sk-0123456789abcdefghijklmnop':mode==='binary'?Buffer.from([0xff,0xfe,0x00]):'x'.repeat(131073));await assert.rejects(f.reader.collect(f.options));}
});
test('publication revocation, cancellation and registry reassignment stop collection/readout',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,f.scope.relativeDirectory,'result.md'),'result');await assert.rejects(f.reader.collect({...f.options,authorize:()=>false}));const controller=new AbortController();controller.abort();await assert.rejects(f.reader.collect({...f.options,signal:controller.signal}));
 const other=realpathSync(mkdtempSync(join(tmpdir(),'owner-task-other-')));t.after(()=>rmSync(other,{recursive:true,force:true}));const reader=createOwnerTaskArtifacts({ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',path:other}]}});await assert.rejects(reader.collect(f.options));
});
test('file mutation after collection is rejected by expected readback identity',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,f.scope.relativeDirectory,'result.txt'),'first');const files=await f.reader.collect(f.options);writeFileSync(join(f.root,f.scope.relativeDirectory,'result.txt'),'second');await assert.rejects(f.reader.readArtifact({...f.options,relativePath:files[0].relativePath,expectedSha256:files[0].sha256}));
});
test('Owner native delivery text removes local path references and never forwards credential-looking content',()=>{
 const result=sanitizeOwnerTaskText('写好了，见 /Users/synthetic/project/family-output/mom/result.md 和 file:///tmp/native.md。',{cwd:'/Users/synthetic/project'});assert.doesNotMatch(result,/Users|file:\/\/|\/tmp/);assert.match(result,/写好了/);const generic=sanitizeOwnerTaskText('见 /Volumes/disk/project/file.md 及 /opt/local/notes.md，来源 https://example.com/news/article');assert.doesNotMatch(generic,/Volumes|\/opt/);assert.match(generic,/https:\/\/example.com\/news\/article/);
 assert.doesNotMatch(sanitizeOwnerTaskText('这是秘密 api_key=sk-0123456789abcdefghijklmnop'),/sk-0123/);
});
test('a real generated PPTX is collected and delivered as the identical bytes and digest',async t=>{
 const f=fixture(t),deck=new PptxGenJS();deck.addSlide().addText('合成家庭演示文稿');const bytes=await deck.write({outputType:'nodebuffer'});writeFileSync(join(f.root,f.scope.relativeDirectory,'文稿.pptx'),bytes);
 const files=await f.reader.collect(f.options);assert.equal(files.length,1);const artifact=await f.reader.readArtifact({...f.options,relativePath:files[0].relativePath,expectedSha256:files[0].sha256});assert.deepEqual(artifact.bytes,bytes);assert.equal(artifact.mimeType,'application/vnd.openxmlformats-officedocument.presentationml.presentation');assert.equal(artifact.sha256,createHash('sha256').update(bytes).digest('hex'));
});
const officeBytes=(kind,extra={})=>{const mains={docx:['word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml','w:document','http://schemas.openxmlformats.org/wordprocessingml/2006/main'],xlsx:['xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','workbook','http://schemas.openxmlformats.org/spreadsheetml/2006/main']},[main,type,tag,ns]=mains[kind];return Buffer.from(zipSync(Object.fromEntries(Object.entries({'[Content_Types].xml':`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${type}"/></Types>`,'_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`,[main]:`<${tag} xmlns${tag.includes(':')?':w':''}="${ns}"/>`,...extra}).map(([name,value])=>[name,strToU8(value)]))));};
test('static DOCX/XLSX and PDF generated files have matching media types',async t=>{
 for(const [extension,bytes,mime]of [['docx',officeBytes('docx'),'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],['xlsx',officeBytes('xlsx'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],['pdf',Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),'application/pdf']]){const f=fixture(t);writeFileSync(join(f.root,f.scope.relativeDirectory,'result.'+extension),bytes);const [file]=await f.reader.collect(f.options);const result=await f.reader.readArtifact({...f.options,relativePath:file.relativePath});assert.equal(result.mimeType,mime);assert.deepEqual(result.bytes,bytes);}
});
test('disguised binaries, mismatched Office formats, active packages and ZIP expansion bombs reject',async t=>{
 const cases=[['pptx',Buffer.from('This is not a PPTX')],['pptx',officeBytes('docx')],['docx',officeBytes('docx',{'word/vbaProject.bin':'malicious'})],['docx',officeBytes('docx',{'word/_rels/document.xml.rels':'<Relationships><Relationship TargetMode="External" Target="file:///private/secret"/></Relationships>'})],['docx',officeBytes('docx',{'../outside.xml':'outside'})],['docx',officeBytes('docx',{'word/large.xml':'x'.repeat(33*1024*1024)})],['pdf',Buffer.from('%PDF-1.7\n/JavaScript (bad)\n%%EOF')],['pdf',Buffer.from('not a PDF')]];
 for(const[extension,bytes]of cases){const f=fixture(t);writeFileSync(join(f.root,f.scope.relativeDirectory,'result.'+extension),bytes);await assert.rejects(f.reader.collect(f.options));}
});
test('binary output limits remain separate from the existing 128 KiB text limit',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,f.scope.relativeDirectory,'large.pdf'),Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(10*1024*1024)]));await assert.rejects(f.reader.collect(f.options),/too_large/);
});
test('forged ZIP size claims, excessive entry counts and XML-escaped external targets reject',async t=>{
 const falseSize=officeBytes('docx'),central=falseSize.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));falseSize.writeUInt32LE(0,central+24);const local=falseSize.readUInt32LE(central+42);falseSize.writeUInt32LE(0,local+22);
 const many=officeBytes('docx');many.writeUInt16LE(1025,many.length-14);many.writeUInt16LE(1025,many.length-12);
 for(const bytes of [falseSize,many,officeBytes('docx',{'word/_rels/document.xml.rels':'<Relationships><Relationship TargetMode="&#69;xternal" Target="file:///private/secret"/></Relationships>'}),officeBytes('docx',{'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><oops></w:document>'})]){const f=fixture(t);writeFileSync(join(f.root,f.scope.relativeDirectory,'result.docx'),bytes);await assert.rejects(f.reader.collect(f.options));}
});
