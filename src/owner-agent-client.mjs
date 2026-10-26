/** Browser-side adapter for the authenticated local Owner surface.
 * Uses the official workspace/session Remote APIs, retaining Host tools and
 * approvals. It must never be exposed to a family member's channel handler.
 * Durable session/request identities belong to the calling Owner workbench.
 */
export function createOwnerAgentClient({ remote, timeoutMs = 30_000 } = {}) {
  const fail = code => Object.assign(new Error(code), { code });
  const admissions = new Map(), admissionTails = new Map();
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const absolute = path => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(path) && (/^\//u.test(path) || /^[A-Za-z]:[\\/]/u.test(path));
  const unwrap = value => { if (value?.ok !== true) throw fail('owner_agent_remote_failed'); return value.value; };
  const method = (namespace, name) => {
    if (typeof remote?.[namespace]?.[name] !== 'function') throw fail('owner_agent_unavailable');
    return remote[namespace][name].bind(remote[namespace]);
  };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fail('owner_agent_invalid_timeout');
  async function bounded(fn, signal) {
    if (signal?.aborted) throw fail('owner_agent_cancelled');
    const controller = new AbortController(); let timer, abort;
    try {
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fail('owner_agent_unknown')); }, timeoutMs);
        abort = () => { controller.abort(); reject(fail('owner_agent_cancelled')); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), expired]);
    } catch (error) {
      if (typeof error?.code === 'string' && /^owner_agent_[a-z_]+$/u.test(error.code)) throw fail(error.code);
      throw fail('owner_agent_remote_failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  function validateIntent(intent) {
    if (!intent || typeof intent !== 'object' || typeof intent.workspaceId !== 'string' || !intent.workspaceId || intent.workspaceId.length > 240 ||
        !absolute(intent.cwd) || typeof intent.sessionId !== 'string' || !intent.sessionId.startsWith('family_owner_') || !uuid.test(intent.sessionId.slice(13)) ||
        typeof intent.requestId !== 'string' || !uuid.test(intent.requestId) ||
        intent.conversationId !== undefined && (typeof intent.conversationId !== 'string' || !uuid.test(intent.conversationId) || intent.sessionId !== 'family_owner_' + intent.conversationId)) throw fail('owner_agent_invalid_intent');
  }
  function workspaceView(row) {
    if (!row || typeof row.workspaceId !== 'string' || !row.workspaceId || !absolute(row.path) || !Array.isArray(row.sessionIds) || row.sessionIds.some(id => typeof id !== 'string')) throw fail('owner_agent_registry_invalid');
    return { workspaceId: row.workspaceId, path: row.path, title: typeof row.title === 'string' ? row.title.slice(0, 240) : row.workspaceId, sessionIds: [...row.sessionIds] };
  }
  async function listWorkspaces({ signal } = {}) {
    return bounded(async innerSignal => {
      const iterator = method('workspace', 'follow')(innerSignal)[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        if (first.done || first.value?.type !== 'baseline' || !Array.isArray(first.value.value?.items)) throw fail('owner_agent_registry_invalid');
        return first.value.value.items.map(workspaceView);
      } finally { void Promise.resolve(iterator.return?.()).catch(() => {}); }
    }, signal);
  }
  async function addWorkspace(path, { signal } = {}) {
    if (!absolute(path)) throw fail('owner_agent_invalid_path');
    const result = unwrap(await bounded(() => method('workspace', 'create')({ path }), signal));
    return workspaceView(result?.workspace);
  }
  async function pickWorkspace({ signal } = {}) {
    const path = unwrap(await bounded(innerSignal => method('directoryPicker', 'pick')(innerSignal), signal));
    return path === null ? null : addWorkspace(path, { signal });
  }
  async function requireWorkspace(intent, signal, requireMembership = true) {
    const rows = await listWorkspaces({ signal }), row = rows.find(item => item.workspaceId === intent.workspaceId);
    if (!row || row.path !== intent.cwd || requireMembership && !row.sessionIds.includes(intent.sessionId)) throw fail('owner_agent_identity_mismatch');
    return row;
  }
  function observation(intent, snapshot, records) {
    // These are official Host-authored context messages, not new requests.
    // Unknown producers remain unowned; do not infer authority from user role.
    const contextSources = new Set(['runtime-context', 'agent-instructions', 'compact-checkpoint', 'model-selection',
      'time-context', 'tmux-context', 'user-approval', 'working-directory', 'repeat-tool-reminder',
      'plan-mode', 'tool-registry', 'ptc-mode', 'skill-catalog', 'skill-invocation', 'session-reference', 'tool-goal']);
    const events = [];
    for (const record of records) {
      const e = record?.event, d = e?.data;
      if (record?.type !== 'event' || !d) continue;
      if (!Number.isSafeInteger(e.seq) || e.seq < 0) throw fail('owner_agent_observation_invalid');
      if (e.type === 'turn/start' || e.type === 'turn/end') events.push({ type: e.type, seq: e.seq, turn: d.turn, ...(e.type === 'turn/end' ? { reason: d.reason?.kind ?? 'unknown' } : {}) });
      if (e.type === 'user/message') events.push({ type: e.type, seq: e.seq, requestId: d.source?.rpcId ?? null, sourceKind: d.source?.kind ?? 'unknown', callId: d.source?.callId });
      if (e.type === 'assistant/message') events.push({ type: e.type, seq: e.seq, turn: d.turn, text: (Array.isArray(d.message?.content) ? d.message.content : []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'), interrupted: d.interrupted === true });
      if (e.type === 'approval/asked' || e.type === 'approval/decided') events.push({ type: e.type, seq: e.seq, id: d.id });
      if (e.type === 'tool/call' || e.type === 'tool/ptc-dispatch-start' || e.type === 'tool/ptc-dispatch') events.push({ type: e.type, seq: e.seq, turn: d.turn, name: d.name, callId: e.type === 'tool/call' ? d.callId : d.subCallId, status: e.type === 'tool/ptc-dispatch' ? d.isError ? 'failed' : 'completed' : 'running' });
      if (e.type === 'tool/result') events.push({ type: e.type, seq: e.seq, turn: d.turn, callId: d.message?.toolCallId, status: d.error || d.message?.isError ? 'failed' : 'completed' });
    }
    events.sort((a, b) => a.seq - b.seq);
    if (new Set(events.map(e => e.seq)).size !== events.length) throw fail('owner_agent_observation_invalid');
    let currentTurn = null, targetTurn = null, ending = null, activeTurn = null;
    const requests = new Map(), ownedTurns = new Set(), ownedQuestions = new Set(), unfinishedQuestions = new Map(), tools = new Map();
    for (const e of events) {
      if (e.type === 'turn/start') currentTurn = activeTurn = e.turn;
      if (e.turn === undefined) e.turn = currentTurn;
      if (e.type === 'user/message' && !contextSources.has(e.sourceKind)) {
        // Timed native questions may resume in the same or a later turn.
        // Only a reply to a question emitted by this request extends its chain.
        const linkedReply = e.sourceKind === 'user-question-reply' && typeof e.callId === 'string' && ownedQuestions.has(e.callId);
        if (linkedReply) unfinishedQuestions.delete(e.callId);
        const id = linkedReply ? intent.requestId : ['user', 'owner'].includes(e.sourceKind) ? e.requestId : null;
        const ids = requests.get(currentTurn) ?? new Set(); ids.add(id); requests.set(currentTurn, ids);
        if (id === intent.requestId && currentTurn !== null) { ownedTurns.add(currentTurn); targetTurn = currentTurn; }
      }
      if (e.type === 'tool/call' || e.type === 'tool/ptc-dispatch-start') tools.set(e.callId, e);
      if (e.name === 'ask_user_question' && typeof e.callId === 'string' && ownedTurns.has(e.turn)) {
        ownedQuestions.add(e.callId); unfinishedQuestions.set(e.callId, e.turn);
      }
      if (e.type === 'tool/result' || e.type === 'tool/ptc-dispatch') {
        unfinishedQuestions.delete(e.callId);
        const call = tools.get(e.callId);
        if (call) { call.status = e.status; e.name = call.name; }
      }
      if (e.type === 'turn/end' && e.turn === activeTurn) { activeTurn = null; currentTurn = null; }
    }
    const foreign = [...ownedTurns].some(turn => [...(requests.get(turn) ?? [])].some(id => id !== intent.requestId));
    const approvals = new Set();
    if (targetTurn !== null) for (const e of events) {
      if (e.type === 'turn/end' && e.turn === targetTurn) ending = e.reason;
      if (e.turn !== targetTurn || targetTurn !== activeTurn) continue;
      if (e.type === 'approval/asked') approvals.add(e.id);
      if (e.type === 'approval/decided') approvals.delete(e.id);
    }
    const values = snapshot.projections?.values ?? {};
    const activeQuestions = new Set((Array.isArray(values.userQuestions?.active) ? values.userQuestions.active : []).filter(item => ['open', 'continued'].includes(item.state) && ownedQuestions.has(item.callId)).map(item => item.callId));
    // The official legacy schema blocks inside the tool and intentionally has
    // no userQuestions projection. Its unreturned call is the durable evidence.
    for (const [callId, turn] of unfinishedQuestions) if (turn === activeTurn) activeQuestions.add(callId);
    const questions = activeQuestions.size;
    const inbox = ['next-turn', 'next-step'].flatMap(key => Array.isArray(values.inbox?.[key]) ? values.inbox[key] : []);
    const queued = inbox.some(item => item.source?.rpcId === intent.requestId || item.source?.kind === 'user-question-reply' && ownedQuestions.has(item.source.callId));
    let state = 'unknown';
    if (!foreign && targetTurn !== null) state = approvals.size ? 'needs_approval' : queued ? 'queued' : questions ? 'needs_input' : ending === 'completed' ? 'succeeded' : ['cancelled', 'aborted', 'interrupted'].includes(ending) ? 'cancelled' : ending ? 'failed' : 'running';
    else if (!foreign && queued) state = 'queued';
    const ownedEvents = foreign ? [] : events.filter(e => ownedTurns.has(e.turn));
    let budget = 24_000;
    for (const e of [...ownedEvents].reverse()) if (e.type === 'assistant/message') {
      const full = e.text; e.text = full.slice(0, budget); budget -= e.text.length;
      if (e.text.length < full.length) e.truncated = true;
    }
    const messages = ownedEvents.filter(e => e.type === 'assistant/message').map(e => ({ role: 'assistant', text: e.text, seq: e.seq, interrupted: e.interrupted, truncated: e.truncated === true }));
    return { workspaceId: intent.workspaceId, sessionId: intent.sessionId, requestId: intent.requestId, cwd: intent.cwd, state, events: ownedEvents, messages,
      text: messages.filter(item => !item.interrupted).at(-1)?.text ?? '', queued, requestSeen: events.some(e => e.type === 'user/message' && e.requestId === intent.requestId),
      turn: targetTurn, terminalReason: ending, pendingApprovals: approvals.size, questions, foreign,
      activeTurn, activeRequestIds: activeTurn === null ? [] : [...(requests.get(activeTurn) ?? [])], pendingInput: inbox.length > 0 };
  }
  async function readObservation(intent, { signal } = {}, admission = false) {
    validateIntent(intent); await requireWorkspace(intent, signal);
    return bounded(async innerSignal => {
      const iterator = method('session', 'follow')({ address: { kind: 'session', sessionId: intent.sessionId }, maxMessages: 128, turnWindow: { minMessages: 32, minTurns: 8 } }, innerSignal)[Symbol.asyncIterator]();
      try {
        const first = await iterator.next(), snapshot = first.value;
        if (first.done || snapshot?.type !== 'snapshot' || snapshot.header?.id !== intent.sessionId || snapshot.header?.cwd !== intent.cwd || !Array.isArray(snapshot.records)) throw fail('owner_agent_identity_mismatch');
        let records = snapshot.records, hasMore = snapshot.hasMore === true;
        const anchored = () => { let turn = null; for (const record of records) { const e = record?.event; if (record?.type !== 'event') continue; if (e?.type === 'turn/start') turn = e.data?.turn; if (e?.type === 'user/message' && e.data?.source?.rpcId === intent.requestId && turn !== null) return true; } return false; };
        const inbox = snapshot.projections?.values?.inbox ?? {};
        const pending = ['next-turn', 'next-step'].some(key => Array.isArray(inbox[key]) && inbox[key].some(item => item.source?.rpcId === intent.requestId));
        for (let page = 0; !admission && hasMore && !pending && !anchored() && page < 8; page++) {
          const seqs = records.filter(record => record.type === 'event').map(record => record.event?.seq).filter(Number.isSafeInteger);
          if (!seqs.length || !Number.isSafeInteger(snapshot.cursor)) throw fail('owner_agent_history_incomplete');
          const older = unwrap(await method('session', 'page')({ address: { kind: 'session', sessionId: intent.sessionId }, throughSeq: snapshot.cursor, beforeSeq: Math.min(...seqs), maxMessages: 128, turnWindow: { minMessages: 32, minTurns: 8 } }, innerSignal));
          if (!Array.isArray(older?.records) || !older.records.length) throw fail('owner_agent_history_incomplete');
          records = [...older.records, ...records]; hasMore = older.hasMore === true;
          if (records.length > 10_000) throw fail('owner_agent_history_incomplete');
        }
        if (!admission && hasMore && !pending && !anchored()) throw fail('owner_agent_history_incomplete');
        innerSignal.throwIfAborted(); return observation(intent, snapshot, records);
      } finally { void Promise.resolve(iterator.return?.()).catch(() => {}); }
    }, signal);
  }
  const observe = (intent, options) => readObservation(intent, options);
  function start(intent, { signal } = {}) {
    try {
      validateIntent(intent);
      if (typeof intent.prompt !== 'string' || !intent.prompt.trim() || intent.prompt.length > 64_000) throw fail('owner_agent_invalid_intent');
      if (signal?.aborted) throw fail('owner_agent_cancelled');
    } catch (error) { return Promise.reject(error); }
    // Capture values before waiting: callers cannot change a queued command.
    const captured = { workspaceId: intent.workspaceId, cwd: intent.cwd, sessionId: intent.sessionId, requestId: intent.requestId, prompt: intent.prompt, ...(intent.conversationId !== undefined ? { conversationId: intent.conversationId } : {}) };
    const key = captured.sessionId + ':' + captured.requestId, fingerprint = JSON.stringify(captured);
    const existing = admissions.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(fail('owner_agent_invalid_intent'));
    const previous = admissionTails.get(captured.sessionId) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(() => admit(captured, signal));
    const entry = { fingerprint, promise }; admissions.set(key, entry); admissionTails.set(captured.sessionId, promise);
    const cleanup = () => {
      if (admissions.get(key) === entry) admissions.delete(key);
      if (admissionTails.get(captured.sessionId) === promise) admissionTails.delete(captured.sessionId);
    };
    // Cleanup handles both outcomes without creating an unhandled rejection.
    void promise.then(cleanup, cleanup);
    return promise;
  }
  async function admit(intent, signal) {
    const workspace = await requireWorkspace(intent, signal, false);
    if (!workspace.sessionIds.includes(intent.sessionId)) {
      const created = unwrap(await bounded(() => method('session', 'create')({ workspaceId: intent.workspaceId, sessionId: intent.sessionId }), signal));
      if (created?.sessionId !== intent.sessionId) throw fail('owner_agent_identity_mismatch');
    }
    // Conversation admission only needs the current inbox/activity snapshot.
    // A fresh request cannot have a history anchor. The Host independently
    // deduplicates rpcId before followup; result reads still require an anchor.
    const before = await readObservation(intent, { signal }, intent.conversationId !== undefined);
    if (before.requestSeen || before.queued) return before;
    // Only the trusted Owner conversation entry may append another next-turn
    // request. Queue uses Host followup, never steering or approval decisions.
    if (intent.conversationId === undefined && (before.activeTurn !== null || before.pendingInput)) throw fail('owner_agent_busy');
    let admissionStarted = false, accepted;
    try {
      accepted = unwrap(await bounded(innerSignal => {
        const prompt = method('session', 'prompt'); admissionStarted = true;
        return prompt({ sessionId: intent.sessionId, requestId: intent.requestId, mode: 'queue', content: [{ type: 'text', text: intent.prompt }] }, innerSignal);
      }, signal));
    } catch (error) {
      if (admissionStarted && error.code === 'owner_agent_cancelled') throw fail('owner_agent_unknown');
      throw error;
    }
    if (accepted?.accepted !== true) throw fail('owner_agent_unknown');
    return { ...before, state: 'queued', queued: true, accepted: true };
  }
  async function cancel(intent, { signal } = {}) {
    await observe(intent, { signal });
    // Official cancel accepts only sessionId, so a new native turn can start
    // after this observation. Never represent that operation as request-owned.
    return { requiresNativeSession: true };
  }
  return { listWorkspaces, addWorkspace, pickWorkspace, start, observe, cancel };
}
