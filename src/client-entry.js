/* Web and desktop global workbench delegates authenticated requests through the parent host. */
window.__ModuleLoader__.load({
  id: '@oxmumu3/dsh-family-assistant',
  factory: require => {
    const React = require('react');
    const inject = ['slots', 'layout', 'uiWorkspace', 'sessions', 'remote', 'remote.session', 'remote.workspace'];
    function apply(ctx) {
      function FamilyIcon() {
        return React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
          React.createElement('path', { d: 'M3 10.5 12 3l9 7.5M5 9v11h14V9M9 20v-6h6v6' }));
      }
      /** Sample the live Harness shell so the embedded workbench inherits its
       * canvas colour, colour scheme, font size and --dsh-* tokens. */
      function readHostTheme() {
        try {
          const root = getComputedStyle(document.documentElement);
          const body = getComputedStyle(document.body);
          const opaque = value => /^rgba?\(\s*\d+/.test(value ?? '') ? value : '';
          const canvas = opaque(body.backgroundColor) || opaque(root.backgroundColor) || '';
          const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(canvas);
          const fallbackDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
          const dark = match
            ? (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255 < 0.5
            : fallbackDark;
          const tokens = [];
          for (const style of [root, body]) {
            for (const name of style) {
              if (name.startsWith('--dsh-')) tokens.push(`${name}:${style.getPropertyValue(name).trim()}`);
            }
          }
          const size = Number.parseFloat(root.fontSize) || 16;
          return {
            dark,
            tokens: [...new Set(tokens)],
            fontSize: Math.min(20, Math.max(13, size)),
            fontFamily: root.fontFamily || body.fontFamily || '',
            canvas: canvas || (dark ? '#14170f' : '#faf9f5'),
          };
        } catch {
          return { dark: false, tokens: [], fontSize: 16, fontFamily: '', canvas: '#faf9f5' };
        }
      }
      function applyHostTheme(source, theme, options = {}) {
        const declarations = [
          `color-scheme:${theme.dark ? 'dark' : 'light'}`,
          `--host-canvas:${theme.canvas}`,
          `--host-font-size:${theme.fontSize}px`,
          theme.fontFamily ? `--host-font-family:${theme.fontFamily}` : '',
          ...theme.tokens,
        ].filter(Boolean).join(';');
        const style = `<style id="family-host-theme">:root{${declarations}}`
          + 'html{font-size:var(--host-font-size)}'
          + 'body{background:var(--host-canvas);font-family:var(--host-font-family,inherit)}</style>';
        const themed = source.includes('</head>')
          ? source.replace(/<\/head>/i, `${style}</head>`)
          : style + source;
        return themed.replace(/<html(\s[^>]*)?>/i, (_m, rest) => `<html${rest ?? ''} data-host-theme="${theme.dark ? 'dark' : 'light'}"${options.nativeChat ? ' data-native-chat="1"' : ''}>`);
      }
      // Unsent main-chat text from the old workbench box. Both frames share this
      // window's session storage; text is merged, and removed only after the
      // Host composer has accepted it.
      // 乐乐's avatar is already inlined into the workbench page; reuse it.
      let avatarCache = { source: null, url: '' };
      function leleAvatar(source) {
        if (typeof source !== 'string') return '';
        if (avatarCache.source !== source) {
          const match = /<img class="lele-avatar" src="(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)"/.exec(source);
          avatarCache = { source, url: match ? match[1] : '' };
        }
        return avatarCache.url;
      }
      function openRequestsOf(state) {
        const rows = Array.isArray(state?.workbench?.requests) ? state.workbench.requests : [];
        return rows.filter(row => row && row.status === 'open' && typeof row.id === 'string')
          .map(row => ({ id: row.id, personId: row.personId, text: String(row.text ?? '').slice(0, 80) }));
      }
      // Phrases the Owner can start from; each only fills the input box.
      const STARTERS = [
        ['家里今天有什么新消息', '家里今天有什么新消息？'],
        ['给家人带句话', '帮我给家人带句话：'],
        ['安排一个提醒', '帮我安排一个提醒：'],
        ['交代的事办得怎么样', '我之前交代的事都办得怎么样了？'],
      ];
      const HANDOFF_KEY = 'family-native-chat-handoff-v1';
      const WORKBENCH_DRAFTS_KEY = 'family-workbench-drafts-v1';
      function collectNativeHandoff() {
        try {
          const storage = window.sessionStorage;
          const stored = JSON.parse(storage.getItem(HANDOFF_KEY) || 'null');
          let held = typeof stored?.text === 'string' ? stored.text.slice(0, 4000) : '';
          const drafts = JSON.parse(storage.getItem(WORKBENCH_DRAFTS_KEY) || 'null');
          const pending = typeof drafts?.drafts?.[''] === 'string' ? drafts.drafts[''].trim() : '';
          if (pending) {
            held = !held ? pending : held.includes(pending) ? held : (held + '\n\n' + pending).slice(0, 4000);
            storage.setItem(HANDOFF_KEY, JSON.stringify({ text: held }));
            drafts.drafts[''] = '';
            storage.setItem(WORKBENCH_DRAFTS_KEY, JSON.stringify(drafts));
          }
          return held.trim();
        } catch {
          return '';
        }
      }
      function clearNativeHandoff(text) {
        try {
          const stored = JSON.parse(window.sessionStorage.getItem(HANDOFF_KEY) || 'null');
          if (stored?.text === text) window.sessionStorage.removeItem(HANDOFF_KEY);
        } catch { /* nothing to clear */ }
      }
      function FamilyAssistant(props = {}) {
        const [page, setPage] = React.useState(null);
        const [error, setError] = React.useState('');
        const [attempt, setAttempt] = React.useState(0);
        const [health, setHealth] = React.useState(null);
        const [healthError, setHealthError] = React.useState('');
        // The Owner's main conversation is the Host's own session, embedded
        // through the main slot's SessionProvider. Older Hosts keep the iframe chat.
        const nativeCapable = typeof props.SessionProvider === 'function' && typeof props.renderSlot === 'function' && typeof ctx.sessions?.retain === 'function';
        const [view, setView] = React.useState(nativeCapable ? 'chat' : 'overview');
        const [conversation, setConversation] = React.useState(nativeCapable ? { status: 'opening' } : { status: 'off' });
        const [handoff, setHandoff] = React.useState('');
        const [handoffNote, setHandoffNote] = React.useState('');
        const [requests, setRequests] = React.useState([]);
        const [bandNote, setBandNote] = React.useState('');
        React.useEffect(() => {
          let active = true;
          const previousFetch = window.__FamilyHostFetch;
          const previousVoice = window.__FamilyVoice;
          const previousOwnerAgent = window.__FamilyOwnerAgent;
          const hostFetch = (input, init) => globalThis.fetch(input, init);
          // Capture runs in the trusted primary frame. The workbench receives
          // text and state only; it never requests iframe microphone permission.
          const voice = createFamilyVoice();
          const ownerAbort = new AbortController();
          let remote;
          try { remote = ctx.get?.('remote'); } catch { /* Other local helpers remain usable. */ }
          const ownerClient = createOwnerAgentClient({ remote });
          const requireActive = () => { if (!active) throw new Error('owner_agent_unavailable'); };
          const ownerAgent = Object.freeze({
            listWorkspaces: async () => { requireActive(); return ownerClient.listWorkspaces({ signal: ownerAbort.signal }); },
            pickWorkspace: async () => { requireActive(); return ownerClient.pickWorkspace({ signal: ownerAbort.signal }); },
            addWorkspace: async path => { requireActive(); return ownerClient.addWorkspace(path, { signal: ownerAbort.signal }); },
            start: async intent => { requireActive(); return ownerClient.start(intent, { signal: ownerAbort.signal }); },
            observe: async intent => { requireActive(); return ownerClient.observe(intent, { signal: ownerAbort.signal }); },
            cancel: async intent => { requireActive(); return ownerClient.cancel(intent, { signal: ownerAbort.signal }); },
            openSession: async intent => {
              requireActive();
              // Verify both project and session before navigating to Host-owned
              // questions/permissions. The bridge never approves a tool itself.
              await ownerClient.observe(intent, { signal: ownerAbort.signal });
              requireActive();
              if (typeof ctx.uiWorkspace?.openSession !== 'function') throw new Error('owner_agent_unavailable');
              await ctx.uiWorkspace.openSession(intent.sessionId);
              requireActive(); ctx.layout.selectPanel(null);
            },
            openTask: async task => {
              requireActive();
              const rows=await ownerClient.listWorkspaces({signal:ownerAbort.signal});
              const workspace=rows.find(row=>row.workspaceId===task?.workspaceId);
              if(!workspace||!workspace.sessionIds.includes(task?.sessionId))throw new Error('owner_agent_identity_mismatch');
              await ownerClient.observe({workspaceId:workspace.workspaceId,cwd:workspace.path,sessionId:task.sessionId,requestId:task.requestId},{signal:ownerAbort.signal});
              requireActive();
              if(typeof ctx.uiWorkspace?.openSession!=='function')throw new Error('owner_agent_unavailable');
              await ctx.uiWorkspace.openSession(task.sessionId);
              requireActive();ctx.layout.selectPanel(null);
            },
          });
          window.__FamilyHostFetch = hostFetch;
          window.__FamilyVoice = voice;
          window.__FamilyOwnerAgent = ownerAgent;
          setError('');
          Promise.resolve().then(() => globalThis.fetch('/api/family/workbench', { credentials: 'same-origin' }))
            .then(response => { if (!response.ok) throw new Error('unavailable'); return response.text(); })
            .then(source => { if (active) setPage({ source, theme: readHostTheme() }); })
            .catch(() => { if (active) setError('家庭助手暂时无法载入，请确认插件已启用后重试。'); });
          return () => {
            active = false;
            ownerAbort.abort();
            voice.dispose();
            if (window.__FamilyOwnerAgent === ownerAgent) {
              if (previousOwnerAgent === undefined) delete window.__FamilyOwnerAgent;
              else window.__FamilyOwnerAgent = previousOwnerAgent;
            }
            if (window.__FamilyVoice === voice) {
              if (previousVoice === undefined) delete window.__FamilyVoice;
              else window.__FamilyVoice = previousVoice;
            }
            if (window.__FamilyHostFetch === hostFetch) {
              if (previousFetch === undefined) delete window.__FamilyHostFetch;
              else window.__FamilyHostFetch = previousFetch;
            }
          };
        }, [attempt]);
        React.useEffect(() => {
          let active = true;
          const load = () => Promise.resolve().then(() => globalThis.fetch('/api/family/control', { credentials: 'same-origin' }))
            .then(response => { if (!response.ok) throw new Error('status'); return response.json(); })
            .then(state => {
              if (!active) return;
              setHealth(state && state.health ? state.health : null);
              setHealthError('');
              setRequests(openRequestsOf(state));
            })
            .catch(() => { if (active) setHealthError('暂时读不到家庭状态'); });
          load();
          const timer = setInterval(load, 30000);
          if (typeof timer?.unref === 'function') timer.unref();
          return () => { active = false; clearInterval(timer); };
        }, [attempt]);
        // Open (or create once) the Owner's desktop conversation and retain it.
        // Opening never sends a message. Any failure falls back to the iframe chat.
        React.useEffect(() => {
          if (!nativeCapable) return undefined;
          let live = true, reference = null;
          const previousShow = window.__FamilyShowNativeChat;
          const show = () => { if (live) setView('chat'); };
          window.__FamilyShowNativeChat = show;
          const previousHandoff = window.__FamilyHandoffChanged;
          const syncHandoff = () => { if (live) setHandoff(collectNativeHandoff()); };
          window.__FamilyHandoffChanged = syncHandoff;
          const release = () => { const held = reference; reference = null; try { held?.release?.(); } catch { /* already released */ } };
          const fallBack = status => { release(); if (!live) return; setConversation({ status }); setView(value => value === 'chat' ? 'workbench' : value); };
          const readPolicy = async sessionId => {
            const response = await globalThis.fetch('/api/family/control', { credentials: 'same-origin' });
            if (!response.ok) return 'unknown';
            const state = await response.json();
            return state?.ownerConversation?.sessionId === sessionId ? state.ownerConversation.policy : 'unknown';
          };
          setConversation({ status: 'opening' });
          (async () => {
            const response = await globalThis.fetch('/api/family/control', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'X-Family-Action': '1' },
              body: JSON.stringify({ action: 'owner_conversation_open' }),
            });
            const body = await response.json().catch(() => null);
            const target = body?.ownerConversation;
            if (!response.ok || !target || typeof target.sessionId !== 'string' || !target.sessionId.startsWith('family_owner_')) throw new Error('owner_conversation_unavailable');
            if (!live) return;
            reference = ctx.sessions.retain(target.sessionId, { source: 'controllerOperation' });
            await reference.ready;
            if (!live) return;
            if (reference.binding?.sessionId !== target.sessionId) throw new Error('owner_conversation_mismatch');
            setConversation({ status: 'ready', sessionId: target.sessionId, reference, policy: target.policy });
            syncHandoff();
            // The family role section is attached when the Host creates the
            // agent. Without it the native thread would not be 乐乐, so a failed
            // attachment hands the main thread back to the iframe chat.
            for (let round = 0; round < 8 && live; round++) {
              const policy = target.policy === 'active' && round === 0 ? 'active' : await readPolicy(target.sessionId).catch(() => 'unknown');
              if (!live) return;
              if (policy === 'inactive') { fallBack('inactive'); return; }
              if (policy === 'active') { setConversation(value => value.sessionId === target.sessionId ? { ...value, policy } : value); return; }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          })().catch(() => fallBack('failed'));
          return () => {
            live = false; release();
            if (window.__FamilyShowNativeChat === show) {
              if (previousShow === undefined) delete window.__FamilyShowNativeChat;
              else window.__FamilyShowNativeChat = previousShow;
            }
            if (window.__FamilyHandoffChanged === syncHandoff) {
              if (previousHandoff === undefined) delete window.__FamilyHandoffChanged;
              else window.__FamilyHandoffChanged = previousHandoff;
            }
          };
        }, [attempt]);
        const nativeOn = ['opening', 'ready'].includes(conversation?.status);
        const html = page ? applyHostTheme(page.source, page.theme, { nativeChat: nativeOn }) : '';
        const rows = health && Array.isArray(health.people) ? health.people : [];
        const summaryText = health
          ? `在线 ${health.totals.online}/${health.totals.people} · 待发 ${health.totals.pending}`
          : (healthError || '正在读取家庭状态…');
        const muted = { opacity: 0.72 };
        const healthRow = row => {
          const parts = [
            React.createElement('span', { key: 'n', style: { minWidth: '4em' } }, row.role === 'owner' ? '我' : row.label),
            React.createElement('span', { key: 's', style: muted }, row.connected ? '在线' : '离线'),
          ];
          if (row.pending) parts.push(React.createElement('span', { key: 'p', style: muted }, `待发 ${row.pending}`));
          if (row.uncertain24h) parts.push(React.createElement('span', { key: 'u', style: { color: 'var(--dsh-color-warning, #b26a00)' } }, `待核对 ${row.uncertain24h}`));
          return React.createElement('div', { key: row.personId, style: { display: 'flex', gap: '12px', padding: '8px 0', fontSize: '13px', borderBottom: '1px solid var(--dsh-color-border, rgba(127,127,127,0.15))' } }, parts);
        };
        const tabs = nativeOn
          ? [['chat', '和乐乐聊'], ['workbench', '家人与工具']]
          : [['overview', '家人状态'], ['workbench', '完整工作台']];
        const tab = ([key, label]) => React.createElement('button', {
          key, type: 'button', 'aria-pressed': view === key,
          onClick: () => setView(key),
          style: { fontSize: '12px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.3))', background: view === key ? 'var(--dsh-color-surface-selected, rgba(127,127,127,0.14))' : 'transparent', fontWeight: view === key ? 600 : 400, cursor: 'pointer' },
        }, label);
        const notice = ['failed', 'inactive'].includes(conversation?.status)
          ? React.createElement('span', { role: 'status', style: { color: 'var(--dsh-color-warning, #b26a00)' } },
            conversation.status === 'inactive' ? '乐乐的家庭规则没加载进原生对话，先用工作台里的对话。' : '原生对话暂时打不开，先用工作台里的对话。',
            React.createElement('button', { type: 'button', onClick: () => setAttempt(value => value + 1), style: { marginLeft: '8px', fontSize: '12px' } }, '重试'))
          : null;
        const header = React.createElement('header', {
          style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px', padding: '10px 16px', borderBottom: '1px solid var(--dsh-color-border, rgba(127,127,127,0.25))', fontSize: '13px' },
        },
          React.createElement('strong', null, '乐乐家庭助手'),
          React.createElement('span', { style: muted }, summaryText),
          notice,
          React.createElement('nav', { 'aria-label': '家庭助手视图', style: { display: 'flex', gap: '6px', marginLeft: 'auto' } }, tabs.map(tab)));
        // Put text into the Host composer as a draft; the Owner decides to send.
        // An existing native draft is never cleared.
        const putInComposer = text => {
          const reference = conversation?.reference, sessionId = conversation?.sessionId;
          const binding = reference?.binding;
          if (!text || !binding || binding.sessionId !== sessionId || (typeof ctx.sessions?.binding === 'function' && ctx.sessions.binding(sessionId) !== binding)) throw new Error('changed');
          const scope = binding.ctx ?? ctx.sessions?.scope?.(sessionId);
          const native = scope?.get?.('conversation', false);
          if (typeof native?.input?.requestDraftInitialization !== 'function') throw new Error('unavailable');
          const status = native.input.requestDraftInitialization(binding, { prompt: text, clearPreviousDraft: false });
          if (status === 'applied') { try { native.input.for?.(scope)?.focus?.(); } catch { /* focus is a convenience */ } }
          return status;
        };
        const placeHandoff = () => {
          const text = handoff;
          try {
            const status = putInComposer(text);
            if (status === 'applied') { clearNativeHandoff(text); setHandoff(''); setHandoffNote('已放进下方输入框，确认后由你发送。'); return; }
            setHandoffNote(status === 'preserved' ? '输入框里已经有一段草稿，没有覆盖它；这段话仍保留在这里。'
              : status === 'blocked' ? '对话正在提交，稍后再放；这段话仍保留在这里。'
                : '没能确认是否放进输入框，这段话仍保留在这里。');
          } catch {
            setHandoffNote('原生输入框暂时收不下这段话，原文仍保留在这里。');
          }
        };
        const handoffBar = view === 'chat' && conversation?.status === 'ready' && (handoff || handoffNote)
          ? React.createElement('div', { role: 'status', 'data-family-handoff': true, style: { padding: '8px 16px', borderBottom: '1px solid var(--dsh-color-border, rgba(127,127,127,0.2))', fontSize: '13px', lineHeight: 1.6 } },
            handoff ? React.createElement('div', null,
              React.createElement('strong', null, '旧对话框里还有一段没发出的话'),
              React.createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '6.5em', overflow: 'auto', margin: '4px 0', opacity: 0.8 } }, handoff),
              React.createElement('button', { type: 'button', onClick: placeHandoff, style: { fontSize: '12px', marginRight: '8px' } }, '放进输入框'),
              React.createElement('button', { type: 'button', onClick: () => { clearNativeHandoff(handoff); setHandoff(''); setHandoffNote('已丢弃这段旧草稿。'); }, style: { fontSize: '12px' } }, '不要了')) : null,
            handoffNote ? React.createElement('p', { style: { margin: '4px 0 0', opacity: 0.8 } }, handoffNote) : null)
          : null;
        const startWith = prompt => {
          try {
            const status = putInComposer(prompt);
            setBandNote(status === 'applied' ? '已放进下方输入框，补全后按回车发送。'
              : status === 'preserved' ? '输入框里已经有内容，没有覆盖。' : '对话正在处理，稍后再试。');
          } catch {
            setBandNote('输入框暂时不可用，直接在下方输入也可以。');
          }
        };
        // Family chips and requests open the same records in the workbench.
        const openInWorkbench = action => {
          setView('workbench');
          setTimeout(() => { try { action(window.__FamilyWorkbench); } catch { /* the tab is still open */ } }, 0);
        };
        const dark = page?.theme?.dark === true;
        const accent = dark ? '#8fbfa9' : '#2f5d50';
        // "Connected" is not "reachable": the carrier only delivers within 24h
        // of that person's own last message, so the chip says which it is.
        const hoursLeft = ms => Math.max(1, Math.floor(ms / 3600000));
        const tone = row => {
          const reach = row.reach ?? null;
          if (!row.connected || reach?.state === 'offline') return ['离线，暂时收不到', 'var(--dsw-alias-state-idle-primary, #9a9a9a)'];
          if (reach?.state === 'closed') return ['要等对方先说一句', 'var(--dsw-alias-state-warn-primary, #c98a1a)'];
          if (reach?.state === 'open') return [`现在能收到·还剩 ${hoursLeft(reach.remainingMs)} 小时`, 'var(--dsw-alias-state-success-primary, #2f9e6b)'];
          if (row.pending || row.uncertain24h) return ['有待发', 'var(--dsw-alias-state-warn-primary, #c98a1a)'];
          return ['在线', 'var(--dsw-alias-state-success-primary, #2f9e6b)'];
        };
        const relatives = rows.filter(row => row.role !== 'owner');
        const nameOf = id => relatives.find(row => row.personId === id)?.label ?? '家人';
        const chipStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '4px 10px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))', background: 'transparent', color: 'inherit', cursor: 'pointer' };
        const avatar = leleAvatar(page?.source);
        const band = view === 'chat' && nativeOn
          ? React.createElement('section', { 'data-family-band': true, 'aria-label': '乐乐和家人', style: { padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))', background: 'var(--dsw-alias-bg-layer-1, transparent)', display: 'flex', flexDirection: 'column', gap: '10px' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              avatar
                ? React.createElement('img', { src: avatar, alt: '乐乐', width: 40, height: 40, style: { width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', boxShadow: `0 0 0 2px ${accent}` } })
                : React.createElement('span', { 'aria-hidden': true, style: { width: '40px', height: '40px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: accent, color: dark ? '#14170f' : '#fff', fontWeight: 600 } }, '乐'),
              React.createElement('div', { style: { minWidth: 0 } },
                React.createElement('div', { style: { fontFamily: '"Songti SC","STSong","Noto Serif SC",serif', fontSize: '16px', fontWeight: 600 } }, '乐乐'),
                React.createElement('div', { style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, '家里的事直接跟我说：给家人带话、安排提醒、看家里的新消息、查项目都可以。'))),
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
              React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)', marginRight: '2px' } }, '家人'),
              ...(relatives.length
                ? relatives.map(row => {
                  const [label, color] = tone(row);
                  return React.createElement('button', { key: row.personId, type: 'button', title: `打开${row.label}的对话与资料`, onClick: () => openInWorkbench(api => api?.openPerson?.(row.personId)), style: chipStyle },
                    row.label,
                    React.createElement('span', { 'aria-hidden': true, style: { width: '7px', height: '7px', borderRadius: '50%', background: color } }),
                    React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, label));
                })
                : [React.createElement('button', { key: 'add', type: 'button', onClick: () => openInWorkbench(api => api?.addFamily?.()), style: chipStyle }, health ? '还没有家人，去添加' : summaryText)])),
            requests.length
              ? React.createElement('div', { role: 'status', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${accent}`, fontSize: '13px' } },
                React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  React.createElement('strong', null, `${nameOf(requests.at(-1).personId)}有件事想问你`),
                  requests.at(-1).text ? `：${requests.at(-1).text}` : '',
                  requests.length > 1 ? `（共 ${requests.length} 件）` : ''),
                React.createElement('button', { type: 'button', onClick: () => openInWorkbench(api => api?.openRequest?.(requests.at(-1).id)), style: { ...chipStyle, borderColor: accent, color: accent, fontWeight: 600 } }, '去回应'))
              : null,
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
              React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)', marginRight: '2px' } }, '可以这样开始'),
              ...STARTERS.map(([label, prompt]) => React.createElement('button', { key: label, type: 'button', disabled: conversation?.status !== 'ready', onClick: () => startWith(prompt), style: { ...chipStyle, opacity: conversation?.status === 'ready' ? 1 : 0.5 } }, label)),
              bandNote ? React.createElement('span', { role: 'status', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, bandNote) : null))
          : null;
        const chat = view === 'chat' && nativeOn
          ? React.createElement('div', { 'data-family-owner-conversation': conversation.sessionId || '', style: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0 } },
            conversation.status === 'ready' && conversation.reference
              ? React.createElement(props.SessionProvider, { session: conversation.reference }, props.renderSlot('family.owner.conversation', {}))
              : React.createElement('p', { role: 'status', style: { padding: '24px' } }, '正在打开和乐乐的对话…'))
          : null;
        const overview = React.createElement('div', { style: { display: view === 'overview' ? 'flex' : 'none', flexDirection: 'column', padding: '16px', overflow: 'auto', flex: '1 1 0', minHeight: 0 } },
          rows.length ? rows.map(healthRow) : React.createElement('p', { style: muted }, health ? '还没有登记家人。' : summaryText),
          React.createElement('p', { style: { ...muted, marginTop: '16px', fontSize: '12px' } }, '详细设置、日记与工具在「' + (nativeOn ? '家人与工具' : '完整工作台') + '」里。'));
        const frame = html
          ? React.createElement('iframe', {
            srcDoc: html,
            title: '家庭助手工作台',
            sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
            style: { display: 'block', flex: '1 1 0', width: '100%', height: '100%', minHeight: 0, border: 0, background: 'transparent', colorScheme: 'normal' },
          })
          : React.createElement('p', { role: 'status', style: { padding: '24px' } }, '正在载入家庭助手…');
        const workbench = React.createElement('div', { style: { display: view === 'workbench' ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 0', minHeight: 0 } },
          error
            ? React.createElement('div', { style: { padding: '24px', lineHeight: 1.7 } },
              React.createElement('p', { role: 'alert' }, error),
              React.createElement('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, '重新载入'))
            : frame);
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, header, handoffBar, band, chat, overview, workbench);
      }
      /** Fills the session-scoped child slot with the Host's own conversation
       * body and composer; tools, approvals and streaming come from the Host. */
      function FamilyOwnerConversation({ renderFactorySlot } = {}) {
        return typeof renderFactorySlot === 'function'
          ? renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })
          : null;
      }
      /** Native settings page: read-only family overview inside Harness settings,
       * so the owner can check service and member health without opening the
       * iframe workbench. */
      function FamilySettingsPanel() {
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState('');
        React.useEffect(() => {
          let active = true;
          Promise.resolve().then(() => globalThis.fetch('/api/family/control', { credentials: 'same-origin' }))
            .then(response => { if (!response.ok) throw new Error('status'); return response.json(); })
            .then(body => { if (active) setState(body); })
            .catch(() => { if (active) setError('暂时读不到家庭状态'); });
          return () => { active = false; };
        }, []);
        const muted = { opacity: 0.72 };
        const health = state && state.health;
        const migration = state && state.migration;
        const rows = health && Array.isArray(health.people) ? health.people : [];
        return React.createElement('section', { style: { padding: '16px', fontSize: '13px', display: 'grid', gap: '10px' } },
          React.createElement('h3', { style: { margin: 0, fontSize: '14px' } }, '家庭助手'),
          state
            ? React.createElement('p', { style: muted }, (state.config && state.config.paused ? '服务已暂停' : '服务运行中') + (health ? ` · ${health.totals.online}/${health.totals.people} 在线` : ''))
            : React.createElement('p', { style: muted }, error || '正在读取家庭状态…'),
          migration
            ? React.createElement('p', { style: { margin: 0, ...(migration.ready ? muted : { color: 'var(--dsh-color-warning, #b26a00)' }) } },
              migration.ready ? '家人迁移：就绪（无未结清请求）' : `家人迁移：待处理 ${migration.totals.blocked} 位 / ${migration.totals.pendingRequests} 项`)
            : null,
          rows.length
            ? React.createElement('ul', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '4px' } },
              rows.map(row => React.createElement('li', { key: row.personId, 'data-state': row.state },
                `${row.role === 'owner' ? '我' : row.label} · ${row.connected ? '在线' : '离线'}` + (row.pending ? ` · 待发 ${row.pending}` : ''))))
            : React.createElement('p', { style: muted }, '还没有登记家人。'),
          React.createElement('p', { style: { ...muted, fontSize: '12px', margin: 0 } }, '详细设置与日记在侧栏「家庭助手」面板里。'));
      }
      // The main panel declares one session-scoped child: the Owner's native
      // conversation, rendered inside the SessionProvider the panel binds.
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'family-assistant',
        children: { 'family.owner.conversation': { kind: 'single', scope: 'session' } },
      }, FamilyAssistant)));
      ctx.effect(() => ctx.slots.inject('family.owner.conversation', () => ctx.slots.register({
        name: 'family.owner.conversation',
      }, FamilyOwnerConversation)));
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'family-assistant', order: 60, label: '家庭助手',
      }, FamilySettingsPanel)));
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'family-assistant', order: 6, label: '家庭助手',
      }, FamilyIcon)));
    }
    return { inject, apply };
  },
});
