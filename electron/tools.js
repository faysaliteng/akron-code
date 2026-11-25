'use strict';
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const store = require('./store');
const visualize = require('./visualize');
const computer = require('./computer');
const chrome = require('./chrome');
const cowork = require('./cowork');
const browser = require('./browser');
const pluginsDir = require('./plugins');
const scheduler = require('./scheduler');
const { expandPath } = require('./paths');

const MAX_OUTPUT = 120000; // chars

function truncate(s) {
  if (!s) return s;
  s = String(s);
  if (s.length > MAX_OUTPUT) return s.slice(0, MAX_OUTPUT) + '\n…[truncated]';
  return s;
}

function resolvePath(p, cwd) {
  if (!p) throw new Error('path required');
  const expanded = expandPath(p);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(expandPath(cwd) || process.cwd(), expanded);
}

// Expand a directory string the way the shell would (`~`, $HOME, $VAR).
function resolveDir(d) {
  if (!d) return process.cwd();
  return path.resolve(expandPath(d));
}

// ---------- slash commands registry ----------
const SLASH_COMMANDS = {
  help: 'Show available slash commands and capabilities.',
  clear: 'Clear the current conversation history.',
  compact: 'Summarize the conversation to save context and continue in a fresh window.',
  model: 'Show or switch the active model.',
  review: 'Review the current working tree / recent changes for bugs and issues.',
  memory: 'Show the contents of long-term memory.',
  reset: 'Reset Helio Bot to a clean state (clear memory + conversations).',
  status: 'Show provider, model, and tool configuration status.',
};

