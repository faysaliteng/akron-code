// OS-aware keyboard shortcut labels for macOS vs Windows/Linux

export function isWinPlatform(overridePlatform) {
  if (overridePlatform) {
    return overridePlatform === 'win32' || overridePlatform === 'linux' || /^win/i.test(String(overridePlatform));
  }
  try {
    const dp = typeof document !== 'undefined' && document.querySelector('.app')?.dataset?.platform;
    if (dp) return dp !== 'darwin';
  } catch (_) {}
  try {
    const navPlat = typeof navigator !== 'undefined' ? (navigator.platform || navigator.userAgent || '') : '';
    if (/Win|Linux|X11/i.test(navPlat) && !/Mac/i.test(navPlat)) return true;
  } catch (_) {}
  return false;
}

export function shortcutLabels(overridePlatform) {
  const isWin = isWinPlatform(overridePlatform);
  return {
    isWin,
    mod: isWin ? 'Ctrl+' : '⌘',
    modShift: isWin ? 'Ctrl+Shift+' : '⇧⌘',
    quickOpen: isWin ? 'Ctrl+P' : '⌘P',
    inlineEdit: isWin ? 'Ctrl+K' : '⌘K',
    globalSearch: isWin ? 'Ctrl+Shift+F' : '⇧⌘F',
    goToSymbol: isWin ? 'Ctrl+Shift+O' : '⇧⌘O',
    toggleTerminal: isWin ? 'Ctrl+J' : '⌘J',
    toggleAgent: isWin ? 'Ctrl+B' : '⌘B',
    save: isWin ? 'Ctrl+S' : '⌘S',
    find: isWin ? 'Ctrl+F' : '⌘F',
    submit: isWin ? 'Ctrl+Enter' : '⌘⏎',
    newTab: isWin ? 'Ctrl+N' : '⌘N',
    settings: isWin ? 'Ctrl+,' : '⌘,',
    quickEntry: isWin ? 'Ctrl+Shift+Space' : '⌘⇧Space',
    revealLabel: isWin ? 'Reveal in Explorer' : 'Reveal in Finder',
  };
}
