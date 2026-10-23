/* Web and desktop global workbench delegates authenticated requests through the parent host. */
window.__ModuleLoader__.load({
  id: 'dsh-family-assistant',
  factory: require => {
    const React = require('react');
    const inject = ['slots', 'layout'];
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
          const hostFetch = (input, init) => globalThis.fetch(input, init);
          // Capture runs in the trusted primary frame. The workbench receives
          // text and state only; it never requests iframe microphone permission.
          const voice = createFamilyVoice();
          window.__FamilyHostFetch = hostFetch;
          window.__FamilyVoice = voice;
          setError('');
          Promise.resolve().then(() => globalThis.fetch('/api/family/workbench', { credentials: 'same-origin' }))
            .then(response => { if (!response.ok) throw new Error('unavailable'); return response.text(); })
            .then(source => { if (active) setHtml(source); })
            .catch(() => { if (active) setError('家庭助手暂时无法载入，请确认插件已启用后重试。'); });
          return () => {
            active = false;
            voice.dispose();
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
          sandbox: 'allow-scripts allow-same-origin allow-forms',
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