// ---------- executors ----------
const executors = {
  async bash({ command, cwd, timeout }) {
    if (!command) return 'Error: command required';
    const t = Math.min(Number(timeout) || 60, 120) * 1000;
    const dir = resolveDir(cwd);
    return new Promise((resolve) => {
      // `-l` login shell → inherits ~/.zprofile / ~/.zshenv so brew, npm, pip,
      // and other toolchain binaries are on PATH exactly as they are in Terminal.
      // (spawn /bin/zsh with `-l -c` rather than exec `shell:'/bin/zsh -l'`,
      //  which Node would treat as a single executable name and ENOENT on.)
      let out = '';
      let settled = false;
      const child = spawn('/bin/zsh', ['-l', '-c', String(command)], { cwd: dir, timeout: t });
      const finish = (fn) => {
        if (settled) return; settled = true;
        if (out === '') out = '(no output)';
        resolve(truncate(fn ? fn(out) : out));
      };
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += (out ? '\n[stderr]\n' : '') + d; });
      child.on('error', (e) => { if (out === '') out = `Error (${e.code || 'spawn'}): ${e.message}`; finish(); });
      child.on('close', (code, signal) => {
        if (code !== 0 && out === '') out = signal ? `Error (killed by ${signal})` : `Error (exit ${code})`;
        finish();
      });
    });
  },

  async read_file({ path: p, cwd }) {
    const fp = resolvePath(p, cwd);
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const lines = raw.split('\n');
      const maxLines = 2000;
      let out = lines.slice(0, maxLines).join('\n');
      if (lines.length > maxLines) out += `\n…[${lines.length - maxLines} more lines]`;
      return out || '(empty file)';
    } catch (e) {
      return 'Error reading file: ' + e.message;
    }
  },

  async write_file({ path: p, content, cwd }) {
    if (!p) return 'Error: Write requires a "path" argument, e.g. {"path":"index.html","content":"..."}. Point the file at the project folder with a relative path.';
    if (content === undefined || content === null) {
      return 'Error: Write requires a "content" argument with the COMPLETE file contents. For an empty file pass content: "".';
    }
    let fp;
    try { fp = resolvePath(p, cwd); } catch (e) { return 'Error writing file: ' + e.message; }
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      // Guard against the classic "model wrote a fragment" failure: a file that
      // only contains a placeholder is worse than no file at all.
      fs.writeFileSync(fp, body, 'utf8');
      const size = fs.statSync(fp).size;
      const warn = /(\/\/\s*rest of (the )?(code|file)|\.\.\.\s*(rest|omitted)|<placeholder>)/i.test(body)
        ? ' WARNING: content contains a placeholder — rewrite the file with its COMPLETE contents.'
        : '';
      return `Wrote ${size} bytes to ${fp}.${warn}`;
    } catch (e) {
      return 'Error writing file (path=' + (p || '?') + '): ' + e.message;
    }
  },

  async edit_file({ path: p, old_string, new_string, cwd, replace_all }) {
    if (!p) return 'Error: Edit requires a "path" argument.';
    let fp;
    try { fp = resolvePath(p, cwd); } catch (e) { return 'Error editing file: ' + e.message; }
    try {
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); }
      catch (e) {
        return `Error editing file: cannot read ${fp} (${e.code || e.message}). Use the Write tool to create it first.`;
      }
      if (old_string === undefined || old_string === '') {
        return 'Error: Edit requires a non-empty "old_string" copied exactly from the file (use Read first), plus "new_string".';
      }
      const ns = new_string == null ? '' : String(new_string);
      const replaceAll = !!replace_all;

      // 1) exact or whitespace-tolerant match
      if (replaceAll) {
        const n = raw.split(old_string).length - 1;
        if (n === 0) {
          return `Error: old_string not found in ${fp}. The file is unchanged.\n\n${fileHead(fp, raw)}\n\nRe-copy old_string exactly from the lines above (or use Write to replace the whole file).`;
        }
        fs.writeFileSync(fp, raw.split(old_string).join(ns), 'utf8');
        return `Replaced ${n} occurrence${n === 1 ? '' : 's'} in ${fp}`;
      }
      const r = replaceOnce(raw, old_string, ns);
      if (r.raw != null) {
        fs.writeFileSync(fp, r.raw, 'utf8');
        return r.fuzzy
          ? `Replaced 1 occurrence in ${fp} (matched after ignoring whitespace differences).`
          : `Replaced 1 occurrence in ${fp}`;
      }

      // 2) give the model something actionable instead of a dead end
      return `Error: old_string not found in ${fp}. The file is unchanged.\n\n${fileHead(fp, raw)}\n\nRe-copy old_string exactly from the lines above (or use Write to replace the whole file).`;
    } catch (e) {
      return 'Error editing file: ' + e.message;
    }
  },

  async multi_edit({ path: p, edits, cwd }) {
    if (!p) return 'Error: MultiEdit requires a "path" argument.';
    let fp;
    try { fp = resolvePath(p, cwd); } catch (e) { return 'Error multi-editing file: ' + e.message; }
    try {
      if (!Array.isArray(edits) || !edits.length) {
        return 'Error: MultiEdit requires a non-empty "edits" array of {old_string, new_string} pairs.';
      }
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); }
      catch (e) {
        return `Error multi-editing file: cannot read ${fp} (${e.code || e.message}). Use the Write tool to create it first.`;
      }
      let applied = 0;
      for (const e of edits) {
        if (!e || typeof e.old_string !== 'string' || e.old_string === '') {
          return `Error: edit #${applied + 1} is missing a non-empty "old_string". No changes were applied.`;
        }
        const r = replaceOnce(raw, e.old_string, e.new_string == null ? '' : String(e.new_string));
        if (r.raw == null) {
          return `Error: one old_string not found (edit #${applied + 1} of ${edits.length}); no changes applied.\n\n${fileHead(fp, raw, 40)}\n\nFix that edit's old_string (copy it exactly from the lines above) and resend.`;
        }
        raw = r.raw;
        applied++;
      }
      fs.writeFileSync(fp, raw, 'utf8');
      return `Applied ${applied} edits to ${fp}`;
    } catch (e) {
      return 'Error multi-editing file: ' + e.message;
    }
  },

  async glob({ pattern, cwd }) {
    const base = resolveDir(cwd);
    const results = [];
    const reStr = '^' + pattern
      .split(path.sep).join('/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*') + '$';
    let re;
    try { re = new RegExp(reStr); } catch { return 'Error: invalid pattern'; }
    const walk = (dir, depth) => {
      if (depth > 8 || results.length > 5000) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        if (re.test(rel) && rel !== '') results.push(rel);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
      }
    };
    walk(base, 0);
    return results.length ? results.slice(0, 2000).join('\n') : '(no matches)';
  },

  async grep({ pattern, path: p, cwd }) {
    const target = p ? resolvePath(p, cwd) : resolveDir(cwd);
    return new Promise((resolve) => {
      const args = ['-n', '--', pattern || '', target];
      exec('rg ' + args.map((a) => JSON.stringify(a)).join(' '), { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout) return resolve(truncate(stdout));
        const gargs = ['-rIn', '--', pattern || '', target];
        exec('grep ' + gargs.map((a) => JSON.stringify(a)).join(' '), { maxBuffer: 8 * 1024 * 1024 }, (e2, out2) => {
          resolve(truncate(out2) || '(no matches)');
        });
      });
    });
  },

  async web_fetch({ url }) {
    if (!url || !/^https?:\/\//i.test(url)) return 'Error: absolute http(s) URL required';
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'HelioBot/1.0' } });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return truncate(text.slice(0, 30000));
      }
      return truncate(await res.text());
    } catch (e) {
      return 'Error fetching URL: ' + e.message;
    }
  },

  async web_search({ query }) {
    if (!query) return 'Error: query required';
    try {
      const u = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (AUTOBOT)' } });
      const html = await res.text();
      const hits = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && hits.length < 8) {
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        let url = m[1];
        const ud = /uddg=([^&]+)/.exec(url);
        if (ud) url = decodeURIComponent(ud[1]);
        hits.push(`${title}\n  ${url}`);
      }
      return hits.length ? hits.join('\n\n') : '(no results)';
    } catch (e) {
      return 'Error searching: ' + e.message;
    }
  },

  async todo_write({ todos }) {
    if (!Array.isArray(todos)) return 'Error: todos array required';
    const lines = todos.map((t) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content || t.title || ''}`);
    return 'TODOS:\n' + lines.join('\n');
  },

  // ---- Notebooks ----
  async notebook_read({ name }) {
    if (!name) return 'Error: notebook name required';
    const nb = store.getNotebook(name);
    if (!nb.cells || !nb.cells.length) return `Notebook "${name}" is empty.`;
    return nb.cells.map((c, i) => `### Cell ${i} (${c.language || 'text'})\n${c.source || ''}`).join('\n\n');
  },

  async notebook_edit({ name, cells }) {
    if (!name) return 'Error: notebook name required';
    if (!Array.isArray(cells)) return 'Error: cells array required';
    const nb = store.writeNotebook(name, cells);
    return `Saved notebook "${name}" with ${nb.cells.length} cells.`;
  },

  async list_notebooks() {
    const names = store.listNotebooks();
    return names.length ? 'NOTEBOOKS:\n' + names.map((n) => `- ${n}`).join('\n') : '(no notebooks)';
  },

  // ---- Memory ----
  async memory_add({ content }) {
    if (!content) return 'Error: content required';
    store.addMemory(content);
    return 'Saved to memory.';
  },

  async memory_list() {
    return 'MEMORY:\n' + store.memoryAsText();
  },

  async memory_delete({ index }) {
    const r = store.deleteMemory(index);
    if (r.ok) return `Deleted memory entry at index ${index}.`;
    return r.error || 'Failed to delete memory entry.';
  },

  // ---- Skills ----
  async list_skills() {
    const skills = store.getSkills().filter((s) => s.enabled !== false);
    if (!skills.length) return 'SKILLS:\n(no skills enabled)';
    return 'SKILLS:\n' + skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  },

  async load_skill({ name }) {
    const text = store.loadSkill(name);
    return text ? `SKILL "${name}":\n${text}` : `Skill "${name}" not found.`;
  },

  async skill({ name }) {
    return executors.load_skill({ name });
  },

  // ---- Custom skill authoring ----
  async create_skill({ name, content }) {
    const r = store.addCustomSkill(name, content);
    if (!r.ok) return 'Error: ' + r.error;
    return `Created custom skill "${r.name}" (saved to ${r.file}). It is now available via list_skills and Skill.`;
  },

  async delete_skill({ name }) {
    const r = store.deleteCustomSkill(name);
    if (!r.ok) return 'Error: ' + r.error;
    return `Deleted custom skill "${r.name}".`;
  },

  // ---- Plugins & connectors ----
  async plugins_list_plugins({ type, category, installedOnly } = {}) {
    const list = pluginsDir.listPlugins({ type, category, installedOnly: !!installedOnly });
    return pluginsDir.formatList(list, 'PLUGINS & CONNECTORS (' + list.length + ')');
  },
  async plugins_search_plugins({ query, limit } = {}) {
    const list = pluginsDir.search(query, { type: 'plugin', limit });
    return pluginsDir.formatList(list, 'PLUGIN SEARCH: ' + (query || ''));
  },
  async plugins_search_connectors({ query, limit } = {}) {
    const list = pluginsDir.search(query, { type: 'connector', limit });
    return pluginsDir.formatList(list, 'CONNECTOR SEARCH: ' + (query || ''));
  },
  async plugins_suggest_plugin_install({ goal, limit } = {}) {
    return pluginsDir.formatSuggest(pluginsDir.suggest(goal, { limit }), goal);
  },
  async plugins_install({ id } = {}) {
    const r = pluginsDir.install(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Installed ${r.entry.name} (${r.entry.id}).${r.entry.auth !== 'none' ? ' It needs a sign-in/credential before its tools work — open Plugins in the sidebar to connect it.' : ''}`;
  },
  async plugins_uninstall({ id } = {}) {
    const r = pluginsDir.uninstall(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Uninstalled ${id}.`;
  },

  // ---- MCP registry (connector view of the same catalog) ----
  async mcp_registry_list_connectors({ installedOnly } = {}) {
    const list = pluginsDir.listPlugins({ type: 'connector', installedOnly: !!installedOnly });
    return pluginsDir.formatList(list, 'MCP CONNECTORS (' + list.length + ')');
  },
  async mcp_registry_search_mcp_registry({ query, limit } = {}) {
    const list = pluginsDir.search(query, { type: 'connector', limit });
    return pluginsDir.formatList(list, 'MCP REGISTRY SEARCH: ' + (query || ''));
  },
  async mcp_registry_suggest_connectors({ goal, limit } = {}) {
    const list = pluginsDir.suggest(goal, { limit });
    return pluginsDir.formatSuggest(list, goal);
  },

  // ---- Scheduled tasks ----
  async scheduled_tasks_create_scheduled_task(args = {}) {
    const r = scheduler.create(args);
    if (!r.ok) return 'Error: ' + r.error;
    return `Created scheduled task ${r.task.id} "${r.task.name}" [${r.task.schedule}].`;
  },
  async scheduled_tasks_list_scheduled_tasks() {
    return scheduler.formatList(scheduler.list());
  },
  async scheduled_tasks_update_scheduled_task({ id, ...patch } = {}) {
    const r = scheduler.update(id, patch);
    if (!r.ok) return 'Error: ' + r.error;
    return `Updated scheduled task ${r.task.id} [${r.task.schedule}].`;
  },
  async scheduled_tasks_delete_scheduled_task({ id } = {}) {
    const r = scheduler.remove(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Deleted scheduled task ${id}.`;
  },
  async scheduled_tasks_run_scheduled_task({ id } = {}) {
    const r = await scheduler.runNow(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Ran scheduled task ${id}: ` + (r.result.ok ? String(r.result.output || '').slice(0, 1200) : 'ERROR ' + r.result.error);
  },

  // ---- Slash commands ----
  async slash_command({ command }) {
    if (!command) return 'Error: command required';
    const key = String(command).replace(/^\//, '');
    if (SLASH_COMMANDS[key]) return `Slash command "/${key}": ${SLASH_COMMANDS[key]}`;
    return `Unknown slash command "/${key}". Available: ${Object.keys(SLASH_COMMANDS).map((c) => '/' + c).join(', ')}`;
  },

  async list_slash_commands() {
    return 'SLASH COMMANDS:\n' + Object.entries(SLASH_COMMANDS).map(([c, d]) => `/${c} — ${d}`).join('\n');
  },

  // ---- Code execution (REPL / JavaScript) ----
  async javascript({ code, cwd }) {
    if (!code) return 'Error: code required';
    return runCode('javascript', code, cwd, 60000);
  },

  async repl({ language, code, cwd }) {
    if (!code) return 'Error: code required';
    const lang = (language || 'javascript').toLowerCase();
    return runCode(lang, code, cwd, 60000);
  },

  // ---- Tool search ----
  async tool_search({ query }) {
    const q = String(query || '').toLowerCase();
    const matches = toolDefinitions.filter(
      (t) => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
    if (!matches.length) return '(no matching tools)';
    return 'TOOLS:\n' + matches.slice(0, 25).map((t) => `- ${t.name}: ${t.description}`).join('\n');
  },

  // ---- Jira / Linear integrations (config-gated) ----
  async jira({ action, jql, issueKey, project, summary, description }) {
    const base = process.env.JIRA_BASE_URL || '';
    const email = process.env.JIRA_EMAIL || '';
    const token = process.env.JIRA_API_TOKEN || '';
    if (!base || !email || !token) {
      return 'Jira integration not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN to enable (search / get / create issues).';
    }
    const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    const act = (action || 'search').toLowerCase();
    try {
      let url, method = 'GET', body;
      if (act === 'search' || act === 'list') {
        url = `${base.replace(/\/$/, '')}/rest/api/3/search?jql=${encodeURIComponent(jql || 'order by created DESC')}&maxResults=10`;
      } else if (act === 'get') {
        url = `${base.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey || '')}`;
      } else if (act === 'create') {
        method = 'POST';
        url = `${base.replace(/\/$/, '')}/rest/api/3/issue`;
        body = JSON.stringify({ fields: { project: { key: project || '' }, summary: summary || '', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description || '' }] }] } } });
      } else {
        return 'Unsupported Jira action. Use search, get, or create.';
      }
      const res = await fetch(url, { method, headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' }, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return `Jira error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`;
      if (act === 'search' || act === 'list') {
        const issues = data.issues || [];
        if (!issues.length) return '(no Jira issues found)';
        return issues.map((i) => `- ${i.key}: ${(i.fields && i.fields.summary) || ''}`).join('\n');
      }
      return truncate(JSON.stringify(data, null, 2));
    } catch (e) {
      return 'Jira error: ' + e.message;
    }
  },

  async linear({ action, query }) {
    const key = process.env.LINEAR_API_KEY || '';
    if (!key) return 'Linear integration not configured. Set LINEAR_API_KEY to enable.';
    const act = (action || 'issues').toLowerCase();
    let gql;
    if (act === 'issues' || act === 'list') gql = `query { issues(first: 10, orderBy: updatedAt) { nodes { identifier title state { name } } } }`;
    else if (act === 'search') gql = `query { issueSearch(filter: { query: ${JSON.stringify(query || '')} }, first: 10) { nodes { identifier title } } }`;
    else return 'Unsupported Linear action. Use issues or search.';
    try {
      const res = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ query: gql }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return `Linear error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`;
      const nodes = data.data && (data.data.issues ? data.data.issues.nodes : data.data.issueSearch && data.data.issueSearch.nodes) || [];
      if (!nodes.length) return '(no Linear issues found)';
      return nodes.map((n) => `- ${n.identifier}: ${n.title}`).join('\n');
    } catch (e) {
      return 'Linear error: ' + e.message;
    }
  },

  // ---- Computer Use ----
  async computer_screenshot({ dir }) {
    const r = await computer.screenshot({ dir });
    return `Screenshot saved: ${r.path} (${r.size} bytes)`;
  },
  async computer_click({ x, y, button, double }) {
    await computer.click(Number(x), Number(y), button, !!double);
    return `Clicked at (${x}, ${y}).`;
  },
  async computer_move({ x, y }) {
    await computer.move(Number(x), Number(y));
    return `Moved mouse to (${x}, ${y}).`;
  },
  async computer_drag({ x1, y1, x2, y2 }) {
    await computer.drag(Number(x1), Number(y1), Number(x2), Number(y2));
    return `Dragged from (${x1},${y1}) to (${x2},${y2}).`;
  },
  async computer_scroll({ direction, amount }) {
    await computer.scroll(direction, amount);
    return 'Scrolled.';
  },
  async computer_type({ text }) {
    await computer.type(text);
    return 'Typed.';
  },
  async computer_key({ keys }) {
    await computer.key(keys);
    return 'Key pressed.';
  },
  async computer_screen_size() {
    const s = await computer.screenSize();
    return `Screen: ${s.width}x${s.height}`;
  },

  // ---- Chrome (CDP) ----
  async chrome_list_tabs() {
    const ts = await chrome.getTargets();
    return ts.length ? ts.map((t) => `- ${t.id}: ${t.title} (${t.url})`).join('\n') : '(no Chrome tabs found)';
  },
  async chrome_navigate({ url, targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    cdp.close();
    return `Navigated to ${url}`;
  },
  async chrome_evaluate({ expression, targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    const v = await chrome.evaluate(cdp, expression);
    cdp.close();
    return String(v);
  },
  async chrome_screenshot({ targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    cdp.close();
    return r && r.data ? `base64 PNG (length ${r.data.length})` : '(no screenshot)';
  },

  // ---- Built-in Browser (the in-app <webview> pane) ----
  async browser_open({ url, cwd }) {
    const r = await browser.loadURL(url, cwd);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Opened ${r.url} in the built-in browser.`;
  },
  async browser_navigate({ url, cwd }) {
    const r = await browser.loadURL(url, cwd);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Navigated to ${r.url}.`;
  },
  async browser_back() {
    const r = await browser.goBack();
    return r.ok ? `Went back to ${r.url || 'previous page'}.` : 'Browser error: ' + r.error;
  },
  async browser_forward() {
    const r = await browser.goForward();
    return r.ok ? `Went forward to ${r.url || 'next page'}.` : 'Browser error: ' + r.error;
  },
  async browser_reload() {
    const r = await browser.reload();
    return r.ok ? 'Reloaded.' : 'Browser error: ' + r.error;
  },
  async browser_stop() {
    const r = await browser.stop();
    return r.ok ? 'Stopped.' : 'Browser error: ' + r.error;
  },
  async browser_read() {
    const r = await browser.read();
    if (!r.ok) return 'Browser error: ' + r.error;
    return truncate(`PAGE: ${r.title}\nURL: ${r.url}\n\n${r.text || '(no visible text)'}`);
  },
  async browser_snapshot() {
    const r = await browser.read();
    if (!r.ok) return 'Browser error: ' + r.error;
    const lines = [`PAGE: ${r.title}`, `URL: ${r.url}`];
    if (r.links && r.links.length) { lines.push('\nLINKS:'); r.links.forEach((l) => lines.push('- ' + l)); }
    if (r.buttons && r.buttons.length) { lines.push('\nBUTTONS:'); r.buttons.forEach((b) => lines.push('- ' + b)); }
    if (r.inputs && r.inputs.length) { lines.push('\nINPUTS:'); r.inputs.forEach((i) => lines.push(`- <${i.tag}> name="${i.name}" type="${i.type}" placeholder="${i.placeholder}"`)); }
    return truncate(lines.join('\n'));
  },
  async browser_click({ selector, index }) {
    const r = await browser.click(selector, index);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}" at index ${Number(index) || 0}.`;
    return `Clicked <${r.tag}> "${r.text}".`;
  },
  async browser_type({ selector, text }) {
    const r = await browser.type(selector, text);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}".`;
    return `Typed into ${selector}.`;
  },
  async browser_press({ key }) {
    const r = await browser.press(key);
    return r.ok ? `Pressed "${key}".` : 'Browser error: ' + r.error;
  },
  async browser_js({ code }) {
    const r = await browser.executeJS(code, true);
    if (!r.ok) return 'Browser error: ' + r.error;
    return typeof r.result === 'object' ? JSON.stringify(r.result, null, 2) : String(r.result);
  },
  async browser_hover({ selector, index }) {
    const r = await browser.hover(selector, index);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}" at index ${Number(index) || 0}.`;
    return `Hovered <${r.tag}> "${r.text}".`;
  },
  async browser_select({ selector, value }) {
    const r = await browser.select(selector, value);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No <select> matched selector "${selector}".`;
    return `Selected "${r.value}" in ${selector}.`;
  },
  async browser_scroll({ direction, amount, selector }) {
    const r = await browser.scroll(direction, amount, selector);
    if (!r.ok) return 'Browser error: ' + r.error;
    const pos = r.scrollY != null ? `scrollY=${r.scrollY}` : `scrollTop=${r.scrollTop}`;
    return `Scrolled ${String(direction || 'down')} ${amount == null ? 600 : amount}px (${pos}).`;
  },
  async browser_wait_for({ selector, timeoutMs }) {
    const r = await browser.waitFor(selector, timeoutMs);
    if (!r.ok) return 'Browser error: ' + r.error;
    return r.found ? `Element "${selector}" appeared after ${r.waited}ms.` : `Timed out after ${r.waited}ms waiting for "${selector}".`;
  },
  async browser_screenshot({ fullPage }) {
    const r = await browser.screenshot(!!fullPage);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Screenshot saved: ${r.path} (${r.width}x${r.height}${fullPage ? ', full page' : ''}). Use Read to view it.`;
  },
  async browser_tabs({ action, url, index }) {
    const act = String(action || 'list').toLowerCase();
    if (act === 'list') {
      const r = browser.listTabs();
      if (!r.tabs || !r.tabs.length) return 'No browser tabs (pane closed).';
      return 'TABS:\n' + r.tabs.map((t, i) => `${i + 1}. ${t.title || '(untitled)'} — ${t.url}${t.id === r.activeId ? ' [active]' : ''}`).join('\n');
    }
    if (act === 'new') {
      const r = browser.sendTabCommand({ type: 'new', url: url ? browser.normalizeUrl(url) : undefined });
      if (!r.ok) return 'Browser error: ' + r.error;
      await new Promise((res) => setTimeout(res, 1500));
      const st = browser.listTabs();
      const t = (st.tabs || []).find((x) => x.id === st.activeId);
      return t ? `Opened new tab: ${t.title || t.url} — ${t.url}` : 'Opened a new tab.';
    }
    const state = browser.listTabs();
    if (act === 'close' || act === 'switch') {
      const tabs = state.tabs || [];
      const target = tabs[Number(index)] || tabs.find((t) => t.id === state.activeId) || null;
      if (!target) return 'No such tab.';
      const r = browser.sendTabCommand({ type: act, tabId: target.id });
      if (!r.ok) return 'Browser error: ' + r.error;
      await new Promise((res) => setTimeout(res, act === 'switch' ? 400 : 700));
      if (act === 'switch') {
        const wid = browser.getGuest();
        const u = wid ? (() => { try { return wid.getURL(); } catch (e) { return ''; } })() : '';
        return `Switched to tab "${target.title || target.url}"${u ? ' — ' + u : ''}.`;
      }
      return `Closed tab "${target.title || target.url}".`;
    }
    return `Unknown action "${action}". Use list, new, switch, or close.`;
  },
};

