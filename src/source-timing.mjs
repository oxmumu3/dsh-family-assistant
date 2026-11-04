// Classification only; not permission to schedule or send. A relative-time
// action must additionally check current user intent and its own idempotency.
export function sourceTimingState(value,now){
 if(!value||typeof value.receivedAt!=='string'||typeof value.providerCreatedAt!=='string'||typeof now!=='string')return 'unknown';
 const received=Date.parse(value.receivedAt),created=Date.parse(value.providerCreatedAt),current=Date.parse(now);
 if(![received,created,current].every(Number.isFinite)||created>received+5000||received>current+5000)return 'unknown';
 if(received-created>30000||current-received>30000)return 'stale';
 return 'fresh';
}
