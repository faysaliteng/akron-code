'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const REPO = path.resolve(__dirname, '..');

test('1. All core Akron Code bundled skills exist on disk and appear enabled in store.getSkills()', () => {
  const store = require(path.join(REPO, 'electron/store'));
  store.invalidateSkillsCache();
  const skills = store.getSkills();
  const required = [
    'akron-code-guide',
    'akron-browser-bot',
    'akron-swarm-orchestration',
    'akron-desktop-computer',
    'automation',
    'reverse-engineer-anything',
  ];
  for (const name of required) {
    const entry = skills.find((s) => s.name === name);
    assert.ok(entry, `Missing bundled skill: ${name}`);
    assert.equal(entry.source, 'bundled');
    assert.equal(entry.enabled, true);
    assert.ok(fs.existsSync(entry.file), `Missing SKILL.md on disk for ${name}`);
    const content = store.loadSkill(name);
    assert.ok(content && content.length > 300, `Empty/short skill body for ${name}`);
  }
});

test('2. Skill executor supports name, Claude { skill } alias, and akron-web-bot -> akron-browser-bot', async () => {
  const tools = require(path.join(REPO, 'electron/tools'));
  const txt = (r) => (r && typeof r === 'object' ? String(r.content || '') : String(r || ''));
  const byName = txt(await tools.runTool('Skill', { name: 'akron-browser-bot' }, { cwd: REPO }));
  assert.match(byName, /SKILL "akron-browser-bot":/);
  assert.match(byName, /close_tab/);
  assert.match(byName, /sidepanel_status/);

  const bySkillParam = txt(await tools.runTool('Skill', { skill: 'akron-code-guide', args: '--summary' }, { cwd: REPO }));
  assert.match(bySkillParam, /SKILL "akron-code-guide":/);
  assert.match(bySkillParam, /\[Skill Arguments\]: --summary/);

  const byAlias = txt(await tools.runTool('Skill', { name: 'akron-web-bot' }, { cwd: REPO }));
  assert.match(byAlias, /close_tab/);
  assert.match(byAlias, /sidepanel_status/);
});

test('3. ExtractSkill immediately invalidates cache so list_skills & Skill find it in the same turn', async () => {
  const store = require(path.join(REPO, 'electron/store'));
  const skillLearner = require(path.join(REPO, 'electron/skill-learner'));
  const tools = require(path.join(REPO, 'electron/tools'));

  // Project scope test inside an isolated temporary folder
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-proj-skill-'));
  try {
    store.invalidateSkillsCache();
    const resProj = skillLearner.extractSkillToDisk({
      name: 'live-project-skill',
      description: 'Project skill available immediately without restart',
      scope: 'project',
      cwd: projDir,
    });
    assert.equal(resProj.ok, true);

    const txt = (r) => (r && typeof r === 'object' ? String(r.content || '') : String(r || ''));
    const listed = txt(await tools.runTool('list_skills', { cwd: projDir }, { cwd: projDir }));
    assert.match(listed, /live-project-skill/);

    const loaded = txt(await tools.runTool('Skill', { name: 'live-project-skill', cwd: projDir }, { cwd: projDir }));
    assert.match(loaded, /Project skill available immediately without restart/);
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
    store.invalidateSkillsCache();
  }

  // Custom directory mtime auto-refresh check
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-user-skill-'));
  const fakeUserSkills = path.join(fakeHome, 'skills');
  try {
    const resUser = skillLearner.extractSkillToDisk({
      name: 'live-user-skill',
      description: 'User skill',
      scope: 'user',
      userSkillsDir: fakeUserSkills,
    });
    assert.equal(resUser.ok, true);
    assert.ok(fs.existsSync(resUser.file));
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('4. llm.runAgent injects <available_skills> in prefix order and exposes Skill in lean profile', async () => {
  const llm = require(path.join(REPO, 'electron/llm'));
  const store = require(path.join(REPO, 'electron/store'));
  store.invalidateSkillsCache();

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-llm-skills-'));
  fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), 'Project memory rule');
  fs.mkdirSync(path.join(projDir, '.akron'), { recursive: true });
  fs.writeFileSync(path.join(projDir, '.akron', 'mindmap.md'), '# Mindmap');

  let seenBody = null;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1',
        model: 'mock-lean',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  try {
    await llm.runAgent({
      provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-lean' },
      toolProfile: 'lean',
      messages: [
        { role: 'system', content: 'RENDERER_DIR_MARKER' },
        { role: 'user', content: 'hi' },
      ],
      cwd: projDir,
      useMemory: false,
      emit: () => {},
    });

    const sys = seenBody.messages[0].content;
    const iMem = sys.indexOf('\n\n<project_memory>\n');
    const iSkills = sys.indexOf('\n\n<available_skills>\n');
    const iWs = sys.indexOf('\n\n<project_workspace>\n');
    const iDir = sys.indexOf('RENDERER_DIR_MARKER');

    assert.ok(iMem > 0 && iSkills > iMem && iWs > iSkills && iDir > iWs,
      `Unexpected prompt section order: mem=${iMem}, skills=${iSkills}, ws=${iWs}, dir=${iDir}`);
    assert.match(sys, /akron-code-guide:/);
    assert.match(sys, /akron-browser-bot:/);
    assert.match(sys, /akron-swarm-orchestration:/);
    assert.match(sys, /akron-desktop-computer:/);

    const toolNames = (seenBody.tools || []).map((t) => t.function.name);
    assert.ok(toolNames.includes('Skill'), 'Expected Skill in lean profile');
    assert.ok(toolNames.includes('list_skills'), 'Expected list_skills in lean profile');
  } finally {
    await new Promise((r) => srv.close(r));
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
