import { timestamp, validTime, validTimeZone } from './store.mjs';

const formatters = new Map();
function formatter(timeZone) {
  validTimeZone(timeZone);
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
  }));
  return formatters.get(timeZone);
}
export function asInstant(now = new Date()) {
  const value = typeof now === 'function' ? now() : now;
  return timestamp(value instanceof Date ? value.toISOString() : value);
}
export function localParts(instant, timeZone) {
  const date = new Date(asInstant(instant));
  return Object.fromEntries(formatter(timeZone).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
export function localDate(instant, timeZone) {
  const parts = localParts(instant,timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期须为 YYYY-MM-DD');
  timestamp(`${date}T00:00:00Z`);
  return date;
}
export function addLocalDays(date, days) {
  validDate(date);
  if (!Number.isSafeInteger(days)) throw new Error('日期跨度无效');
  return new Date(Date.parse(`${date}T12:00:00Z`)+days*86400000).toISOString().slice(0,10);
}
/** Returns the first occurrence during fall-back; null for a nonexistent spring-forward wall time. */
export function localDateTimeToInstant(date, time, timeZone) {
  validDate(date); validTime(time); validTimeZone(timeZone);
  const target = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set();
  for (let hours=-36; hours<=36; hours+=6) {
    const instant=target+hours*3600000;
    const p=localParts(new Date(instant),timeZone);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-instant);
  }
  const matches=[];
  for(const offset of offsets) {
    const instant=new Date(target-offset).toISOString();
    const parts=localParts(instant,timeZone);
    if(`${parts.year}-${parts.month}-${parts.day}`===date && `${parts.hour}:${parts.minute}`===time) matches.push(instant);
  }
  return matches.sort()[0] ?? null;
}
const issueNames={failed:'接口拒绝',blocked:'发送受阻',uncertain:'结果未知',expired:'内容过期'};

/** A deterministic service ledger, not a health or wellbeing assessment. */
export function buildOwnerBrief(store,{date,now}={}) {
  const state=store.snapshot();
  const owner=state.people.find(p=>p.role==='owner');
  if(!owner) throw new Error('请先添加 Owner，再生成服务简报');
  const day=validDate(date??localDate(asInstant(now),owner.timeZone));
  const elders=state.people.filter(p=>p.role==='elder'&&p.shareWithOwner!=='none');
  const lines=[`${day} 家庭服务简报`];
  if(!elders.length) lines.push('暂无已开放分享的长辈服务记录。');
  for(const elder of elders) {
    const messages=state.messages.filter(m=>m.personId===elder.id&&localDate(m.at,owner.timeZone)===day);
    const inbound=messages.filter(m=>m.dir==='in');
    const outbound=messages.filter(m=>m.dir==='out');
    const active=state.reminders.filter(r=>r.personId===elder.id&&r.status==='active').length;
    const sends=state.outbox.filter(o=>o.personId===elder.id&&localDate(o.createdAt,owner.timeZone)===day);
    const acceptedReminders=sends.filter(o=>o.kind==='reminder'&&o.status==='api_accepted').length;
    const issues=Object.entries(issueNames).map(([status,label])=>{
      const count=sends.filter(o=>o.status===status).length;
      return count ? `${label} ${count} 条` : '';
    }).filter(Boolean);
    const binding=state.bindings.find(b=>b.personId===elder.id);
    if(!binding||binding.status!=='connected') issues.push('通路未连接');
    let section=`${elder.label}：对话收到 ${inbound.length} 条，发送接口已接收 ${outbound.length} 条；有效提醒 ${active} 项，今日提醒接口已接收 ${acceptedReminders} 条。`;
    section+=issues.length ? `\n服务问题：${issues.join('；')}。` : '\n今日记录中暂无发送异常。';
    if(elder.shareWithOwner==='full') {
      const excerpts=messages.slice(-3).map(m=>`${m.dir==='in'?'收到':'回复'}：${m.text.replace(/\s+/g,' ').slice(0,180)}`);
      if(excerpts.length) section+=`\n已授权完整记录（最近 ${excerpts.length} 条）：\n${excerpts.join('\n')}`;
    }
    if(lines.join('\n\n').length+section.length>2950) {lines.push('其他已授权成员的记录请在工作台查看。');break;}
    lines.push(section);
  }
  lines.push('以上仅为服务记录；接口接收状态不代表微信实际收信。');
  return {text:lines.join('\n\n'),personId:owner.id,sourceKey:`owner-brief:${owner.id}:${day}`};
}

export function buildElderDaily(store,personId,{date,now}={}) {
  const person=store.person(personId);
  if(person.role!=='elder') throw new Error('长辈日报只适用于长辈');
  const current=asInstant(now);
  const currentDay=localDate(current,person.timeZone);
  const day=validDate(date??currentDay);
  const weekday=new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',weekday:'long'}).format(new Date(`${day}T12:00:00Z`));
  const hour=Number(localParts(current,person.timeZone).hour);
  const greeting=hour>=5&&hour<12?'早上好':hour>=12&&hour<18?'下午好':'晚上好';
  const lines=[`${person.label}，${greeting}。${day===currentDay?`今天是 ${day}，${weekday}`:`这是 ${day} 的日报（${weekday}）`}。`];
  if(person.interests.length) lines.push(`你感兴趣的${person.interests.slice(0,3).join('、')}，今天也可以慢慢聊；想从哪件小事开始，随时告诉我。`);
  else lines.push('今天想聊什么，或需要记下一件事，都可以直接告诉我。');
  const snapshot=store.snapshot();
  const byOccurrence=new Map();
  for(const reminder of store.reminders(personId).filter(r=>!['cancelled','expired'].includes(r.status))) {
    if(localDate(reminder.dueAt,person.timeZone)===day) byOccurrence.set(`${reminder.id}:${reminder.dueAt}`,reminder);
    const prefix=`reminder:${reminder.id}:`;
    for(const queued of snapshot.outbox.filter(o=>o.personId===personId&&o.kind==='reminder'&&o.sourceKey.startsWith(prefix)&&o.status!=='cancelled')) {
      const dueAt=queued.sourceKey.slice(prefix.length);
      if(localDate(dueAt,person.timeZone)===day) byOccurrence.set(`${reminder.id}:${dueAt}`,{...reminder,dueAt});
    }
  }
  const reminders=[...byOccurrence.values()].sort((a,b)=>a.dueAt.localeCompare(b.dueAt));
  if(reminders.length) {
    lines.push(`${day===currentDay?'今天':day}已设置的提醒：`);
    for(const reminder of reminders) {
      const p=localParts(reminder.dueAt,person.timeZone);
      const line=`${p.hour}:${p.minute} ${reminder.text}`;
      if(lines.join('\n').length+line.length>2900) {lines.push('其余提醒可以回复“查看提醒”了解。');break;}
      lines.push(line);
    }
  } else lines.push(`${day===currentDay?'今天':day}暂时没有已设置的提醒。`);
  return {text:lines.join('\n'),personId:person.id,sourceKey:`elder-daily:${person.id}:${day}`};
}
