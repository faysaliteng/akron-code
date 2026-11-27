'use strict';
/**
 * Cross-platform Windows 11/10 & Linux backends for Computer Use 2.0.
 * Zero native C++ addons (`npmRebuild: false` safe):
 *   - Windows (`win32`): PowerShell + .NET P/Invoke (`user32.dll`, `System.Drawing`, `UIAutomationClient`)
 *   - Linux (`linux`):   X11 / Wayland CLI bridge (`xdotool`, `ydotool`, `wmctrl`, `grim`, `import`, `scrot`, `xclip`, `wl-copy`, `pyatspi`)
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runPS(script, { timeout = 20000, input } = {}) {
  const tmp = path.join(os.tmpdir(), `akron-cu-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ps1`);
  fs.writeFileSync(tmp, String(script), 'utf8');
  try {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      input: input != null ? String(input) : undefined,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `PowerShell exit ${r.status}`).trim());
    return String(r.stdout || '').trim();
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

const WIN_USER32_PREAMBLE = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AkronWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@ -ErrorAction SilentlyContinue
`;

function winKeyCodeFor(token) {
  const t = String(token || '').toLowerCase().trim();
  const map = {
    ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12, shift: 0x10,
    win: 0x5B, meta: 0x5B, cmd: 0x5B, command: 0x5B, super: 0x5B,
    enter: 0x0D, return: 0x0D, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x08,
    forwarddelete: 0x2E, del: 0x2E, esc: 0x1B, escape: 0x1B,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28,
    home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
    f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  };
  if (map[t] != null) return map[t];
  if (/^[a-z0-9]$/.test(t)) return t.toUpperCase().charCodeAt(0);
  return null;
}

function buildWinMousePs(kind, opts = {}) {
  const x = Math.round(Number(opts.x) || 0);
  const y = Math.round(Number(opts.y) || 0);
  const x2 = Math.round(Number(opts.x2 != null ? opts.x2 : x));
  const y2 = Math.round(Number(opts.y2 != null ? opts.y2 : y));
  const btn = opts.btn != null ? opts.btn : ({ left: 0, right: 1, middle: 2 }[opts.button] ?? 0);
  const downFlag = btn === 1 ? '0x0008' : btn === 2 ? '0x0020' : '0x0002';
  const upFlag = btn === 1 ? '0x0010' : btn === 2 ? '0x0040' : '0x0004';
  const clicks = opts.triple ? 3 : (opts.double ? 2 : 1);

  if (kind === 'move') {
    return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::SetProcessDPIAware() | Out-Null\n[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\n"ok"`;
  }
  if (kind === 'down') {
    return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::SetProcessDPIAware() | Out-Null\n[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\n[AkronWin32]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)\n"ok"`;
  }
  if (kind === 'up') {
    return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::SetProcessDPIAware() | Out-Null\n[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\n[AkronWin32]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)\n"ok"`;
  }
  if (kind === 'drag') {
    return `${WIN_USER32_PREAMBLE}
[AkronWin32]::SetProcessDPIAware() | Out-Null
[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 30
[AkronWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[AkronWin32]::SetCursorPos(${x2}, ${y2}) | Out-Null
Start-Sleep -Milliseconds 40
[AkronWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
"ok"`;
  }
  const clickCalls = Array.from({ length: clicks }, () => `[AkronWin32]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)\n[AkronWin32]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)`).join('\nStart-Sleep -Milliseconds 35\n');
  return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::SetProcessDPIAware() | Out-Null\n[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\nStart-Sleep -Milliseconds 20\n${clickCalls}\n"ok"`;
}

function buildWinKeyPs(keys, holdMs = 0) {
  const parts = String(keys || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const vks = parts.map(winKeyCodeFor).filter((n) => n != null);
  if (!vks.length) throw new Error(`Unsupported Windows key chord: ${keys}`);
  const downs = vks.map((k) => `[AkronWin32]::keybd_event(${k}, 0, 0, [UIntPtr]::Zero)`).join('\n');
  const ups = [...vks].reverse().map((k) => `[AkronWin32]::keybd_event(${k}, 0, 2, [UIntPtr]::Zero)`).join('\n');
  const hold = holdMs > 0 ? `Start-Sleep -Milliseconds ${Math.min(Math.max(50, Math.round(holdMs)), 10000)}` : 'Start-Sleep -Milliseconds 25';
  return `${WIN_USER32_PREAMBLE}\n${downs}\n${hold}\n${ups}\n"ok"`;
}

function winScreenPointsSync() {
  try {
    const out = runPS(`
Add-Type -AssemblyName System.Windows.Forms
${WIN_USER32_PREAMBLE}
$logical = [System.Windows.Forms.SystemInformation]::VirtualScreen
[AkronWin32]::SetProcessDPIAware() | Out-Null
$phys = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$lw = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Width
$lh = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Height
$scale = if ($lw -gt 0) { [Math]::Round($phys.Width / $lw, 2) } else { 1 }
ConvertTo-Json @{ width = [int]$phys.Width; height = [int]$phys.Height; scale = $scale } -Compress
`, { timeout: 6000 });
    if (out) {
      const p = JSON.parse(out);
      return { width: Number(p.width) || 1920, height: Number(p.height) || 1080, scale: Number(p.scale) || 1 };
    }
  } catch (_) {}
  return { width: 1920, height: 1080, scale: 1 };
}

function winScreenshot(file, region = null, displayIndex = 0) {
  const r = region
    ? { x: Math.round(region.x), y: Math.round(region.y), w: Math.max(1, Math.round(region.w)), h: Math.max(1, Math.round(region.h)) }
    : null;
  const escaped = file.replace(/'/g, "''");
  const out = runPS(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${WIN_USER32_PREAMBLE}
[AkronWin32]::SetProcessDPIAware() | Out-Null
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = [Math]::Min([Math]::Max(0, ${Number(displayIndex) || 0}), $screens.Length - 1)
$bounds = $screens[$idx].Bounds
${r
  ? `$rx = ${r.x}; $ry = ${r.y}; $rw = ${r.w}; $rh = ${r.h}`
  : `$rx = $bounds.X; $ry = $bounds.Y; $rw = $bounds.Width; $rh = $bounds.Height`}
$bmp = New-Object System.Drawing.Bitmap($rw, $rh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
$g.Dispose()
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
ConvertTo-Json @{ width = [int]$rw; height = [int]$rh } -Compress
`, { timeout: 20000 });
  return JSON.parse(out);
}

function winListWindows() {
  const out = runPS(`
${WIN_USER32_PREAMBLE}
[AkronWin32]::SetProcessDPIAware() | Out-Null
$rows = New-Object System.Collections.ArrayList
[AkronWin32]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [AkronWin32]::IsWindowVisible($hWnd)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][AkronWin32]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $title = $sb.ToString().Trim()
  if (-not $title) { return $true }
  $rect = New-Object AkronWin32+RECT
  [void][AkronWin32]::GetWindowRect($hWnd, [ref]$rect)
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -lt 20 -or $h -lt 20) { return $true }
  [uint32]$wpid = 0
  [void][AkronWin32]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
  $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
  $appName = if ($proc) { $proc.ProcessName } else { "pid:$wpid" }
  [void]$rows.Add(@{ windowId = $hWnd.ToInt64(); app = $appName; title = $title; x = $rect.Left; y = $rect.Top; width = $w; height = $h })
  return $true
}, [IntPtr]::Zero) | Out-Null
ConvertTo-Json $rows -Compress
`);
  const parsed = out ? JSON.parse(out) : [];
  return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
}

function winAxFind({ app = '', query = '', role = '', maxResults = 40 } = {}) {
  const escapedApp = String(app || '').replace(/'/g, "''");
  const escapedQuery = String(query || '').replace(/'/g, "''").toLowerCase();
  const escapedRole = String(role || '').replace(/'/g, "''").toLowerCase();
  const out = runPS(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${WIN_USER32_PREAMBLE}
$target = [AkronWin32]::GetForegroundWindow()
$appFilter = '${escapedApp}'
if ($appFilter) {
  Get-Process | Where-Object { $_.ProcessName -like "*$appFilter*" -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1 | ForEach-Object { $target = $_.MainWindowHandle }
}
if ($target -eq [IntPtr]::Zero) { "[]"; exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
$walker = [System.Windows.Automation.Condition]::TrueCondition
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $walker)
$res = New-Object System.Collections.ArrayList
$q = '${escapedQuery}'
$r = '${escapedRole}'
$max = ${Math.min(Math.max(1, Number(maxResults) || 40), 120)}
for ($i = 0; $i -lt [Math]::Min($all.Count, 350); $i++) {
  $el = $all.Item($i)
  $name = [string]$el.Current.Name
  $ctype = [string]$el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")
  $rect = $el.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
  if ($q -and ($name.ToLower().IndexOf($q) -lt 0)) { continue }
  if ($r -and ($ctype.ToLower().IndexOf($r) -lt 0)) { continue }
  [void]$res.Add(@{
    role = $ctype; title = $name; x = [int]$rect.X; y = [int]$rect.Y;
    width = [int]$rect.Width; height = [int]$rect.Height;
    centerX = [int]($rect.X + $rect.Width / 2); centerY = [int]($rect.Y + $rect.Height / 2)
  })
  if ($res.Count -ge $max) { break }
}
ConvertTo-Json $res -Compress
`, { timeout: 15000 });
  const parsed = out ? JSON.parse(out) : [];
  return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
}

// ---------------------------------------------------------------------------
// Linux X11 / Wayland backend
// ---------------------------------------------------------------------------

function linuxHas(cmd) {
  try {
    const r = spawnSync('which', [cmd], { encoding: 'utf8', timeout: 1200 });
    return r.status === 0 && !!String(r.stdout || '').trim();
  } catch (_) { return false; }
}

function linuxExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 15000, input: opts.input });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${cmd} exited ${r.status}`).trim());
  return String(r.stdout || '').trim();
}

function buildLinuxMouseCommand(kind, opts = {}) {
  const x = Math.round(Number(opts.x) || 0);
  const y = Math.round(Number(opts.y) || 0);
  const x2 = Math.round(Number(opts.x2 != null ? opts.x2 : x));
  const y2 = Math.round(Number(opts.y2 != null ? opts.y2 : y));
  const btnNum = (opts.btn != null ? opts.btn : ({ left: 0, right: 1, middle: 2 }[opts.button] ?? 0)) === 1
    ? 3
    : ((opts.btn != null ? opts.btn : ({ left: 0, right: 1, middle: 2 }[opts.button] ?? 0)) === 2 ? 2 : 1);

  if (kind === 'move') return ['mousemove', '--sync', String(x), String(y)];
  if (kind === 'down') return ['mousemove', '--sync', String(x), String(y), 'mousedown', String(btnNum)];
  if (kind === 'up') return ['mousemove', '--sync', String(x), String(y), 'mouseup', String(btnNum)];
  if (kind === 'drag') return ['mousemove', '--sync', String(x), String(y), 'mousedown', '1', 'mousemove', '--sync', String(x2), String(y2), 'mouseup', '1'];
  const repeat = opts.triple ? 3 : (opts.double ? 2 : 1);
  return ['mousemove', '--sync', String(x), String(y), 'click', '--repeat', String(repeat), String(btnNum)];
}

function linuxKeyToken(tok) {
  const t = String(tok || '').toLowerCase().trim();
  const map = {
    ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
    super: 'super', meta: 'super', cmd: 'super', command: 'super', win: 'super',
    enter: 'Return', return: 'Return', tab: 'Tab', space: 'space',
    backspace: 'BackSpace', delete: 'BackSpace', forwarddelete: 'Delete', del: 'Delete',
    esc: 'Escape', escape: 'Escape', left: 'Left', right: 'Right', up: 'Up', down: 'Down',
    home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  };
  return map[t] || t;
}

function linuxMouse(kind, opts = {}) {
  if (linuxHas('xdotool')) {
    linuxExec('xdotool', buildLinuxMouseCommand(kind, opts));
    return { ok: true, backend: 'xdotool' };
  }
  if (linuxHas('ydotool')) {
    const x = Math.round(Number(opts.x) || 0);
    const y = Math.round(Number(opts.y) || 0);
    linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
    if (kind === 'click') linuxExec('ydotool', ['click', opts.btn === 1 ? '0xC1' : '0xC0']);
    return { ok: true, backend: 'ydotool' };
  }
  throw new Error('No Linux input automation tool found. Install `xdotool` (X11) or `ydotool` (Wayland).');
}

function linuxScreenPointsSync() {
  try {
    if (linuxHas('xdotool')) {
      const out = linuxExec('xdotool', ['getdisplaygeometry']);
      const m = /(\d+)\s+(\d+)/.exec(out);
      if (m) return { width: Number(m[1]), height: Number(m[2]), scale: 1 };
    }
    if (linuxHas('xrandr')) {
      const out = linuxExec('xrandr', ['--current']);
      const m = /current\s+(\d+)\s*x\s*(\d+)/.exec(out);
      if (m) return { width: Number(m[1]), height: Number(m[2]), scale: 1 };
    }
  } catch (_) {}
  return { width: 1920, height: 1080, scale: 1 };
}

function linuxScreenshot(file, region = null, windowId = null) {
  if (windowId && linuxHas('import')) {
    linuxExec('import', ['-window', String(windowId), file]);
    return;
  }
  if (region) {
    const { x, y, w, h } = region;
    if (process.env.WAYLAND_DISPLAY && linuxHas('grim')) {
      linuxExec('grim', ['-g', `${Math.round(x)},${Math.round(y)} ${Math.max(1, Math.round(w))}x${Math.max(1, Math.round(h))}`, file]);
      return;
    }
    if (linuxHas('import')) {
      linuxExec('import', ['-window', 'root', '-crop', `${Math.max(1, Math.round(w))}x${Math.max(1, Math.round(h))}+${Math.round(x)}+${Math.round(y)}`, file]);
      return;
    }
  }
  if (process.env.WAYLAND_DISPLAY && linuxHas('grim')) {
    linuxExec('grim', [file]);
    return;
  }
  if (linuxHas('scrot')) {
    linuxExec('scrot', ['-o', file]);
    return;
  }
  if (linuxHas('import')) {
    linuxExec('import', ['-window', 'root', file]);
    return;
  }
  if (linuxHas('gnome-screenshot')) {
    linuxExec('gnome-screenshot', ['-f', file]);
    return;
  }
  throw new Error('No Linux screenshot utility found (install `scrot`, `imagemagick` (`import`), or `grim`).');
}

function linuxListWindows() {
  if (linuxHas('wmctrl')) {
    const out = linuxExec('wmctrl', ['-lGpx']);
    return out.split(/\r?\n/).filter(Boolean).map((ln) => {
      const parts = ln.trim().split(/\s+/);
      if (parts.length < 9) return null;
      return {
        windowId: parts[0],
        x: Number(parts[3]) || 0,
        y: Number(parts[4]) || 0,
        width: Number(parts[5]) || 0,
        height: Number(parts[6]) || 0,
        app: parts[7] || 'window',
        title: parts.slice(9).join(' '),
      };
    }).filter(Boolean);
  }
  if (linuxHas('xdotool')) {
    const ids = linuxExec('xdotool', ['search', '--onlyvisible', '--name', '.*']).split(/\r?\n/).filter(Boolean).slice(0, 40);
    return ids.map((id) => {
      let title = '';
      try { title = linuxExec('xdotool', ['getwindowname', id]); } catch (_) {}
      return { windowId: id, app: 'X11', title, x: 0, y: 0, width: 0, height: 0 };
    }).filter((w) => w.title);
  }
  return [];
}

module.exports = {
  runPS,
  winKeyCodeFor,
  buildWinMousePs,
  buildWinKeyPs,
  winScreenPointsSync,
  winScreenshot,
  winListWindows,
  winAxFind,
  linuxHas,
  linuxExec,
  buildLinuxMouseCommand,
  linuxKeyToken,
  linuxMouse,
  linuxScreenPointsSync,
  linuxScreenshot,
  linuxListWindows,
};
