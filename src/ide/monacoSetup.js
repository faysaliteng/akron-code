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
  if (codeActionDisposable) { try { codeActionDisposable.dispose(); } catch (_) {} codeActionDisposable = null; }
  if (typeof onFixCallback !== 'function') return () => {};
  const cmdId = 'akron.fixDiagnostic';
  codeActionDisposable = monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, range, context) {
      const markers = (context && context.markers) || [];
      if (!markers.length) return { actions: [], dispose: () => {} };
      const top = markers[0];
      return {
        actions: [{
          title: '✦ Fix with Akron Code',
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: markers,
          run: () => onFixCallback({ model, range, markers, primary: top }),
          command: { id: cmdId, title: 'Fix with Akron Code', arguments: [{ uri: model.uri.toString(), marker: top }] },
        }],
        dispose: () => {},
      };
    },
  });
  return () => {
    if (codeActionDisposable) { try { codeActionDisposable.dispose(); } catch (_) {} codeActionDisposable = null; }
  };
}

export { monaco };
