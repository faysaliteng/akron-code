import * as monaco from 'monaco-editor';
import * as monacoTs from 'monaco-editor/languages/features/typescript/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker&inline';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker&inline';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker&inline';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker&inline';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker&inline';

let initialized = false;
let ghostDisposable = null;
let codeActionDisposable = null;
let fixCommandDisposable = null;
let fixCallbackRef = null;
let lspHoverDisposable = null;
let lspDefDisposable = null;

export function registerFixCommand() {
  if (fixCommandDisposable) return fixCommandDisposable;
  try {
    if (monaco.editor && typeof monaco.editor.registerCommand === 'function') {
      fixCommandDisposable = monaco.editor.registerCommand('akron.fixDiagnostic', (_accessor, arg) => {
        if (typeof fixCallbackRef === 'function') {
          fixCallbackRef(arg || {});
        }
      });
    }
  } catch (_) {}
  return fixCommandDisposable;
}

export function ensureMonaco() {
  if (initialized) return monaco;
  initialized = true;

  self.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TsWorker();
      return new EditorWorker();
    },
  };

  monaco.editor.defineTheme('akron-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: '34d399' },
      { token: 'string', foreground: 'a7f3d0' },
      { token: 'number', foreground: 'fbbf24' },
      { token: 'type', foreground: '60a5fa' },
    ],
    colors: {
      'editor.background': '#131316',
      'editor.foreground': '#e4e4ea',
      'editor.lineHighlightBackground': '#1c1c22',
      'editorLineNumber.foreground': '#52525b',
      'editorLineNumber.activeForeground': '#a7f3d0',
      'editorCursor.foreground': '#10b981',
      'editor.selectionBackground': '#10b98133',
      'editor.inactiveSelectionBackground': '#10b9811a',
      'editorGutter.background': '#131316',
      'editorWidget.background': '#18181c',
      'editorWidget.border': '#2e2e36',
      'diffEditor.insertedTextBackground': '#10b98122',
      'diffEditor.removedTextBackground': '#ef444424',
    },
  });

  monaco.editor.defineTheme('akron-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: '047857' },
      { token: 'string', foreground: '065f46' },
      { token: 'number', foreground: 'b45309' },
      { token: 'type', foreground: '1d4ed8' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#18181b',
      'editor.lineHighlightBackground': '#f4f4f6',
      'editorLineNumber.foreground': '#a1a1aa',
      'editorLineNumber.activeForeground': '#047857',
      'editorCursor.foreground': '#059669',
      'editor.selectionBackground': '#05966926',
      'editorGutter.background': '#fafafa',
      'editorWidget.background': '#f8f8fa',
      'editorWidget.border': '#e4e4e7',
      'diffEditor.insertedTextBackground': '#16a34a1f',
      'diffEditor.removedTextBackground': '#dc26261f',
    },
  });

  const tsNs = monacoTs || (monaco.languages && monaco.languages.typescript);
  if (tsNs && tsNs.ScriptTarget && tsNs.typescriptDefaults) {
    const tsOpts = {
      target: tsNs.ScriptTarget.ESNext,
      module: tsNs.ModuleKind.ESNext,
      moduleResolution: tsNs.ModuleResolutionKind.NodeJs,
      jsx: tsNs.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
    };
    tsNs.typescriptDefaults.setCompilerOptions(tsOpts);
    tsNs.javascriptDefaults.setCompilerOptions(tsOpts);
    tsNs.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
    tsNs.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }

  registerFixCommand();

  return monaco;
}

export function setMonacoTheme(theme) {
  ensureMonaco();
  monaco.editor.setTheme(theme === 'light' ? 'akron-light' : 'akron-dark');
}

export function registerGhostTextProvider(fetchCompletionFn) {
  ensureMonaco();
  if (ghostDisposable) { try { ghostDisposable.dispose(); } catch (_) {} ghostDisposable = null; }
  if (typeof fetchCompletionFn !== 'function') return () => {};
  let timer = null;
  ghostDisposable = monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions(model, position, _context, token) {
      return new Promise((resolve) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (token.isCancellationRequested) return resolve({ items: [] });
          try {
            const insertText = await fetchCompletionFn(model, position, token);
            if (!insertText || token.isCancellationRequested) return resolve({ items: [] });
            resolve({
              items: [{
                insertText,
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              }],
            });
          } catch (_) {
            resolve({ items: [] });
          }
        }, 420);
      });
    },
    freeInlineCompletions() {},
  });
  return () => {
    if (ghostDisposable) { try { ghostDisposable.dispose(); } catch (_) {} ghostDisposable = null; }
  };
}

