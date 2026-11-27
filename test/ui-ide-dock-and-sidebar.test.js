'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log('  ✓ ' + name);
}

console.log('\nui-ide-dock-and-sidebar tests');

const ROOT = path.resolve(__dirname, '..');
const ideCss = fs.readFileSync(path.join(ROOT, 'src/ide/ide.css'), 'utf8');
const mainCss = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const ecCss = fs.readFileSync(path.join(ROOT, 'src/styles/emerald-carbon.css'), 'utf8');
const sidebarJsx = fs.readFileSync(path.join(ROOT, 'src/components/sidebar/ProjectsSidebar.jsx'), 'utf8');
const appJsx = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
const icons = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/icons.json'), 'utf8'));

check('IDE right Agent dock overrides --chat-side-pad: 12px and wraps Mission Control badges/phases', () => {
  assert.ok(ideCss.includes('--chat-side-pad: 12px'));
  assert.ok(ideCss.includes('--chat-max-w: 100%'));
  assert.ok(ideCss.includes('.ide-dock-body .mc-panel.inline .mc-head'));
  assert.ok(mainCss.includes('.main-split:has(.session-pane) .main-content'));
});

check('ProjectsSidebar conversation menu renders icons, inline rename, archive, and danger delete', () => {
  for (const ico of ['Pin', 'PinSlash', 'Edit', 'Archive', 'Trash', 'DotsVertical']) {
    assert.ok(icons[ico], `icons.json missing ${ico}`);
    assert.ok(sidebarJsx.includes(`'${ico}'`) || sidebarJsx.includes(`"${ico}"`), `ProjectsSidebar missing icon ${ico}`);
  }
  assert.ok(sidebarJsx.includes('className="conv-rename-input"'));
  assert.ok(sidebarJsx.includes('{hoverInfo && !menuConvId && !renamingConvId && ('), 'hover card must stay hidden while menu or rename is open');
  assert.ok(ecCss.includes('.conv-menu-pop button.danger'));
  assert.ok(ecCss.includes('.conv-rename-input'));
});

check('no window.prompt remains in src/App.jsx or src/', () => {
  assert.strictEqual(/window\.prompt/.test(appJsx), false, 'window.prompt breaks in Electron');
  assert.strictEqual(/window\.prompt/.test(sidebarJsx), false);
});

console.log(`\n${pass} passed, 0 failed`);
