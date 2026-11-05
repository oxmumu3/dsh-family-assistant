/* Web and desktop global workbench delegates authenticated requests through the parent host. */
window.__ModuleLoader__.load({
  id: '@oxmumu3/dsh-family-assistant',
  factory: require => {
    const React = require('react');
    const inject = ['slots', 'layout', 'uiWorkspace', 'remote', 'remote.session', 'remote.workspace'];
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
      function applyHostTheme(source, theme) {
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
        return themed.replace(/<html(\s[^>]*)?>/i, (_m, rest) => `<html${rest ?? ''} data-host-theme="${theme.dark ? 'dark' : 'light'}">`);
      }
      function FamilyAssistant() {
        const [html, setHtml] = React.useState('');
        const [error, setError] = React.useState('');
        const [attempt, setAttempt] = React.useState(0);
        // native-inline-v2: health summary state for the panel header
        const [health, setHealth] = React.useState(null);
        const [healthError, setHealthError] = React.useState('');
        const [view, setView] = React.useState('overview');
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
            .then(source => { if (active) setHtml(applyHostTheme(source, readHostTheme())); })
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
          Promise.resolve().then(() => globalThis.fetch('/api/family/control', { credentials: 'same-origin' }))
            .then(response => { if (!response.ok) throw new Error('status'); return response.json(); })
            .then(state => { if (active) setHealth(state && state.health ? state.health : null); })
            .catch(() => { if (active) setHealthError('暂时读不到家庭状态'); });
          return () => { active = false; };
        }, [attempt]);
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
        const header = React.createElement('header', {
          style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 16px', borderBottom: '1px solid var(--dsh-color-border, rgba(127,127,127,0.25))', fontSize: '13px' },
        },
          React.createElement('strong', null, '乐乐家庭助手'),
          React.createElement('span', { style: muted }, summaryText),
          React.createElement('button', {
            type: 'button',
            onClick: () => setView(value => value === 'workbench' ? 'overview' : 'workbench'),
            style: { marginLeft: 'auto', fontSize: '12px' },
          }, view === 'workbench' ? '收起完整工作台' : '打开完整工作台'));
        const overview = React.createElement('div', { style: { display: view === 'overview' ? 'flex' : 'none', flexDirection: 'column', padding: '16px', overflow: 'auto', flex: '1 1 0', minHeight: 0 } },
          rows.length ? rows.map(healthRow) : React.createElement('p', { style: muted }, health ? '还没有登记家人。' : summaryText),
          React.createElement('p', { style: { ...muted, marginTop: '16px', fontSize: '12px' } }, '详细设置、日记与工具在完整工作台里。'));
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
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, header, overview, workbench);
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
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'family-assistant',
      }, FamilyAssistant)));
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