export function registerFixWithAkronAction(onFixCallback) {
  ensureMonaco();
  registerFixCommand();
  fixCallbackRef = typeof onFixCallback === 'function' ? onFixCallback : null;
  if (codeActionDisposable) { try { codeActionDisposable.dispose(); } catch (_) {} codeActionDisposable = null; }
  if (typeof onFixCallback !== 'function') return () => {};
  const cmdId = 'akron.fixDiagnostic';
  codeActionDisposable = monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, range, context) {
      const markers = (context && context.markers) || [];
      if (!markers.length) return { actions: [], dispose: () => {} };
      const top = markers[0];
      const payload = { model, range, markers, primary: top, uri: model.uri.toString(), file: model.uri.fsPath || model.uri.path || '' };
      return {
        actions: [{
          title: '✦ Fix with Akron Code',
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: markers,
          run: () => onFixCallback(payload),
          command: { id: cmdId, title: 'Fix with Akron Code', arguments: [payload] },
        }],
        dispose: () => {},
      };
    },
  });
  return () => {
    fixCallbackRef = null;
    if (codeActionDisposable) { try { codeActionDisposable.dispose(); } catch (_) {} codeActionDisposable = null; }
  };
}

export function registerLspBridgeProviders(getCwdAndLang) {
  ensureMonaco();
  if (lspHoverDisposable) { try { lspHoverDisposable.dispose(); } catch (_) {} lspHoverDisposable = null; }
  if (lspDefDisposable) { try { lspDefDisposable.dispose(); } catch (_) {} lspDefDisposable = null; }
  if (typeof getCwdAndLang !== 'function') return () => {};

  const toLspPos = (pos) => ({ line: Math.max(0, pos.lineNumber - 1), character: Math.max(0, pos.column - 1) });

  lspHoverDisposable = monaco.languages.registerHoverProvider('*', {
    async provideHover(model, position) {
      try {
        if (!window.autobot?.ideLspRequest) return null;
        const { cwd } = getCwdAndLang(model) || {};
        if (!cwd) return null;
        const res = await window.autobot.ideLspRequest({
          cwd,
          language: model.getLanguageId(),
          method: 'textDocument/hover',
          params: { textDocument: { uri: model.uri.toString() }, position: toLspPos(position) },
        });
        const r = res && res.result;
        if (!r || !r.contents) return null;
        const contents = Array.isArray(r.contents) ? r.contents : [r.contents];
        const md = contents.map((c) => (typeof c === 'string' ? { value: c } : { value: String(c.value || '') })).filter((c) => c.value);
        return md.length ? { contents: md } : null;
      } catch (_) {
        return null;
      }
    },
  });

  lspDefDisposable = monaco.languages.registerDefinitionProvider('*', {
    async provideDefinition(model, position) {
      try {
        if (!window.autobot?.ideLspRequest) return null;
        const { cwd, onOpenLocation } = getCwdAndLang(model) || {};
        if (!cwd) return null;
        const res = await window.autobot.ideLspRequest({
          cwd,
          language: model.getLanguageId(),
          method: 'textDocument/definition',
          params: { textDocument: { uri: model.uri.toString() }, position: toLspPos(position) },
        });
        const raw = res && res.result;
        const locs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        const mapped = locs
          .filter((l) => l && (l.uri || l.targetUri) && (l.range || l.targetSelectionRange))
          .map((l) => {
            const u = monaco.Uri.parse(l.targetUri || l.uri);
            const rng = l.targetSelectionRange || l.range;
            if (onOpenLocation && u.fsPath && u.fsPath !== (model.uri.fsPath || '')) {
              setTimeout(() => onOpenLocation(u.fsPath, rng.start.line + 1, rng.start.character + 1), 0);
            }
            return {
              uri: u,
              range: new monaco.Range(rng.start.line + 1, rng.start.character + 1, rng.end.line + 1, rng.end.character + 1),
            };
          });
        return mapped.length ? mapped : null;
      } catch (_) {
        return null;
      }
    },
  });

  return () => {
    if (lspHoverDisposable) { try { lspHoverDisposable.dispose(); } catch (_) {} lspHoverDisposable = null; }
    if (lspDefDisposable) { try { lspDefDisposable.dispose(); } catch (_) {} lspDefDisposable = null; }
  };
}

export { monaco };