// Run a snippet of code in a language via a local runtime and return output.
function runCode(lang, code, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const t = Math.min(timeoutMs || 60000, 120000);
    let cmd;
    if (lang === 'javascript' || lang === 'js' || lang === 'node') {
      cmd = 'node -e ' + JSON.stringify(String(code));
    } else if (lang === 'python' || lang === 'py' || lang === 'python3') {
      cmd = 'python3 -c ' + JSON.stringify(String(code));
    } else if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
      cmd = '/bin/zsh -c ' + JSON.stringify(String(code));
    } else {
      resolve(`Unsupported REPL language "${lang}". Supported: javascript/node, python, bash/shell.`);
      return;
    }
    exec(cmd, { cwd: resolveDir(cwd), timeout: t, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n[stderr]\n' : '') + stderr;
      if (err && !out) out = 'Error: ' + err.message;
      resolve(truncate(out || '(no output)'));
    });
  });
}

// ---------- tool definitions (OpenAI function-calling schema) ----------
// Names/descriptions mirror Claude Code's tool surface 1:1 where applicable.
const toolDefinitions = [
  { name: 'Bash', description: 'Run a shell command in zsh (run code, git, install deps, list/inspect files). Do NOT create or edit files with heredocs, echo, tee or sed -i — use Write/Edit for file content.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to execute' }, cwd: { type: 'string', description: 'Working directory' }, timeout: { type: 'number', description: 'Timeout in seconds (max 120)' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a text file from disk and return its contents (up to 2000 lines). Read a file before editing it.', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string', description: 'Alias for path' }, cwd: { type: 'string' } }, required: ['path'] } },
  { name: 'Write', description: 'Create a new file or fully overwrite an existing one. Provide the COMPLETE final contents (no placeholders, no elisions). Relative paths resolve inside the project folder. This is the only correct way to create files — never use bash heredocs.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path, relative to the project folder' }, file_path: { type: 'string', description: 'Alias for path' }, content: { type: 'string', description: 'The complete file contents' }, cwd: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'Edit', description: 'Make a targeted change to an existing file: replace old_string with new_string (first match). Read the file first and copy old_string exactly, including indentation. Whitespace drift is tolerated.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string', description: 'Exact text to replace (copy from Read output)' }, new_string: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace every occurrence' }, cwd: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'MultiEdit', description: 'Apply several {old_string,new_string} replacements to one file in a single call (all-or-nothing). Use instead of many separate Edits.', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] } }, cwd: { type: 'string' } }, required: ['path', 'edits'] } },
  { name: 'Glob', description: 'Find files matching a glob pattern (supports **, *, ?).', parameters: { type: 'object', properties: { pattern: { type: 'string' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents for a regex pattern recursively.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'WebFetch', description: 'Fetch the contents of a URL and return readable text.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'WebSearch', description: 'Search the web and return top results (titles + URLs).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'TodoWrite', description: 'Create/update a structured todo list to track multi-step work.', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'completed'] } } } } }, required: ['todos'] } },
  { name: 'Task', description: 'Spawn a sub-agent to complete a self-contained, multi-step task and return its result. Use for parallelizable or independent work.', parameters: { type: 'object', properties: { description: { type: 'string', description: 'Short label for the task' }, prompt: { type: 'string', description: 'The full instructions for the sub-agent' }, cwd: { type: 'string' } }, required: ['description', 'prompt'] } },
  { name: 'Agent', description: 'Spawn a sub-agent (alias of Task) to delegate a self-contained piece of work.', parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' } }, required: ['description', 'prompt'] } },
  { name: 'NotebookRead', description: 'Read the cells of a notebook by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'NotebookEdit', description: 'Create or replace the cells of a notebook by name.', parameters: { type: 'object', properties: { name: { type: 'string' }, cells: { type: 'array', items: { type: 'object', properties: { language: { type: 'string' }, source: { type: 'string' } } } } }, required: ['name', 'cells'] } },
  { name: 'AskUserQuestion', description: 'Ask the user a structured question and wait for their answer. Use when you need a decision, clarification, or choice before proceeding.', parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } } } }, required: ['question'] } },
  { name: 'KillShell', description: 'Kill a running background shell by its id.', parameters: { type: 'object', properties: { shell_id: { type: 'string' } }, required: ['shell_id'] } },
  { name: 'SlashCommand', description: 'Invoke a slash command by name (e.g. /help, /clear, /compact, /model, /review).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'ExitPlanMode', description: 'Exit plan mode — present a plan for user approval before execution.', parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } },
  { name: 'Skill', description: 'Load the full instructions for a skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'ListMcpResources', description: 'List resources exposed by a connected MCP server.', parameters: { type: 'object', properties: { server: { type: 'string' } } } },
  { name: 'ReadMcpResource', description: 'Read a resource from a connected MCP server by URI.', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['uri'] } },
  { name: 'memory_add', description: 'Persist a fact/note to long-term memory.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'memory_list', description: 'List everything saved to long-term memory.', parameters: { type: 'object', properties: {} } },
  { name: 'memory_delete', description: 'Delete a memory entry by its index.', parameters: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] } },
  { name: 'list_skills', description: 'List available skills.', parameters: { type: 'object', properties: {} } },
  { name: 'list_notebooks', description: 'List available notebooks.', parameters: { type: 'object', properties: {} } },
  { name: 'list_slash_commands', description: 'List available slash commands.', parameters: { type: 'object', properties: {} } },
  { name: 'REPL', description: 'Run a snippet of code in a REPL-like session for the given language (javascript/node, python, or bash) and return the output.', parameters: { type: 'object', properties: { language: { type: 'string', description: 'Language: javascript, python, or bash' }, code: { type: 'string', description: 'The code to execute' }, cwd: { type: 'string' } }, required: ['code'] } },
  { name: 'JavaScript', description: 'Execute a JavaScript snippet with Node.js and return its stdout/stderr.', parameters: { type: 'object', properties: { code: { type: 'string' }, cwd: { type: 'string' } }, required: ['code'] } },
  { name: 'Cd', description: 'Change the current working directory for subsequent Bash/Read/Write/Glob/Grep tools.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'TaskStop', description: 'Stop a running sub-agent/task by its description label.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Sub-agent label to stop' } }, required: ['name'] } },
  { name: 'ListAgents', description: 'List currently running sub-agents/tasks.', parameters: { type: 'object', properties: {} } },
  { name: 'SendUserMessage', description: 'Send a message/notification to the user outside the normal assistant reply.', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'SetGoal', description: 'Set or update the current task/goal being worked on.', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
  { name: 'ToolSearch', description: 'Search the available tool surface by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'Artifact', description: 'Create or update a named artifact (a code block / document) that appears in the Artifacts panel.', parameters: { type: 'object', properties: { name: { type: 'string' }, language: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] } },
  { name: 'Jira', description: 'Interact with Jira (search/list/get/create issues) if JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN are configured.', parameters: { type: 'object', properties: { action: { type: 'string', description: 'search | get | create' }, jql: { type: 'string' }, issueKey: { type: 'string' }, project: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' } }, required: ['action'] } },
  { name: 'Linear', description: 'Interact with Linear (list/search issues) if LINEAR_API_KEY is configured.', parameters: { type: 'object', properties: { action: { type: 'string', description: 'issues | search' }, query: { type: 'string' } } } },
  { name: 'mcp__secrets__request_secret', description: '[secrets] Request a secret value (e.g. API key) by name from the secrets store.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ---- Virtual built-in MCP namespaces (mirror Claude Code's internal MCP tools 1:1) ----
  { name: 'mcp__workspace__bash', description: '[workspace] Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
  { name: 'mcp__workspace__read_file', description: '[workspace] Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string', description: 'Alias for path' }, cwd: { type: 'string' } }, required: ['path'] } },
  { name: 'mcp__workspace__write_file', description: '[workspace] Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, cwd: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'mcp__workspace__edit_file', description: '[workspace] Edit a file (string replace).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, cwd: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'mcp__workspace__glob', description: '[workspace] Glob for files.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'mcp__workspace__grep', description: '[workspace] Grep file contents.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'mcp__workspace__web_fetch', description: '[workspace] Fetch a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'mcp__terminal__list_terminal_tabs', description: '[terminal] List open terminal tabs.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__terminal__open_terminal_tab', description: '[terminal] Open a new terminal tab.', parameters: { type: 'object', properties: { cwd: { type: 'string' } } } },
  { name: 'mcp__terminal__read_terminal', description: '[terminal] Read output from a terminal tab.', parameters: { type: 'object', properties: { terminal_id: { type: 'string' } }, required: ['terminal_id'] } },
  { name: 'mcp__terminal__run_in_terminal', description: '[terminal] Run a command in a terminal tab.', parameters: { type: 'object', properties: { terminal_id: { type: 'string' }, command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
  { name: 'mcp__terminal__stop_terminal_tab', description: '[terminal] Stop and close a terminal tab.', parameters: { type: 'object', properties: { terminal_id: { type: 'string' } }, required: ['terminal_id'] } },
  { name: 'mcp__memory__memory_add', description: '[memory] Add to long-term memory.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'mcp__memory__memory_list', description: '[memory] List long-term memory.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__memory__memory_delete', description: '[memory] Delete a memory entry.', parameters: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] } },
  { name: 'mcp__skills__list_skills', description: '[skills] List available skills.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__skills__load_skill', description: '[skills] Load a skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ---- Visualize (charts) ----
  { name: 'mcp__visualize__visualize', description: '[visualize] Render a chart (bar/line/pie/scatter/area) from data as an SVG artifact.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'bar | line | pie | scatter | area' }, title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, data: { type: 'array', items: { type: 'number' } } } } },

  // ---- Computer Use ----
  { name: 'mcp__computer__screenshot', description: '[computer] Capture the screen to a PNG file and return its path/size.', parameters: { type: 'object', properties: { dir: { type: 'string' } } } },
  { name: 'mcp__computer__click', description: '[computer] Click at screen coordinates (x, y). button: left|right|middle.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, double: { type: 'boolean' } }, required: ['x', 'y'] } },
  { name: 'mcp__computer__move', description: '[computer] Move the mouse to (x, y).', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'mcp__computer__drag', description: '[computer] Drag from (x1,y1) to (x2,y2).', parameters: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'mcp__computer__scroll', description: '[computer] Scroll (direction: up|down|left|right).', parameters: { type: 'object', properties: { direction: { type: 'string' }, amount: { type: 'number' } } } },
  { name: 'mcp__computer__type', description: '[computer] Type text via keystroke.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'mcp__computer__key', description: '[computer] Press a key chord (e.g. "cmd+c", "enter").', parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'mcp__computer__screen_size', description: '[computer] Get the screen dimensions.', parameters: { type: 'object', properties: {} } },

  // ---- Chrome (CDP) ----
  { name: 'mcp__chrome__list_tabs', description: '[chrome] List open Chrome tabs (requires Chrome started with --remote-debugging-port=9222).', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__chrome__navigate', description: '[chrome] Navigate a Chrome tab to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' }, targetId: { type: 'string' } }, required: ['url'] } },
  { name: 'mcp__chrome__evaluate', description: '[chrome] Evaluate a JavaScript expression in a Chrome tab and return its value.', parameters: { type: 'object', properties: { expression: { type: 'string' }, targetId: { type: 'string' } }, required: ['expression'] } },
  { name: 'mcp__chrome__screenshot', description: '[chrome] Screenshot a Chrome tab (returns base64 PNG length).', parameters: { type: 'object', properties: { targetId: { type: 'string' } } } },

  // ---- Cowork orchestration ----
  { name: 'mcp__cowork__register_worker', description: '[cowork] Register a cowork worker (a sub-agent). Optionally pin it to its own model endpoint (baseURL + model + apiKey) so different workers run on different backends (e.g. NVIDIA NIM vs local Ollama Gemma).', parameters: { type: 'object', properties: { name: { type: 'string' }, goal: { type: 'string' }, baseURL: { type: 'string', description: 'OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1 or http://127.0.0.1:11434/v1' }, model: { type: 'string', description: 'Model id for this worker, e.g. nvidia/nemotron-3.5-bolt-e4b or gemma4:latest' }, apiKey: { type: 'string', description: 'API key for this worker (omit for local endpoints)' }, supportsTools: { type: 'boolean' }, systemPrompt: { type: 'string' } }, required: ['name'] } },
  { name: 'mcp__cowork__list_workers', description: '[cowork] List registered cowork workers.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__cowork__orchestrate', description: '[cowork] Fan a goal out to named workers (sub-agents) in parallel and return their results. Each entry of `workers` may be a name or an object {name, baseURL, model, apiKey} to run that worker on a specific backend for this call.', parameters: { type: 'object', properties: { goal: { type: 'string' }, workers: { type: 'array', items: { type: ['string', 'object'] }, description: 'Worker names, or {name, baseURL, model, apiKey} objects' }, concurrency: { type: 'number' }, maxSteps: { type: 'number' } }, required: ['goal'] } },
  { name: 'mcp__ccd_submit', description: '[ccd] Submit a task to the cloud cowork daemon (CCD) queue.', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'mcp__ccd_list', description: '[ccd] List tasks in the cloud cowork daemon (CCD) queue.', parameters: { type: 'object', properties: {} } },

  // ---- Bot bridges ----
  { name: 'mcp__botbridge__start', description: '[botbridge] Start the local bot-bridge webhook server (hearthbot/slackbot/teamsbot/webagent).', parameters: { type: 'object', properties: { port: { type: 'number' } } } },
  { name: 'mcp__botbridge__register', description: '[botbridge] Register a webhook route that forwards messages to a sub-agent bot.', parameters: { type: 'object', properties: { route: { type: 'string' }, method: { type: 'string' }, bot: { type: 'string' } }, required: ['route'] } },
  { name: 'mcp__bots__send', description: '[bots] Send a message to a connected bot bridge / notify the user.', parameters: { type: 'object', properties: { bot: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } },

  // ---- Built-in Browser (in-app <webview> pane, mirrors Claude Desktop's browser) ----
  { name: 'browser_open', description: 'Open a URL in the built-in browser pane (in-app webview). Use for browsing the web visually.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_navigate', description: 'Navigate the built-in browser to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_back', description: 'Go back in the built-in browser history.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_forward', description: 'Go forward in the built-in browser history.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_reload', description: 'Reload the current page in the built-in browser.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_stop', description: 'Stop loading the current page in the built-in browser.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_read', description: 'Read the visible text of the current page in the built-in browser.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_snapshot', description: 'Snapshot the current page: title, URL, links, buttons, and inputs (an accessibility-style view for the agent).', parameters: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click an element in the built-in browser by CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, index: { type: 'number' } }, required: ['selector'] } },
  { name: 'browser_type', description: 'Type text into an element (input/textarea) in the built-in browser by CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
  { name: 'browser_press', description: 'Press a key (e.g. "Enter", "Escape") in the built-in browser.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_js', description: 'Execute a JavaScript expression in the built-in browser page and return its value.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'browser_hover', description: 'Hover an element in the built-in browser by CSS selector (opens CSS/JS menus and tooltips).', parameters: { type: 'object', properties: { selector: { type: 'string' }, index: { type: 'number' } }, required: ['selector'] } },
  { name: 'browser_select', description: 'Choose an option in a <select> dropdown in the built-in browser, by option value or visible label.', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } },
  { name: 'browser_scroll', description: 'Scroll the built-in browser page (or a scrollable element) up/down/left/right by pixels.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' }, selector: { type: 'string' } } } },
  { name: 'browser_wait_for', description: 'Wait until an element matching a CSS selector exists in the built-in browser (default 5s, max 30s).', parameters: { type: 'object', properties: { selector: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['selector'] } },
  { name: 'browser_screenshot', description: 'Capture a PNG screenshot of the built-in browser viewport (or the full page) and save it to a temp file.', parameters: { type: 'object', properties: { fullPage: { type: 'boolean' } } } },
  { name: 'browser_tabs', description: 'Manage built-in browser tabs: list open tabs, open a new tab, switch to a tab by index, or close a tab by index.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] }, url: { type: 'string' }, index: { type: 'number' } }, required: ['action'] } },

  // ---- Plugins & Connectors directory ----
  { name: 'plugins__list_plugins', description: 'List available plugins and connectors, optionally filtered by type (connector|plugin), category, or installed-only.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'connector | plugin' }, category: { type: 'string' }, installedOnly: { type: 'boolean' } } } },
  { name: 'plugins__search_plugins', description: 'Search the plugin directory by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'plugins__search_connectors', description: 'Search the connector (integration) directory by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'plugins__suggest_plugin_install', description: 'Suggest connectors/plugins worth installing for a user goal.', parameters: { type: 'object', properties: { goal: { type: 'string' }, limit: { type: 'number' } }, required: ['goal'] } },
  { name: 'plugins__install', description: 'Install a plugin or connector by id from the directory.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'plugins__uninstall', description: 'Uninstall a plugin or connector by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },

  // ---- MCP Registry ----
  { name: 'mcp-registry__list_connectors', description: 'List all connectors in the MCP registry (installed and available).', parameters: { type: 'object', properties: { installedOnly: { type: 'boolean' } } } },
  { name: 'mcp-registry__search_mcp_registry', description: 'Search the MCP registry for connectors by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'mcp-registry__suggest_connectors', description: 'Suggest MCP connectors that match a described task or goal.', parameters: { type: 'object', properties: { goal: { type: 'string' }, limit: { type: 'number' } }, required: ['goal'] } },

  // ---- Scheduled tasks ----
  { name: 'scheduled-tasks__create_scheduled_task', description: 'Create a scheduled task that runs a prompt on a cadence (once | every | hourly | daily | weekly).', parameters: { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' }, cadence: { type: 'string', enum: ['once', 'every', 'hourly', 'daily', 'weekly'] }, at: { type: 'string', description: 'ISO time for cadence=once' }, everyMinutes: { type: 'number' }, time: { type: 'string', description: 'HH:MM for daily/weekly' }, dayOfWeek: { type: 'number', description: '0=Sunday for weekly' }, enabled: { type: 'boolean' } }, required: ['prompt'] } },
  { name: 'scheduled-tasks__list_scheduled_tasks', description: 'List all scheduled tasks with their next run time.', parameters: { type: 'object', properties: {} } },
  { name: 'scheduled-tasks__update_scheduled_task', description: 'Update a scheduled task (name, prompt, cadence, schedule, or enabled).', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, cadence: { type: 'string' }, at: { type: 'string' }, everyMinutes: { type: 'number' }, time: { type: 'string' }, dayOfWeek: { type: 'number' }, enabled: { type: 'boolean' } }, required: ['id'] } },
  { name: 'scheduled-tasks__delete_scheduled_task', description: 'Delete a scheduled task by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'scheduled-tasks__run_scheduled_task', description: 'Run a scheduled task immediately, without waiting for its next fire time.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },

  // ---- Custom skill authoring ----
  { name: 'create_skill', description: 'Create a new custom skill from Markdown content (the model writes a SKILL.md-style document with name/description frontmatter).', parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string', description: 'Full Markdown skill document' } }, required: ['name', 'content'] } },
  { name: 'delete_skill', description: 'Delete a custom skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

// Map tool name -> executor. Names are case-sensitive per above.
const executorsByTool = {
  Bash: 'bash',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'multi_edit',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  NotebookRead: 'notebook_read',
  NotebookEdit: 'notebook_edit',
  Skill: 'skill',
  SlashCommand: 'slash_command',
  KillShell: 'kill_shell',
  memory_add: 'memory_add',
  memory_list: 'memory_list',
  memory_delete: 'memory_delete',
  list_skills: 'list_skills',
  load_skill: 'load_skill',
  list_notebooks: 'list_notebooks',
  list_slash_commands: 'list_slash_commands',
  JavaScript: 'javascript',
  REPL: 'repl',
  ToolSearch: 'tool_search',
  Jira: 'jira',
  Linear: 'linear',

  // ---- Virtual built-in MCP namespaces (reuse existing executors) ----
  mcp__workspace__bash: 'bash',
  mcp__workspace__read_file: 'read_file',
  mcp__workspace__write_file: 'write_file',
  mcp__workspace__edit_file: 'edit_file',
  mcp__workspace__glob: 'glob',
  mcp__workspace__grep: 'grep',
  mcp__workspace__web_fetch: 'web_fetch',
  mcp__memory__memory_add: 'memory_add',
  mcp__memory__memory_list: 'memory_list',
  mcp__memory__memory_delete: 'memory_delete',
  mcp__skills__list_skills: 'list_skills',
  mcp__skills__load_skill: 'load_skill',

  // ---- Computer Use / Chrome ----
  mcp__computer__screenshot: 'computer_screenshot',
  mcp__computer__click: 'computer_click',
  mcp__computer__move: 'computer_move',
  mcp__computer__drag: 'computer_drag',
  mcp__computer__scroll: 'computer_scroll',
  mcp__computer__type: 'computer_type',
  mcp__computer__key: 'computer_key',
  mcp__computer__screen_size: 'computer_screen_size',
  mcp__chrome__list_tabs: 'chrome_list_tabs',
  mcp__chrome__navigate: 'chrome_navigate',
  mcp__chrome__evaluate: 'chrome_evaluate',
  mcp__chrome__screenshot: 'chrome_screenshot',

  // ---- Built-in Browser ----
  browser_open: 'browser_open',
  browser_navigate: 'browser_navigate',
  browser_back: 'browser_back',
  browser_forward: 'browser_forward',
  browser_reload: 'browser_reload',
  browser_stop: 'browser_stop',
  browser_read: 'browser_read',
  browser_snapshot: 'browser_snapshot',
  browser_click: 'browser_click',
  browser_type: 'browser_type',
  browser_press: 'browser_press',
  browser_js: 'browser_js',

  // ---- Plugins / MCP registry / scheduled tasks / custom skills ----
  plugins__list_plugins: 'plugins_list_plugins',
  plugins__search_plugins: 'plugins_search_plugins',
  plugins__search_connectors: 'plugins_search_connectors',
  plugins__suggest_plugin_install: 'plugins_suggest_plugin_install',
  plugins__install: 'plugins_install',
  plugins__uninstall: 'plugins_uninstall',
  'mcp-registry__list_connectors': 'mcp_registry_list_connectors',
  'mcp-registry__search_mcp_registry': 'mcp_registry_search_mcp_registry',
  'mcp-registry__suggest_connectors': 'mcp_registry_suggest_connectors',
  'scheduled-tasks__create_scheduled_task': 'scheduled_tasks_create_scheduled_task',
  'scheduled-tasks__list_scheduled_tasks': 'scheduled_tasks_list_scheduled_tasks',
  'scheduled-tasks__update_scheduled_task': 'scheduled_tasks_update_scheduled_task',
  'scheduled-tasks__delete_scheduled_task': 'scheduled_tasks_delete_scheduled_task',
  'scheduled-tasks__run_scheduled_task': 'scheduled_tasks_run_scheduled_task',
  create_skill: 'create_skill',
  delete_skill: 'delete_skill',
};

/**
 * Run a built-in tool.
 * @param {string} name tool name
 * @param {object} args tool arguments
 * @param {object} ctx optional context: { cwd, shell, askUser, runSubagent, exitPlanMode, mcpListResources, mcpReadResource }
 */
// Replace the first occurrence of `oldStr` in `raw`, tolerating whitespace
// drift (indentation / trailing-space changes are the #1 reason models retry an
// Edit forever). Returns { raw } on success or { raw: null, fuzzy: false }.
function replaceOnce(raw, oldStr, newStr) {
  const idx = raw.indexOf(oldStr);
  if (idx !== -1) {
    return { raw: raw.slice(0, idx) + newStr + raw.slice(idx + oldStr.length), fuzzy: false };
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const target = norm(oldStr);
  if (!target) return { raw: null, fuzzy: false };
  let normBuf = '';
  const map = new Map();
  let prevSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (!prevSpace && normBuf.length) { map.set(normBuf.length, i); normBuf += ' '; }
      prevSpace = true;
    } else {
      map.set(normBuf.length, i);
      normBuf += ch;
      prevSpace = false;
    }
  }
  const nIdx = normBuf.indexOf(target);
  if (nIdx === -1) return { raw: null, fuzzy: false };
  const origStart = map.get(nIdx);
  const lastNorm = nIdx + target.length - 1;
  let origEnd = map.get(lastNorm);
  origEnd = origEnd == null ? raw.length : origEnd + 1;
  return { raw: raw.slice(0, origStart) + newStr + raw.slice(origEnd), fuzzy: true };
}

function fileHead(fp, raw, lines) {
  const head = raw.split('\n').slice(0, lines || 60).map((l, i) => String(i + 1).padStart(4) + '| ' + l).join('\n');
  return `First ${lines || 60} lines of ${path.basename(fp)}:\n${head}`;
}

// Claude Code's file tools use `file_path` / `file_text`; other models copy
// that convention. Accepting it here means a Claude-shaped Write from any
// backend actually lands on disk instead of "path argument required".
const FILE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'mcp__workspace__write_file', 'mcp__workspace__edit_file', 'write_file', 'edit_file',
]);
const FILE_ARG_ALIASES = {
  path: ['file_path', 'filePath', 'filename', 'file'],
  content: ['file_text', 'contents'],
  old_string: ['old_str', 'oldString'],
  new_string: ['new_str', 'newString'],
};
function normalizeFileArgs(args) {
  for (const [canonical, aliases] of Object.entries(FILE_ARG_ALIASES)) {
    if (args[canonical] !== undefined && args[canonical] !== null && args[canonical] !== '') continue;
    for (const alias of aliases) {
      if (args[alias] !== undefined && args[alias] !== null && args[alias] !== '') {
        args[canonical] = args[alias];
        break;
      }
    }
  }
  // MultiEdit payloads arrive as `edits: [{old_string,new_string}]` — same aliasing.
  if (Array.isArray(args.edits)) args.edits.forEach((e) => { if (e && typeof e === 'object') normalizeFileArgs(e); });
  return args;
}

// A tool that never resolves used to freeze the whole run forever: the spinner
// kept ticking, the composer stayed locked and no result ever arrived. Claude's
// tools fail fast and let the model recover, so give every executor a deadline.
const LONG_RUNNING = new Set([
  'Task', 'Agent', 'mcp__cowork__orchestrate', 'mcp__botbridge__register',
  'mcp__ccd_submit', 'mcp__bots__send', 'mcp__visualize__visualize',
]);
function toolTimeoutMs(name, args) {
  if (LONG_RUNNING.has(name)) return 30 * 60 * 1000;
  if (name === 'Bash') return 130 * 1000; // the executor caps zsh at 120s
  if (name === 'mcp__terminal__run_in_terminal') return 130 * 1000;
  if (name === 'browser_wait_for') return 45 * 1000;
  if (/^browser_/.test(name)) return 30 * 1000;
  if (name === 'WebFetch') return 60 * 1000;
  return 5 * 60 * 1000;
}
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      content: `Tool error: ${label} did not respond within ${Math.round(ms / 1000)}s and was abandoned. The run continues — retry with a narrower or simpler call.`,
      isError: true,
      timedOut: true,
    }), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

async function runTool(name, args, ctx) {
  ctx = ctx || {};
  // A provider that mangled the tool arguments used to look like a generic
  // "Unknown tool"/"path required" error, which made models give up and fall
  // back to bash heredocs. Tell them exactly what went wrong so they retry
  // with clean JSON.
  if (args && args._parse_error) {
    return {
      content: `Error: could not parse arguments for ${name}: ${args._parse_error}. Re-send the call with a single valid JSON object of arguments (no wrapping string, no arrays). Raw: ${String(args._raw == null ? '' : args._raw).slice(0, 300)}`,
      isError: true,
    };
  }
  const { shell, askUser, runSubagent, exitPlanMode, mcpListResources, mcpReadResource, setCwd, listAgents, stopTask, sendUserMessage, setGoal, createArtifact, requestSecret, approveTool } = ctx;

  // B8 Claude Code mode: require user approval before mutating tools.
  const MUTATING = new Set([
    'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'JavaScript', 'REPL',
    'KillShell', 'Jira', 'Linear', 'POST',
    'mcp__workspace__write_file', 'mcp__workspace__edit_file',
    'mcp__terminal__run_in_terminal', 'mcp__terminal__open_terminal_tab',
  ]);
  // Any MCP tool whose name implies a state change is gated too.
  const isMutatingTool = (name) =>
    MUTATING.has(name) ||
    (/^mcp__/.test(name) && /(write|edit|create|delete|remove|run|exec|move|rename|upload|patch)/i.test(name));
  if (approveTool && isMutatingTool(name)) {
    const ok = await approveTool(name, args);
    if (!ok) return { content: `Blocked: permission not granted for ${name} (denied or disallowed in the current permission mode).`, isError: true, denied: true };
  }

  // Special tools handled via context
  if (name === 'Task' || name === 'Agent') {
    if (!runSubagent) return 'Sub-agents unavailable (no subagent runner).';
    return await runSubagent(args);
  }
  if (name === 'AskUserQuestion') {
    if (!askUser) return 'Error: interactive questions unavailable.';
    return await askUser(args);
  }
  if (name === 'ExitPlanMode') {
    if (!exitPlanMode) return 'Plan approval unavailable.';
    return await exitPlanMode(args);
  }
  if (name === 'KillShell') {
    if (!shell) return 'Error: no shell manager.';
    const id = args.shell_id || args.id;
    return shell.kill(id) ? `Killed shell ${id}.` : `No shell with id "${id}".`;
  }
  if (name === 'ListMcpResources') {
    if (!mcpListResources) return 'No MCP resources available.';
    return await mcpListResources(args.server);
  }
  if (name === 'ReadMcpResource') {
    if (!mcpReadResource) return 'MCP resource reading unavailable.';
    return await mcpReadResource(args.server, args.uri);
  }
  if (name === 'Cd') {
    const p = args.path || args.dir || '.';
    const newCwd = resolvePath(p, ctx.cwd || process.cwd());
    try {
      if (!fs.statSync(newCwd).isDirectory()) return `Not a directory: ${newCwd}`;
    } catch {
      return `Directory does not exist: ${newCwd}`;
    }
    if (setCwd) setCwd(newCwd);
    return `Changed working directory to ${newCwd}`;
  }
  if (name === 'TaskStop' || name === 'StopTask') {
    if (!stopTask) return 'Task stopping unavailable.';
    return stopTask(args.name || args.description || '');
  }
  if (name === 'ListAgents') {
    if (!listAgents) return '(no agents running)';
    return listAgents();
  }
  if (name === 'SendUserMessage') {
    const text = args.message || args.text || args.content || '';
    if (sendUserMessage) sendUserMessage(text);
    return 'Message sent to user.';
  }
  if (name === 'SetGoal') {
    const goal = args.goal || args.text || '';
    if (setGoal) setGoal(goal);
    return 'Goal updated.';
  }
  if (name === 'Artifact') {
    if (!createArtifact) return 'Artifact creation unavailable.';
    return createArtifact(args);
  }
  if (name === 'mcp__secrets__request_secret') {
    if (!requestSecret) return 'No secrets store configured. Ask the user to provide the secret directly.';
    return await requestSecret(args.name || '');
  }

  // ---- Virtual terminal MCP namespace (mirrors Claude Code's mcp__terminal__*) ----
  if (name === 'mcp__terminal__list_terminal_tabs') {
    if (!shell) return 'No shell manager available.';
    const tabs = await shell.list();
    return tabs.length ? 'TERMINAL TABS:\n' + tabs.map((t) => `- ${t.id} [${t.running ? 'running' : 'exited'}] (${t.cwd})`).join('\n') : '(no terminal tabs)';
  }
  if (name === 'mcp__terminal__open_terminal_tab') {
    if (!shell) return 'No shell manager available.';
    const t = shell.start({ cwd: resolveDir(args.cwd || ctx.cwd) });
    return `Opened terminal tab "${t.id}" in ${t.cwd}.`;
  }
  if (name === 'mcp__terminal__read_terminal') {
    if (!shell) return 'No shell manager available.';
    const id = args.terminal_id || args.id;
    const out = shell.read(id);
    return out || '(no output)';
  }
  if (name === 'mcp__terminal__run_in_terminal') {
    if (!shell) return 'No shell manager available.';
    const id = args.terminal_id || args.id;
    try {
      const out = await shell.run(id, args.command, { timeoutMs: Math.min(Number(args.timeout) || 60, 120) * 1000 });
      return out;
    } catch (e) {
      return 'Terminal error: ' + e.message;
    }
  }
  if (name === 'mcp__terminal__stop_terminal_tab') {
    if (!shell) return 'No shell manager available.';
    const id = args.terminal_id || args.id;
    return shell.kill(id) ? `Stopped terminal tab "${id}".` : `No terminal tab with id "${id}".`;
  }

  // ---- Visualize (charts) ----
  if (name === 'mcp__visualize__visualize') {
    const chart = visualize.render(args);
    if (createArtifact) createArtifact({ name: chart.title || 'chart', language: 'svg', content: chart.svg });
    return `Rendered ${chart.type} chart "${chart.title}" as an SVG artifact (${chart.svg.length} chars).`;
  }

  // ---- Cowork orchestration (needs agent runner + provider) ----
  if (name === 'mcp__cowork__register_worker') {
    if (!ctx.runAgent) return 'Cowork unavailable (no agent runner wired).';
    if (!args.name) return 'Error: worker name required.';
    const w = cowork.registerWorker(args.name, {
      runAgent: ctx.runAgent,
      provider: ctx.provider,
      goal: args.goal || '',
      baseURL: args.baseURL,
      model: args.model,
      apiKey: args.apiKey,
      supportsTools: args.supportsTools,
      systemPrompt: args.systemPrompt,
    });
    const pin = w.model ? ` pinned to ${w.model} @ ${w.baseURL}` : ' (uses the active provider)';
    return `Registered cowork worker "${args.name}"${pin}.`;
  }
  if (name === 'mcp__cowork__list_workers') {
    const ws = cowork.listWorkers();
    return ws.length
      ? 'COWORK WORKERS:\n' + ws.map((w) => `- ${w.name} [${w.status}]${w.model ? ' ' + w.model + ' @ ' + w.baseURL : ''}${w.goal ? ' goal="' + w.goal + '"' : ''}`).join('\n')
      : '(no cowork workers registered)';
  }
  if (name === 'mcp__cowork__orchestrate') {
    if (!ctx.runAgent) return 'Cowork unavailable (no agent runner wired).';
    if (!args.goal) return 'Error: goal required.';
    const results = await cowork.orchestrate(args.goal, args.workers, {
      provider: ctx.provider,
      concurrency: Number(args.concurrency) || 4,
      maxSteps: Number(args.maxSteps) || 0,
    });
    const lines = results.map((r) => {
      const who = r.provider ? `${r.name} (${r.provider.model} @ ${r.provider.baseURL})` : r.name;
      return `--- ${who} [${r.status}${r.ms != null ? ', ' + r.ms + 'ms' : ''}] ---\n${r.result}`;
    });
    return 'ORCHESTRATION RESULTS:\n' + lines.join('\n\n') + '\n\n(JSON)\n' + JSON.stringify(results, null, 2);
  }

  // ---- CCD (cloud cowork daemon) ----
  if (name === 'mcp__ccd_submit') {
    const e = cowork.ccdSubmit(args.task || args.goal || '');
    return `CCD task queued (id=${e.id}).`;
  }
  if (name === 'mcp__ccd_list') {
    const q = cowork.ccdList();
    return q.length
      ? 'CCD QUEUE:\n' + q.map((t) => `- [${t.id}] ${t.status}: ${t.task}`).join('\n')
      : '(CCD queue empty)';
  }

  // ---- Bot bridges ----
  if (name === 'mcp__botbridge__start') {
    const r = await cowork.startBridge(Number(args.port) || 0);
    return `Bot bridge running at ${r.url}${r.alreadyRunning ? ' (already running)' : ''}.`;
  }
  if (name === 'mcp__botbridge__register') {
    if (!ctx.runAgent) return 'Bot bridge requires an agent runner.';
    if (!args.route) return 'Error: route required.';
    cowork.registerBridge(args.route, args.method, async ({ body }) => {
      const msg = (body && (body.message || body.text || body.prompt)) || JSON.stringify(body || {});
      const out = await ctx.runAgent({ messages: [{ role: 'user', content: String(msg) }], maxSteps: 0 });
      const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
      return { reply: last ? last.content : '(bot completed)' };
    });
    return `Registered bot bridge route ${(args.method || 'POST').toUpperCase()} ${args.route}.`;
  }
  if (name === 'mcp__bots__send') {
    const bot = args.bot || args.channel || 'user';
    const text = args.message || args.text || '';
    if (sendUserMessage) sendUserMessage(`${bot && bot !== 'user' ? '[' + bot + '] ' : ''}${text}`);
    return `Message sent to ${bot}.`;
  }

  const execName = executorsByTool[name] || name;
  const fn = executors[execName];
  if (!fn) return { content: `Unknown tool: ${name}` };
  try {
    let finalArgs = { ...(args || {}) };
    // Last-ditch unwrap: a `_raw` string that still parses to a JSON object.
    if (finalArgs._raw !== undefined && typeof finalArgs._raw === 'string') {
      try {
        const parsed = JSON.parse(finalArgs._raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) finalArgs = { ...parsed };
      } catch { /* leave as-is; the executor's own validation will explain */ }
    }
    if (FILE_TOOLS.has(name) || FILE_TOOLS.has(execName)) normalizeFileArgs(finalArgs);
    if (!finalArgs.cwd && ctx.cwd) finalArgs.cwd = ctx.cwd;
    const content = await withTimeout(fn(finalArgs), toolTimeoutMs(name, finalArgs), name);
    if (content && typeof content === 'object' && content.isError) return content;
    return { content: String(content) };
  } catch (e) {
    return { content: 'Tool error: ' + e.message, isError: true };
  }
}

module.exports = { executors, toolDefinitions, runTool, executorsByTool, SLASH_COMMANDS, toolTimeoutMs, withTimeout };
