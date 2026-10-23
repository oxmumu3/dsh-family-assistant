'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const forms = ['add-person', 'preferences', 'add-reminder', 'send-message', 'brief-schedule', 'service-settings', 'verify-login'];
  const statusText = { connected: '已连接', connecting: '连接中', awaiting_scan: '等待扫码', scanned: '等待手机确认', expired: '二维码已过期', disconnected: '未连接', error: '连接异常', need_verification: '需要验证码' };
  const deliveryText = { pending: '等待发送', dispatching: '正在提交', api_accepted: '接口已接收', failed: '发送失败', blocked: '发送受阻', uncertain: '发送结果不明', cancelled: '已取消', expired: '已过期' };
  const ownerCommandText = { pending: '等待执行', scheduled: '已创建提醒', api_accepted: '发送接口已接收', failed: '执行未完成', uncertain: '发送结果未知', cancelled: '操作已取消' };
  let state = null;
  let selectedId = null;
  let busy = false;
  let reading = false;
  let requestVersion = 0;
  let reminderSignature = '';
  let historySignature = '';
  let ownerCommandSignature = '';
  let modelSignature = '';
  let previousQr = '';
  let qrObjectUrl = null;
  let qrLoadVersion = 0;
  const personButtons = new Map();
  let voiceBridge = null, voiceUnsubscribe = null, voiceAttempt = null, voiceRevision = 0, voiceOpened = false;
  let voiceSnapshot = { phase: 'unavailable', message: '请在 Harness 中打开家庭助手，即可使用语音输入。' };
  const voiceActive = () => ['checking','requesting','recording','transcribing'].includes(voiceSnapshot.phase);
  const selectedPerson = () => state?.people?.find(person => person.id === selectedId);
  const text = (id, value) => { $(id).textContent = value ?? ''; };
  const show = (id, visible) => { $(id).hidden = !visible; };
  const notify = value => { for (const id of ['notice','drawer-notice']) { text(id, value); show(id, Boolean(value)); } show('notice-toast', Boolean(value)); };
  const fail = value => { for (const id of ['error','drawer-error']) { text(id, value); show(id, Boolean(value)); } };
  const localDate = (value, zone) => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return '时间待确认';
    try { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: zone || undefined }).format(new Date(value)); }
    catch { return new Date(value).toLocaleString('zh-CN'); }
  };
  function node(tag, content, className) {
    const element = document.createElement(tag);
    if (content != null) element.textContent = content;
    if (className) element.className = className;
    return element;
  }
  function empty(list, value) { list.append(node('li', value, 'empty-list')); }
  function setValue(id, value) { $(id).value = value ?? ''; if (id === 'owner-input') voiceRevision++; }
  function safeStatus(person) {
    const binding = person?.binding || {};
    return binding.phase === 'need_verification' ? 'need_verification' : binding.status || binding.phase || 'disconnected';
  }
  function connected(person) { return Boolean(person?.binding?.connected || safeStatus(person) === 'connected'); }
  function canReadHistory(person) { return person?.role === 'owner' || person?.shareWithOwner === 'full'; }
  function validZone(value) {
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(); return Boolean(value); }
    catch { return false; }
  }
  async function request(body, personId = selectedId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), body?.action === 'owner_chat' ? 90000 : 20000);
    try {
      const url = '/family/api' + (!body && personId ? '?personId=' + encodeURIComponent(personId) : '');
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', 'X-Family-Action': '1', Accept: 'application/json' } : { Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      let value;
      try { value = await response.json(); } catch { throw new Error('服务暂时没有返回可读状态，请稍后刷新。'); }
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '这次操作未完成，请稍后再试。');
      if (!value || !Array.isArray(value.people) || !value.config) throw new Error('服务状态暂不可用，请稍后刷新。');
      return value;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(body ? '操作等待超时，结果暂不确定。未自动重试，请刷新后核对。' : '读取状态超时，请稍后刷新。');
      if (error instanceof TypeError || error.name === 'TypeError') throw new Error(body ? '连接中断，操作结果暂不确定。未自动重试，请刷新后核对。' : '暂时连接不到家庭助手，请确认宿主仍在运行。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function updateButtons() {
    const person = selectedPerson();
    const owner = state?.people?.find(value => value.role === 'owner');
    for (const button of document.querySelectorAll('button')) button.disabled = busy || !state;
    for (const button of personButtons.values()) button.disabled = busy;
    $('refresh').disabled = busy || reading;
    $('run-toggle').disabled = busy || !state;
    $('preview-brief').disabled = busy || !owner;
    $('send-brief').disabled = busy || !owner || !connected(owner) || state?.config?.paused !== false;
    $('send-message-button').disabled = busy || !connected(person) || state?.config?.paused !== false;
    $('connect').disabled = busy || !person || connected(person);
    $('disconnect').disabled = busy || !person || ['disconnected', 'expired'].includes(safeStatus(person));
    $('login').disabled = busy || !person;
    $('add-role').options[0].disabled = Boolean(owner);
    if (owner && $('add-role').value === 'owner') $('add-role').value = 'elder';
    for (const id of ['nav-chat','nav-family','nav-inbox','nav-activity','drawer-close','settings-open','brief-open','context-clear']) $(id).disabled = !state;
    $('drawer-close').disabled = false;
    $('notice-dismiss').disabled = false;
    $('owner-input').disabled = !state || !owner;
    $('send-owner').disabled = busy || voiceActive() || !owner || !$('owner-input').value.trim() || Boolean(activeContext && !contextLabel(activeContext));
    $('request-send').disabled = busy || !activeRequestId;
    document.body.setAttribute('aria-busy', String(busy));
    renderVoiceControls();
  }
  function loadPreferences(person) {
    setValue('person-label', person.label);
    setValue('person-zone', person.timeZone);
    setValue('person-interests', (person.interests || []).join('、'));
    setValue('person-notes', person.notes);
    setValue('daily-time', person.dailyTime || '08:00');
    $('daily-enabled').checked = Boolean(person.dailyEnabled);
    setValue('person-sharing', person.shareWithOwner || 'none');
    $('share-consent').checked = false;
    $('preferences').dataset.dirty = '';
    text('preferences-draft', '');
    syncConsent();
  }
  function syncConsent() {
    const needsConsent = $('person-sharing').value !== 'none';
    show('consent-row', needsConsent);
    $('share-consent').required = needsConsent && selectedPerson()?.role === 'elder';
  }
  function renderPeople() {
    const people = state.people;
    show('people-empty', people.length === 0);
    const ids = new Set(people.map(person => person.id));
    for (const [id, button] of personButtons) if (!ids.has(id)) { button.remove(); personButtons.delete(id); }
    people.forEach(person => {
      let button = personButtons.get(person.id);
      if (!button) {
        button = node('button', null, 'person-button');
        button.type = 'button';
        const title = node('span'); title.append(node('span'), node('small'));
        button.append(title, node('span', null, 'person-state'));
        button.addEventListener('click', () => openPerson(person.id));
        personButtons.set(person.id, button);
        $('people-list').append(button);
      }
      button.firstChild.firstChild.textContent = person.label;
      button.firstChild.lastChild.textContent = person.role === 'owner' ? '简报接收人' : '长辈';
      button.lastChild.textContent = statusText[safeStatus(person)] || '状态待确认';
      button.setAttribute('aria-current', String(person.id === selectedId));
      button.setAttribute('aria-label', person.label + '，' + (statusText[safeStatus(person)] || '状态待确认'));
    });
  }
  function renderReminders(person) {
    const all = (state.reminders || []).filter(reminder => reminder.personId === person.id);
    const active = all.filter(reminder => !['cancelled', 'completed', 'sent', 'expired'].includes(reminder.status));
    text('reminder-count', active.length ? active.length + ' 项待提醒' : '');
    const signature = JSON.stringify([person.id, person.timeZone, active]);
    if (signature === reminderSignature) return;
    reminderSignature = signature;
    const list = $('reminder-list'); list.replaceChildren();
    if (!active.length) empty(list, '还没有待办提醒。也可以让家人在微信里直接说“提醒我……”');
    active.forEach(reminder => {
      const li = node('li'); const content = node('div');
      content.append(node('p', reminder.text), node('p', localDate(reminder.dueAt, person.timeZone) + (reminder.repeat === 'daily' ? ' · 每天重复' : ' · 仅一次') + ' · 家人当地时间', 'meta'));
      const cancel = node('button', '取消'); cancel.type = 'button';
      cancel.setAttribute('aria-label', '取消提醒：' + reminder.text);
      cancel.addEventListener('click', () => mutate({ action: 'cancel_reminder', personId: person.id, reminderId: reminder.id }, { notice: '提醒已取消。' }));
      li.append(content, cancel); list.append(li);
    });
  }
  function renderHistory(person) {
    const allowed = canReadHistory(person);
    const messages = allowed ? (state.messages || []).filter(message => !message.personId || message.personId === person.id) : [];
    const outbox = (state.outbox || []).filter(item => item.personId === person.id);
    const signature = JSON.stringify([person.id, allowed, messages, outbox]);
    const count = person.messageCount ?? person.counts?.messages;
    text('history-count', Number.isFinite(count) ? count + ' 条服务记录' : '');
    text('history-privacy', person.role === 'owner' ? '你自己的聊天与服务记录' : allowed ? '本人已授权完整记录分享。这里展示可读取的最近聊天。' : person.shareWithOwner === 'summary' ? '当前仅分享服务摘要，不展示聊天原文。' : '当前不分享聊天记录。需先向本人说明并获得同意，才能开放记录。');
    if (signature === historySignature) return;
    historySignature = signature;
    const list = $('history-list'); list.replaceChildren();
    if (allowed && !messages.length) empty(list, '暂时没有可展示的聊天记录。');
    messages.slice(-50).forEach(message => {
      const li = node('li'); li.dataset.dir = message.dir;
      li.append(node('p', (message.dir === 'in' ? person.label : '家庭助手') + ' · ' + localDate(message.at, person.timeZone), 'meta'), node('p', message.text || '', 'message'));
      list.append(li);
    });
    const issues = outbox.filter(item => ['uncertain', 'failed', 'blocked'].includes(item.status)).slice(-5);
    issues.forEach(item => {
      const li = node('li');
      li.append(node('p', (deliveryText[item.status] || '状态待确认') + ' · ' + localDate(item.createdAt, person.timeZone), 'meta'), node('p', item.status === 'uncertain' ? '这次发送结果不明，系统不会自动重发，请由本人核对手机。' : '有一条服务消息未能确认发送，请检查连接。', 'message'));
      list.append(li);
    });
  }
  function renderOwnerCommands(person) {
    const visible = person.role === 'owner';
    show('owner-command-section', visible);
    const list = $('owner-command-list');
    if (!visible) { ownerCommandSignature = ''; list.replaceChildren(); text('owner-command-count', ''); return; }
    const commands = (Array.isArray(state.ownerCommands) ? state.ownerCommands : []).filter(command => command.requestedBy === person.id);
    text('owner-command-count', commands.length ? commands.length + ' 条指令' : '');
    const signature = JSON.stringify([person.id, person.timeZone, state.people.map(value => [value.id, value.label]), commands.map(command => [command.requestedBy, command.targetPersonId, command.action, command.status, command.deliveryStatus, command.createdAt, command.detail])]);
    if (signature === ownerCommandSignature) return;
    ownerCommandSignature = signature; list.replaceChildren();
    if (!commands.length) empty(list, '还没有微信指令记录。你可以在微信里指定一位家人，请助手发日报或安排提醒。时间按目标家人当地时间理解；成员或时间不明确时会先询问。');
    commands.slice(-30).reverse().forEach(command => {
      const requestedBy = state.people.find(value => value.id === command.requestedBy);
      const target = state.people.find(value => value.id === command.targetPersonId);
      const action = command.action === 'send_daily' ? '发送今天的日报' : command.action === 'remind' ? '安排提醒' : '家庭服务';
      const status = ownerCommandText[command.status] || '状态待确认';
      const content = node('div');
      content.append(node('p', action + ' · ' + (target?.label || '长辈待确认')),
        node('p', (requestedBy?.label || 'Owner') + '发起 · ' + localDate(command.createdAt, person.timeZone) + ' · ' + status, 'meta'));
      if (command.deliveryStatus) content.append(node('p', '消息发送：' + (deliveryText[command.deliveryStatus] || '状态待确认'), 'meta'));
      const li = node('li'); li.append(content); list.append(li);
    });
  }
  async function loadQr(personId, key) {
    const version = ++qrLoadVersion;
    if (qrObjectUrl) { URL.revokeObjectURL(qrObjectUrl); qrObjectUrl = null; }
    $('qr-image').removeAttribute('src');
    try {
      const response = await fetch('/family/qr.svg?personId=' + encodeURIComponent(personId), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'image/svg+xml' } });
      if (!response.ok) throw new Error('qr unavailable');
      const blob = await response.blob();
      if (version !== qrLoadVersion || selectedId !== personId || previousQr !== key) return;
      qrObjectUrl = URL.createObjectURL(blob); $('qr-image').src = qrObjectUrl;
    } catch {
      if (version === qrLoadVersion) { previousQr = ''; text('qr-caption', '二维码暂时未能载入，请刷新状态或重新生成。'); }
    }
  }
  function renderPerson({ load = false } = {}) {
    const person = selectedPerson();
    show('welcome', !person); show('person-detail', Boolean(person));
    if (!person) return;
    text('person-name', person.label);
    text('person-role', person.role === 'owner' ? '简报接收人' : '长辈的日常陪伴');
    const status = safeStatus(person);
    text('connection-badge', statusText[status] || '状态待确认'); $('connection-badge').dataset.state = status;
    const description = {
      connected: '已连接当前成员的微信。开始服务后可接收聊天和发送提醒。',
      awaiting_scan: '请本人用微信扫描下方二维码，并在手机上确认。',
      scanned: '手机已扫码，请在微信上完成确认。',
      need_verification: '请按微信提示完成验证，再提交验证码。',
      connecting: '正在恢复这位家人的独立连接，请稍候。',
      expired: '这个二维码已过期，可以重新生成。',
      disconnected: '尚未连接。为这位家人生成二维码，或恢复之前保存的连接。',
      error: '这位家人的连接遇到问题，请查看提示后恢复连接。',
    };
    text('connection-text', description[status] || '连接状态待确认，请刷新查看。');
    text('connection-error', person.binding?.lastError || ''); show('connection-error', Boolean(person.binding?.lastError));
    text('login', connected(person) ? '重新扫码绑定' : ['awaiting_scan', 'scanned', 'expired'].includes(status) ? '重新生成二维码' : '生成登录二维码');
    const qr = Boolean(person.binding?.qrUrl && ['awaiting_scan', 'scanned', 'connecting'].includes(status));
    show('qr-wrap', qr);
    const qrKey = qr ? person.id + ':' + person.binding.qrUrl : '';
    const qrChanged = qrKey !== previousQr;
    previousQr = qrKey;
    if (qrKey && qrChanged) void loadQr(person.id, qrKey);
    if (!qr) {
      ++qrLoadVersion; $('qr-image').removeAttribute('src');
      if (qrObjectUrl) { URL.revokeObjectURL(qrObjectUrl); qrObjectUrl = null; }
    }
    text('qr-caption', '仅用于连接 ' + person.label + ' 的微信');
    show('verify-login', status === 'need_verification');
    text('verification-prompt', person.binding?.prompt || '请输入微信页面提示的验证码。');
    show('elder-preferences', person.role === 'elder');
    if (load || !$('preferences').dataset.dirty) loadPreferences(person);
    text('message-label', '发送给 ' + person.label + ' 的内容');
    renderReminders(person); renderHistory(person); renderOwnerCommands(person);
  }
  function renderModelOptions() {
    const providers = state.model?.providers || [];
    const signature = JSON.stringify(providers);
    if (signature === modelSignature) return;
    modelSignature = signature;
    $('model-providers').replaceChildren(); $('model-names').replaceChildren();
    const seen = new Set();
    for (const provider of providers) {
      const id = typeof provider === 'string' ? provider : provider.id;
      if (id) { const option = node('option'); option.value = id; option.label = provider.name || id; $('model-providers').append(option); }
      for (const model of provider.models || []) {
        const modelId = typeof model === 'string' ? model : model.id;
        if (!modelId || seen.has(modelId)) continue; seen.add(modelId);
        const option = node('option'); option.value = modelId; option.label = model.name || modelId; $('model-names').append(option);
      }
    }
  }
  const tabTitles = {
    chat: ['家里的事，直接和我说。', '说清你的想法，我来整理、安排，带着结果回来。'],
    family: ['每个人，都按自己的节奏。', '资料可以继续补充。连接与分享范围，由本人分别确认。'],
    inbox: ['有些事，需要你的回应。', '这里只汇集家人同意转达的事项，每次回应都接在原来的事情里。'],
    activity: ['交代过的事，都接着往下走。', '查看当前安排、分别处理失败，结果不明的发送先核对。'],
  };
  const actionNames = {send_daily:'发送今天的日报',send_message:'发送消息',remind:'安排提醒',daily_schedule:'每日问候安排',cancel_reminder:'取消提醒',reply_request:'回应家人'};
  const actionStates = {draft:'待你确认',running:'正在执行',scheduled:'已安排',api_accepted:'发送接口已接收',failed:'明确失败',uncertain:'发送结果不明',cancelled:'已取消'};
  const cardStates = {draft:'待你确认',saved:'资料已保存',active:'正在跟进',completed:'处理已结束',cancelled:'已取消'};
  const requestStates = {open:'待你回应',waiting:'等待后续',resolved:'已结束跟进'};
  const storageKey = 'family-workbench-drafts-v1';
  let drafts = Object.create(null), attempts = Object.create(null), replyDrafts = Object.create(null), replyAttempts = Object.create(null);
  let activeTab = 'chat', activeContext = '', activeRequestId = '', drawerKind = '', lastFocus = null, workbenchSignature = '';
  function restoreDrafts() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey) || '{}');
      for (const [target, source] of [[drafts,saved.drafts],[replyDrafts,saved.replyDrafts]]) {
        for (const [key,value] of Object.entries(source || {}).slice(-50)) if (typeof value === 'string') target[key] = value.slice(0,4000);
      }
      for (const [target, source] of [[attempts,saved.attempts],[replyAttempts,saved.replyAttempts]]) {
        for (const [key,value] of Object.entries(source || {}).slice(-50)) if (typeof value?.id === 'string' && typeof value?.text === 'string') target[key] = {id:value.id.slice(0,160),text:value.text.slice(0,4000)};
      }
      if (typeof saved.activeContext === 'string') activeContext = saved.activeContext;
      if (Object.hasOwn(tabTitles,saved.activeTab)) activeTab = saved.activeTab;
    } catch { /* Draft storage is optional; the current text still stays in the composer. */ }
  }
  function persistDrafts() {
    try { window.sessionStorage.setItem(storageKey, JSON.stringify({drafts,attempts,replyDrafts,replyAttempts,activeContext,activeTab})); }
    catch { text('composer-storage','当前窗口无法保存草稿，请在离开页面前保留未发送文字。'); }
  }
  function keepDraft() { drafts[activeContext] = $('owner-input').value.slice(0,4000); persistDrafts(); }
  function newOperationId() { return globalThis.crypto?.randomUUID?.() || 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function attemptId(map, key, value) {
    if (map[key]?.text !== value) map[key] = {id:newOperationId(),text:value};
    persistDrafts(); return map[key].id;
  }
  function workbench() { return state?.workbench || {messages:[],cards:[],requests:[]}; }
  function contextLabel(id) {
    if (!id) return '';
    const colon = id.indexOf(':'); const kind = id.slice(0,colon), value = id.slice(colon+1);
    if (kind === 'card') return workbench().cards.find(card=>card.id===value)?.title || '';
    if (kind === 'person') return state?.people.find(person=>person.id===value)?.label || '';
    if (kind === 'request') { const item=workbench().requests.find(item=>item.id===value); return item ? '转达事项 · ' + (state.people.find(person=>person.id===item.personId)?.label || '家人') : ''; }
    return '';
  }
  function renderContext() {
    const label = contextLabel(activeContext);
    show('composer-context-strip',Boolean(activeContext));
    text('composer-context-label',activeContext ? '正在处理：' + (label || '此事项已不可用，请回到一般对话') : '');
  }
  function voiceContextKey() { return [state?.people?.find(person=>person.role==='owner')?.id || '',activeTab,activeContext].join('|'); }
  function cancelVoice() {
    voiceAttempt=null;voiceOpened=false;voiceBridge?.cancel();
    if(!voiceBridge){voiceSnapshot={phase:'unavailable',message:'请在 Harness 中打开家庭助手，即可使用语音输入。'};renderVoiceControls();}
  }
  function renderVoiceControls() {
    const phase=voiceSnapshot.phase,readiness=voiceSnapshot.readiness;
    const preparing=['installing','enabling','checking','downloading','loading','waking','cancelling'].includes(readiness?.phase);
    const setup=phase==='setup'||phase==='unavailable'||phase==='error'&&!readiness?.ready;
    const captured=phase==='transcript'&&Boolean(voiceSnapshot.transcript);
    const recording=phase==='recording';
    show('voice-panel',voiceOpened&&phase!=='idle');
    $('voice-panel').dataset.phase=phase;
    text('voice-status',voiceSnapshot.message || readiness?.message || (setup?'首次使用需准备本地语音模型。':'语音输入已就绪。'));
    text('voice-start-label',voiceActive()?'正在说话':phase==='error'?'重试语音':'说话');
    $('voice-start').disabled=busy||!state?.people?.some(person=>person.role==='owner')||voiceActive()||preparing;
    $('voice-start').setAttribute('aria-expanded',String(voiceOpened&&phase!=='idle'));
    show('voice-stop',recording);$('voice-stop').disabled=!recording;
    show('voice-time',recording);show('voice-level',recording);
    const seconds=Math.max(0,Math.floor(voiceSnapshot.elapsedSeconds||0));
    text('voice-time',Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'));
    $('voice-level').value=Math.max(0,Math.min(1,voiceSnapshot.level||0));
    show('voice-prepare',setup&&!preparing&&Boolean(voiceBridge));$('voice-prepare').disabled=busy||!voiceBridge||preparing;
    text('voice-prepare',phase==='unavailable'?'重新检查':readiness?.phase==='failed'?'重新准备':'下载并准备');
    show('voice-cancel-setup',preparing);$('voice-cancel-setup').disabled=readiness?.phase==='cancelling';
    show('voice-cancel',!preparing);$('voice-cancel').disabled=false;
    text('voice-cancel',captured?'舍弃这段文字':voiceActive()?'取消':'关闭');
    show('voice-transcript',captured);text('voice-transcript',captured?voiceSnapshot.transcript:'');
    show('voice-insert',captured);$('voice-insert').disabled=busy;
    let detail='';
    const progress=readiness?.providers?.[0]?.preparation;
    if(progress?.phase==='downloading'&&Number.isFinite(progress.completedBytes)){
      const mb=n=>(n/1024/1024).toFixed(1)+' MB';detail='已下载 '+mb(progress.completedBytes)+(Number.isFinite(progress.totalBytes)?' / '+mb(progress.totalBytes):'');
    }else if(setup&&!preparing){detail='识别在这台 Harness 主机上完成。首次需下载模型；准备好后，点「说话」即可录音。';}
    else if(recording){detail='最长 2 分钟；只转成文字，检查后再发送。';}
    show('voice-detail',Boolean(detail));text('voice-detail',detail);
  }
  function insertVoiceText(explicit=false) {
    const capture=voiceSnapshot.capture,transcript=voiceSnapshot.transcript,input=$('owner-input');
    if(!capture||!transcript||!voiceAttempt||capture.contextKey!==voiceContextKey())return false;
    if(!explicit&&(voiceAttempt.revision!==voiceRevision||input.value!==capture.draft)){
      voiceSnapshot={...voiceSnapshot,message:'草稿在识别期间有修改。文字已保留，你可以插入或舍弃。'};return false;
    }
    const start=explicit?(Number.isFinite(input.selectionStart)?input.selectionStart:input.value.length):capture.selectionStart;
    const end=explicit?(Number.isFinite(input.selectionEnd)?input.selectionEnd:start):capture.selectionEnd;
    const value=input.value.slice(0,start)+transcript+input.value.slice(end);
    if(value.length>4000){voiceSnapshot={...voiceSnapshot,message:'合并后超过 4000 字。请先精简草稿，再插入；识别文字已保留。'};return false;}
    setValue('owner-input',value);keepDraft();voiceAttempt=null;voiceOpened=false;voiceBridge?.cancel();
    text('composer-progress','语音已转成文字，请检查后点击发送。');input.focus();
    input.setSelectionRange?.(start+transcript.length,start+transcript.length);updateButtons();return true;
  }
  function receiveVoice(snapshot) {
    voiceSnapshot=snapshot;
    if(snapshot.phase==='transcript'){
      if(!voiceAttempt||snapshot.capture?.contextKey!==voiceContextKey())return;
      if(insertVoiceText())return;
    }
    if(voiceOpened&&snapshot.phase==='idle'&&snapshot.readiness?.ready){voiceOpened=false;text('composer-progress','语音已准备好，点「说话」开始。');}
    renderVoiceControls();updateButtons();
  }
  function initializeVoice() {
    try{voiceBridge=window.parent?.__FamilyVoice || null;}catch{voiceBridge=null;}
    if(!voiceBridge){renderVoiceControls();return;}
    voiceUnsubscribe=voiceBridge.subscribe(receiveVoice);
    voiceBridge.contextChanged(voiceContextKey());void voiceBridge.refresh();
  }
  async function startVoice() {
    if(busy||voiceActive())return;voiceOpened=true;
    if(!voiceBridge){renderVoiceControls();return;}
    const input=$('owner-input');voiceAttempt={revision:voiceRevision};
    const start=Number.isFinite(input.selectionStart)?input.selectionStart:input.value.length;
    const end=Number.isFinite(input.selectionEnd)?input.selectionEnd:start;
    await voiceBridge.start({contextKey:voiceContextKey(),draft:input.value,selectionStart:start,selectionEnd:end});
  }
  function setContext(id, {focus = true} = {}) {
    if((id||'')!==activeContext)cancelVoice();
    keepDraft(); activeContext = id || ''; setValue('owner-input',drafts[activeContext] || '');
    voiceBridge?.contextChanged(voiceContextKey());renderContext(); persistDrafts(); renderWorkbench(); updateButtons(); if (focus) $('owner-input').focus();
  }
  function setTab(tab) {
    if (!Object.hasOwn(tabTitles,tab)) return;
    const changed = activeTab !== tab;if(changed)cancelVoice();
    keepDraft(); activeTab = tab; workbenchSignature = ''; renderWorkbench(); updateButtons(); persistDrafts();
    voiceBridge?.contextChanged(voiceContextKey());
    if (changed) $('workspace').scrollTop = tab === 'chat' ? $('workspace').scrollHeight : 0;
  }
  function actionButton(label, callback, className='secondary') {
    const button=node('button',label,className);button.type='button';button.addEventListener('click',callback);return button;
  }
  function field(list,label,value) {
    if (value == null || value === '') return;
    const row=node('div',null,'field-row');row.append(node('dt',label),node('dd',Array.isArray(value)?value.join('、'):String(value)));list.append(row);
  }
  function statusPill(value,status) { const pill=node('span',value,'state-pill');pill.dataset.state=status;return pill; }
  function cardView(card) {
    const article=node('article',null,'result-card');article.dataset.cardId=card.id;article.dataset.active=String(activeContext==='card:'+card.id);
    const top=node('div',null,'card-top'), title=node('div');title.append(node('p',card.kind==='profile'?'家人资料':'服务安排','card-label'),node('h3',card.title || (card.kind==='profile'?'家人资料':'服务安排')));
    top.append(title,statusPill(cardStates[card.status] || '状态待确认',card.status));article.append(top);
    if (card.kind === 'profile') {
      const profile=card.profile || {}, fields=node('dl',null,'card-fields');
      field(fields,'称呼',profile.label);field(fields,'所在时区',profile.timeZone);field(fields,'喜欢的话题',profile.interests);field(fields,'陪伴偏好',profile.notes);article.append(fields);
      article.append(node('p','资料来自你的描述。连接微信与分享范围由本人另外确认。','card-note'));
    } else {
      for (const item of card.actions || []) {
        const section=node('section',null,'action-item');section.dataset.action=item.id;
        const actionTop=node('div',null,'action-top');actionTop.append(node('h4',(item.targetLabel || state.people.find(person=>person.id===item.personId)?.label || '对象待确认')+' · '+(actionNames[item.type] || '服务操作')),statusPill(actionStates[item.status] || '状态待确认',item.status));section.append(actionTop);
        const fields=node('dl',null,'card-fields');field(fields,'内容',item.text);field(fields,'日期',item.date);field(fields,'当地时间',item.time);field(fields,'重复',item.repeat==='daily'?'每天':item.repeat==='once'?'仅一次':item.repeat);if(typeof item.enabled==='boolean')field(fields,'每日问候',item.enabled?'开启':'关闭');section.append(fields);
        if (item.detail) section.append(node('p',item.detail,'card-note'));
        if (item.status === 'uncertain') section.append(node('p','这次发送可能已经提交。先核对状态，不重发。手机实收请由本人确认。','card-note'));
        if (item.status === 'api_accepted') section.append(node('p','接口接收了发送请求，手机是否收到仍需本人确认。','card-note'));
        const controls=node('div',null,'action-controls');
        const add = (label,action) => {const button=actionButton(label,()=>mutate({action,cardId:card.id,actionId:item.id}));button.dataset.actionId=item.id;button.dataset.focusKey=card.id+':'+item.id+':'+action;controls.append(button);};
        if (item.status === 'draft' || (item.status === 'scheduled' && ['remind','daily_schedule'].includes(item.type))) add('取消这一项','cancel_card');
        if (item.status === 'failed') add('仅重试这一项','retry_action');
        if (['uncertain','running','api_accepted'].includes(item.status)) add('核对状态','check_action');
        if (controls.children.length) section.append(controls);article.append(section);
      }
    }
    if (card.detail) article.append(node('p',card.detail,'card-note'));
    const controls=node('div',null,'card-actions');
    if (card.status==='draft' && (card.kind==='profile' || (card.actions || []).some(item=>item.status==='draft'))) controls.append(actionButton(card.kind==='profile'?'确认保存资料':'确认待执行安排',()=>mutate({action:'confirm_card',cardId:card.id,revision:card.revision},{notice:card.kind==='profile'?'资料已保存。连接与分享仍需本人确认。':'安排已提交，请查看每一项的实际状态。'}),'primary'));
    if (card.status!=='cancelled') controls.append(actionButton('继续修改',()=>{setTab('chat');setContext('card:'+card.id);}));
    if (card.kind==='profile' && card.status==='draft') controls.append(actionButton('放弃这份草稿',()=>mutate({action:'cancel_card',cardId:card.id})));
    if (card.kind==='profile' && card.status==='saved' && card.previousProfile) controls.append(actionButton('撤销上次资料修改',()=>mutate({action:'undo_profile',cardId:card.id},{notice:'已恢复上一次资料；连接与分享范围未改变。'})));
    if (card.kind==='profile' && card.personId && card.status==='saved') controls.append(actionButton('连接与详情',()=>openPerson(card.personId)));
    for (const button of controls.children) button.dataset.focusKey = card.id + ':' + button.textContent;
    if (controls.children.length) article.append(controls);return article;
  }
  function emptyState(title,description) {
    const section=node('section',null,'empty-state');section.append(node('h2',title),node('p',description));return section;
  }
  function renderChat(space) {
    const data=workbench(), messages=data.messages || [], cards=data.cards || [], lastReference=new Map();
    messages.forEach(message=>(message.cardIds || []).forEach(id=>lastReference.set(id,message.id)));
    if (!messages.length && !cards.length) {
      const owner=state.people.find(person=>person.role==='owner');
      space.append(emptyState(owner?'还没有交代过的事。':'还没有家庭资料。',owner?'从介绍一位家人开始：怎么称呼、住在哪个时区、喜欢什么。助手会整理成一份可以修改的资料。':'先设置你自己的称呼与时区，再和助手聊聊想照顾的人。'));
      if (owner) {const prompts=node('div',null,'suggestion-row');prompts.append(actionButton('添加一位家人',startAddFamily,'prompt-chip'),actionButton('查看模型与服务设置',()=>openDrawer('settings'),'prompt-chip'));space.append(prompts);}
    }
    for (const message of messages) {
      const article=node('article',null,'chat-message '+(message.role==='user'?'user':'assistant'));
      article.append(node('p',message.role==='user'?'你':'家庭助手','message-label'),node('p',message.text,'message-text'));
      if (message.contextId && contextLabel(message.contextId)) article.append(node('small','关于 '+contextLabel(message.contextId),'message-context'));
      for(const id of message.cardIds || []) {const card=cards.find(card=>card.id===id);if(card&&lastReference.get(id)===message.id)article.append(cardView(card));}
      space.append(article);
    }
    for (const card of cards) if (!lastReference.has(card.id)) space.append(cardView(card));
  }
  function personView(person) {
    const card=node('article',null,'family-card'), heading=node('div',null,'family-heading');
    heading.append(node('span',person.label?.slice(0,1) || '家','avatar'),node('h2',person.label));card.append(heading);
    card.append(node('p',person.role==='owner'?'你 · 家庭安排人':'家人 · 独立微信会话','muted small'),statusPill(statusText[safeStatus(person)] || '状态待确认',safeStatus(person)));
    const fields=node('dl',null,'card-fields');field(fields,'所在时区',person.timeZone);field(fields,'喜欢的话题',person.interests);field(fields,'陪伴偏好',person.notes);card.append(fields);
    if(person.role==='elder')card.append(node('p',person.shareWithOwner==='full'?'本人已同意分享完整记录':person.shareWithOwner==='summary'?'仅分享服务摘要':'当前不向你分享聊天记录','hint'));
    const controls=node('div',null,'card-actions');controls.append(actionButton('继续补充资料',()=>setContext('person:'+person.id)),actionButton('连接与详情',()=>openPerson(person.id)));card.append(controls);return card;
  }
  function requestView(item,compact=false) {
    const card=node('article',null,compact?'inbox-mini':'result-card request-card'), person=state.people.find(person=>person.id===item.personId);
    const top=node('div',null,'card-top');top.append(node('h3',person?.label || '家人'),statusPill(requestStates[item.status] || '状态待确认',item.status));card.append(top);
    card.append(node('p',item.text,'request-text'));
    if(item.replyStatus)card.append(node('p','你的回应：'+(deliveryText[item.replyStatus] || '状态待确认'),'hint'));
    const actions=node('div',null,'card-actions');actions.append(actionButton(item.status==='resolved'?'查看往返记录':'查看并回应',()=>openRequest(item.id)));card.append(actions);return card;
  }
  function renderActivity(space) {
    const cards=workbench().cards.filter(card=>card.kind==='plan'), active=cards.filter(card=>['draft','active'].includes(card.status)), past=cards.filter(card=>!['draft','active'].includes(card.status));
    space.append(node('h2','当前安排','section-heading'));
    for(const card of active)space.append(cardView(card));
    const reminders=(state.reminders || []).filter(item=>!['cancelled','completed','sent','expired'].includes(item.status));
    for(const reminder of reminders) {const row=node('article',null,'activity-row');row.append(node('h3',(state.people.find(person=>person.id===reminder.personId)?.label || '家人')+' · 提醒'),node('p',reminder.text),node('p',localDate(reminder.dueAt,state.people.find(person=>person.id===reminder.personId)?.timeZone)+(reminder.repeat==='daily'?' · 每天':'')+' · 家人当地时间','hint'));space.append(row);}
    const daily=state.people.filter(person=>person.dailyEnabled);
    for(const person of daily) {const row=node('article',null,'activity-row');row.append(node('h3',person.label+' · 每日问候'),node('p',(person.dailyTime || '时间待确认')+' · '+person.timeZone,'hint'));space.append(row);}
    if(!active.length&&!reminders.length&&!daily.length)space.append(emptyState('还没有待执行的安排。','可以在下方交代一件事，助手会先整理收件对象、内容与时间。'));
    if(past.length){space.append(node('h2','之前的安排','section-heading'));for(const card of past.slice().reverse())space.append(cardView(card));}
    const outbox=(state.outbox || []).slice(-20).reverse();
    if(outbox.length){space.append(node('h2','最近发送状态','section-heading'));for(const item of outbox){const row=node('article',null,'activity-row');row.append(node('h3',(state.people.find(person=>person.id===item.personId)?.label || '家人')+' · '+(deliveryText[item.status] || '状态待确认')),node('p',localDate(item.createdAt),'hint'));if(item.status==='uncertain')row.append(node('p','结果不明，未自动重发。'));space.append(row);}space.append(node('p','发送状态仅反映接口处理结果。实际收信由本人确认。','hint'));}
  }
  function renderWorkbench() {
    if(!state)return;
    const data=workbench(), owner=state.people.find(person=>person.role==='owner');
    show('owner-setup',!owner);show('nav-count',data.requests.some(item=>item.status==='open'));text('nav-count',data.requests.filter(item=>item.status==='open').length);
    for(const tab of Object.keys(tabTitles)) {if(activeTab===tab)$('nav-'+tab).setAttribute('aria-current','page');else $('nav-'+tab).removeAttribute('aria-current');}
    text('chat-title',tabTitles[activeTab][0]);text('chat-subtitle',tabTitles[activeTab][1]);renderContext();
    const signature=JSON.stringify([activeTab,activeContext,data,state.people,state.reminders,state.outbox]);
    if(signature!==workbenchSignature){
      workbenchSignature=signature;const space=$('workspace'),nearBottom=space.scrollHeight-space.scrollTop-space.clientHeight<100,focusKey=document.activeElement?.dataset?.focusKey;
      space.replaceChildren();
      if(activeTab==='chat')renderChat(space);
      if(activeTab==='family'){if(!state.people.length)space.append(emptyState('还没有家人资料。','先设置你自己，再通过对话添加家人。'));const list=node('div',null,'family-list');for(const person of state.people)list.append(personView(person));space.append(list);}
      if(activeTab==='inbox'){if(!data.requests.length)space.append(emptyState('目前没有需要你回应的事。','家人同意转达的事项会出现在这里。没有转达的私聊不会展示。'));for(const item of data.requests.slice().reverse())space.append(requestView(item));}
      if(activeTab==='activity')renderActivity(space);
      if(nearBottom&&activeTab==='chat')space.scrollTop=space.scrollHeight;
      if(focusKey)for(const button of space.querySelectorAll('button'))if(button.dataset.focusKey===focusKey)button.focus();
      const rail=$('rail-requests');rail.replaceChildren();const pending=data.requests.filter(item=>item.status!=='resolved');text('rail-request-count',pending.length?String(pending.length):'');
      if(!pending.length)rail.append(node('p','目前没有待回应事项。','muted small'));for(const item of pending.slice(-2))rail.append(requestView(item,true));
    }
    if(drawerKind==='request')renderRequest();
  }
  function openDrawer(kind) {
    if(voiceActive()||voiceSnapshot.phase==='transcript')cancelVoice();
    if($('drawer-overlay').hidden)lastFocus=document.activeElement;
    drawerKind=kind;for(const panel of ['person','settings','add','request'])show(panel+'-panel',panel===kind);
    text('drawer-title',kind==='person'?(selectedPerson()?.label || '家人详情'):kind==='settings'?'服务与简报设置':kind==='request'?'这件事的往返':'添加家人');
    show('drawer-overlay',true);$('drawer-content').scrollTop = 0;$('app-shell').inert = true;$('drawer-panel').focus();
  }
  function closeDrawer() {show('drawer-overlay',false);$('app-shell').inert = false;drawerKind='';lastFocus?.focus?.();}
  function openPerson(id) {select(id);openDrawer('person');}
  function startAddFamily() {
    if(!state)return;
    if(!state.people.some(person=>person.role==='owner')){openOwnerSetup();return;}
    closeDrawer();setTab('chat');setContext('');notify('直接介绍这位家人：称呼、所在时区、喜欢的话题。助手会整理资料供你确认。');
  }
  function openOwnerSetup() {openDrawer('add');show('add-person',true);setValue('add-role','owner');setValue('add-zone',state?.config?.timeZone || 'Asia/Shanghai');text('drawer-title','设置我自己');$('add-label').focus();}
  function openRequest(id) {
    if(activeRequestId)replyDrafts[activeRequestId]=$('request-reply-text').value;
    activeRequestId=id;setContext('request:'+id,{focus:false});setValue('request-reply-text',replyDrafts[id] || '');renderRequest();openDrawer('request');
  }
  function renderRequest() {
    const item=workbench().requests.find(item=>item.id===activeRequestId),thread=$('request-thread');thread.replaceChildren();
    if(!item){thread.append(node('p','此事项已不可用，请关闭详情后刷新。'));show('request-reply-form',false);return;}
    const person=state.people.find(person=>person.id===item.personId),line=(who,value,at)=>{const entry=node('article',null,'request-line');entry.append(node('p',who+(at?' · '+localDate(at):''),'message-label'),node('p',value,'message-text'));thread.append(entry);};
    line(person?.label || '家人',item.text,item.createdAt);
    const responses=Array.isArray(item.responses)?item.responses:[];
    if(responses.length)for(const response of responses)line(response.by==='owner'?'你的回应':person?.label || '家人',response.text,response.at);
    else if(item.reply)line('你的回应',typeof item.reply==='string'?item.reply:item.reply.text,item.updatedAt);
    thread.append(statusPill(requestStates[item.status] || '状态待确认',item.status));
    if(item.replyStatus)thread.append(node('p','回应发送状态：'+(deliveryText[item.replyStatus] || '状态待确认'),'hint'));
    text('request-reply-label','以我的身份回应 '+(person?.label || '家人')+' 的这件事');show('request-reply-form',item.status!=='resolved');show('request-closed',item.status==='resolved');
  }
  async function sendOwnerChat() {
    const value=$('owner-input').value.trim(),context=activeContext;
    if(!value||voiceActive()||busy||!state?.people.some(person=>person.role==='owner'))return;
    if(context&&!contextLabel(context))return fail('这个事项已不可用，请回到一般对话后继续。');
    setTab('chat');keepDraft();const requestId=attemptId(attempts,context,value);text('composer-progress','助手正在整理，请稍候。你的文字会保留到收到结果。');
    const ok=await mutate({action:'owner_chat',text:value,...(context?{contextId:context}:{}),requestId});
    if(ok){delete attempts[context];if((drafts[context] || '').trim()===value){delete drafts[context];if(activeContext===context&&$('owner-input').value.trim()===value)setValue('owner-input','');}text('composer-progress','已收到助手的处理结果。');}
    else text('composer-progress','这次没有取得完整结果，原文已保留。再次提交相同文字会核对同一次请求。');
    persistDrafts();updateButtons();
  }
  function render({ loadPerson = false, loadConfig = false } = {}) {
    const validSelection = state.people.some(person => person.id === selectedId);
    if (!validSelection) { selectedId = state.people[0]?.id || null; loadPerson = true; }
    renderPeople(); renderPerson({ load: loadPerson });
    text('run-status', state.config.paused ? '服务已暂停' : '服务运行中');
    $('run-status').dataset.state = state.config.paused ? 'paused' : 'running';
    text('run-toggle', state.config.paused ? '开始服务' : '暂停服务');
    const owner = state.people.find(person => person.role === 'owner');
    text('brief-recipient', owner ? '接收人：' + owner.label + ' · ' + (connected(owner) ? '微信已连接' : '请先连接微信') : '添加一位“我自己”，作为简报接收人。');
    text('brief-preview', state.lastBrief?.text || '先预览，再决定是否发送。');
    if (loadConfig || !$('brief-schedule').dataset.dirty) { $('brief-enabled').checked = Boolean(state.config.ownerBriefEnabled); setValue('brief-time', state.config.ownerBriefTime || '20:00'); }
    if (loadConfig || !$('service-settings').dataset.dirty) { setValue('service-zone', state.config.timeZone || 'Asia/Shanghai'); setValue('model-provider', state.config.provider); setValue('model-name', state.config.model); }
    const modelSelected = Boolean(state.config.provider?.trim() && state.config.model?.trim());
    text('model-status', state.model?.available
      ? modelSelected ? '模型服务可用，将只读取当前家人的偏好和有限会话。' : '已发现宿主模型服务，请选择服务与模型。'
      : '当前未接通模型。连接宿主模型服务后，才能进行 AI 对话；不会模拟回复。');
    renderModelOptions(); renderWorkbench(); updateButtons();
    text('last-updated', '最近更新 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  async function refresh({ quiet = false } = {}) {
    if (reading || busy || (document.hidden && quiet)) return;
    reading = true; const version = ++requestVersion; const personId = selectedId; updateButtons();
    try {
      const value = await request(null, personId);
      if (version !== requestVersion) return;
      const first = !state; state = value; render({ loadPerson: first });
      if (!quiet) fail('');
      // The first snapshot deliberately has no selected conversation; fetch only the selected person's permitted view.
      if (!personId && selectedId && canReadHistory(selectedPerson())) setTimeout(() => refresh({ quiet: true }), 0);
    } catch (error) { if (version === requestVersion) fail(error.message); }
    finally { reading = false; updateButtons(); }
  }
  async function mutate(body, options = {}) {
    if (busy || !state) return false;
    let succeeded = false;
    busy = true; ++requestVersion; fail(''); notify(''); updateButtons();
    try {
      state = await request(body);
      succeeded = true;
      if (options.created) {
        const added = state.people.find(person => !options.created.has(person.id));
        if (added) selectedId = added.id;
        $('add-person').reset(); setValue('add-zone', state.config.timeZone || 'Asia/Shanghai');
        show('add-person', false); $('add-toggle').setAttribute('aria-expanded', 'false');
      }
      if (options.resetForm) { $(options.resetForm).reset(); $(options.resetForm).dataset.dirty = ''; }
      if (options.loadConfig) { $('brief-schedule').dataset.dirty = ''; $('service-settings').dataset.dirty = ''; }
      render({ loadPerson: Boolean(options.loadPerson || options.created), loadConfig: Boolean(options.loadConfig) });
      if (options.notice) notify(options.notice);
      if (options.created) openPerson(selectedId);
    } catch (error) { fail(error.message); }
    finally { busy = false; updateButtons(); }
    // Restore the Owner's own history or an elder's consented full view after POST snapshots.
    if (canReadHistory(selectedPerson())) void refresh({ quiet: true });
    return succeeded;
  }
  function select(id) {
    if (busy || selectedId === id) return;
    selectedId = id; ++requestVersion;
    // A selected conversation never borrows messages from the previous selection.
    state = { ...state, messages: [] };
    $('add-reminder').reset(); $('send-message').reset(); $('verify-login').reset();
    renderPeople(); renderPerson({ load: true }); updateButtons();
    if (!reading) void refresh({ quiet: true });
  }
  function onSubmit(id, handler) {
    $(id).addEventListener('submit', event => { event.preventDefault(); if (!busy && state) handler(); });
    $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; if (id === 'preferences') text('preferences-draft', '有尚未保存的修改'); });
    $(id).addEventListener('change', () => { $(id).dataset.dirty = 'true'; });
  }
  onSubmit('add-person', () => {
    if (!validZone($('add-zone').value.trim())) return fail('请填写有效的所在时区，例如 Asia/Shanghai。');
    const label = $('add-label').value.trim(); if (!label) return fail('请先填写这位家人的称呼。');
    void mutate({ action: 'add_person', role: $('add-role').value, label, timeZone: $('add-zone').value.trim(), shareWithOwner: 'none' }, { created: new Set(state.people.map(person => person.id)), notice: '家人已添加。接下来可以由本人扫码连接微信。' });
  });
  onSubmit('preferences', () => {
    const person = selectedPerson(); if (!person) return;
    if (!validZone($('person-zone').value.trim())) return fail('请填写有效的所在时区，例如 Asia/Shanghai。');
    const sharing = person.role === 'elder' ? $('person-sharing').value : person.shareWithOwner;
    if (person.role === 'elder' && sharing !== 'none' && !$('share-consent').checked) return fail('请先确认本人知情并同意当前分享范围。');
    const label = $('person-label').value.trim(); if (!label) return fail('称呼不能为空。');
    void mutate({ action: 'update_person', personId: person.id, label, timeZone: $('person-zone').value.trim(), interests: $('person-interests').value.split(/[,，、;；\n]+/).map(value => value.trim()).filter(Boolean), notes: $('person-notes').value.trim(), shareWithOwner: sharing, dailyEnabled: person.role === 'elder' && $('daily-enabled').checked, dailyTime: $('daily-time').value }, { loadPerson: true, notice: '这位家人的偏好已保存。' });
  });
  onSubmit('add-reminder', () => {
    const person = selectedPerson(); if (!person) return;
    const date = new Date($('reminder-due').value); const value = $('reminder-text').value.trim();
    if (!value) return fail('请先写下要提醒的事。');
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return fail('请选择将来的提醒时间。');
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: person.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    void mutate({ action: 'add_reminder', personId: person.id, text: value, dueAt: date.toISOString(), repeat: $('reminder-repeat').value, time, timeZone: person.timeZone }, { resetForm: 'add-reminder', notice: '提醒已保存，将按家人所在时区安排。' });
  });
  onSubmit('send-message', () => {
    const person = selectedPerson(); const value = $('message-text').value.trim(); if (!person || !value) return;
    void mutate({ action: 'send_message', personId: person.id, text: value }, { resetForm: 'send-message', notice: '发送请求已提交，请在服务记录中查看结果；实际收信由本人确认。' });
  });
  onSubmit('brief-schedule', () => { void mutate({ action: 'configure', ownerBriefEnabled: $('brief-enabled').checked, ownerBriefTime: $('brief-time').value }, { resetForm: 'brief-schedule', notice: '简报安排已保存。' }); });
  onSubmit('service-settings', () => {
    if (!validZone($('service-zone').value.trim())) return fail('请填写有效的默认时区。');
    void mutate({ action: 'configure', timeZone: $('service-zone').value.trim(), provider: $('model-provider').value.trim(), model: $('model-name').value.trim() }, { resetForm: 'service-settings', notice: '服务设置已保存。' });
  });
  onSubmit('verify-login', () => {
    const person = selectedPerson(); const code = $('verification-code').value.trim(); if (!person || !code) return;
    void mutate({ action: 'verify_login', personId: person.id, code }, { resetForm: 'verify-login', notice: '验证码已提交，请等待微信确认结果。' });
  });
  $('person-sharing').addEventListener('change', () => { $('share-consent').checked = false; syncConsent(); });
  $('add-toggle').addEventListener('click', () => {
    const visible = $('add-person').hidden; show('add-person', visible); $('add-toggle').setAttribute('aria-expanded', String(visible));
    if (visible) $('add-label').focus();
  });
  $('run-toggle').addEventListener('click', () => { void mutate({ action: state.config.paused ? 'start' : 'pause' }, { notice: state.config.paused ? '服务已开始。提醒和对话将按设置运行。' : '服务已暂停。已连接通路的来信仅归档，不触发 AI 回复或自动发送。' }); });
  for (const action of ['login', 'connect', 'disconnect']) $(action).addEventListener('click', () => {
    const person = selectedPerson(); if (person) void mutate({ action, personId: person.id });
  });
  $('preview-brief').addEventListener('click', () => { void mutate({ action: 'preview_brief' }, { notice: '简报预览已更新，尚未发送。' }); });
  $('send-brief').addEventListener('click', () => { void mutate({ action: 'send_brief' }, { notice: '简报发送请求已提交，实际收信请在手机上确认。' }); });
  $('refresh').addEventListener('click', () => { void refresh(); });
  $('qr-image').addEventListener('error', () => { text('qr-caption', '二维码暂时未能载入，请刷新状态或重新生成。'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh({ quiet: true }); });
  const timer = setInterval(() => { if (!document.hidden) void refresh({ quiet: true }); }, 5000);
  window.addEventListener('pagehide', () => { voiceUnsubscribe?.();voiceBridge?.cancel();keepDraft(); clearInterval(timer); ++qrLoadVersion; if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl); }, { once: true });
  for (const id of forms) $(id).dataset.dirty = '';
  text('reminder-due-label', '首次时间（' + Intl.DateTimeFormat().resolvedOptions().timeZone + '）');

  restoreDrafts(); setValue('owner-input',drafts[activeContext] || '');
  $('owner-input').addEventListener('input',()=>{voiceRevision++;keepDraft();updateButtons();});
  $('owner-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void sendOwnerChat();}});
  $('composer-form').addEventListener('submit',event=>{event.preventDefault();void sendOwnerChat();});
  for(const tab of Object.keys(tabTitles))$('nav-'+tab).addEventListener('click',()=>setTab(tab));
  $('context-clear').addEventListener('click',()=>setContext(''));
  $('settings-open').addEventListener('click',()=>openDrawer('settings'));
  $('manual-add-open').addEventListener('click',()=>{openDrawer('add');show('add-person',true);setValue('add-role',state.people.some(person=>person.role==='owner')?'elder':'owner');setValue('add-zone',state.config.timeZone || 'Asia/Shanghai');$('add-label').focus();});
  $('brief-open').addEventListener('click',()=>openDrawer('settings'));
  $('setup-owner').addEventListener('click',openOwnerSetup);
  $('add-family').addEventListener('click',startAddFamily);$('rail-add-family').addEventListener('click',startAddFamily);
  $('voice-start').addEventListener('click',()=>{void startVoice();});
  $('voice-stop').addEventListener('click',()=>{void voiceBridge?.stop();});
  $('voice-cancel').addEventListener('click',cancelVoice);
  $('voice-prepare').addEventListener('click',()=>{voiceOpened=true;void (voiceSnapshot.phase==='unavailable'?voiceBridge?.refresh():voiceBridge?.prepare());});
  $('voice-cancel-setup').addEventListener('click',()=>{void voiceBridge?.cancelPreparation();});
  $('voice-insert').addEventListener('click',()=>{insertVoiceText(true);renderVoiceControls();});
  $('notice-dismiss').addEventListener('click',()=>{notify('');$('owner-input').focus();});
  $('drawer-close').addEventListener('click',closeDrawer);
  $('drawer-overlay').addEventListener('click',event=>{if(event.target===$('drawer-overlay'))closeDrawer();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&voiceActive()){event.preventDefault();cancelVoice();return;}
    if($('drawer-overlay').hidden)return;
    if(event.key==='Escape'){event.preventDefault();closeDrawer();}
    if(event.key==='Tab'){
      const focusable=[...$('drawer-panel').querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')].filter(element=>!element.disabled&&element.getClientRects?.().length);
      const first=focusable[0],last=focusable.at(-1);
      if(!first){event.preventDefault();$('drawer-panel').focus();}
      else if(event.shiftKey&&(document.activeElement===first||document.activeElement===$('drawer-panel'))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===$('drawer-panel'))){event.preventDefault();first.focus();}
    }
  });
  $('request-reply-text').addEventListener('input',()=>{if(activeRequestId){replyDrafts[activeRequestId]=$('request-reply-text').value.slice(0,4000);persistDrafts();}});
  $('request-reply-form').addEventListener('submit',async event=>{
    event.preventDefault();const requestId=activeRequestId,value=$('request-reply-text').value.trim();if(!value||!requestId||busy)return;
    replyDrafts[requestId]=$('request-reply-text').value;const operationId=attemptId(replyAttempts,requestId,value);
    const ok=await mutate({action:'reply_request',requestId,text:value,operationId},{notice:'回应请求已提交。请查看接口状态，实际收信由本人确认。'});
    if(ok){delete replyAttempts[requestId];if(replyDrafts[requestId]?.trim()===value){delete replyDrafts[requestId];if(activeRequestId===requestId&&$('request-reply-text').value.trim()===value)setValue('request-reply-text','');}persistDrafts();}
  });
  $('request-resolve').addEventListener('click',()=>{if(activeRequestId)void mutate({action:'resolve_request',requestId:activeRequestId},{notice:'已结束这件事的跟进。结束不代表手机已收到回应。'});});
  initializeVoice();
  updateButtons();
  void refresh();
})();
