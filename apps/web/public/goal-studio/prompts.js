// Owned by Goal Studio workstream 08 (Prompt Studio).
// Registers with `window.WazirGoalStudio.register('prompts', { mount(el, ctx), unmount() })`
// per reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md §9. No build step; vanilla ES module.

const BASE = '/api/v1/goal-studio/prompts';
const STYLE_ID = 'wazir-gs-prompts-style';

const STYLES = `
.wgs-prompts { display: grid; grid-template-columns: 270px 1fr; gap: 16px; min-height: 620px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--fg, #e5e7eb); }
.wgs-prompts * { box-sizing: border-box; }
.wgs-p-sidebar, .wgs-p-panel { background: var(--panel-bg, #111827); border: 1px solid var(--border, #1f2937); border-radius: 8px; padding: 12px; }
.wgs-p-sidebar { display: flex; flex-direction: column; gap: 8px; max-height: 82vh; overflow-y: auto; }
.wgs-p-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wgs-p-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.wgs-p-item { width: 100%; text-align: left; padding: 8px 10px; border-radius: 6px; border: 1px solid transparent; background: rgba(255,255,255,0.02); color: inherit; cursor: pointer; }
.wgs-p-item:hover { border-color: #374151; background: rgba(255,255,255,0.05); }
.wgs-p-item[aria-selected="true"] { border-color: #3b82f6; background: rgba(59,130,246,0.14); }
.wgs-p-role { font-size: 11px; color: #9ca3af; margin-top: 2px; }
.wgs-p-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.wgs-p-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; background: #1f2937; color: #d1d5db; border: 1px solid #374151; }
.wgs-p-badge.ok { background: rgba(16,185,129,0.15); color: #6ee7b7; border-color: rgba(16,185,129,0.4); }
.wgs-p-badge.warn { background: rgba(245,158,11,0.15); color: #fcd34d; border-color: rgba(245,158,11,0.4); }
.wgs-p-badge.err { background: rgba(239,68,68,0.15); color: #fca5a5; border-color: rgba(239,68,68,0.4); }
.wgs-p-input, .wgs-p-textarea, .wgs-p-select { width: 100%; background: #0b0f19; color: inherit; border: 1px solid #374151; border-radius: 6px; padding: 7px 9px; font-size: 13px; }
.wgs-p-textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45; resize: vertical; }
.wgs-p-btn { padding: 6px 11px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: inherit; font-size: 12px; cursor: pointer; }
.wgs-p-btn.primary { background: #2563eb; border-color: #3b82f6; color: #fff; }
.wgs-p-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.wgs-p-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.wgs-p-diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; border: 1px solid #1f2937; border-radius: 6px; overflow-x: auto; max-height: 280px; }
.wgs-p-diff-line { display: grid; grid-template-columns: 36px 36px 20px 1fr; gap: 6px; padding: 1px 8px; white-space: pre-wrap; word-break: break-word; }
.wgs-p-diff-line.add { background: rgba(16,185,129,0.14); color: #a7f3d0; }
.wgs-p-diff-line.remove { background: rgba(239,68,68,0.14); color: #fecaca; }
.wgs-p-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #9ca3af; margin-bottom: 4px; }
.wgs-p-banner { padding: 8px 10px; border-radius: 6px; font-size: 12px; }
`;

function ensureStyles(doc) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

