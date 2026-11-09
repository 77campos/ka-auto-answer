// ==UserScript==
// @name         Khan Academy — Auto Answer (IA)
// @namespace    smith/ka
// @version      7.4.3
// @description  Lê a questão renderizada, resolve com OpenRouter/Gemini ou APIs OpenAI-compatible.
// @match        https://*.khanacademy.org/*
// @match        https://khanacademy.org/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '7.4.3';
  const LS_KEY = 'ka_auto_cfg_v8';
  const TIMEOUT = 25000;
  const GEMINI_TIMEOUT = 90000;

  // As chaves ficam no armazenamento local do navegador, nunca neste arquivo.
  const KEYS_KEY = 'ka_auto_api_keys_v1';

  function safeParse(s) {
    try { return JSON.parse(s) || {}; } catch { return {}; }
  }

  const CFG = Object.assign(
    {
      enabled: true,
      autoAdvance: false,
      backend: 'auto', // auto | gemini | openrouter
      model: '',
      geminiModel: '',
      pollMs: 1200,
      debug: true,
    },
    safeParse(localStorage.getItem(LS_KEY))
  );

  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(CFG)); } catch {} };
  let KEYS = Object.assign({ gemini: '', openrouter: '', compatible: { baseUrl: '', model: '', keys: [] } }, safeParse(localStorage.getItem(KEYS_KEY)));
  const keyPositions = { gemini: 0, openrouter: 0, compatible: 0 };
  function backendKeys(backend) {
    const value = backend === 'compatible' ? KEYS.compatible?.keys : KEYS[backend];
    return (Array.isArray(value) ? value : [value]).map((key) => String(key || '').trim()).filter(Boolean);
  }

  function configureKeys() {
    const gemini = prompt('Cole sua chave Gemini (deixe vazio para manter a atual):');
    if (gemini === null) return;
    const openrouter = prompt('Cole sua chave OpenRouter (deixe vazio para manter a atual):');
    if (openrouter === null) return;
    const model = prompt('Modelo Gemini (deixe vazio para manter):', CFG.geminiModel || 'gemini-3.8-flash');
    if (model === null) return;
    const compat = KEYS.compatible || { baseUrl: '', model: '', keys: [] };
    const compatKey = prompt('Chave da API compatível com OpenAI (opcional; deixe vazio para manter):');
    if (compatKey === null) return;
    const compatUrl = prompt('URL base da API compatível (ex.: https://api.exemplo.com/v1):', compat.baseUrl || '');
    if (compatUrl === null) return;
    const compatModel = prompt('Modelo dessa API compatível:', compat.model || '');
    if (compatModel === null) return;
    if (gemini.trim()) KEYS.gemini = [gemini.trim()];
    if (openrouter.trim()) KEYS.openrouter = [openrouter.trim()];
    keyPositions.gemini = keyPositions.openrouter = 0;
    if (model.trim()) CFG.geminiModel = model.trim();
    if (compatKey.trim()) compat.keys = [compatKey.trim()];
    if (compatUrl.trim()) compat.baseUrl = compatUrl.trim();
    if (compatModel.trim()) compat.model = compatModel.trim();
    KEYS.compatible = compat;
    keyPositions.compatible = 0;
    saveCfg();
    try { localStorage.setItem(KEYS_KEY, JSON.stringify(KEYS)); } catch {}
    geminiBlockedUntil = orBlockedUntil = compatibleBlockedUntil = 0;
    geminiFails = orFails = compatibleFails = 0;
    log('chaves atualizadas neste navegador; valores não são exibidos nos logs');
    setStatus('chaves salvas');
  }

  /* ---------------- diagnóstico ---------------- */

  let badge = null;
  let panel = null;
  let panelWrap = null;
  let panelBody = null;
  let statusEl = null;
  let pillEl = null;
  let toggleBtn = null;
  let solveBtn = null;
  let testBtn = null;
  let keysBtn = null;
  let autoChk = null;
  const backendBtns = {};
  const diagLines = [];
  let statusText = 'pronto';

  function renderLogs(scroll) {
    if (!panelBody) return;
    panelBody.textContent = diagLines.slice(-40).join('\n');
    if (scroll) panelBody.scrollTop = panelBody.scrollHeight;
  }

  function pushDiag(line) {
    const t = new Date().toLocaleTimeString();
    diagLines.push(`${t}  ${line}`);
    while (diagLines.length > 60) diagLines.shift();
    renderLogs(true);
  }

  function fmt(x) {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
  }

  const log = (...a) => {
    const msg = a.map(fmt).join(' ');
    if (CFG.debug) console.log('%c[KA-AUTO]', 'color:#8b5cf6;font-weight:700', msg);
    pushDiag(msg);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- estado ---------------- */

  let busy = false;
  let solveRequested = false;
  let phase = 'idle'; // idle | submitted | locked
  let attempts = 0;
  let lastApplied = null;
  let lastCheckAt = 0;
  let submittedAt = 0;
  let cooldownUntil = 0;
  let tickStartedAt = 0;
  let lastSig = '';
  let baselineText = '';
  const tried = new Set();

  let lastBackendUsed = '';
  let geminiBlockedUntil = 0;
  let geminiFails = 0;
  let orBlockedUntil = 0;
  let orFails = 0;
  let compatibleBlockedUntil = 0;
  let compatibleFails = 0;

  /* ---------------- ui ---------------- */

  function mk(tag, css, text) {
    const e = document.createElement(tag);
    if (css) Object.assign(e.style, css);
    if (text != null) e.textContent = text;
    return e;
  }

  function mkBtn(text, bg) {
    const b = mk(
      'button',
      {
        padding: '7px 9px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: bg,
        color: '#fff',
        font: '600 12px system-ui, sans-serif',
        cursor: 'pointer',
        lineHeight: '1.1',
        flex: '1',
        minWidth: '0',
      },
      text
    );
    b.type = 'button';
    return b;
  }

  const BACKEND_LABEL = { auto: 'Auto', gemini: 'Gemini', openrouter: 'OpenRouter', compatible: 'API compatível' };

  function setStatus(text) {
    statusText = text;
    if (badge) {
      badge.textContent = `KA auto · ${CFG.enabled ? 'ON' : 'OFF'} · ${text}`;
      badge.style.background = !CFG.enabled
        ? '#4b5563'
        : /concluída|correto/i.test(text)
          ? '#065f46'
          : '#1f2937';
    }
    if (statusEl) statusEl.textContent = text;
    if (pillEl) {
      pillEl.textContent = CFG.enabled ? 'ON' : 'OFF';
      pillEl.style.background = CFG.enabled ? '#065f46' : '#4b5563';
      pillEl.style.color = CFG.enabled ? '#6ee7b7' : '#d1d5db';
    }
  }

  function updatePanel() {
    if (!panel) return;
    if (toggleBtn) {
      toggleBtn.textContent = CFG.enabled ? 'Desligar' : 'Ligar';
      toggleBtn.style.background = CFG.enabled ? '#059669' : '#4b5563';
    }
    for (const k of Object.keys(backendBtns)) {
      const b = backendBtns[k];
      const active = CFG.backend === k;
      b.style.background = active ? '#7c3aed' : '#1f2937';
      b.style.color = active ? '#fff' : '#cbd5e1';
      b.style.borderColor = active ? '#a78bfa' : 'transparent';
    }
    if (autoChk) autoChk.checked = !!CFG.autoAdvance;
    if (statusEl) statusEl.textContent = statusText;
    if (pillEl) {
      pillEl.textContent = CFG.enabled ? 'ON' : 'OFF';
      pillEl.style.background = CFG.enabled ? '#065f46' : '#4b5563';
      pillEl.style.color = CFG.enabled ? '#6ee7b7' : '#d1d5db';
    }
  }

  function buildBadge() {
    badge = mk('div', {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: 2147483647,
      padding: '7px 11px',
      borderRadius: '9px',
      font: '12px/1.2 system-ui, sans-serif',
      background: '#1f2937',
      color: '#e5e7eb',
      opacity: '0.92',
      cursor: 'pointer',
      boxShadow: '0 3px 10px rgba(0,0,0,.4)',
      userSelect: 'none',
      maxWidth: '70vw',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    badge.dataset.kaAuto = '1';
    badge.onclick = (e) => { e.stopPropagation(); togglePanel(); };
    document.documentElement.appendChild(badge);
    setStatus(statusText);
  }

  function buildPanel() {
    panel = mk('div', {
      position: 'fixed',
      right: '12px',
      bottom: '52px',
      zIndex: 2147483647,
      width: 'min(430px, 92vw)',
      maxHeight: '72vh',
      overflow: 'hidden',
      background: 'rgba(17,24,39,.98)',
      color: '#e5e7eb',
      borderRadius: '12px',
      boxShadow: '0 8px 28px rgba(0,0,0,.6)',
      border: '1px solid #374151',
      boxSizing: 'border-box',
      display: 'none',
    });
    panel.dataset.kaAutoPanel = '1';
    panel.onclick = (e) => e.stopPropagation();

    const head = mk('div', {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '9px 12px',
      background: '#111827',
      borderBottom: '1px solid #374151',
      borderRadius: '12px 12px 0 0',
    });
    const title = mk(
      'div',
      {
        font: '700 12px system-ui, sans-serif',
        color: '#a78bfa',
        flex: '1',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      `KA Auto v${VERSION}`
    );
    pillEl = mk(
      'span',
      {
        font: '700 10px system-ui, sans-serif',
        padding: '2px 8px',
        borderRadius: '999px',
        background: '#065f46',
        color: '#6ee7b7',
      },
      'ON'
    );
    const iconBtnCss = {
      background: 'transparent',
      border: '0',
      color: '#9ca3af',
      cursor: 'pointer',
      font: '700 16px/1 system-ui, sans-serif',
      padding: '2px 6px',
      borderRadius: '6px',
    };
    const minBtn = mk('button', iconBtnCss, '–');
    minBtn.type = 'button';
    minBtn.title = 'Minimizar';
    const closeBtn = mk('button', iconBtnCss, '×');
    closeBtn.type = 'button';
    closeBtn.title = 'Fechar';
    closeBtn.onclick = () => togglePanel(false);

    head.append(title, pillEl, minBtn, closeBtn);

    panelWrap = mk('div', { padding: '10px 12px' });

    const row1 = mk('div', { display: 'flex', gap: '6px', marginBottom: '8px' });
    toggleBtn = mkBtn('Desligar', '#059669');
    toggleBtn.dataset.kaAct = 'toggle';
    toggleBtn.onclick = () => toggleEnabled();
    solveBtn = mkBtn('Resolver agora', '#7c3aed');
    solveBtn.dataset.kaAct = 'solve';
    solveBtn.onclick = () => manualSolve();
    testBtn = mkBtn('Testar IA', '#374151');
    testBtn.dataset.kaAct = 'test';
    testBtn.onclick = () => testAI();
    keysBtn = mkBtn('Configurar chaves', '#374151');
    keysBtn.dataset.kaAct = 'keys';
    keysBtn.onclick = () => configureKeys();
    row1.append(toggleBtn, solveBtn, testBtn, keysBtn);

    const row2 = mk('div', { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' });
    row2.appendChild(mk('span', { font: '600 11px system-ui, sans-serif', color: '#9ca3af' }, 'IA:'));
    for (const k of ['auto', 'openrouter', 'gemini', 'compatible']) {
      const b = mkBtn(BACKEND_LABEL[k], '#1f2937');
      b.style.flex = '0 1 auto';
      b.dataset.kaAct = 'backend-' + k;
      b.onclick = () => setBackend(k);
      backendBtns[k] = b;
      row2.appendChild(b);
    }

    const row3 = mk('label', {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      font: '11px system-ui, sans-serif',
      color: '#d1d5db',
      marginBottom: '8px',
      cursor: 'pointer',
    });
    autoChk = document.createElement('input');
    autoChk.type = 'checkbox';
    autoChk.checked = !!CFG.autoAdvance;
    autoChk.style.margin = '0';
    autoChk.onchange = () => {
      CFG.autoAdvance = !!autoChk.checked;
      saveCfg();
      log('avançar automático: ' + (CFG.autoAdvance ? 'on' : 'off'));
    };
    row3.append(autoChk, document.createTextNode('Avançar automaticamente'));

    statusEl = mk(
      'div',
      {
        font: '600 11px system-ui, sans-serif',
        color: '#fbbf24',
        marginBottom: '8px',
        minHeight: '15px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      statusText
    );

    const logsLabel = mk(
      'div',
      { font: '600 10px system-ui, sans-serif', color: '#6b7280', marginBottom: '3px' },
      'logs'
    );

    panelBody = mk('div', {
      font: '10px/1.4 ui-monospace, Consolas, monospace',
      color: '#9ca3af',
      maxHeight: '150px',
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      background: '#0b1220',
      border: '1px solid #1f2937',
      borderRadius: '8px',
      padding: '6px 8px',
    });

    minBtn.onclick = () => {
      panelWrap.style.display = panelWrap.style.display === 'none' ? 'block' : 'none';
    };

    panelWrap.append(row1, row2, row3, statusEl, logsLabel, panelBody);
    panel.append(head, panelWrap);
    document.documentElement.appendChild(panel);

    renderLogs(true);
    updatePanel();
  }

  function ensureUI() {
    if (!document.documentElement) return;
    if (!badge || !document.documentElement.contains(badge)) buildBadge();
    if (!panel || !document.documentElement.contains(panel)) buildPanel();
    updatePanel();
  }

  function togglePanel(force) {
    ensureUI();
    if (!panel) return;
    const show = typeof force === 'boolean' ? force : panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    if (show) {
      renderLogs(true);
      updatePanel();
    }
  }

  function toggleEnabled() {
    CFG.enabled = !CFG.enabled;
    if (!CFG.enabled) solveRequested = false;
    saveCfg();
    log(CFG.enabled ? 'ativado' : 'desativado');
    setStatus(CFG.enabled ? 'pronto' : 'desligado');
    updatePanel();
  }

  function setBackend(k) {
    if (!BACKEND_LABEL[k]) return;
    CFG.backend = k;
    saveCfg();
    geminiBlockedUntil = 0;
    orBlockedUntil = 0;
    compatibleBlockedUntil = 0;
    geminiFails = 0;
    orFails = 0;
    compatibleFails = 0;
    log('IA: ' + BACKEND_LABEL[k]);
    setStatus('backend: ' + BACKEND_LABEL[k]);
    updatePanel();
  }

  function manualSolve() {
    if (!CFG.enabled) { setStatus('ative antes de resolver'); return; }
    if (busy) { log('aguarde a ação atual terminar'); return; }
    solveRequested = true;
    cooldownUntil = 0;
    phase = 'idle';
    attempts = 0;
    tried.clear();
    lastApplied = null;
    submittedAt = 0;
    baselineText = '';
    log('resolver agora');
    setStatus('resolvendo…');
    if (!busy) tick();
  }

  async function testAI() {
    if (busy) {
      log('teste: aguarde a questão atual');
      return;
    }
    busy = true;
    tickStartedAt = Date.now();
    setStatus('testando IA…');
    try {
      const raw = await askLLM('Return ONLY compact JSON: {"answer": 42}');
      log('teste ok [' + lastBackendUsed + ']: ' + String(raw).slice(0, 120));
      setStatus('IA ok: ' + lastBackendUsed);
    } catch (e) {
      log('teste falhou: ' + ((e && e.message) || e));
      setStatus('IA falhou');
    } finally {
      busy = false;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'a') toggleEnabled();
    else if (k === 'd') togglePanel();
    else if (k === 's') {
      setBackend(CFG.backend === 'auto' ? 'openrouter' : CFG.backend === 'openrouter' ? 'gemini' : 'auto');
    }
  });

  /* ---------------- dom ---------------- */

  function exerciseRoot() {
    return (
      document.querySelector('[data-testid="perseus-renderer"]') ||
      document.querySelector('.perseus-renderer') ||
      document.querySelector('[data-testid="exercise"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  const textOf = (el) =>
    ((el && el.innerText) || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();

  const rootText = () => textOf(exerciseRoot());
  const pageText = () => textOf(document.body);

  const own = (el) =>
    !!(el && el.closest && (el.closest('[data-ka-auto-panel]') || el.closest('[data-ka-auto]')));

  function checkButton() {
    return (
      document.querySelector('[data-testid="exercise-check-answer"]') ||
      document.querySelector('[data-testid="exercise-check-answer-button"]') ||
      [...document.querySelectorAll('button')].find(
        (b) =>
          !own(b) &&
          /^(check|check answer|verificar( resposta)?|conferir|comprobar)\b/i.test(
            (b.textContent || '').trim()
          )
      )
    );
  }

  function nextButton() {
    const direct =
      document.querySelector('[data-testid="exercise-next-question"]') ||
      document.querySelector('[data-testid="exercise-next-question-button"]');
    if (direct) return direct;

    const check = checkButton();
    if (!check) return null;

    let scope = check.parentElement;
    for (let i = 0; i < 4 && scope; i++) {
      const b = [...scope.querySelectorAll('button')].find(
        (x) =>
          !own(x) &&
          /^(next|next question|próxim[ao]|proxima|continuar|siguiente)\b/i.test(
            (x.textContent || '').trim()
          )
      );
      if (b) return b;
      scope = scope.parentElement;
    }
    return null;
  }

  const isChecked = (el) =>
    'checked' in el
      ? !!el.checked
      : el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('aria-checked') === 'true';

  function choiceLabel(el) {
    const al = (el.getAttribute('aria-label') || '').trim();
    if (al) {
      const m = al.match(
        /^(?:choice|op[çc][ãa]o|opci[oó]n|alternativa|escolha|resposta)\s*[A-Za-z]?\s*[:\-–]?\s*(.+)$/i
      );
      if (m && m[1] && m[1].trim()) return m[1].replace(/\s+/g, ' ').trim();
      return al;
    }
    const li = el.closest('li') || el.closest('label') || el;
    return textOf(li);
  }

  function detectWidget() {
    const root = exerciseRoot();
    if (!root) return null;

    // Perseus radio: <li role="listitem"><button aria-pressed="...">...</button></li>
    const allPressed = [...root.querySelectorAll('button[aria-pressed]')].filter((b) => !own(b));
    if (allPressed.length) {
      const inList = allPressed.filter(
        (b) => b.closest('li') && b.closest('li').getAttribute('role') === 'listitem'
      );
      const btns = inList.length >= 2 ? inList : allPressed;
      if (btns.length >= 2) {
        return { type: 'radio', choices: btns, labels: btns.map(choiceLabel), root };
      }
    }

    // ARIA radios
    const roleRadios = [...root.querySelectorAll('[role="radio"]')].filter((b) => !own(b));
    if (roleRadios.length >= 2) {
      return { type: 'radio', choices: roleRadios, labels: roleRadios.map(choiceLabel), root };
    }

    // native radios
    const radios = [...root.querySelectorAll('input[type="radio"]')].filter((b) => !own(b));
    if (radios.length >= 2) {
      const labels = radios.map((r) => {
        let lab = r.closest('label');
        if (!lab && r.id) lab = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        return textOf(lab || r.parentElement || r);
      });
      return { type: 'radio', radios, labels, root };
    }

    // dropdown
    const select = [...root.querySelectorAll('select')].find((s) => !own(s));
    if (select && select.options.length > 1) {
      return {
        type: 'select',
        select,
        options: [...select.options].map((o) => textOf(o)),
        root,
      };
    }

    // expression (MathQuill)
    const expr = root.querySelector(
      '.perseus-widget-expression, [class*="perseus-widget-expression"]'
    );
    if (expr && !own(expr)) return { type: 'expression', el: expr, root };

    // numeric / text
    const inputs = [
      ...root.querySelectorAll('input[type="text"], input:not([type]), textarea'),
    ].filter((i) => !own(i) && !i.readOnly && !i.disabled && i.offsetParent !== null);
    if (inputs.length) return { type: 'text', inputs, root };

    return null;
  }

  /* ---------------- feedback ---------------- */

  const WRONG_RE =
    /(try again|tentar (novamente|de novo)|tente (novamente|de novo)|intentar de nuevo|not quite|incorrect|incorreto|incorrecto|não (é bem assim|foi dessa vez)|errou|quase)/i;
  const RIGHT_RE =
    /\b(correct|correto|correta|acertou|exactly|that'?s right|nice work|great job|muy bien|isso mesmo|exato|perfeito|muito bem|parabéns|excelente|você acertou|voce acertou|boa resposta)\b/i;

  function feedbackText() {
    const sels = [
      '[data-testid="exercise-feedback"]',
      '[data-testid="feedback"]',
      '[data-testid="answer-feedback"]',
      '.perseus-feedback',
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      '[role="alert"]',
      '[role="status"]',
    ];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (own(el)) continue;
        const t = textOf(el);
        if (t && (WRONG_RE.test(t) || RIGHT_RE.test(t))) return t;
      }
    }
    return '';
  }

  function newTextSince(base, cur) {
    if (!base || !cur || cur === base) return '';
    const n = Math.min(base.length, cur.length);
    let p = 0;
    while (p < n && base.charCodeAt(p) === cur.charCodeAt(p)) p++;
    let s = 0;
    while (s < n - p && base.charCodeAt(base.length - 1 - s) === cur.charCodeAt(cur.length - 1 - s)) s++;
    return cur.slice(p, cur.length - s).trim();
  }

  function feedbackProbe() {
    return feedbackText() || newTextSince(baselineText, pageText());
  }

  /* ---------------- prompt / IA ---------------- */

  function buildPrompt(w, text, triedArr) {
    const page = text.replace(/\n{3,}/g, '\n\n').slice(0, 3500);
    let s =
      'You solve a Khan Academy exercise. Read the visible page text and return the correct answer.\n\n' +
      `VISIBLE PAGE TEXT:\n"""\n${page}\n"""\n\n`;

    if (w.type === 'radio') {
      s += 'INPUT TYPE: multiple choice.\nCHOICES (0-based index):\n';
      s += w.labels.map((l, i) => `${i}: ${l || '(image/unknown)'}`).join('\n');
      s += '\n\n';
      if (triedArr && triedArr.length) {
        s += `Previous WRONG indices: ${triedArr.join(', ')}. Do not choose them.\n\n`;
      }
      s += 'Return ONLY compact JSON: {"answer": <0-based integer index of the correct choice>}';
    } else if (w.type === 'select') {
      s += 'INPUT TYPE: dropdown.\nOPTIONS (0-based index):\n';
      s += w.options.map((o, i) => `${i}: ${o}`).join('\n');
      s += '\n\n';
      if (triedArr && triedArr.length) {
        s += `Previous WRONG indices: ${triedArr.join(', ')}. Do not choose them.\n\n`;
      }
      s += 'Return ONLY compact JSON: {"answer": <0-based integer index of the correct option>}';
    } else if (w.type === 'expression') {
      s +=
        'INPUT TYPE: math expression (MathQuill).\n' +
        'Return ONLY compact JSON: {"answer":"<expression>"}. Use * for multiplication, ^ for powers, / for fractions, sqrt() for roots. No equals sign, no units.';
    } else {
      s +=
        'INPUT TYPE: numeric/text input.\n' +
        'Return ONLY compact JSON: {"answer":"<value>"}. Use a fraction like "3/4" when needed. No units, no thousands separators.';
    }
    return s;
  }

  async function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const id = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    } finally {
      clearTimeout(id);
    }
  }

  function makeErr(msg, status, retryMs) {
    const e = new Error(msg);
    e.status = status;
    e.retryMs = retryMs || 0;
    return e;
  }

  async function callGemini(prompt, apiKey) {
    if (!apiKey) throw makeErr('Chave Gemini ausente. Use “Configurar chaves”.', 401);
    const model = CFG.geminiModel || 'gemini-3.8-flash';
    const generationConfig = { responseMimeType: 'application/json' };
    // Gemini 3 uses medium thinking by default; low is faster for a single short answer.
    if (/^gemini-3(?:\.\d+)?-/i.test(model)) {
      generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    }
    let r;
    try {
      r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // Gemini 3.8 rejects legacy sampling controls such as temperature.
          generationConfig,
        }),
      },
        GEMINI_TIMEOUT
      );
    } catch (e) {
      if (e && (/abort/i.test(e.name || '') || /abort/i.test(e.message || ''))) {
        throw makeErr('Gemini excedeu o limite de 90 segundos.', 0);
      }
      throw e;
    }
    if (!r.ok) {
      let retryMs = 0;
      const ra = Number(r.headers.get('retry-after'));
      if (ra > 0) retryMs = ra * 1000;
      let detail = '';
      try {
        const j = await r.json();
        detail = (j && j.error && j.error.message) || '';
      } catch {}
      throw makeErr(
        'Gemini HTTP ' + r.status + (detail ? ': ' + detail.slice(0, 120) : ''),
        r.status,
        retryMs
      );
    }
    const j = await r.json();
    return j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  }

  async function callOpenRouter(prompt, apiKey) {
    if (!apiKey) throw makeErr('Chave OpenRouter ausente. Use “Configurar chaves”.', 401);
    const r = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': location.origin,
          'X-Title': 'KA Auto Answer',
        },
        body: JSON.stringify({
          model: CFG.model || 'openrouter/free',
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You solve Khan Academy exercises accurately. Output only compact JSON. No markdown, no prose.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      },
      TIMEOUT
    );
    if (!r.ok) {
      let retryMs = 0;
      const ra = r.headers.get('retry-after');
      if (ra) retryMs = Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || j?.message || ''; } catch {}
      throw makeErr('OpenRouter HTTP ' + r.status + (detail ? ': ' + detail.slice(0, 180) : ''), r.status, retryMs);
    }
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || '';
  }

  async function callCompatible(prompt, apiKey) {
    const cfg = KEYS.compatible || {};
    if (!apiKey) throw makeErr('Chave da API compatível ausente.', 401);
    if (!cfg.baseUrl || !cfg.model) throw makeErr('Configure a URL base e o modelo da API compatível.', 400);
    const base = String(cfg.baseUrl).trim().replace(/\/+$/, '');
    const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Solve the exercise accurately. Return only compact JSON, without markdown or prose.' },
          { role: 'user', content: prompt },
        ],
      }),
    }, TIMEOUT);
    if (!r.ok) {
      let retryMs = 0;
      const ra = r.headers.get('retry-after');
      if (ra) retryMs = Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || j?.message || ''; } catch {}
      throw makeErr('API compatível HTTP ' + r.status + (detail ? ': ' + detail.slice(0, 180) : ''), r.status, retryMs);
    }
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || '';
  }

  function backendOrder() {
    const now = Date.now();
    const ready = {
      gemini: now >= geminiBlockedUntil,
      openrouter: now >= orBlockedUntil,
      compatible: now >= compatibleBlockedUntil,
    };
    const pref = CFG.backend === 'gemini'
      ? ['gemini', 'openrouter', 'compatible']
      : CFG.backend === 'compatible'
        ? ['compatible', 'openrouter', 'gemini']
        : ['openrouter', 'gemini', 'compatible']; // OpenRouter permanece como principal
    return pref.filter((b) => backendKeys(b).length && ready[b]);
  }

  async function askLLM(prompt) {
    const order = backendOrder();
    if (!order.length) throw new Error('Nenhuma chave disponível ou os backends estão em espera; confira as chaves e o log.');

    let lastErr = null;
    for (let i = 0; i < order.length; i++) {
      const b = order[i];
      const keys = backendKeys(b);
      let providerFailed = false;
      for (let attempt = 0; attempt < keys.length; attempt++) {
        const keyIndex = (keyPositions[b] || 0) % keys.length;
        try {
          const raw = b === 'gemini'
            ? await callGemini(prompt, keys[keyIndex])
            : b === 'openrouter'
              ? await callOpenRouter(prompt, keys[keyIndex])
              : await callCompatible(prompt, keys[keyIndex]);
          keyPositions[b] = keyIndex;
          lastBackendUsed = b;
          if (b === 'gemini') geminiFails = 0;
          else if (b === 'openrouter') orFails = 0;
          else compatibleFails = 0;
          if (i > 0) log('usando ' + BACKEND_LABEL[b] + ' (fallback)');
          return raw;
        } catch (e) {
          lastErr = e;
          log('ERRO: ' + ((e && e.message) || e));
          const status = Number(e?.status || 0);
          if (attempt < keys.length - 1 && (status === 401 || status === 403 || status === 429)) {
            keyPositions[b] = (keyIndex + 1) % keys.length;
            log(BACKEND_LABEL[b] + ': tentando a próxima chave (' + (attempt + 2) + '/' + keys.length + ')');
            continue;
          }
          const retryable = !status || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
          const fails = b === 'gemini' ? ++geminiFails : b === 'openrouter' ? ++orFails : ++compatibleFails;
          const base = e.retryMs || (status === 429 ? 60000 : 20000);
          const until = retryable
            ? Date.now() + Math.min(base * Math.pow(2, Math.max(0, fails - 1)), 30 * 60000)
            : Infinity;
          if (b === 'gemini') geminiBlockedUntil = until;
          else if (b === 'openrouter') orBlockedUntil = until;
          else compatibleBlockedUntil = until;
          if (retryable) log(BACKEND_LABEL[b] + ' em espera por ' + Math.ceil((until - Date.now()) / 1000) + 's (HTTP ' + (status || 'rede') + ')');
          else log(BACKEND_LABEL[b] + ' indisponível até corrigir chave, modelo ou permissão (HTTP ' + status + ')');
          providerFailed = true;
          break;
        }
      }
      if (!providerFailed) break;
    }
    throw lastErr || new Error('sem backend disponível');
  }

  function parseAnswer(text, w) {
    if (!text) return null;
    let clean = String(text).trim();
    clean = clean.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

    const m = clean.match(/\{[\s\S]*?\}/);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        if (o && Object.prototype.hasOwnProperty.call(o, 'answer')) return o.answer;
        if (o && Object.prototype.hasOwnProperty.call(o, 'index')) return o.index;
        if (o && Object.prototype.hasOwnProperty.call(o, 'choice')) return o.choice;
      } catch {}
    }

    if (w.type === 'radio' || w.type === 'select') {
      const num = clean.match(/-?\d+/);
      if (num) return Number(num[0]);
      const letter = clean.match(/\b([A-Za-z])\b/);
      if (letter) return letter[1].toUpperCase().charCodeAt(0) - 65;
    }

    return clean.replace(/^["'`]+|["'`]+$/g, '').trim();
  }

  function resolveIndex(val, labels) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    const s = String(val).trim();
    if (/^[A-Za-z]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
    if (/^-?\d+$/.test(s)) return Number(s);

    const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const t = norm(s);
    let i = labels.findIndex((l) => norm(l) === t);
    if (i >= 0) return i;
    i = labels.findIndex((l) => t && (norm(l).includes(t) || t.includes(norm(l))));
    return i;
  }

  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    try { input.focus(); input.blur(); } catch {}
  }

  function applyAnswer(w, val) {
    if (val === null || val === undefined || val === '') return { ok: false, idx: null };

    if (w.type === 'radio') {
      const idx = resolveIndex(val, w.labels);
      if (!(idx >= 0)) return { ok: false, idx: null };
      const el = w.choices ? w.choices[idx] : w.radios[idx];
      if (!el) return { ok: false, idx };
      if (!isChecked(el)) {
        el.click();
        if (!isChecked(el)) {
          const t = el.closest('li') || el.closest('label');
          if (t) t.click();
        }
      }
      return { ok: isChecked(el), idx };
    }

    if (w.type === 'select') {
      const idx = resolveIndex(val, w.options);
      const opt =
        w.select.options[idx] ||
        [...w.select.options].find((o) => textOf(o).toLowerCase() === String(val).toLowerCase());
      if (!opt) return { ok: false, idx };
      w.select.value = opt.value;
      w.select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, idx };
    }

    if (w.type === 'expression') {
      const s = String(val);
      try {
        const MQ = window.MathQuill;
        if (MQ && MQ.getInterface) {
          const field =
            w.el.querySelector('.mq-editable-field') || w.el.querySelector('.mq-math-mode') || w.el;
          const mf = MQ.getInterface(2).MathField(field);
          mf.write(s);
          return { ok: true, idx: null };
        }
      } catch (e) {
        log('MathQuill falhou: ' + (e && e.message));
      }
      const ta = w.el.querySelector('textarea, input');
      if (ta) {
        setNativeValue(ta, s);
        return { ok: true, idx: null };
      }
      return { ok: false, idx: null };
    }

    if (w.type === 'text') {
      const input = w.inputs[0];
      if (!input) return { ok: false, idx: null };
      setNativeValue(input, val);
      return { ok: true, idx: null };
    }

    return { ok: false, idx: null };
  }

  async function submitAnswer() {
    for (let i = 0; i < 12; i++) {
      const chk = checkButton();
      if (chk && !chk.disabled) {
        chk.click();
        return true;
      }
      await sleep(250);
    }
    const chk = checkButton();
    if (chk) {
      chk.click();
      return true;
    }
    return false;
  }

  /* ---------------- loop ---------------- */

  async function tick() {
    ensureUI();

    if (busy && tickStartedAt && Date.now() - tickStartedAt > 90000) {
      busy = false;
      log('watchdog: liberando trava');
    }
    if (!CFG.enabled || busy) return;

    const check = checkButton();
    const w0 = detectWidget();
    if (!check && !w0) {
      solveRequested = false;
      setStatus('fora de exercício');
      return;
    }

    // detecta troca de questão (a assinatura usa só a área da questão, sem o feedback)
    const sig = rootText().slice(0, 400);
    if (sig && sig !== lastSig) {
      const isNew = !!lastSig;
      lastSig = sig;
      if (isNew) {
        const settled = phase !== 'submitted' || Date.now() - submittedAt > 3000;
        if (settled) {
          phase = 'idle';
          attempts = 0;
          tried.clear();
          lastApplied = null;
          submittedAt = 0;
          baselineText = '';
          log('nova questão detectada');
        }
      }
    }

    busy = true;
    tickStartedAt = Date.now();

    try {
      // avança quando o botão Next estiver liberado (só depois de acertar, na KA)
      const next = nextButton();
      if (next && !next.disabled && CFG.autoAdvance) {
        log('avançando');
        next.click();
        phase = 'idle';
        attempts = 0;
        tried.clear();
        lastApplied = null;
        submittedAt = 0;
        baselineText = '';
        cooldownUntil = Date.now() + 1500;
        setStatus('avançando');
        return;
      }

      if (Date.now() < cooldownUntil) return;
      if (phase === 'locked') {
        setStatus('concluída ✓');
        return;
      }

      if (phase === 'submitted') {
        const probe = feedbackProbe();
        if (WRONG_RE.test(probe)) {
          const w = detectWidget();
          const max = w && w.type === 'radio' ? Math.max(2, w.labels.length) : 4;
          if (attempts < max) {
            phase = 'idle';
            setStatus('errada — tentando de novo');
            log('feedback: errado (tentativa ' + attempts + '/' + max + ')');
          } else {
            phase = 'locked';
            setStatus('desisti após ' + attempts + ' tentativas');
            log('feedback: errado — limite de tentativas');
          }
          cooldownUntil = Date.now() + 1200;
        } else if (RIGHT_RE.test(probe)) {
          phase = 'locked';
          setStatus('concluída ✓');
          log('feedback: correto');
        } else if (Date.now() - submittedAt > 15000) {
          if (attempts < 4) {
            phase = 'idle';
            log('sem feedback — tentando de novo');
          } else {
            phase = 'locked';
            setStatus('sem feedback');
          }
          cooldownUntil = Date.now() + 1000;
        } else {
          setStatus('verificando…');
        }
        return;
      }

      if (!solveRequested) {
        setStatus('aguardando clique em Resolver agora');
        return;
      }
      solveRequested = false;

      const w = detectWidget();
      if (!w) {
        setStatus('sem campo de resposta');
        return;
      }

      setStatus(`resolvendo (${w.type})…`);
      log(
        'widget: ' +
          w.type +
          (w.type === 'radio' ? ` · ${w.labels.length} opções` : '') +
          (w.type === 'text' ? ` · ${w.inputs.length} input(s)` : '')
      );

      const raw = await askLLM(buildPrompt(w, rootText(), [...tried]));
      log('IA [' + lastBackendUsed + ']: ' + String(raw).slice(0, 200));

      let ans = parseAnswer(raw, w);

      // em múltipla escolha, nunca repete um índice já marcado como errado
      if (w.type === 'radio' || w.type === 'select') {
        const labels = w.type === 'radio' ? w.labels : w.options;
        let idx = resolveIndex(ans, labels);
        if (tried.has(idx)) {
          const alt = labels.findIndex((_, i) => !tried.has(i));
          if (alt >= 0) {
            log('IA repetiu o índice ' + idx + ' — usando ' + alt);
            idx = alt;
          }
        }
        ans = idx;
      }

      log('resposta: ' + fmt(ans));

      const applied = applyAnswer(w, ans);
      if (!applied.ok) {
        setStatus('falha ao aplicar');
        log('apply falhou (idx=' + applied.idx + ')');
        cooldownUntil = Date.now() + 3000;
        return;
      }

      if (applied.idx != null) tried.add(applied.idx);
      lastApplied = applied.idx;
      attempts++;
      setStatus('marcada — verificando…');
      log('resposta marcada/escrita · clicando em Verificar');

      baselineText = pageText();
      const clicked = await submitAnswer();
      if (!clicked) {
        setStatus('não achei o botão Verificar');
        log('botão Verificar não encontrado');
        cooldownUntil = Date.now() + 2500;
        return;
      }

      submittedAt = Date.now();
      lastCheckAt = Date.now();
      phase = 'submitted';
      cooldownUntil = Date.now() + 900;
      setStatus('enviada (' + attempts + ')');
    } catch (e) {
      log('ERRO: ' + ((e && e.message) || e));
      setStatus('erro — tentando de novo');
      cooldownUntil = Date.now() + 5000;
    } finally {
      busy = false;
    }
  }

  /* ---------------- boot ---------------- */

  console.log(
    `%c KA Auto Answer %c v${VERSION} · painel: clique no selo · Alt+A on/off `,
    'background:#8b5cf6;color:#fff;font-weight:700;padding:2px 4px;border-radius:4px 0 0 4px',
    'background:#1f2937;color:#e5e7eb;padding:2px 4px;border-radius:0 4px 4px 0'
  );

  ensureUI();
  setInterval(ensureUI, 3000);
  setInterval(() => { tick(); }, CFG.pollMs);
  setTimeout(() => { tick(); }, 800);
})();
