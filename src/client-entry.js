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
      function FamilyAssistant() {
        const [html, setHtml] = React.useState('');
        const [error, setError] = React.useState('');
        const [attempt, setAttempt] = React.useState(0);
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
            .then(source => { if (active) setHtml(source); })
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
        if (error) return React.createElement('div', { style: { padding: '24px', lineHeight: 1.7 } },
          React.createElement('p', { role: 'alert' }, error),
          React.createElement('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, '重新载入'));
        if (!html) return React.createElement('p', { role: 'status', style: { padding: '24px' } }, '正在载入家庭助手…');
        return React.createElement('iframe', {
          srcDoc: html,
          title: '家庭助手工作台',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
          // The main slot already owns the available height. Only reserve the
          // macOS window controls when the Host has collapsed its sidebar.
          style: { display: 'block', flex: '1 1 0', width: '100%', height: '100%', minHeight: 0, marginTop: 'min(var(--dsh-frame-leading-clearance, 0px), 48px)', border: 0, background: '#faf9f5' },
        });
      }
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'family-assistant',
      }, FamilyAssistant)));
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'family-assistant', order: 6, label: '家庭助手',
      }, FamilyIcon)));
    }
    return { inject, apply };
  },
});
