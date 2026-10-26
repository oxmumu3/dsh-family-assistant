import {localDate} from './brief.mjs';

/** Coarse factual progress, never prompts, note contents, paths or model results. */
export function buildServiceProgress({people=[],date,timeZone,tasks=[],presentations=[],toolRuns=[],requests=[],workflowRequests=[]}={}){
 const members=new Map(people.filter(person=>person.role==='elder').map(person=>[person.id,person]));
 const visible=new Set([...members.values()].filter(person=>['summary','full'].includes(person.shareWithOwner)).map(person=>person.id));
 const today=row=>{try{return localDate(row.updatedAt??row.createdAt,timeZone)===date;}catch{return false;}};
 const groups=new Map();
 const add=(personId,label)=>{if(!visible.has(personId))return;const counts=groups.get(personId)??new Map();counts.set(label,(counts.get(label)??0)+1);groups.set(personId,counts);};
 const projectLabels={succeeded:'项目已完成',failed:'项目未完成',needs_approval:'项目待审批',needs_input:'项目待补充信息',unknown:'项目结果待核对',running:'项目处理中',queued:'项目等待处理'};
 const pptLabels={api_accepted:'PPT文件接口已接收',ready:'PPT文件已生成',collecting:'PPT待补充材料',failed:'PPT未完成',uncertain:'PPT发送结果待核对',interrupted:'PPT制作已中断',generating:'PPT正在制作'};
 const toolLabels={succeeded:'工具已执行',failed:'工具未完成',uncertain:'工具结果待核对',running:'工具执行中'};
 for(const row of tasks)if(today(row)&&projectLabels[row.state])add(row.personId,projectLabels[row.state]);
 for(const row of presentations)if(today(row)&&pptLabels[row.status])add(row.personId,pptLabels[row.status]);
 for(const row of toolRuns)if(today(row)&&toolLabels[row.status])add(row.personId,toolLabels[row.status]);
 const lines=[];
 for(const[personId,counts]of groups)lines.push(`${members.get(personId).label}：${[...counts].map(([label,count])=>`${label} ${count} 项`).join('；')}。`);
 // These requests are explicitly forwarded; ordinary chat sharing stays separate.
 for(const person of members.values()){
  const open=requests.filter(row=>row.personId===person.id&&row.status==='open').length;
  const workflows=workflowRequests.filter(row=>row.personId===person.id&&row.status==='pending').length;
  if(open)lines.push(`${person.label}：${open} 件明确转达的事需要你回应。`);
  if(workflows)lines.push(`${person.label}：${workflows} 个新工具需求待你查看。`);
 }
 if(!lines.length)return'';
 const result=['办事进度与待处理'];
 for(const line of lines){if(result.join('\n').length+line.length>850){result.push('其余进度请到工作台查看。');break;}result.push(line);}
 return result.join('\n');
}
