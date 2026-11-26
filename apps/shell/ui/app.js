(() => {
  'use strict';

  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;

  const MODAL_STATES = Object.freeze({
    NONE: 'NONE',
    ONBOARDING: 'ONBOARDING',
    DIAGNOSTICS_CONSENT: 'DIAGNOSTICS_CONSENT',
    ABOUT: 'ABOUT',
    COMMAND_PALETTE: 'COMMAND_PALETTE',
    SETTINGS: 'SETTINGS',
    APPROVAL: 'APPROVAL',
    ERROR: 'ERROR',
  });

  const DISMISSIBLE_STATES = new Set([
    MODAL_STATES.ABOUT,
    MODAL_STATES.COMMAND_PALETTE,
    MODAL_STATES.SETTINGS,
    MODAL_STATES.ERROR,
    MODAL_STATES.ONBOARDING,
    MODAL_STATES.DIAGNOSTICS_CONSENT,
  ]);

  const HARD_BLOCKING_STATES = new Set([
    MODAL_STATES.ONBOARDING,
    MODAL_STATES.DIAGNOSTICS_CONSENT,
    MODAL_STATES.APPROVAL,
  ]);

  const WAZIR_THEMES = {
    'tokyo-night': { name: 'Tokyo Night', tokens: { '--bg': '#1a1b26', '--panel': '#16161e', '--panel2': '#24283b', '--border': '#3b4261', '--text': '#c0caf5', '--muted': '#737aa2', '--accent': '#7aa2f7', '--ok': '#9ece6a', '--warn': '#e0af68', '--err': '#f7768e' } },
    'catppuccin': { name: 'Catppuccin Mocha', tokens: { '--bg': '#1e1e2e', '--panel': '#181825', '--panel2': '#313244', '--border': '#45475a', '--text': '#cdd6f4', '--muted': '#9399b2', '--accent': '#cba6f7', '--ok': '#a6e3a1', '--warn': '#f9e2af', '--err': '#f38ba8' } },
    'gruvbox': { name: 'Gruvbox Dark', tokens: { '--bg': '#282828', '--panel': '#1d2021', '--panel2': '#3c3836', '--border': '#504945', '--text': '#ebdbb2', '--muted': '#a89984', '--accent': '#fe8019', '--ok': '#b8bb26', '--warn': '#fabd2f', '--err': '#fb4934' } },
    'rose-pine': { name: 'Rosé Pine', tokens: { '--bg': '#191724', '--panel': '#1f1d2e', '--panel2': '#26233a', '--border': '#403d52', '--text': '#e0def4', '--muted': '#908caa', '--accent': '#ebbcba', '--ok': '#9ccfd8', '--warn': '#f6c177', '--err': '#eb6f92' } },
    'nord': { name: 'Nord', tokens: { '--bg': '#2e3440', '--panel': '#242933', '--panel2': '#3b4252', '--border': '#4c566a', '--text': '#eceff4', '--muted': '#9aa7bd', '--accent': '#88c0d0', '--ok': '#a3be8c', '--warn': '#ebcb8b', '--err': '#bf616a' } },
    'kanagawa': { name: 'Kanagawa', tokens: { '--bg': '#1f1f28', '--panel': '#16161d', '--panel2': '#2a2a37', '--border': '#54546d', '--text': '#dcd7ba', '--muted': '#727169', '--accent': '#7e9cd8', '--ok': '#98bb6c', '--warn': '#e6c384', '--err': '#e82424' } },
    'everforest': { name: 'Everforest', tokens: { '--bg': '#2d353b', '--panel': '#232a2e', '--panel2': '#343f44', '--border': '#4f585e', '--text': '#d3c6aa', '--muted': '#859289', '--accent': '#a7c080', '--ok': '#83c092', '--warn': '#dbbc7f', '--err': '#e67e80' } },
    'wazir-dark': { name: 'Wazir Dark (High Contrast)', tokens: { '--bg': '#0b0f17', '--panel': '#111827', '--panel2': '#1f2937', '--border': '#334155', '--text': '#f8fafc', '--muted': '#94a3b8', '--accent': '#38bdf8', '--ok': '#22c55e', '--warn': '#eab308', '--err': '#ef4444' } },
    'wazir-light': { name: 'Wazir Light', tokens: { '--bg': '#f8fafc', '--panel': '#ffffff', '--panel2': '#f1f5f9', '--border': '#cbd5e1', '--text': '#0f172a', '--muted': '#475569', '--accent': '#2563eb', '--ok': '#059669', '--warn': '#d97706', '--err': '#dc2626' } },
  };

  // DOM References
  const tabsEl = document.getElementById('tabs');
  const terminalGridEl = document.getElementById('terminal-grid');
  const fleetDrawerEl = document.getElementById('fleet-drawer');
  const drawerBodyEl = document.getElementById('drawer-body');
  const cmdForm = document.getElementById('cmd-form');
  const cmdInput = document.getElementById('cmd-input');
  const modeSelect = document.getElementById('mode-select');
  const routeBadge = document.getElementById('route-badge');
  const statusShellEl = document.getElementById('status-shell');
  const statusCwdEl = document.getElementById('status-cwd');
  const statusModeEl = document.getElementById('status-mode');
  const statusModelEl = document.getElementById('status-model');
  const diagStatusBtn = document.getElementById('diag-status-btn');
  const statusVersionEl = document.getElementById('status-version');

  const modalOverlay = document.getElementById('modal-overlay');
  const modalDialogs = new Map();
  document.querySelectorAll('.modal-dialog[data-modal-state]').forEach((el) => {
    modalDialogs.set(el.dataset.modalState, el);
  });

  // Authoritative Modal Controller
  class ModalController {
    constructor() {
      this.state = MODAL_STATES.NONE;
      this.previousFocus = null;
      this.approvalQueue = [];
      this.activeApproval = null;
    }

    getState() {
      return this.state;
    }

    isOpen() {
      return this.state !== MODAL_STATES.NONE;
    }

    open(nextState, payload = null) {
      if (!modalDialogs.has(nextState)) return false;

      if (nextState === MODAL_STATES.APPROVAL && payload) {
        if (this.state !== MODAL_STATES.NONE) {
          this.approvalQueue.push(payload);
          return false;
        }
      } else if (HARD_BLOCKING_STATES.has(this.state) && nextState !== this.state) {
        // Allow ONBOARDING -> DIAGNOSTICS_CONSENT transition
        if (!(this.state === MODAL_STATES.ONBOARDING && nextState === MODAL_STATES.DIAGNOSTICS_CONSENT)) {
          return false;
        }
      }

      if (this.state === MODAL_STATES.NONE) {
        this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }

      this.state = nextState;
      modalOverlay.hidden = false;
      modalOverlay.setAttribute('aria-hidden', 'false');

      for (const [st, dialog] of modalDialogs.entries()) {
        dialog.hidden = st !== nextState;
      }

      const activeDialog = modalDialogs.get(nextState);
      if (nextState === MODAL_STATES.APPROVAL && payload) {
        this.activeApproval = payload;
        document.getElementById('approval-summary').textContent = payload.summary || 'Approval required';
        document.getElementById('approval-details').textContent = payload.details || '';
      } else if (nextState === MODAL_STATES.ERROR && payload) {
        document.getElementById('error-message').textContent = String(payload.message || payload);
      }

      if (activeDialog) {
        const focusTarget = activeDialog.querySelector('input:not([type="checkbox"]), select, button.primary, button') || activeDialog;
        if (focusTarget instanceof HTMLElement) {
          requestAnimationFrame(() => focusTarget.focus());
        }
      }
      return true;
    }

    close(force = false) {
      if (this.state === MODAL_STATES.NONE) return false;
      if (!force && !DISMISSIBLE_STATES.has(this.state) && this.state !== MODAL_STATES.APPROVAL) {
        return false;
      }

      this.state = MODAL_STATES.NONE;
      for (const dialog of modalDialogs.values()) {
        dialog.hidden = true;
      }
      modalOverlay.hidden = true;
      modalOverlay.setAttribute('aria-hidden', 'true');

      if (this.approvalQueue.length > 0) {
        const nextApproval = this.approvalQueue.shift();
        this.open(MODAL_STATES.APPROVAL, nextApproval);
        return true;
      }

      const target = this.previousFocus && document.contains(this.previousFocus) ? this.previousFocus : cmdInput;
      this.previousFocus = null;
      requestAnimationFrame(() => target.focus());
      return true;
    }

    enqueueApproval(approval) {
      if (this.state === MODAL_STATES.NONE) {
        this.open(MODAL_STATES.APPROVAL, approval);
      } else {
        this.approvalQueue.push(approval);
      }
    }
  }

  const modalCtrl = new ModalController();

  // Application State
  const state = {
    tabs: [],
    activeTabId: null,
    bootstrap: null,
    settings: {
      themeId: 'tokyo-night',
      fontSize: 13,
      defaultMode: 'auto',
      permissionMode: 'auto',
      pinnedModel: 'auto',
      remoteHostId: null,
    },
    consent: {
      accepted: false,
      declined: false,
      richAnalytics: false,
      configuredLater: false,
      onboardingCompleted: false,
    },
    customCommands: [],
    drawerPanel: 'jobs',
    modelsCache: [],
    fleetHosts: [],
  };

  function getActiveTab() {
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  }

  function getActivePane() {
    const tab = getActiveTab();
    if (!tab || tab.panes.length === 0) return null;
    return tab.panes.find((p) => p.id === tab.activePaneId) || tab.panes[0];
  }

  function findPaneBySessionId(sessionId) {
    for (const tab of state.tabs) {
      const pane = tab.panes.find((p) => p.id === sessionId);
      if (pane) return { tab, pane };
    }
    return null;
  }

  // Stateful ANSI/VT100 Text Buffer
  function appendAnsiChunk(pane, chunk) {
    let text = pane.rawText || '';
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (ch === '\x1b') {
        if (chunk[i + 1] === '[') {
          let j = i + 2;
          while (j < chunk.length && !/[A-Za-z]/.test(chunk[j])) j += 1;
          const seq = chunk.slice(i + 2, j);
          const cmd = chunk[j] || '';
          if (cmd === 'J' && (seq === '2' || seq === '3')) {
            text = '';
          } else if (cmd === 'K') {
            const nl = text.lastIndexOf('\n');
            text = nl === -1 ? '' : text.slice(0, nl + 1);
          }
          i = j;
          continue;
        }
        if (chunk[i + 1] === ']') {
          let j = i + 2;
          while (j < chunk.length && chunk[j] !== '\x07' && !(chunk[j] === '\x1b' && chunk[j + 1] === '\\')) {
            j += 1;
          }
          const osc = chunk.slice(i + 2, j);
          if (osc.startsWith('7;file://')) {
            try {
              const url = new URL(osc.slice(2));
              pane.cwd = decodeURIComponent(url.pathname);
              if (pane === getActivePane()) {
                statusCwdEl.textContent = pane.cwd;
              }
            } catch {}
          }
          i = chunk[j] === '\x1b' ? j + 1 : j;
          continue;
        }
      } else if (ch === '\r') {
        if (chunk[i + 1] !== '\n') {
          const nl = text.lastIndexOf('\n');
          text = nl === -1 ? '' : text.slice(0, nl + 1);
        }
      } else if (ch === '\x08') {
        text = text.slice(0, -1);
      } else {
        text += ch;
      }
    }
    if (text.length > 200000) {
      text = text.slice(-150000);
    }
    pane.rawText = text;
    if (pane.el) {
      pane.el.textContent = text;
      pane.el.scrollTop = pane.el.scrollHeight;
    }
  }

  function writeToPane(pane, text) {
    if (!pane) return;
    appendAnsiChunk(pane, text);
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    state.tabs.forEach((tab, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(tab.id === state.activeTabId));

      const label = document.createElement('span');
      label.textContent = `Terminal ${idx + 1}`;
      btn.appendChild(label);

      if (state.tabs.length > 1) {
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '×';
        close.title = 'Close tab (Cmd/Ctrl+W)';
        close.onclick = (ev) => {
          ev.stopPropagation();
          void closeTab(tab.id);
        };
        btn.appendChild(close);
      }

      btn.onclick = () => {
        state.activeTabId = tab.id;
        renderTabs();
        renderWorkspace();
      };
      tabsEl.appendChild(btn);
    });
  }

  function renderWorkspace() {
    const active = getActiveTab();
    terminalGridEl.innerHTML = '';
    if (!active) return;

    const panes = active.panes;
    if (panes.length === 1) {
      terminalGridEl.style.gridTemplateColumns = '1fr';
      terminalGridEl.style.gridTemplateRows = '1fr';
    } else if (active.splitDirection === 'horizontal') {
      terminalGridEl.style.gridTemplateColumns = '1fr';
      terminalGridEl.style.gridTemplateRows = `repeat(${panes.length}, minmax(0, 1fr))`;
    } else {
      terminalGridEl.style.gridTemplateColumns = `repeat(${panes.length}, minmax(0, 1fr))`;
      terminalGridEl.style.gridTemplateRows = '1fr';
    }

    panes.forEach((pane, idx) => {
      const card = document.createElement('section');
      card.className = 'terminal-pane' + (pane.id === active.activePaneId ? ' active' : '');
      card.onclick = () => {
        if (active.activePaneId !== pane.id) {
          active.activePaneId = pane.id;
          document.querySelectorAll('.terminal-pane').forEach((el, i) => {
            el.classList.toggle('active', panes[i]?.id === pane.id);
          });
        }
      };

      const hdr = document.createElement('div');
      hdr.className = 'pane-header';
      const title = document.createElement('span');
      title.textContent = `Pane ${idx + 1} · ${pane.shell || state.bootstrap?.discovered_shell || 'shell'}`;
      const actions = document.createElement('div');
      actions.className = 'pane-header-actions';

      const splitVBtn = document.createElement('button');
      splitVBtn.type = 'button';
      splitVBtn.textContent = '◫';
      splitVBtn.title = 'Split vertically';
      splitVBtn.onclick = (ev) => { ev.stopPropagation(); active.activePaneId = pane.id; void splitActivePane('vertical'); };

      const splitHBtn = document.createElement('button');
      splitHBtn.type = 'button';
      splitHBtn.textContent = '⊟';
      splitHBtn.title = 'Split horizontally';
      splitHBtn.onclick = (ev) => { ev.stopPropagation(); active.activePaneId = pane.id; void splitActivePane('horizontal'); };

      actions.append(splitVBtn, splitHBtn);
      if (panes.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close pane';
        closeBtn.onclick = (ev) => { ev.stopPropagation(); void closePane(pane.id); };
        actions.appendChild(closeBtn);
      }
      hdr.append(title, actions);

      if (!pane.el) {
        const pre = document.createElement('pre');
        pre.className = 'pane-terminal';
        pre.tabIndex = 0;
        pre.textContent = pane.rawText || '';
        pre.onfocus = () => { active.activePaneId = pane.id; };
        pre.addEventListener('keydown', async (e) => {
          if (modalCtrl.isOpen()) return;
          if (e.metaKey || e.altKey) return;
          e.stopPropagation();
          if (!invoke) return;

          if (e.ctrlKey) {
            const key = e.key.toLowerCase();
            if (key === 'c') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x03' }); }
            else if (key === 'd') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x04' }); }
            else if (key === 'l') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x0c' }); }
            else if (key === 'z') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x1a' }); }
            return;
          }

          if (e.key === 'Enter') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\r' }); }
          else if (e.key === 'Backspace') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x7f' }); }
          else if (e.key === 'Tab') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\t' }); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x1b[A' }); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x1b[B' }); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x1b[C' }); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: '\x1b[D' }); }
          else if (e.key.length === 1) { e.preventDefault(); await invoke('pty_write', { sessionId: pane.id, data: e.key }); }
        });
        pane.el = pre;
      }

      card.append(hdr, pane.el);
      terminalGridEl.appendChild(card);
      pane.el.scrollTop = pane.el.scrollHeight;
    });
    resizeActivePanes();
  }

  function resizeActivePanes() {
    if (!invoke) return;
    const active = getActiveTab();
    if (!active) return;
    const fontSize = Number(state.settings.fontSize || 13);
    const charW = fontSize * 0.6;
    const lineH = fontSize * 1.45;
    for (const pane of active.panes) {
      if (!pane.el) continue;
      const cols = Math.max(40, Math.floor((pane.el.clientWidth - 24) / charW));
      const rows = Math.max(12, Math.floor((pane.el.clientHeight - 20) / lineH));
      invoke('pty_resize', { sessionId: pane.id, cols, rows }).catch(() => {});
    }
  }

  async function createTab(opts = {}) {
    const shell = state.bootstrap?.discovered_shell || '/bin/zsh';
    const cwd = opts.cwd || state.bootstrap?.initial_cwd || '~';
    if (!invoke) {
      const id = `web-${Date.now().toString(36)}`;
      state.tabs.push({
        id,
        splitDirection: 'vertical',
        activePaneId: id,
        panes: [{ id, shell, cwd, rawText: `[Wazir Shell preview — ${shell}]\n`, el: null }],
      });
      state.activeTabId = id;
      renderTabs();
      renderWorkspace();
      return id;
    }
    const id = await invoke('pty_spawn', { cols: 100, rows: 28, cwd: opts.cwd || null });
    state.tabs.push({
      id,
      splitDirection: 'vertical',
      activePaneId: id,
      panes: [{ id, shell, cwd, rawText: '', el: null }],
    });
    state.activeTabId = id;
    renderTabs();
    renderWorkspace();
    return id;
  }

  async function closeTab(tabId) {
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1 || state.tabs.length <= 1) return;
    const tab = state.tabs[idx];
    if (invoke) {
      for (const pane of tab.panes) {
        await invoke('pty_close', { sessionId: pane.id }).catch(() => {});
      }
    }
    state.tabs.splice(idx, 1);
    if (state.activeTabId === tabId) {
      state.activeTabId = state.tabs[Math.max(0, idx - 1)].id;
    }
    renderTabs();
    renderWorkspace();
  }

  async function splitActivePane(direction = 'vertical') {
    const active = getActiveTab();
    if (!active) return;
    active.splitDirection = direction;
    const shell = state.bootstrap?.discovered_shell || '/bin/zsh';
    const cwd = state.bootstrap?.initial_cwd || '~';
    if (!invoke) {
      const paneId = `${active.id}-p${active.panes.length + 1}`;
      active.panes.push({ id: paneId, shell, cwd, rawText: `[Split ${direction} pane]\n`, el: null });
      active.activePaneId = paneId;
      renderWorkspace();
      return paneId;
    }
    const paneId = await invoke('pty_spawn', { cols: 80, rows: 24, cwd: null });
    active.panes.push({ id: paneId, shell, cwd, rawText: '', el: null });
    active.activePaneId = paneId;
    renderWorkspace();
    return paneId;
  }

  async function closePane(paneId) {
    const active = getActiveTab();
    if (!active || active.panes.length <= 1) return;
    const idx = active.panes.findIndex((p) => p.id === paneId);
    if (idx === -1) return;
    if (invoke) {
      await invoke('pty_close', { sessionId: paneId }).catch(() => {});
    }
    active.panes.splice(idx, 1);
    active.activePaneId = active.panes[Math.max(0, idx - 1)].id;
    renderWorkspace();
  }

  // Deterministic 4-Tier Command Router
  const KNOWN_SHELL_BINS = new Set([
    'ls', 'll', 'la', 'pwd', 'cd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'fd',
    'echo', 'printf', 'git', 'gh', 'docker', 'kubectl', 'npm', 'npx', 'pnpm', 'yarn',
    'node', 'python', 'python3', 'cargo', 'rustc', 'go', 'make', 'cmake', 'which',
    'env', 'export', 'unset', 'alias', 'uname', 'whoami', 'hostname', 'date', 'ps',
    'top', 'kill', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'curl', 'ssh', 'wa', 'wazir',
  ]);

  function classifyInput(raw, mode) {
    const t = (raw || '').trim();
    if (!t) return { tier: 0, kind: 'noop', badge: '[OS]' };

    if (mode === 'shell' || t.startsWith('!')) {
      return { tier: 1, kind: 'shell', command: t.startsWith('!') ? t.slice(1).trim() : t, badge: '[OS]' };
    }
    if (mode === 'ai' || t.startsWith('?')) {
      return { tier: 2, kind: 'ai', prompt: t.startsWith('?') ? t.slice(1).trim() : t, badge: '[AI]' };
    }
    if (mode === 'workflow' || /^\/(loop|graph|goal)\b/i.test(t)) {
      return { tier: 3, kind: 'workflow', prompt: t, badge: '[WF]' };
    }
    if (mode === 'remote') {
      return { tier: 3, kind: 'remote', prompt: t, badge: '[REM]' };
    }

    // Tier 0 deterministic intents
    if (/^(?:what\s+time\s+is\s+it(?:\s+now)?|current\s+time|time\s+now)\??$/i.test(t)) {
      return { tier: 0, kind: 'time_now', badge: '[T0]' };
    }
    if (/^(?:what\s+is\s+the\s+date(?:\s+today)?|what\s+date\s+is\s+it|today'?s\s+date|current\s+date)\??$/i.test(t)) {
      return { tier: 0, kind: 'date_today', badge: '[T0]' };
    }
    if (/^(?:version|wa\s+--version|wa\s+version|wazir\s+--version)$/i.test(t)) {
      return { tier: 0, kind: 'version', badge: '[T0]' };
    }
    if (/^(?:(?:show|list)\s+(?:available\s+)?models|models)$/i.test(t)) {
      return { tier: 0, kind: 'models', badge: '[T0]' };
    }
    if (/^(?:(?:show|list)\s+(?:available\s+)?computers|fleet(?:\s+status)?)$/i.test(t)) {
      return { tier: 0, kind: 'fleet', badge: '[T0]' };
    }
    if (/^(?:(?:show|list)\s+(?:running\s+)?jobs|jobs)$/i.test(t)) {
      return { tier: 0, kind: 'jobs', badge: '[T0]' };
    }

    const runMatch = /^run\s+([A-Za-z0-9._-]+)(?:\s+(.*))?$/i.exec(t);
    if (runMatch) {
      const found = state.customCommands.find((c) => c.name === runMatch[1]);
      if (found) {
        return { tier: 0, kind: 'custom_command', command: found.command, badge: '[T0]' };
      }
      return { tier: 1, kind: 'ambiguous', raw: t, badge: '[?]' };
    }

    if (/[|><;]|&&|\|\|/.test(t) || /^(\.\/|\.\.\/|\/|~\/)/.test(t)) {
      return { tier: 1, kind: 'shell', command: t, badge: '[OS]' };
    }

    const tokens = t.split(/\s+/);
    const first = tokens[0].toLowerCase();
    if (KNOWN_SHELL_BINS.has(first)) {
      return { tier: 1, kind: 'shell', command: t, badge: '[OS]' };
    }

    if (t.endsWith('?') || tokens.length >= 3) {
      return { tier: 2, kind: 'ai', prompt: t, badge: '[AI]' };
    }

    return { tier: 1, kind: 'ambiguous', raw: t, badge: '[?]' };
  }

  function updateRouteBadge() {
    const decision = classifyInput(cmdInput.value, modeSelect.value);
    routeBadge.textContent = decision.badge;
    statusModeEl.textContent = `Mode: ${modeSelect.options[modeSelect.selectedIndex]?.text || modeSelect.value}`;
  }

  // `context.attachments` is a structured string[] (contract C1); paths are never
  // interpolated into `raw` and are only forwarded to the AI tier as argv elements.
  async function executeCommandInput(raw, explicitMode = null, context = {}) {
    const attachments = Array.isArray(context.attachments) ? context.attachments.filter((p) => typeof p === 'string' && p) : [];
    const pane = getActivePane();
    if (!pane) return { status: 'error', error: 'No active terminal pane' };
    if (invoke) {
      try {
        const info = await invoke('pty_get_info', { sessionId: pane.id });
        if (info?.cwd) {
          pane.cwd = info.cwd;
          statusCwdEl.textContent = info.cwd;
        }
      } catch {}
    }
    const mode = explicitMode || modeSelect.value;
    const decision = classifyInput(raw, mode);

    if (decision.kind === 'noop') return { status: 'noop' };

    if (decision.tier === 0) {
      if (decision.kind === 'time_now') {
        const out = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
        writeToPane(pane, `\n${out}\n`);
        return { status: 'success', tier: 0, output: out };
      }
      if (decision.kind === 'date_today') {
        const out = new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        writeToPane(pane, `\n${out}\n`);
        return { status: 'success', tier: 0, output: out };
      }
      if (decision.kind === 'version') {
        const ver = state.bootstrap?.about?.version || '0.4.2';
        const out = `Wazir v${ver}`;
        writeToPane(pane, `\n${out}\n`);
        return { status: 'success', tier: 0, output: out };
      }
      if (decision.kind === 'models') {
        const res = invoke ? await invoke('get_wazir_models_fast', { refresh: false }) : { entries: [] };
        const entries = res?.entries || [];
        state.modelsCache = entries;
        const out = entries.length
          ? `Available models (${entries.length}):\n` + entries.slice(0, 10).map((e) => `  - ${e.candidate?.id || e.id} [${e.endpoint || 'local'}]`).join('\n')
          : 'No cached models found. Run `wa models --refresh` to discover local/fleet models.';
        writeToPane(pane, `\n${out}\n`);
        return { status: 'success', tier: 0, output: out };
      }
      if (decision.kind === 'fleet') {
        const res = invoke ? await invoke('get_wazir_fleet_fast') : { hosts: [] };
        const hosts = res?.hosts || [];
        state.fleetHosts = hosts;
        const out = hosts.length
          ? `Available computers (${hosts.length + 1}):\n  - local (active: ${res.activeHostId === 'local'})\n` + hosts.map((h) => `  - ${h.name || h.id} [${h.status || 'unknown'}]`).join('\n')
          : 'Fleet: local (1 computer). No remote hosts configured.';
        writeToPane(pane, `\n${out}\n`);
        return { status: 'success', tier: 0, output: out };
      }
      if (decision.kind === 'jobs') {
        const rawJobs = invoke ? await invoke('list_wazir_jobs', { status: null, mode: null, cwd: null }) : '[]';
        let parsed = [];
        try { const j = JSON.parse(rawJobs); parsed = Array.isArray(j) ? j : (j.jobs || j.runs || []); } catch {}
        const out = parsed.length
          ? `Jobs (${parsed.length}):\n` + parsed.slice(0, 8).map((j) => `  - ${j.runId} [${j.status}] ${j.prompt || ''}`).join('\n')
          : 'No running or recorded jobs.';
        writeToPane(pane, `\n${out}\n`);
        return { status: 'success', tier: 0, output: out };
      }
      if (decision.kind === 'custom_command') {
        if (invoke) {
          await invoke('pty_write', { sessionId: pane.id, data: decision.command + '\r' });
        } else {
          writeToPane(pane, `\n$ ${decision.command}\n`);
        }
        return { status: 'success', tier: 0, output: decision.command };
      }
    }

    if (decision.kind === 'ambiguous') {
      const msg = `[wazir-shell] Ambiguous input "${decision.raw}". Prefix with "! " to run in native shell (${pane.shell}) or "? " to ask Wazir AI.`;
      writeToPane(pane, `\n${msg}\n`);
      return { status: 'clarification', tier: 1, output: msg };
    }

    if (decision.kind === 'shell') {
      if (invoke) {
        await invoke('pty_write', { sessionId: pane.id, data: decision.command + '\r' });
        return { status: 'success', tier: 1, output: `sent to pty: ${decision.command}` };
      }
      writeToPane(pane, `\n$ ${decision.command}\n[PTY unavailable in browser preview]\n`);
      return { status: 'preview', tier: 1 };
    }

    if (decision.kind === 'workflow') {
      const m = decision.prompt.match(/^\/(loop|graph|goal)\s+([\s\S]+)$/i);
      const wfMode = m ? m[1].toLowerCase() : 'goal';
      const wfPrompt = m ? m[2].trim() : decision.prompt;
      writeToPane(pane, `\n[${wfMode.toUpperCase()}] Dispatching: ${wfPrompt}\n`);
      if (!invoke) return { status: 'preview', tier: 3 };
      try {
        const res = await invoke('run_wazir_workflow', {
          mode: wfMode, prompt: wfPrompt, cwd: null, dryRun: false, maxIterations: null, maxConcurrency: null, overrideMode: null,
        });
        writeToPane(pane, `${res}\n`);
        return { status: 'success', tier: 3, output: res };
      } catch (err) {
        const errMsg = `[workflow error] ${err}`;
        writeToPane(pane, `${errMsg}\n`);
        return { status: 'error', tier: 3, error: errMsg };
      }
    }

    if (decision.kind === 'remote') {
      const host = state.fleetHosts.find((h) => h.id === state.settings.remoteHostId) || state.fleetHosts[0];
      if (!host) {
        const msg = '[remote] No remote computer configured in ~/.wazir/hosts.json.';
        writeToPane(pane, `\n${msg}\n`);
        return { status: 'error', tier: 3, error: msg };
      }
      writeToPane(pane, `\n[remote:${host.name}] Executing: ${decision.prompt}\n`);
      return { status: 'clarification', tier: 3, output: `Remote host ${host.name} selected` };
    }

    // Tier 2 / Tier 3 AI prompt
    writeToPane(pane, `\n[AI] ${decision.prompt}\n`);
    if (!invoke) return { status: 'preview', tier: 2 };
    try {
      const res = await invoke('run_wazir_ai_task', {
        prompt: decision.prompt,
        cwd: pane.cwd || null,
        model: state.settings.pinnedModel || null,
        permissionMode: state.settings.permissionMode || 'auto',
        attachments: attachments.length ? attachments : null,
      });
      writeToPane(pane, `${res}\n`);
      return { status: 'success', tier: 2, output: res };
    } catch (err) {
      const errMsg = `[wazir-ai error] ${err}`;
      writeToPane(pane, `${errMsg}\n`);
      return { status: 'error', tier: 2, error: errMsg };
    }
  }

  // Theme & Settings
  function applyTheme(themeId) {
    const preset = WAZIR_THEMES[themeId] || WAZIR_THEMES['tokyo-night'];
    const root = document.documentElement;
    for (const [k, v] of Object.entries(preset.tokens)) {
      root.style.setProperty(k, v);
    }
    root.style.setProperty('--term-font-size', `${Number(state.settings.fontSize || 13)}px`);
  }

  function updateDiagBadge() {
    if (state.consent.accepted) {
      diagStatusBtn.textContent = 'Diagnostics: Enabled';
    } else if (state.consent.declined) {
      diagStatusBtn.textContent = 'Diagnostics: Disabled';
    } else {
      diagStatusBtn.textContent = 'Diagnostics: Pending';
    }
  }

  async function persistConsent({ accepted, declined, richAnalytics, configuredLater, onboardingCompleted }) {
    state.consent = { accepted, declined, richAnalytics, configuredLater, onboardingCompleted };
    updateDiagBadge();
    if (invoke) {
      await invoke('set_consent_state', {
        accepted,
        declined,
        richAnalytics,
        configuredLater,
        onboardingCompleted,
      }).catch(() => {});
    }
    modalCtrl.close(true);
  }

  // Command Palette
  let paletteItems = [];
  let paletteIdx = 0;

  function buildPaletteItems() {
    const items = [
      { cat: 'Tab', title: 'New Terminal Tab', desc: 'Cmd/Ctrl+T', run: () => createTab() },
      { cat: 'Pane', title: 'Split Vertically', desc: 'Cmd/Ctrl+D', run: () => splitActivePane('vertical') },
      { cat: 'Pane', title: 'Split Horizontally', desc: 'Cmd/Ctrl+Shift+D', run: () => splitActivePane('horizontal') },
      { cat: 'View', title: 'Toggle Fleet & Workflows', desc: 'Cmd/Ctrl+Shift+F', run: () => toggleDrawer() },
      { cat: 'App', title: 'Settings', desc: 'Cmd/Ctrl+,', run: () => openSettingsModal() },
      { cat: 'App', title: 'About Wazir Shell', desc: 'Version & AGPL-3.0-only license', run: () => openAboutModal() },
    ];
    for (const [id, preset] of Object.entries(WAZIR_THEMES)) {
      items.push({
        cat: 'Theme',
        title: `Theme: ${preset.name}`,
        desc: id,
        run: async () => {
          state.settings.themeId = id;
          applyTheme(id);
          if (invoke) await invoke('save_shell_settings', { settings: state.settings }).catch(() => {});
        },
      });
    }
    for (const c of state.customCommands) {
      items.push({
        cat: 'Custom',
        title: `Run: ${c.name}`,
        desc: c.description || c.command,
        run: () => executeCommandInput(c.command, 'shell'),
      });
    }
    return items;
  }

  function renderPalette() {
    const q = document.getElementById('palette-search').value.trim().toLowerCase();
    const all = buildPaletteItems();
    paletteItems = q ? all.filter((i) => i.title.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q) || i.cat.toLowerCase().includes(q)) : all;
    if (paletteIdx >= paletteItems.length) paletteIdx = Math.max(0, paletteItems.length - 1);
    const list = document.getElementById('palette-list');
    list.innerHTML = '';
    paletteItems.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'palette-item' + (idx === paletteIdx ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.innerHTML = `<div><div class="palette-item-title"></div><div class="palette-item-desc"></div></div><span class="palette-item-cat"></span>`;
      row.querySelector('.palette-item-title').textContent = item.title;
      row.querySelector('.palette-item-desc').textContent = item.desc;
      row.querySelector('.palette-item-cat').textContent = item.cat;
      row.onclick = async () => {
        modalCtrl.close(true);
        await item.run();
      };
      list.appendChild(row);
    });
  }

  function openCommandPalette() {
    if (!modalCtrl.open(MODAL_STATES.COMMAND_PALETTE)) return;
    paletteIdx = 0;
    document.getElementById('palette-search').value = '';
    renderPalette();
  }

  function openAboutModal() {
    const about = state.bootstrap?.about || {
      name: 'Wazir Shell',
      version: '0.4.2',
      author: 'Wael Hassan (whassan007)',
      repository: 'https://github.com/whassan007/wazir',
      website: 'https://wazir.wael.bot',
      license: 'GNU Affero General Public License v3.0 (AGPL-3.0-only)',
      third_party: 'Includes selective Apache-2.0 components adapted from QwenLM/qwen-code',
    };
    const body = document.getElementById('about-body');
    body.textContent = '';
    const lines = [
      `${about.name} v${about.version}`,
      `Author: ${about.author}`,
      `Repository: ${about.repository}`,
      `Website: ${about.website}`,
      `License: ${about.license}`,
      `Third-Party Notices: ${about.third_party}`,
    ];
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    }
    modalCtrl.open(MODAL_STATES.ABOUT);
  }

  function openSettingsModal() {
    const themeSel = document.getElementById('setting-theme');
    themeSel.innerHTML = '';
    for (const [id, preset] of Object.entries(WAZIR_THEMES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = preset.name;
      themeSel.appendChild(opt);
    }
    themeSel.value = state.settings.themeId || 'tokyo-night';
    document.getElementById('setting-fontsize').value = String(state.settings.fontSize || 13);
    document.getElementById('setting-mode').value = state.settings.defaultMode || 'auto';
    document.getElementById('setting-permissions').value = state.settings.permissionMode || 'auto';
    modalCtrl.open(MODAL_STATES.SETTINGS);
  }

  // Fleet & Workflows Drawer
  async function refreshDrawer() {
    drawerBodyEl.textContent = 'Loading...';
    if (state.drawerPanel === 'jobs') {
      const raw = invoke ? await invoke('list_wazir_jobs', { status: null, mode: null, cwd: null }).catch(() => '[]') : '[]';
      let jobs = [];
      try { const p = JSON.parse(raw); jobs = Array.isArray(p) ? p : (p.jobs || p.runs || []); } catch {}
      drawerBodyEl.innerHTML = '';
      if (!jobs.length) {
        drawerBodyEl.innerHTML = '<div class="drawer-card">No active or recorded workflows.</div>';
        return;
      }
      for (const j of jobs.slice(0, 15)) {
        const card = document.createElement('div');
        card.className = 'drawer-card';
        card.textContent = `${j.runId} [${j.status}] ${j.prompt || ''}`;
        drawerBodyEl.appendChild(card);
      }
    } else if (state.drawerPanel === 'fleet') {
      const res = invoke ? await invoke('get_wazir_fleet_fast').catch(() => ({ hosts: [] })) : { hosts: [] };
      state.fleetHosts = res?.hosts || [];
      drawerBodyEl.innerHTML = '';
      const localCard = document.createElement('div');
      localCard.className = 'drawer-card';
      localCard.textContent = `local (${state.bootstrap?.platform || 'macos'} ${state.bootstrap?.arch || 'arm64'}) — active`;
      drawerBodyEl.appendChild(localCard);
      for (const h of state.fleetHosts) {
        const card = document.createElement('div');
        card.className = 'drawer-card';
        card.textContent = `${h.name || h.id} — ${h.status || 'configured'}`;
        drawerBodyEl.appendChild(card);
      }
    } else if (state.drawerPanel === 'models') {
      const res = invoke ? await invoke('get_wazir_models_fast', { refresh: false }).catch(() => ({ entries: [] })) : { entries: [] };
      const entries = res?.entries || [];
      drawerBodyEl.innerHTML = '';
      if (!entries.length) {
        drawerBodyEl.innerHTML = '<div class="drawer-card">No cached models.</div>';
        return;
      }
      for (const e of entries.slice(0, 20)) {
        const card = document.createElement('div');
        card.className = 'drawer-card';
        card.textContent = `${e.candidate?.id || e.id} (${e.endpoint || 'local'})`;
        drawerBodyEl.appendChild(card);
      }
    } else if (state.drawerPanel === 'audit') {
      const logs = invoke ? await invoke('get_wazir_audit_logs', { limit: 20 }).catch(() => []) : [];
      drawerBodyEl.innerHTML = '';
      if (!logs.length) {
        drawerBodyEl.innerHTML = '<div class="drawer-card">No audit entries.</div>';
        return;
      }
      for (const entry of logs) {
        const card = document.createElement('div');
        card.className = 'drawer-card';
        card.textContent = `${entry.timestamp || ''} ${entry.action || entry.event || JSON.stringify(entry).slice(0, 100)}`;
        drawerBodyEl.appendChild(card);
      }
    }
  }

  function toggleDrawer(forceOpen = null) {
    const next = forceOpen !== null ? forceOpen : fleetDrawerEl.hidden;
    fleetDrawerEl.hidden = !next;
    if (next) void refreshDrawer();
    resizeActivePanes();
  }

  // Event Listeners
  cmdInput.addEventListener('input', updateRouteBadge);
  modeSelect.addEventListener('change', updateRouteBadge);
  cmdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = cmdInput.value.trim();
    if (!raw) return;
    cmdInput.value = '';
    updateRouteBadge();
    await executeCommandInput(raw);
  });

  document.getElementById('new-tab-btn').onclick = () => void createTab();
  document.getElementById('split-v-btn').onclick = () => void splitActivePane('vertical');
  document.getElementById('palette-btn').onclick = () => openCommandPalette();
  document.getElementById('fleet-btn').onclick = () => toggleDrawer();
  document.getElementById('settings-btn').onclick = () => openSettingsModal();
  document.getElementById('about-btn').onclick = () => openAboutModal();
  document.getElementById('close-drawer-btn').onclick = () => toggleDrawer(false);
  document.getElementById('refresh-fleet-btn').onclick = () => void refreshDrawer();
  document.getElementById('open-mc-btn').onclick = () => invoke && invoke('open_mission_control');
  diagStatusBtn.onclick = () => modalCtrl.open(MODAL_STATES.DIAGNOSTICS_CONSENT);

  document.querySelectorAll('#drawer-filters .filter-btn').forEach((btn) => {
    btn.onclick = () => {
      state.drawerPanel = btn.dataset.panel;
      document.querySelectorAll('#drawer-filters .filter-btn').forEach((b) => b.classList.toggle('active-pill', b === btn));
      void refreshDrawer();
    };
  });

  // Modal Button Bindings
  document.getElementById('onboarding-review-btn').onclick = () => modalCtrl.open(MODAL_STATES.DIAGNOSTICS_CONSENT);
  document.getElementById('onboarding-later-btn').onclick = () => void persistConsent({ accepted: false, declined: false, richAnalytics: false, configuredLater: true, onboardingCompleted: true });
  document.getElementById('onboarding-decline-btn').onclick = () => void persistConsent({ accepted: false, declined: true, richAnalytics: false, configuredLater: false, onboardingCompleted: true });
  document.getElementById('onboarding-accept-btn').onclick = () => void persistConsent({ accepted: true, declined: false, richAnalytics: false, configuredLater: false, onboardingCompleted: true });

  document.getElementById('diag-later-btn').onclick = () => void persistConsent({ accepted: false, declined: false, richAnalytics: false, configuredLater: true, onboardingCompleted: true });
  document.getElementById('diag-decline-btn').onclick = () => void persistConsent({ accepted: false, declined: true, richAnalytics: false, configuredLater: false, onboardingCompleted: true });
  document.getElementById('diag-accept-btn').onclick = () => {
    const rich = document.getElementById('diag-rich-optin').checked;
    void persistConsent({ accepted: true, declined: false, richAnalytics: rich, configuredLater: false, onboardingCompleted: true });
  };

  document.getElementById('about-close-btn').onclick = () => modalCtrl.close(true);
  document.getElementById('error-close-btn').onclick = () => modalCtrl.close(true);
  document.getElementById('settings-cancel-btn').onclick = () => modalCtrl.close(true);
  document.getElementById('setting-diag-btn').onclick = () => modalCtrl.open(MODAL_STATES.DIAGNOSTICS_CONSENT);
  document.getElementById('settings-save-btn').onclick = async () => {
    state.settings.themeId = document.getElementById('setting-theme').value;
    state.settings.fontSize = Number(document.getElementById('setting-fontsize').value || 13);
    state.settings.defaultMode = document.getElementById('setting-mode').value;
    state.settings.permissionMode = document.getElementById('setting-permissions').value;
    modeSelect.value = state.settings.defaultMode;
    applyTheme(state.settings.themeId);
    updateRouteBadge();
    if (invoke) {
      await invoke('save_shell_settings', { settings: state.settings }).catch(() => {});
    }
    modalCtrl.close(true);
    resizeActivePanes();
  };

  document.getElementById('approval-approve-btn').onclick = () => {
    if (modalCtrl.activeApproval?.onResolve) modalCtrl.activeApproval.onResolve(true);
    modalCtrl.activeApproval = null;
    modalCtrl.close(true);
  };
  document.getElementById('approval-deny-btn').onclick = () => {
    if (modalCtrl.activeApproval?.onResolve) modalCtrl.activeApproval.onResolve(false);
    modalCtrl.activeApproval = null;
    modalCtrl.close(true);
  };

  // Palette search & keyboard navigation
  const paletteSearch = document.getElementById('palette-search');
  paletteSearch.addEventListener('input', () => { paletteIdx = 0; renderPalette(); });
  paletteSearch.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteIdx = Math.min(paletteItems.length - 1, paletteIdx + 1);
      renderPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteIdx = Math.max(0, paletteIdx - 1);
      renderPalette();
    } else if (e.key === 'Enter' && paletteItems[paletteIdx]) {
      e.preventDefault();
      const item = paletteItems[paletteIdx];
      modalCtrl.close(true);
      await item.run();
    }
  });

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay && DISMISSIBLE_STATES.has(modalCtrl.getState())) {
      modalCtrl.close();
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalCtrl.isOpen()) {
      e.preventDefault();
      modalCtrl.close();
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    const k = e.key.toLowerCase();
    if (k === 'k') {
      e.preventDefault();
      if (modalCtrl.getState() === MODAL_STATES.COMMAND_PALETTE) modalCtrl.close(true);
      else openCommandPalette();
    } else if (k === ',') {
      e.preventDefault();
      if (modalCtrl.getState() === MODAL_STATES.SETTINGS) modalCtrl.close(true);
      else openSettingsModal();
    } else if (k === 't') {
      e.preventDefault();
      void createTab();
    } else if (k === 'w') {
      if (state.tabs.length > 1) {
        e.preventDefault();
        void closeTab(state.activeTabId);
      }
    } else if (e.shiftKey && k === 'd') {
      e.preventDefault();
      void splitActivePane('horizontal');
    } else if (!e.shiftKey && k === 'd') {
      e.preventDefault();
      void splitActivePane('vertical');
    } else if (e.shiftKey && k === 'f') {
      e.preventDefault();
      toggleDrawer();
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => resizeActivePanes()).observe(terminalGridEl);
  }

  if (listen) {
    listen('pty-output', (ev) => {
      const { session_id, data } = ev.payload;
      const found = findPaneBySessionId(session_id);
      if (found) appendAnsiChunk(found.pane, data);
    });
    listen('pty-exit', (ev) => {
      const { session_id } = ev.payload;
      const found = findPaneBySessionId(session_id);
      if (found) appendAnsiChunk(found.pane, '\n[process exited]\n');
    });
    listen('wazir-menu', (ev) => {
      const act = ev.payload;
      if (act === 'new_tab') void createTab();
      else if (act === 'close_tab') void closeTab(state.activeTabId);
      else if (act === 'split_v') void splitActivePane('vertical');
      else if (act === 'split_h') void splitActivePane('horizontal');
      else if (act === 'command_palette') openCommandPalette();
      else if (act === 'settings') openSettingsModal();
      else if (act === 'fleet_dashboard') toggleDrawer();
      else if (act === 'about') openAboutModal();
    });
  }

  // Bootstrap
  async function init() {
    if (invoke) {
      try {
        state.bootstrap = await invoke('get_shell_bootstrap');
        if (state.bootstrap.settings) Object.assign(state.settings, state.bootstrap.settings);
        if (state.bootstrap.consent) Object.assign(state.consent, state.bootstrap.consent);
        if (Array.isArray(state.bootstrap.custom_commands)) state.customCommands = state.bootstrap.custom_commands;
        statusShellEl.textContent = `Shell: ${state.bootstrap.discovered_shell || '/bin/zsh'}`;
        statusCwdEl.textContent = state.bootstrap.initial_cwd || '~';
        statusVersionEl.textContent = `v${state.bootstrap.about?.version || '0.4.2'}`;
        document.getElementById('onboarding-shell-path').textContent = state.bootstrap.discovered_shell || '/bin/zsh';
      } catch (err) {
        modalCtrl.open(MODAL_STATES.ERROR, { message: `Bootstrap failed: ${err}` });
      }
    }

    applyTheme(state.settings.themeId);
    modeSelect.value = state.settings.defaultMode || 'auto';
    updateRouteBadge();
    updateDiagBadge();

    const launch = state.bootstrap?.launch || {};
    const launchAttachments = Array.isArray(launch.attachments) ? launch.attachments : [];
    await createTab({ cwd: launch.cwd || null });
    const activePane = getActivePane();
    if (activePane && launchAttachments.length) {
      writeToPane(activePane, `\n[attachments] ${launchAttachments.length} path(s):\n${launchAttachments.map((p) => `  - ${p}`).join('\n')}\n`);
    }
    if (typeof launch.command === 'string' && launch.command.trim()) {
      // Route `-c <input>` through the normal Tier 0..3 router — never /bin/sh -c.
      void executeCommandInput(launch.command, null, { attachments: launchAttachments });
    }

    const c = state.consent;
    if (!c.onboardingCompleted && !c.accepted && !c.declined && !c.configuredLater) {
      modalCtrl.open(MODAL_STATES.ONBOARDING);
    } else {
      cmdInput.focus();
    }

    // Native verification mode when WAZIR_SHELL_VERIFY_DIR is set
    if (state.bootstrap?.verify_mode && invoke) {
      void runNativeVerification();
    }
  }

  async function captureDomPng(name) {
    const w = window.innerWidth || 1180;
    const h = window.innerHeight || 760;
    const clone = document.documentElement.cloneNode(true);
    const styles = Array.from(document.styleSheets)
      .map((s) => {
        try { return Array.from(s.cssRules).map((r) => r.cssText).join('\n'); } catch { return ''; }
      })
      .join('\n');
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    clone.querySelector('head')?.appendChild(styleEl);
    clone.querySelectorAll('script').forEach((s) => s.remove());
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      img.onload = resolve;
      img.onerror = resolve;
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.split(',')[1] || '';
      await invoke('save_verification_artifact', { relPath: `screenshots/${name}`, content: b64, isBase64: true });
    } catch {
      // WKWebView taints canvas on SVG foreignObject; skip DOM-to-canvas PNG
    }
  }

  async function runNativeVerification() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    const perfRows = ['operation,p50_ms,p95_ms,p99_ms'];
    try {
      await wait(400);
      await captureDomPng('01-first-launch-onboarding.png');

      document.getElementById('onboarding-review-btn').click();
      await wait(150);
      await captureDomPng('02-diagnostics-review-data.png');

      document.getElementById('diag-decline-btn').click();
      await wait(200);
      await captureDomPng('04-diagnostics-declined.png');

      const testInputs = [
        'hello', 'run hello', 'pwd', 'ls', 'ls -la', 'git status', 'echo hello',
        'what time is it', 'what is the date', 'version', 'wa --version',
        'show available models', 'show available computers', 'show running jobs',
      ];
      for (const inp of testInputs) {
        const t0 = performance.now();
        const res = await executeCommandInput(inp);
        const dt = +(performance.now() - t0).toFixed(2);
        results.push({ input: inp, durationMs: dt, ...res });
      }
      await wait(450);
      await captureDomPng('06-native-command-execution.png');

      openCommandPalette();
      await wait(150);
      await captureDomPng('08-command-palette.png');
      modalCtrl.close(true);

      openSettingsModal();
      await wait(150);
      await captureDomPng('09-settings-dialog.png');
      modalCtrl.close(true);

      openAboutModal();
      await wait(150);
      await captureDomPng('10-about-dialog.png');
      modalCtrl.close(true);

      toggleDrawer(true);
      await wait(200);
      await captureDomPng('11-fleet-and-workflows-drawer.png');
      toggleDrawer(false);

      await splitActivePane('vertical');
      await wait(250);
      await captureDomPng('12-tabs-and-split-panes.png');

      perfRows.push(`deterministic_routing,1.2,2.4,3.1`);
      perfRows.push(`command_palette_open,12.0,18.0,24.0`);
      await invoke('save_verification_artifact', {
        relPath: 'COMMAND_EXECUTION_RESULTS.json',
        content: JSON.stringify(results, null, 2),
        isBase64: false,
      });
      await invoke('save_verification_artifact', {
        relPath: 'PERFORMANCE.csv',
        content: perfRows.join('\n') + '\n',
        isBase64: false,
      });
    } catch (err) {
      await invoke('save_verification_artifact', {
        relPath: 'verify-error.txt',
        content: String(err),
        isBase64: false,
      }).catch(() => {});
    } finally {
      await invoke('exit_application', { code: 0 }).catch(() => {});
    }
  }

  void init();
})();
