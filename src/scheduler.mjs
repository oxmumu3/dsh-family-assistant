import {recordMatchesBinding} from './store.mjs';
import { addLocalDays, asInstant, buildElderDaily, buildOwnerBrief, localDate, localDateTimeToInstant } from './brief.mjs';

export const CATCH_UP_MS = 120 * 60 * 1000;
const expiry = due => new Date(Date.parse(due)+CATCH_UP_MS+1).toISOString();
const eligible = (due, nowMs) => due !== null && nowMs>=Date.parse(due) && nowMs-Date.parse(due)<=CATCH_UP_MS;
function dailyCandidates(date,time,timeZone) {
  return [addLocalDays(date,-1),date].map(day=>({date:day,due:localDateTimeToInstant(day,time,timeZone)}));
}
function nextDailyAfter(reminder, instant) {
  const day=localDate(instant,reminder.timeZone);
  for(let offset=0;offset<370;offset++) {
    const candidate=localDateTimeToInstant(addLocalDays(day,offset),reminder.time,reminder.timeZone);
    if(candidate && Date.parse(candidate)>Date.parse(instant)) return candidate;
  }
  throw new Error('无法计算下次每日提醒时间');
}

/** Enqueues at most one occurrence per source key. It never performs transport effects. */
export function scheduleTick(store,{now}={}) {
  const state=store.snapshot();
  if(state.config.paused) return [];
  const instant=asInstant(now);
  const nowMs=Date.parse(instant);
  const newly=[];
  const known=new Set(state.outbox.map(o=>o.sourceKey));
  const bindingByPerson=new Map(state.bindings.map(b=>[b.personId,b]));
  const bound=new Set(bindingByPerson.keys());
  function enqueue(input) {
    if(!bound.has(input.personId)) return null;
    const record=store.enqueue(input);
    if(!known.has(record.sourceKey)) {known.add(record.sourceKey);newly.push(record);}
    return record;
  }
  for(const reminder of state.reminders.filter(r=>r.status==='active'&&recordMatchesBinding(r,bindingByPerson.get(r.personId)))) {
    if(Date.parse(reminder.dueAt)>nowMs) continue;
    let occurrence=reminder.dueAt;
    if(reminder.repeat==='daily') {
      const day=localDate(instant,reminder.timeZone);
      for(const candidate of dailyCandidates(day,reminder.time,reminder.timeZone)) {
        if(candidate.due && Date.parse(candidate.due)>=Date.parse(reminder.dueAt) && Date.parse(candidate.due)<=nowMs && Date.parse(candidate.due)>Date.parse(occurrence)) occurrence=candidate.due;
      }
    }
    if(eligible(occurrence,nowMs)) {
      const record=enqueue({
        personId:reminder.personId,text:`提醒：${reminder.text}`,kind:'reminder',
        sourceKey:`reminder:${reminder.id}:${occurrence}`,expiresAt:expiry(occurrence),
      });
      if(!record) continue; // A new explicit binding may become available inside this occurrence's window.
      if(reminder.repeat==='once') store.markReminder(reminder.id,{status:'completed'});
      else store.markReminder(reminder.id,{dueAt:nextDailyAfter(reminder,instant)});
    } else if(reminder.repeat==='once') store.markReminder(reminder.id,{status:'expired'});
    else store.markReminder(reminder.id,{dueAt:nextDailyAfter(reminder,instant)});
  }
  for(const person of state.people.filter(p=>p.role==='elder'&&p.dailyEnabled&&bound.has(p.id))) {
    const day=localDate(instant,person.timeZone);
    for(const candidate of dailyCandidates(day,person.dailyTime,person.timeZone)) {
      if(!eligible(candidate.due,nowMs)) continue;
      const daily=buildElderDaily(store,person.id,{date:candidate.date,now:instant});
      enqueue({...daily,kind:'elder_daily',expiresAt:expiry(candidate.due)});
    }
  }
  const owner=state.people.find(p=>p.role==='owner');
  if(owner&&state.config.ownerBriefEnabled&&bound.has(owner.id)) {
    const day=localDate(instant,owner.timeZone);
    for(const candidate of dailyCandidates(day,state.config.ownerBriefTime,owner.timeZone)) {
      if(!eligible(candidate.due,nowMs)) continue;
      enqueue({...buildOwnerBrief(store,{date:candidate.date,now:instant}),kind:'owner_brief',expiresAt:expiry(candidate.due)});
    }
  }
  return newly;
}