function h(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

function prettyJson(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function parseOptionalJson(raw, label) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

export function createPromptsModule() {
  let root = null;
  let unsubEvents = null;
  let disposed = false;

  const state = {
    prompts: [],
    canEvaluate: false,
    filter: '',
    selectedId: null,
    creatingNew: false,
    versions: [],
    viewingVersion: null,
    activePrompt: null,
    diffA: null,
    diffB: null,
    diff: null,
    renderInputsText: '{\n  \n}',
    renderResult: null,
    evalCasesText: '[\n  {\n    "id": "smoke",\n    "inputs": {},\n    "expect": { "validateOutputSchema": true }\n  }\n]',
    evalCompareWith: '',
    evaluations: [],
    latestComparison: null,
    banner: null,
    serviceUnavailable: false,
  };

  async function request(ctx, path, init) {
    const res = await ctx.api(`${BASE}${path}`, init);
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const msg = payload?.error?.message || `HTTP ${res.status}`;
      const error = new Error(msg);
      error.status = res.status;
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      throw error;
    }
    return payload;
  }

  function setBanner(kind, message) {
    state.banner = message ? { kind, message } : null;
  }

  async function loadList(ctx, preferredId) {
    try {
      const data = await request(ctx, '');
      state.serviceUnavailable = false;
      state.prompts = Array.isArray(data?.prompts) ? data.prompts : [];
      state.canEvaluate = Boolean(data?.canEvaluate);
      const targetId = preferredId ?? state.selectedId ?? state.prompts[0]?.promptId ?? null;
      if (targetId && state.prompts.some((p) => p.promptId === targetId)) {
        await selectPrompt(ctx, targetId);
      } else {
        state.selectedId = null;
        state.activePrompt = null;
        state.versions = [];
        render(ctx);
      }
    } catch (err) {
      if (err.status === 503) state.serviceUnavailable = true;
      setBanner('err', `Could not load prompts: ${err.message}`);
      render(ctx);
    }
  }

  async function selectPrompt(ctx, promptId, version) {
    state.creatingNew = false;
    state.selectedId = promptId;
    state.diff = null;
    state.renderResult = null;
    state.latestComparison = null;
    try {
      const [histData, evalData] = await Promise.all([
        request(ctx, `/${encodeURIComponent(promptId)}/versions`),
        request(ctx, `/${encodeURIComponent(promptId)}/evaluations`).catch(() => ({ evaluations: [] })),
      ]);
      state.versions = Array.isArray(histData?.versions) ? histData.versions : [];
      state.evaluations = Array.isArray(evalData?.evaluations) ? evalData.evaluations : [];
      const head = state.versions[state.versions.length - 1] || null;
      const chosen = version ? state.versions.find((v) => v.version === Number(version)) || head : head;
      state.activePrompt = chosen;
      state.viewingVersion = chosen?.version ?? null;
      if (state.versions.length >= 2) {
        state.diffA = state.versions[state.versions.length - 2].version;
        state.diffB = state.versions[state.versions.length - 1].version;
      } else if (state.versions.length === 1) {
        state.diffA = state.versions[0].version;
        state.diffB = state.versions[0].version;
      }
      render(ctx);
    } catch (err) {
      setBanner('err', `Failed to load prompt '${promptId}': ${err.message}`);
      render(ctx);
    }
  }

  function renderSidebar(doc, ctx) {
    const filterLower = state.filter.trim().toLowerCase();
    const visible = state.prompts.filter((p) => !filterLower
      || p.promptId.toLowerCase().includes(filterLower)
      || p.executorKey.toLowerCase().includes(filterLower)
      || p.role.toLowerCase().includes(filterLower));

    return h(doc, 'aside', { className: 'wgs-p-sidebar', 'aria-label': 'Prompt list' }, [
      h(doc, 'div', { className: 'wgs-p-row' }, [
        h(doc, 'strong', { text: `Prompts (${state.prompts.length})` }),
        h(doc, 'button', {
          className: 'wgs-p-btn primary',
          type: 'button',
          'data-action': 'new-prompt',
          onClick: () => {
            state.creatingNew = true;
            state.selectedId = null;
            state.activePrompt = {
              id: '',
              executorKey: '',
              role: '',
              version: 0,
              template: 'Execute {{task}} and return structured JSON.',
              requiredCapabilities: ['reasoning'],
              inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } } },
              outputSchema: { type: 'object' },
            };
            state.versions = [];
            render(ctx);
          },
          text: '+ New',
        }),
      ]),
      h(doc, 'input', {
        className: 'wgs-p-input',
        type: 'search',
        placeholder: 'Filter by executor or role…',
        value: state.filter,
        onInput: (e) => {
          state.filter = e.target.value;
          render(ctx);
        },
      }),
      ...visible.map((item) => h(doc, 'button', {
        type: 'button',
        className: 'wgs-p-item',
        'data-prompt-id': item.promptId,
        'aria-selected': String(!state.creatingNew && state.selectedId === item.promptId),
        onClick: () => selectPrompt(ctx, item.promptId),
      }, [
        h(doc, 'div', { className: 'wgs-p-row' }, [
          h(doc, 'span', { className: 'wgs-p-mono', text: item.executorKey }),
          h(doc, 'span', { className: 'wgs-p-badge', text: `v${item.latestVersion}` }),
        ]),
        h(doc, 'div', { className: 'wgs-p-role', text: item.role }),
      ])),
      visible.length === 0 ? h(doc, 'div', { className: 'wgs-p-role', text: 'No matching prompts.' }) : null,
    ]);
  }

  function renderEditorPanel(doc, ctx, prompt) {
    const isNew = state.creatingNew;
    const headVersion = state.versions[state.versions.length - 1]?.version ?? 0;
    const executorInput = h(doc, 'input', {
      className: 'wgs-p-input wgs-p-mono',
      name: 'executorKey',
      value: prompt.executorKey || '',
      disabled: !isNew,
      placeholder: 'e.g. LiteratureSynthesisAgent',
    });
    const roleInput = h(doc, 'input', {
      className: 'wgs-p-input',
      name: 'role',
      value: prompt.role || '',
      placeholder: 'e.g. literature_synthesizer',
    });
    const capsInput = h(doc, 'input', {
      className: 'wgs-p-input wgs-p-mono',
      name: 'requiredCapabilities',
      value: (prompt.requiredCapabilities || []).join(', '),
      placeholder: 'reasoning, coding',
    });
    const noteInput = h(doc, 'input', {
      className: 'wgs-p-input',
      name: 'note',
      value: '',
      placeholder: 'Change rationale / release note (optional)',
    });
    const templateInput = h(doc, 'textarea', {
      className: 'wgs-p-textarea',
      name: 'template',
      rows: 8,
    }, prompt.template || '');
    const inSchemaInput = h(doc, 'textarea', {
      className: 'wgs-p-textarea',
      name: 'inputSchema',
      rows: 6,
    }, prettyJson(prompt.inputSchema, ''));
    const outSchemaInput = h(doc, 'textarea', {
      className: 'wgs-p-textarea',
      name: 'outputSchema',
      rows: 6,
    }, prettyJson(prompt.outputSchema, ''));

    const onPublish = async () => {
      try {
        const inputSchema = parseOptionalJson(inSchemaInput.value, 'inputSchema');
        const outputSchema = parseOptionalJson(outSchemaInput.value, 'outputSchema');
        const requiredCapabilities = capsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const draft = {
          executorKey: executorInput.value.trim(),
          role: roleInput.value.trim(),
          template: templateInput.value,
          inputSchema,
          outputSchema,
          requiredCapabilities,
          note: noteInput.value.trim() || undefined,
          ...(isNew ? { expectedVersion: 0 } : { id: prompt.id, expectedVersion: headVersion }),
        };
        const path = isNew ? '' : `/${encodeURIComponent(prompt.id)}/versions`;
        const res = await request(ctx, path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        const warnText = res.warnings?.length ? ` (warnings: ${res.warnings.join('; ')})` : '';
        setBanner('ok', `${res.created ? 'Published' : 'Unchanged at'} ${res.prompt.id} v${res.prompt.version}${warnText}`);
        await loadList(ctx, res.prompt.id);
      } catch (err) {
        setBanner('err', `Publish failed: ${err.message}`);
        render(ctx);
      }
    };

    return h(doc, 'section', { className: 'wgs-p-panel', 'aria-label': 'Prompt definition editor' }, [
      h(doc, 'div', { className: 'wgs-p-row' }, [
        h(doc, 'div', {}, [
          h(doc, 'strong', { className: 'wgs-p-mono', text: isNew ? 'New Prompt Draft' : `${prompt.id} @ v${prompt.version}` }),
          !isNew && prompt.digest ? h(doc, 'span', { className: 'wgs-p-role wgs-p-mono', text: `  sha256:${String(prompt.digest).slice(0, 12)}…` }) : null,
        ]),
        h(doc, 'button', {
          type: 'button',
          className: 'wgs-p-btn primary',
          'data-action': 'publish-prompt',
          onClick: onPublish,
          text: isNew ? 'Create v1' : `Publish v${headVersion + 1}`,
        }),
      ]),
      h(doc, 'div', { className: 'wgs-p-grid2', style: 'margin-top:10px' }, [
        h(doc, 'label', {}, [h(doc, 'span', { className: 'wgs-p-label', text: 'Executor Key' }), executorInput]),
        h(doc, 'label', {}, [h(doc, 'span', { className: 'wgs-p-label', text: 'Role' }), roleInput]),
        h(doc, 'label', {}, [h(doc, 'span', { className: 'wgs-p-label', text: 'Required Capabilities (comma-separated)' }), capsInput]),
        h(doc, 'label', {}, [h(doc, 'span', { className: 'wgs-p-label', text: 'Version Note' }), noteInput]),
      ]),
      h(doc, 'label', { style: 'display:block;margin-top:10px' }, [
        h(doc, 'span', { className: 'wgs-p-label', text: 'Template (use {{variable}} placeholders)' }),
        templateInput,
      ]),
      h(doc, 'div', { className: 'wgs-p-grid2', style: 'margin-top:10px' }, [
        h(doc, 'label', {}, [h(doc, 'span', { className: 'wgs-p-label', text: 'Input JSON Schema' }), inSchemaInput]),
        h(doc, 'label', {}, [h(doc, 'span', { className: 'wgs-p-label', text: 'Output JSON Schema' }), outSchemaInput]),
      ]),
    ]);
  }

  function renderHistoryAndDiffPanel(doc, ctx, prompt) {
    if (state.creatingNew || !prompt?.id) return null;
    const headVersion = state.versions[state.versions.length - 1]?.version ?? prompt.version;

    const selectA = h(doc, 'select', {
      className: 'wgs-p-select',
      'aria-label': 'Diff version A',
      onChange: (e) => { state.diffA = Number(e.target.value); },
    }, state.versions.map((v) => h(doc, 'option', { value: v.version, selected: v.version === state.diffA, text: `v${v.version} (${v.createdBy})` })));

    const selectB = h(doc, 'select', {
      className: 'wgs-p-select',
      'aria-label': 'Diff version B',
      onChange: (e) => { state.diffB = Number(e.target.value); },
    }, state.versions.map((v) => h(doc, 'option', { value: v.version, selected: v.version === state.diffB, text: `v${v.version} (${v.createdBy})` })));

    const runDiff = async () => {
      try {
        const a = Number(selectA.value || state.diffA || 1);
        const b = Number(selectB.value || state.diffB || headVersion);
        state.diffA = a;
        state.diffB = b;
        state.diff = await request(ctx, `/${encodeURIComponent(prompt.id)}/diff?a=${a}&b=${b}`);
        render(ctx);
      } catch (err) {
        setBanner('err', `Diff failed: ${err.message}`);
        render(ctx);
      }
    };

    const doRollback = async (toVersion) => {
      try {
        const res = await request(ctx, `/${encodeURIComponent(prompt.id)}/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toVersion, note: `rollback to v${toVersion}` }),
        });
        setBanner('ok', `Rolled back ${prompt.id} to v${toVersion} as new immutable v${res.prompt.version}`);
        await loadList(ctx, prompt.id);
      } catch (err) {
        setBanner('err', `Rollback failed: ${err.message}`);
        render(ctx);
      }
    };

    return h(doc, 'section', { className: 'wgs-p-panel', 'aria-label': 'Version history and diff' }, [
      h(doc, 'div', { className: 'wgs-p-row' }, [
        h(doc, 'strong', { text: `Immutable Version History (${state.versions.length})` }),
        h(doc, 'div', { className: 'wgs-p-row' }, [
          selectA,
          h(doc, 'span', { text: '→' }),
          selectB,
          h(doc, 'button', { type: 'button', className: 'wgs-p-btn', 'data-action': 'diff-versions', onClick: runDiff, text: 'Compare Diff' }),
        ]),
      ]),
      h(doc, 'div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:6px' }, state.versions.slice().reverse().map((v) => h(doc, 'div', {
        className: 'wgs-p-row',
        'data-version-row': String(v.version),
      }, [
        h(doc, 'div', {}, [
          h(doc, 'span', { className: 'wgs-p-badge', text: `v${v.version}` }),
          v.version === headVersion ? h(doc, 'span', { className: 'wgs-p-badge ok', style: 'margin-left:6px', text: 'HEAD' }) : null,
          v.rollbackOf ? h(doc, 'span', { className: 'wgs-p-badge warn', style: 'margin-left:6px', text: `rollback of v${v.rollbackOf}` }) : null,
          h(doc, 'span', { className: 'wgs-p-mono', style: 'margin-left:8px', text: `${String(v.digest).slice(0, 10)} · ${v.createdBy}` }),
          v.note ? h(doc, 'span', { className: 'wgs-p-role', style: 'margin-left:8px', text: `— ${v.note}` }) : null,
        ]),
        h(doc, 'div', { className: 'wgs-p-row' }, [
          h(doc, 'button', {
            type: 'button',
            className: 'wgs-p-btn',
            'data-action': 'inspect-version',
            'data-version': String(v.version),
            onClick: () => {
              state.activePrompt = v;
              state.viewingVersion = v.version;
              render(ctx);
            },
            text: state.viewingVersion === v.version ? 'Viewing' : 'Inspect',
          }),
          v.version !== headVersion ? h(doc, 'button', {
            type: 'button',
            className: 'wgs-p-btn',
            'data-action': 'rollback-version',
            'data-version': String(v.version),
            onClick: () => doRollback(v.version),
            text: `Rollback to v${v.version}`,
          }) : null,
        ]),
      ]))),
      state.diff ? h(doc, 'div', { style: 'margin-top:10px' }, [
        h(doc, 'div', { className: 'wgs-p-role', style: 'margin-bottom:6px' }, [
          `Diff v${state.diff.a} → v${state.diff.b}: +${state.diff.template.added} / -${state.diff.template.removed} lines`,
          state.diff.identical ? ' (identical content digest)' : '',
        ]),
        h(doc, 'div', { className: 'wgs-p-diff', 'data-testid': 'prompt-diff-output' }, state.diff.template.lines.map((line) => h(doc, 'div', {
          className: `wgs-p-diff-line ${line.op}`,
        }, [
          h(doc, 'span', { text: line.aLine ?? '' }),
          h(doc, 'span', { text: line.bLine ?? '' }),
          h(doc, 'span', { text: line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ' }),
          h(doc, 'span', { text: line.text }),
        ]))),
      ]) : null,
    ]);
  }

  function renderPreviewAndEvalPanel(doc, ctx, prompt) {
    if (state.creatingNew || !prompt?.id) return null;

    const inputsArea = h(doc, 'textarea', {
      className: 'wgs-p-textarea',
      name: 'renderInputs',
      rows: 5,
    }, state.renderInputsText);

    const casesArea = h(doc, 'textarea', {
      className: 'wgs-p-textarea',
      name: 'evalCases',
      rows: 6,
    }, state.evalCasesText);

    const compareInput = h(doc, 'input', {
      className: 'wgs-p-input wgs-p-mono',
      name: 'compareWith',
      placeholder: 'Optional version B to compare against',
      value: state.evalCompareWith,
    });

    const onRenderPreview = async () => {
      state.renderInputsText = inputsArea.value;
      try {
        const inputs = parseOptionalJson(inputsArea.value, 'Render inputs') ?? {};
        state.renderResult = await request(ctx, `/${encodeURIComponent(prompt.id)}/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: prompt.version, inputs }),
        });
        setBanner(null, '');
        render(ctx);
      } catch (err) {
        setBanner('err', `Render validation failed: ${err.message}`);
        render(ctx);
      }
    };

    const onRunEval = async () => {
      state.evalCasesText = casesArea.value;
      state.evalCompareWith = compareInput.value.trim();
      try {
        const cases = parseOptionalJson(casesArea.value, 'Evaluation cases');
        const payload = {
          version: prompt.version,
          cases,
          ...(state.evalCompareWith ? { compareWith: Number(state.evalCompareWith) } : {}),
        };
        const res = await request(ctx, `/${encodeURIComponent(prompt.id)}/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.comparison) {
          state.latestComparison = res.comparison;
          setBanner('ok', `Compared v${res.comparison.a.version} vs v${res.comparison.b.version}`);
        } else if (res.evaluation) {
          state.evaluations = [...state.evaluations, res.evaluation];
          setBanner('ok', `Evaluation passed ${res.evaluation.summary.passed}/${res.evaluation.summary.total} cases`);
        }
        render(ctx);
      } catch (err) {
        setBanner('err', `Evaluation failed: ${err.message}`);
        render(ctx);
      }
    };

    return h(doc, 'div', { className: 'wgs-p-grid2' }, [
      h(doc, 'section', { className: 'wgs-p-panel', 'aria-label': 'Render preview' }, [
        h(doc, 'div', { className: 'wgs-p-row' }, [
          h(doc, 'strong', { text: `Render Preview (v${prompt.version})` }),
          h(doc, 'button', { type: 'button', className: 'wgs-p-btn primary', 'data-action': 'render-preview', onClick: onRenderPreview, text: 'Render' }),
        ]),
        h(doc, 'label', { style: 'display:block;margin-top:8px' }, [
          h(doc, 'span', { className: 'wgs-p-label', text: 'Inputs JSON' }),
          inputsArea,
        ]),
        state.renderResult ? h(doc, 'pre', {
          className: 'wgs-p-diff',
          style: 'padding:8px;margin-top:8px;white-space:pre-wrap',
          'data-testid': 'rendered-prompt-text',
          text: state.renderResult.text,
        }) : null,
      ]),
      h(doc, 'section', { className: 'wgs-p-panel', 'aria-label': 'Prompt evaluation harness' }, [
        h(doc, 'div', { className: 'wgs-p-row' }, [
          h(doc, 'strong', { text: 'Evaluation Harness' }),
          h(doc, 'span', {
            className: `wgs-p-badge ${state.canEvaluate ? 'ok' : 'warn'}`,
            text: state.canEvaluate ? 'Runner ready' : 'Runner not configured',
          }),
          h(doc, 'button', {
            type: 'button',
            className: 'wgs-p-btn primary',
            'data-action': 'run-evaluation',
            disabled: !state.canEvaluate,
            onClick: onRunEval,
            text: 'Run Cases',
          }),
        ]),
        h(doc, 'label', { style: 'display:block;margin-top:8px' }, [
          h(doc, 'span', { className: 'wgs-p-label', text: 'Golden Cases JSON' }),
          casesArea,
        ]),
        h(doc, 'label', { style: 'display:block;margin-top:8px' }, [
          h(doc, 'span', { className: 'wgs-p-label', text: 'Compare Against Version (optional)' }),
          compareInput,
        ]),
        state.evaluations.length ? h(doc, 'div', { style: 'margin-top:8px' }, state.evaluations.slice(-3).reverse().map((ev) => h(doc, 'div', {
          className: 'wgs-p-row',
          'data-eval-id': ev.id,
        }, [
          h(doc, 'span', { className: 'wgs-p-mono', text: `v${ev.version} · ${ev.summary.passed}/${ev.summary.total} passed` }),
          h(doc, 'span', { className: `wgs-p-badge ${ev.summary.failed === 0 ? 'ok' : 'err'}`, text: `${Math.round(ev.summary.passRate * 100)}%` }),
        ]))) : null,
      ]),
    ]);
  }

  function render(ctx) {
    if (!root || disposed) return;
    const doc = root.ownerDocument;
    ensureStyles(doc);
    root.innerHTML = '';

    const bannerNode = state.banner ? h(doc, 'div', {
      className: `wgs-p-banner wgs-p-badge ${state.banner.kind}`,
      role: 'status',
      'data-testid': 'prompt-banner',
      text: state.banner.message,
    }) : null;

    const mainChildren = [bannerNode];
    if (state.serviceUnavailable) {
      mainChildren.push(h(doc, 'div', {
        className: 'wgs-p-panel',
        text: 'Prompt Studio service is not configured on this server (503).',
      }));
    } else if (state.activePrompt) {
      mainChildren.push(
        renderEditorPanel(doc, ctx, state.activePrompt),
        renderHistoryAndDiffPanel(doc, ctx, state.activePrompt),
        renderPreviewAndEvalPanel(doc, ctx, state.activePrompt),
      );
    } else {
      mainChildren.push(h(doc, 'div', {
        className: 'wgs-p-panel',
        text: 'Select a specialist executor prompt from the sidebar or click + New to author one.',
      }));
    }

    root.appendChild(h(doc, 'div', { className: 'wgs-prompts' }, [
      renderSidebar(doc, ctx),
      h(doc, 'div', { className: 'wgs-p-main' }, mainChildren),
    ]));
  }

  return {
    async mount(el, ctx) {
      disposed = false;
      root = el;
      if (ctx?.events && ctx?.state?.runId) {
        try {
          unsubEvents = ctx.events(ctx.state.runId, (ev) => {
            if (ev?.type === 'prompt.version') loadList(ctx, state.selectedId);
          });
        } catch {
          unsubEvents = null;
        }
      }
      await loadList(ctx);
    },
    unmount() {
      disposed = true;
      if (typeof unsubEvents === 'function') {
        try { unsubEvents(); } catch { /* ignore */ }
      }
      unsubEvents = null;
      if (root) root.innerHTML = '';
      root = null;
    },
  };
}

export function registerPromptsStudio(target = typeof window !== 'undefined' ? window : globalThis) {
  const studio = target?.WazirGoalStudio;
  if (studio && typeof studio.register === 'function') {
    studio.register('prompts', createPromptsModule());
    return true;
  }
  return false;
}

registerPromptsStudio();
