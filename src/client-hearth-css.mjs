export const HEARTH_CSS = `
:root, .hearth-root {
  color-scheme: light dark;
  scrollbar-width: thin;
  --font-serif: 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', Georgia, serif;
  --font-sans: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Helvetica Neue', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, monospace;

  /* Warm Editorial Hearth — Light (暖宣纸) */
  --bg-canvas: #f6f3ed;
  --bg-surface: #fffdf9;
  --bg-muted: #efeae0;
  --bg-subtle-2: #e7e1d5;
  --bg-hover: rgba(31, 29, 26, 0.045);
  --text-primary: #1f1d1a;
  --text-secondary: #5c574f;
  --text-tertiary: #7a746a;
  --border: rgba(31, 29, 26, 0.095);
  --border-strong: rgba(31, 29, 26, 0.17);
  --ink-btn-bg: #1f1d1a;
  --ink-btn-fg: #fffdf9;
  --shadow-sm: 0 1px 2px rgba(31, 29, 26, 0.04);
  --shadow-md: 0 8px 24px rgba(31, 29, 26, 0.08);
  --shadow-lg: 0 18px 48px rgba(31, 29, 26, 0.16);

  /* Three Functional Tones */
  --tone-open: #1f6f50;
  --tone-open-bg: #e7f3ec;
  --tone-open-border: rgba(31, 111, 80, 0.24);
  --tone-warn: #9a5212;
  --tone-warn-bg: #fcf1e3;
  --tone-warn-border: rgba(154, 82, 18, 0.26);
  --tone-danger: #b43c2f;
  --tone-danger-bg: #fbeae7;
  --tone-danger-border: rgba(180, 60, 47, 0.26);

  --scrollbar-thumb: rgba(31, 29, 26, 0.18);
  --scrollbar-track: transparent;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);

  --steward-orb-bg: linear-gradient(135deg, #2b241d 0%, #1d1814 100%);
  --steward-orb-fg: #fffdf9;
  --steward-orb-sub: rgba(255, 253, 249, 0.72);
  --steward-orb-border: rgba(240, 164, 88, 0.48);
  --steward-ring: rgba(240, 164, 88, 0.42);

  --header-h: 52px;
  --radius-lg: 14px;
  --radius-md: 10px;
  --radius-sm: 8px;
  --radius-pill: 999px;
}

@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]) .hearth-root:not([data-theme="light"]) {
    --bg-canvas: #151412;
    --bg-surface: #1e1c19;
    --bg-muted: #26231f;
    --bg-subtle-2: #2e2a25;
    --bg-hover: rgba(242, 237, 228, 0.06);
    --text-primary: #f2ede4;
    --text-secondary: #aca59a;
    --text-tertiary: #847e74;
    --border: rgba(242, 237, 228, 0.10);
    --border-strong: rgba(242, 237, 228, 0.20);
    --ink-btn-bg: #f2ede4;
    --ink-btn-fg: #151412;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25);
    --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.35);
    --shadow-lg: 0 18px 48px rgba(0, 0, 0, 0.55);

    --tone-open: #55c295;
    --tone-open-bg: rgba(85, 194, 149, 0.14);
    --tone-open-border: rgba(85, 194, 149, 0.30);
    --tone-warn: #f0a458;
    --tone-warn-bg: rgba(240, 164, 88, 0.15);
    --tone-warn-border: rgba(240, 164, 88, 0.30);
    --tone-danger: #f0796b;
    --tone-danger-bg: rgba(240, 121, 107, 0.15);
    --tone-danger-border: rgba(240, 121, 107, 0.30);
    --scrollbar-thumb: rgba(242, 237, 228, 0.22);
    --steward-orb-bg: linear-gradient(135deg, #342b22 0%, #241e18 100%);
    --steward-orb-fg: #f7f2e9;
    --steward-orb-sub: rgba(247, 242, 233, 0.72);
    --steward-orb-border: rgba(240, 164, 88, 0.56);
    --steward-ring: rgba(240, 164, 88, 0.48);
  }
}

.hearth-root[data-theme="light"] {
  color-scheme: light;
}

html[data-theme="dark"],
body[data-ds-dark-theme="true"],
html.dark {
  color-scheme: dark;
}

html[data-theme="dark"] .hearth-root,
body[data-ds-dark-theme="true"] .hearth-root,
html.dark .hearth-root,
body.dark .hearth-root,
.hearth-root[data-theme="dark"] {
  color-scheme: dark;
  --bg-canvas: #151412;
  --bg-surface: #1e1c19;
  --bg-muted: #26231f;
  --bg-subtle-2: #2e2a25;
  --bg-hover: rgba(242, 237, 228, 0.06);
  --text-primary: #f2ede4;
  --text-secondary: #aca59a;
  --text-tertiary: #847e74;
  --border: rgba(242, 237, 228, 0.10);
  --border-strong: rgba(242, 237, 228, 0.20);
  --ink-btn-bg: #f2ede4;
  --ink-btn-fg: #151412;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25);
  --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.35);
  --shadow-lg: 0 18px 48px rgba(0, 0, 0, 0.55);

  --tone-open: #55c295;
  --tone-open-bg: rgba(85, 194, 149, 0.14);
  --tone-open-border: rgba(85, 194, 149, 0.30);
  --tone-warn: #f0a458;
  --tone-warn-bg: rgba(240, 164, 88, 0.15);
  --tone-warn-border: rgba(240, 164, 88, 0.30);
  --tone-danger: #f0796b;
  --tone-danger-bg: rgba(240, 121, 107, 0.15);
  --tone-danger-border: rgba(240, 121, 107, 0.30);
  --scrollbar-thumb: rgba(242, 237, 228, 0.22);
  --steward-orb-bg: linear-gradient(135deg, #342b22 0%, #241e18 100%);
  --steward-orb-fg: #f7f2e9;
  --steward-orb-sub: rgba(247, 242, 233, 0.72);
  --steward-orb-border: rgba(240, 164, 88, 0.56);
  --steward-ring: rgba(240, 164, 88, 0.48);
}

.hearth-root {
  position: relative;
  height: 100%;
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.hearth-workbench *,
.hearth-workbench *::before,
.hearth-workbench *::after,
dialog.hearth-dialog *,
dialog.hearth-dialog *::before,
dialog.hearth-dialog *::after {
  box-sizing: border-box;
}

:where(.hearth-workbench, dialog.hearth-dialog) :where(button, input, select, textarea) {
  font: inherit;
  color: inherit;
}

.hearth-workbench button,
dialog.hearth-dialog button {
  cursor: pointer;
}

.hearth-root button:focus-visible,
.hearth-root input:focus-visible,
.hearth-root select:focus-visible,
.hearth-root textarea:focus-visible,
dialog.hearth-dialog button:focus-visible,
dialog.hearth-dialog input:focus-visible,
dialog.hearth-dialog select:focus-visible,
dialog.hearth-dialog textarea:focus-visible {
  outline: 2px solid var(--tone-open);
  outline-offset: 2px;
}

.tabular {
  font-variant-numeric: tabular-nums;
}

/* Single-Row Compact Topbar (52px <= 12% viewport height) */
.lele-topbar {
  flex: 0 0 auto;
  height: var(--header-h);
  min-height: var(--header-h);
  padding: 0 20px;
  background: color-mix(in srgb, var(--bg-canvas) 90%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  z-index: 20;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  padding: 4px 6px 4px 0;
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--text-primary);
}

.brand-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  flex-shrink: 0;
}

.nav-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 140ms ease, color 140ms ease;
}

.nav-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-tab[aria-selected="true"] {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--border);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
}

.nav-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.nav-badge.warn {
  background: var(--tone-warn-bg);
  color: var(--tone-warn);
  border: 1px solid var(--tone-warn-border);
}

.nav-badge.neutral {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.topbar-quiet-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  transition: background-color 140ms ease, color 140ms ease;
}

.topbar-quiet-status:hover {
  background: var(--bg-muted);
  color: var(--text-primary);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tone-open);
  flex-shrink: 0;
}

.status-dot.paused {
  background: var(--tone-warn);
}

/* Scoped Hearth Buttons */
.hearth-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 13px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  transition: transform 120ms ease, background-color 140ms ease, border-color 140ms ease;
}

.hearth-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.hearth-btn:active:not(:disabled) {
  scale: 0.97;
}

.hearth-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hearth-btn-primary {
  background: var(--ink-btn-bg);
  color: var(--ink-btn-fg);
  border-color: transparent;
}

.hearth-btn-primary:hover:not(:disabled) {
  background: var(--ink-btn-bg);
  opacity: 0.9;
}

.hearth-btn-warm {
  background: var(--tone-warn-bg);
  color: var(--tone-warn);
  border-color: var(--tone-warn-border);
}

.hearth-btn-soft {
  background: var(--bg-muted);
  border-color: transparent;
  color: var(--text-primary);
}

.hearth-btn-soft:hover:not(:disabled) {
  background: var(--bg-subtle-2);
}

.hearth-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-secondary);
  padding: 0 10px;
}

.hearth-btn-ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.hearth-btn-danger {
  background: var(--tone-danger-bg);
  color: var(--tone-danger);
  border-color: var(--tone-danger-border);
}

.hearth-btn-sm {
  height: 28px;
  padding: 0 11px;
  font-size: 12px;
}

/* Main Split Body & Scroll Container */
.hearth-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.hearth-scroll {
  container-type: inline-size;
  container-name: workbench;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 24px 28px 132px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.hearth-container {
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.hearth-workbench h1,
.hearth-workbench h2,
.hearth-workbench h3,
.live-headline {
  text-wrap: balance;
}

.hearth-workbench p {
  text-wrap: pretty;
}

.hearth-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
  box-shadow: var(--shadow-sm);
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}

.section-sub {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* Compact Hearth Header */
.hearth-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.hearth-copy {
  min-width: 0;
  flex: 1;
}

.eyebrow {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.live-headline {
  font-family: var(--font-serif);
  font-size: clamp(21px, 2.3vw, 27px);
  line-height: 1.42;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.hearth-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

/* Focus-First Accordion Sheet */
.inbox-sheet {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.inbox-row {
  border-bottom: 1px solid var(--border);
  transition: background-color 140ms ease;
}

.inbox-row:last-child {
  border-bottom: none;
}

.inbox-row.is-expanded {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--bg-surface);
}

.inbox-row.is-expanded.tone-open {
  box-shadow: inset 3px 0 0 var(--tone-open);
}

.inbox-row.is-expanded.tone-warn {
  box-shadow: inset 3px 0 0 var(--tone-warn);
}

.inbox-row.is-expanded.tone-danger {
  box-shadow: inset 3px 0 0 var(--tone-danger);
}

.inbox-row:not(.is-expanded) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px 10px 18px;
  background: color-mix(in srgb, var(--bg-canvas) 35%, var(--bg-surface));
  flex-wrap: wrap;
}

.inbox-row:not(.is-expanded):hover {
  background: color-mix(in srgb, var(--bg-muted) 65%, var(--bg-surface));
}

.inbox-summary-btn {
  flex: 1 1 260px;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border: none;
  background: transparent;
  padding: 3px 0;
  text-align: left;
  color: var(--text-primary);
}

.tone-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--tone-open);
}

.tone-dot.warn {
  background: var(--tone-warn);
}

.tone-dot.danger {
  background: var(--tone-danger);
}

.inbox-summary-tag {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
}

.inbox-summary-text {
  font-size: 13.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.inbox-quote {
  padding: 4px 0 4px 12px;
  border-left: 2px solid var(--border-strong);
  font-size: 15.5px;
  line-height: 1.62;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.action-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.action-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 500;
  border: 1px solid transparent;
  white-space: nowrap;
}

.pill-open {
  background: var(--tone-open-bg);
  color: var(--tone-open);
  border-color: var(--tone-open-border);
}

.pill-warn {
  background: var(--tone-warn-bg);
  color: var(--tone-warn);
  border-color: var(--tone-warn-border);
}

.pill-danger {
  background: var(--tone-danger-bg);
  color: var(--tone-danger);
  border-color: var(--tone-danger-border);
}

.pill-muted {
  background: var(--bg-muted);
  color: var(--text-secondary);
  border-color: var(--border);
}

.inline-reply-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.input-field {
  flex: 1;
  min-width: 190px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-size: 13px;
}

.input-rect {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-size: 13px;
}

.textarea-rect {
  width: 100%;
  min-height: 76px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-size: 13px;
  resize: vertical;
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.calm-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-radius: var(--radius-lg);
  background: var(--tone-open-bg);
  border: 1px solid var(--tone-open-border);
  color: var(--tone-open);
  font-size: 13px;
  font-weight: 500;
}

/* 24h Family Reachability Timeline */
.ruler-row {
  display: grid;
  grid-template-columns: 164px 1fr 120px;
  gap: 16px;
  align-items: center;
  margin-bottom: 10px;
}

.ruler-marks {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-tertiary);
}

.line-rows {
  display: flex;
  flex-direction: column;
}

.line-row {
  display: grid;
  grid-template-columns: 164px 1fr 120px;
  gap: 16px;
  align-items: center;
  padding: 14px 6px;
  border-bottom: 1px solid var(--border);
  transition: background-color 140ms ease;
}

.line-row:last-child {
  border-bottom: none;
  padding-bottom: 4px;
}

.line-row:hover {
  background: color-mix(in srgb, var(--bg-canvas) 65%, transparent);
}

.person-ident {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  text-align: left;
}

.avatar-badge {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}

.avatar-badge.open {
  background: var(--tone-open-bg);
  color: var(--tone-open);
  border: 1px solid var(--tone-open-border);
}

.avatar-badge.warn {
  background: var(--tone-warn-bg);
  color: var(--tone-warn);
  border: 1px solid var(--tone-warn-border);
}

.avatar-badge.closed {
  background: var(--bg-muted);
  color: var(--text-secondary);
  border: 1px dashed var(--border-strong);
}

.person-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
}

.person-sub {
  font-size: 12px;
  color: var(--text-secondary);
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-wrap {
  position: relative;
  height: 46px;
  display: flex;
  align-items: center;
  min-width: 0;
}

.track-base {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  border-top: 2px dashed var(--border-strong);
}

.track-solid {
  position: absolute;
  left: 0;
  top: -3px;
  height: 4px;
  border-radius: 999px;
  background: var(--tone-open);
}

.track-solid.warn {
  background: var(--tone-warn);
}

.track-pin {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.track-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--bg-surface);
  background: var(--tone-open);
  box-shadow: 0 0 0 1px var(--border-strong);
}

.track-dot.warn {
  background: var(--tone-warn);
}

.track-dot.closed {
  background: var(--text-tertiary);
}

.track-tag {
  position: absolute;
  top: -17px;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1;
  color: var(--text-tertiary);
}

.row-action-col {
  display: flex;
  justify-content: flex-end;
}

.timeline-foot {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

/* Multi-column Grids (base mobile-first single column; upgraded in container queries below) */
.two-col-grid,
.split-cards,
.wechat-layout,
.wizard-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  align-items: start;
}

/* Lists & Empty Hero */
.feed-list {
  display: flex;
  flex-direction: column;
}

.feed-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.feed-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.feed-item:first-child {
  padding-top: 2px;
}

.feed-left {
  display: flex;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.feed-time {
  color: var(--text-tertiary);
  font-size: 12px;
  min-width: 44px;
  padding-top: 1px;
}

.feed-title {
  color: var(--text-primary);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.feed-desc {
  color: var(--text-secondary);
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}

.empty-hero {
  text-align: left;
  padding: 26px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.onboarding-pillars {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.pillar-box {
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
}

/* People Tab */
.member-strip {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.member-chip-card {
  min-width: 158px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-surface);
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  transition: all 140ms ease;
}

.member-chip-card:hover {
  border-color: var(--border-strong);
}

.member-chip-card.active {
  border-color: var(--ink-btn-bg);
  box-shadow: 0 0 0 1px var(--ink-btn-bg);
}

.member-chip-add {
  min-width: 142px;
  border-style: dashed;
  background: transparent;
  color: var(--text-secondary);
  justify-content: center;
}

.member-chip-add:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.cap-card {
  padding: 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-canvas);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.cap-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.cap-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 3px;
}

.cap-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}

/* Accessible Switch */
.switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: var(--bg-subtle-2);
  border: 1px solid var(--border-strong);
  padding: 2px;
  transition: background-color 150ms ease;
  flex-shrink: 0;
}

.switch[aria-checked="true"] {
  background: var(--tone-open);
  border-color: var(--tone-open);
}

.switch-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fffdf9;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 150ms ease;
}

.switch[aria-checked="true"] .switch-thumb {
  transform: translateX(18px);
}

.segmented {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  border: 1px solid var(--border);
  gap: 2px;
  flex-wrap: wrap;
}

.seg-btn {
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.seg-btn.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
}

.memory-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}

.memory-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

/* Inline Subform Disclosure */
.subform-panel {
  margin-top: 12px;
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* Native Right Conversation Dock (mounted always; toggled with className) */
.hearth-dock {
  width: 392px;
  max-width: 44%;
  flex: 0 0 auto;
  border-left: 1px solid var(--border);
  background: var(--bg-surface);
  display: none;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.hearth-dock.is-open {
  display: flex;
}

.dock-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: 0 0 auto;
}

.dock-handoff {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--tone-warn-bg) 42%, var(--bg-surface));
  font-size: 12.5px;
  line-height: 1.5;
  flex: 0 0 auto;
}

.dock-starters {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-canvas) 60%, var(--bg-surface));
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.dock-session-body {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media (max-width: 1020px) {
  .hearth-dock.is-open {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 25;
    width: min(392px, 94%);
    max-width: none;
    box-shadow: var(--shadow-lg);
  }
}

/* Native Dialogs: closedby="any", scoped display on [open], strict scroll-chain containment */
dialog.hearth-dialog {
  margin: auto;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
  width: min(720px, calc(100vw - 28px));
  max-height: min(88vh, 760px);
  overflow: hidden;
}

dialog.hearth-dialog[open] {
  display: flex;
  flex-direction: column;
}

dialog.hearth-dialog.narrow {
  width: min(500px, calc(100vw - 28px));
}

dialog.hearth-dialog:modal {
  overscroll-behavior: contain;
}

dialog.hearth-dialog::backdrop {
  background: rgba(20, 18, 16, 0.52);
  backdrop-filter: blur(3px);
  overscroll-behavior: contain;
}

.dialog-inner {
  display: flex;
  flex-direction: column;
  max-height: min(88vh, 760px);
  min-height: 0;
}

.dialog-head {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
}

.dialog-body {
  padding: 20px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1 1 auto;
  min-height: 0;
}

.dialog-foot {
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: 0 0 auto;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.step-pill {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.step-pill.active {
  background: var(--ink-btn-bg);
  color: var(--ink-btn-fg);
  font-weight: 600;
}

.step-pill.done {
  background: var(--tone-open-bg);
  color: var(--tone-open);
  border: 1px solid var(--tone-open-border);
}

.qr-card {
  padding: 16px;
  border-radius: var(--radius-md);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.qr-box {
  padding: 10px;
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Undo Toast */
.toast-bar {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 45;
  display: none;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-radius: var(--radius-pill);
  background: var(--ink-btn-bg);
  color: var(--ink-btn-fg);
  font-size: 13px;
  box-shadow: var(--shadow-md);
  max-width: calc(100% - 32px);
}

.toast-bar.visible {
  display: inline-flex;
}

.toast-undo {
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  border-radius: var(--radius-pill);
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
}

/* Global Floating Lele Cat Steward */
.lele-steward-float {
  position: absolute;
  right: 22px;
  bottom: 18px;
  z-index: 34;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}

.lele-steward-float.is-hidden {
  display: none;
}

.lele-steward-float > * {
  pointer-events: auto;
}

.lele-nudge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(356px, calc(100vw - 48px));
  padding: 6px 9px 6px 13px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg-surface) 95%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-md);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.nudge-main {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: transparent;
  padding: 1px 0;
  min-width: 0;
  color: inherit;
  text-align: left;
}

.nudge-text {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.nudge-action {
  color: var(--tone-warn);
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.nudge-close {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.nudge-close:hover {
  background: var(--bg-muted);
  color: var(--text-primary);
}

.lele-whisper {
  position: relative;
  width: min(344px, calc(100vw - 48px));
  background: var(--bg-surface);
  border: 1px solid var(--tone-warn-border);
  border-radius: 16px;
  padding: 12px 14px;
  box-shadow: var(--shadow-lg), 0 0 0 1px color-mix(in srgb, var(--border-strong) 45%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lele-whisper::after {
  content: "";
  position: absolute;
  right: 22px;
  bottom: -6px;
  width: 11px;
  height: 11px;
  background: var(--bg-surface);
  border-right: 1px solid var(--tone-warn-border);
  border-bottom: 1px solid var(--tone-warn-border);
  transform: rotate(45deg);
}

.whisper-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.whisper-body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-primary);
}

.whisper-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.whisper-chip {
  border: 1px solid var(--border-strong);
  background: var(--bg-canvas);
  color: var(--text-primary);
  border-radius: var(--radius-pill);
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.35;
}

.whisper-chip:hover {
  background: var(--tone-warn-bg);
  border-color: var(--tone-warn-border);
  color: var(--tone-warn);
}

.whisper-compose {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}

.whisper-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-size: 12.5px;
}

.lele-orb-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 5px 6px 5px 15px;
  border-radius: var(--radius-pill);
  border: 1.5px solid var(--steward-orb-border);
  background: var(--steward-orb-bg);
  color: var(--steward-orb-fg);
  box-shadow: var(--shadow-lg), 0 0 0 1px rgba(240, 164, 88, 0.14);
  text-align: right;
  transition: box-shadow 150ms ease-out, scale 150ms ease-out, filter 150ms ease-out;
}

.lele-orb-btn:hover {
  box-shadow: var(--shadow-lg), 0 0 0 3px var(--steward-ring);
  filter: brightness(1.06);
}

.lele-orb-btn:active {
  scale: 0.97;
}

.orb-avatar-wrap {
  position: relative;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.orb-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(255, 253, 249, 0.45);
  background: var(--bg-surface);
  display: block;
}

.orb-avatar-ring {
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 2px solid var(--steward-ring);
  opacity: 0.72;
  pointer-events: none;
}

.orb-status-dot {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #46c88d;
  border: 2px solid #1d1814;
}

.orb-status-dot.warn {
  background: #f0a458;
}

.orb-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.2;
}

.orb-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
}

.orb-count {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: rgba(240, 164, 88, 0.22);
  color: #ffd09a;
  border: 1px solid rgba(240, 164, 88, 0.45);
  font-size: 11px;
  font-weight: 600;
}

.orb-sub {
  font-size: 11.5px;
  color: var(--steward-orb-sub);
  margin-top: 2px;
}

@media (prefers-reduced-motion: no-preference) {
  .lele-whisper.is-popping {
    animation: whisper-fade 160ms ease-out both;
  }
  .orb-avatar-ring.pulse {
    animation: orb-pulse 2.6s ease-out infinite;
  }
}

@keyframes whisper-fade {
  from { opacity: 0; scale: 0.94; }
}

@keyframes orb-pulse {
  0% { scale: 1; opacity: 0.78; }
  70% { scale: 1.22; opacity: 0; }
  100% { scale: 1.22; opacity: 0; }
}

/* Container Queries (placed LAST to win cascade cleanly over base single-col layout) */
@container workbench (min-width: 760px) {
  .two-col-grid {
    grid-template-columns: 1.08fr 0.92fr;
  }
  .split-cards {
    grid-template-columns: 1fr 1fr;
  }
  .wechat-layout {
    grid-template-columns: 1.05fr 0.95fr;
  }
  .wizard-grid {
    grid-template-columns: 0.92fr 1.08fr;
  }
}

@container workbench (max-width: 759px) {
  .hearth-head {
    flex-direction: column;
    align-items: flex-start;
  }
  .hearth-chips {
    justify-content: flex-start;
  }
  .ruler-row {
    display: none;
  }
  .line-row {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "person action"
      "track track";
    gap: 10px 12px;
  }
  .person-ident {
    grid-area: person;
  }
  .row-action-col {
    grid-area: action;
  }
  .track-wrap {
    grid-area: track;
    margin-top: 8px;
  }
}

@container workbench (max-width: 520px) {
  .hearth-scroll {
    padding: 16px 14px 120px;
  }
  .lele-topbar {
    padding: 0 12px;
  }
  .brand-title,
  .hide-narrow {
    display: none;
  }
  .hearth-card {
    padding: 14px;
  }
}
`;
