'use strict';
/**
 * Cross-platform Windows 11/10 & Linux (X11 + Wayland) backends for Computer Use 2.0.
 * Zero native C++ addons (`npmRebuild: false` safe):
 *   - Windows (`win32`): PowerShell + .NET P/Invoke (`user32.dll` Per-Monitor DPI v2 +
 *                        `SendInput` Unicode + `System.Drawing` + `UIAutomationClient`)
 *   - Linux (`linux`):   X11 (`xdotool`, `wmctrl`, `scrot`, `import`, `xclip`) +
 *                        Wayland (`ydotool`, `wtype`, `grim`, `spectacle`, `wl-copy`) + AT-SPI2
 */

const { spawnSync } = require('child_process');
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

/**
 * 60Hz cubic ease-out trajectory (`1 - (1 - t)^3`), matching Claude Desktop `XOa`/`YOa`.
 * Returns intermediate points from `(x0, y0)` to `(x1, y1)` ending at `(x1, y1)`.
 */
function computeGlidePoints(x0, y0, x1, y1, { maxSteps = 14 } = {}) {
  const sx = Math.round(Number(x0) || 0);
  const sy = Math.round(Number(y0) || 0);
  const tx = Math.round(Number(x1) || 0);
  const ty = Math.round(Number(y1) || 0);
  const dist = Math.hypot(tx - sx, ty - sy);
  if (!Number.isFinite(dist) || dist < 12) return [{ x: tx, y: ty }];
  const steps = Math.min(Math.max(4, Math.round(dist / 65)), maxSteps);
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const ease = 1 - Math.pow(1 - i / steps, 3);
    pts.push({
      x: Math.round(sx + (tx - sx) * ease),
      y: Math.round(sy + (ty - sy) * ease),
    });
  }
  return pts;
}

const WIN_USER32_PREAMBLE = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AkronWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public long pad1;
    [FieldOffset(8)] public long pad2;
    [FieldOffset(16)] public long pad3;
    [FieldOffset(24)] public long pad4;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type;
    public INPUTUNION U;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
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
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void EnableDpi() {
    try {
      if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetProcessDPIAware();
    } catch {
      try { SetProcessDPIAware(); } catch {}
    }
  }
  public static void TypeUnicode(string text) {
    if (string.IsNullOrEmpty(text)) return;
    foreach (char ch in text) {
      if (ch == '\\r') continue;
      if (ch == '\\n') {
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
        keybd_event(0x0D, 0, 2, UIntPtr.Zero);
        continue;
      }
      var list = new INPUT[2];
      list[0].type = 1;
      list[0].U.ki.wScan = (ushort)ch;
      list[0].U.ki.dwFlags = 0x0004; // KEYEVENTF_UNICODE
      list[1].type = 1;
      list[1].U.ki.wScan = (ushort)ch;
      list[1].U.ki.dwFlags = 0x0004 | 0x0002; // KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
      SendInput(2, list, Marshal.SizeOf(typeof(INPUT)));
    }
  }
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
    ';': 0xBA, semicolon: 0xBA, '=': 0xBB, '+': 0xBB, equal: 0xBB, plus: 0xBB,
    ',': 0xBC, comma: 0xBC, '-': 0xBD, '_': 0xBD, minus: 0xBD,
    '.': 0xBE, period: 0xBE, '/': 0xBF, slash: 0xBF, '`': 0xC0, grave: 0xC0,
    '[': 0xDB, bracketleft: 0xDB, '\\': 0xDC, backslash: 0xDC, ']': 0xDD, bracketright: 0xDD,
    "'": 0xDE, quote: 0xDE,
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

  const glideSteps = (opts.glideFrom && (kind === 'move' || kind === 'click'))
    ? computeGlidePoints(opts.glideFrom.x, opts.glideFrom.y, x, y, { maxSteps: 10 })
      .slice(0, -1)
      .map((pt) => `[AkronWin32]::SetCursorPos(${pt.x}, ${pt.y}) | Out-Null\nStart-Sleep -Milliseconds 10`)
      .join('\n')
    : '';

  if (kind === 'move') {
    return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::EnableDpi() | Out-Null\n${glideSteps ? glideSteps + '\n' : ''}[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\n"ok"`;
  }
  if (kind === 'down') {
    return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::EnableDpi() | Out-Null\n[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\n[AkronWin32]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)\n"ok"`;
  }
  if (kind === 'up') {
    return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::EnableDpi() | Out-Null\n[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\n[AkronWin32]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)\n"ok"`;
  }
  if (kind === 'drag') {
    const dragPts = computeGlidePoints(x, y, x2, y2, { maxSteps: 10 })
      .map((pt) => `[AkronWin32]::SetCursorPos(${pt.x}, ${pt.y}) | Out-Null\nStart-Sleep -Milliseconds 14`)
      .join('\n');
    return `${WIN_USER32_PREAMBLE}
[AkronWin32]::EnableDpi() | Out-Null
[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 25
[AkronWin32]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 35
${dragPts}
Start-Sleep -Milliseconds 25
[AkronWin32]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)
"ok"`;
  }
  const clickCalls = Array.from({ length: clicks }, () => `[AkronWin32]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)\n[AkronWin32]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)`).join('\nStart-Sleep -Milliseconds 35\n');
  return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::EnableDpi() | Out-Null\n${glideSteps ? glideSteps + '\n' : ''}[AkronWin32]::SetCursorPos(${x}, ${y}) | Out-Null\nStart-Sleep -Milliseconds 18\n${clickCalls}\n"ok"`;
}

function buildWinUnicodeTypePs() {
  return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::EnableDpi() | Out-Null\n$txt = [Console]::In.ReadToEnd()\n[AkronWin32]::TypeUnicode($txt)\n"ok"`;
}

function buildWinKeyPs(keys, holdMs = 0) {
  const parts = String(keys || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const vks = parts.map(winKeyCodeFor).filter((n) => n != null);
  if (!vks.length) throw new Error(`Unsupported Windows key chord: ${keys}`);
  const downs = vks.map((k) => `[AkronWin32]::keybd_event(${k}, 0, 0, [UIntPtr]::Zero)`).join('\n');
  const ups = [...vks].reverse().map((k) => `[AkronWin32]::keybd_event(${k}, 0, 2, [UIntPtr]::Zero)`).join('\n');
  const hold = holdMs > 0 ? `Start-Sleep -Milliseconds ${Math.min(Math.max(50, Math.round(holdMs)), 10000)}` : 'Start-Sleep -Milliseconds 25';
  return `${WIN_USER32_PREAMBLE}\n[AkronWin32]::EnableDpi() | Out-Null\n${downs}\n${hold}\n${ups}\n"ok"`;
}

function winScreenPointsSync(displayIndex = 0) {
  try {
    const idx = Math.max(0, Number(displayIndex) || 0);
    const out = runPS(`
Add-Type -AssemblyName System.Windows.Forms
${WIN_USER32_PREAMBLE}
$lw = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Width
[AkronWin32]::EnableDpi() | Out-Null
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = [Math]::Min(${idx}, $screens.Length - 1)
$bounds = $screens[$idx].Bounds
$scale = if ($idx -eq 0 -and $lw -gt 0) { [Math]::Round($bounds.Width / $lw, 2) } else { 1 }
ConvertTo-Json @{
  width = [int]$bounds.Width;
  height = [int]$bounds.Height;
  originX = [int]$bounds.X;
  originY = [int]$bounds.Y;
  displayCount = [int]$screens.Length;
  displayIndex = [int]$idx;
  scale = $scale
} -Compress
`, { timeout: 6000 });
    if (out) {
      const p = JSON.parse(out);
      return {
        width: Number(p.width) || 1920,
        height: Number(p.height) || 1080,
        originX: Number(p.originX) || 0,
        originY: Number(p.originY) || 0,
        displayCount: Number(p.displayCount) || 1,
        displayIndex: Number(p.displayIndex) || 0,
        scale: Number(p.scale) || 1,
      };
    }
  } catch (_) {}
  return { width: 1920, height: 1080, originX: 0, originY: 0, displayCount: 1, displayIndex: 0, scale: 1 };
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
[AkronWin32]::EnableDpi() | Out-Null
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
ConvertTo-Json @{ width = [int]$rw; height = [int]$rh; originX = [int]$bounds.X; originY = [int]$bounds.Y } -Compress
`, { timeout: 20000 });
  return JSON.parse(out);
}

function winListWindows() {
  const out = runPS(`
${WIN_USER32_PREAMBLE}
[AkronWin32]::EnableDpi() | Out-Null
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
[AkronWin32]::EnableDpi() | Out-Null
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

function winAppMenu({ app = '', menuPath = [] } = {}) {
  const segments = Array.isArray(menuPath) ? menuPath.map(String).filter(Boolean) : [];
  if (segments.length < 2) throw new Error('winAppMenu requires menuPath with at least [menuName, itemName].');
  const escapedApp = String(app || '').replace(/'/g, "''");
  const jsonPath = JSON.stringify(segments).replace(/'/g, "''");
  return runPS(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${WIN_USER32_PREAMBLE}
$target = [AkronWin32]::GetForegroundWindow()
$appFilter = '${escapedApp}'
if ($appFilter) {
  Get-Process | Where-Object { $_.ProcessName -like "*$appFilter*" -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1 | ForEach-Object { $target = $_.MainWindowHandle }
}
if ($target -eq [IntPtr]::Zero) { throw "No target window found" }
$cur = [System.Windows.Automation.AutomationElement]::FromHandle($target)
$segs = ConvertFrom-Json '${jsonPath}'
for ($idx = 0; $idx -lt $segs.Count; $idx++) {
  $want = [string]$segs[$idx]
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
  $items = $cur.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $hit = $null
  for ($j = 0; $j -lt $items.Count; $j++) {
    if ([string]$items.Item($j).Current.Name -eq $want) { $hit = $items.Item($j); break }
  }
  if (-not $hit) {
    for ($j = 0; $j -lt $items.Count; $j++) {
      if ([string]$items.Item($j).Current.Name -like "*$want*") { $hit = $items.Item($j); break }
    }
  }
  if (-not $hit) { throw "Menu item not found: $want" }
  if ($idx -lt ($segs.Count - 1)) {
    try { $hit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
    catch { $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    Start-Sleep -Milliseconds 90
    $cur = $hit
  } else {
    $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
}
"ok"
`, { timeout: 15000 });
}

// ---------------------------------------------------------------------------
// Linux X11 + Wayland backend
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
  const rawBtn = opts.btn != null ? opts.btn : ({ left: 0, right: 1, middle: 2 }[opts.button] ?? 0);
  const btnNum = rawBtn === 1 ? 3 : (rawBtn === 2 ? 2 : 1);

  if (kind === 'move') return ['mousemove', '--sync', String(x), String(y)];
  if (kind === 'down') return ['mousemove', '--sync', String(x), String(y), 'mousedown', String(btnNum)];
  if (kind === 'up') return ['mousemove', '--sync', String(x), String(y), 'mouseup', String(btnNum)];
  if (kind === 'drag') return ['mousemove', '--sync', String(x), String(y), 'mousedown', String(btnNum), 'mousemove', '--sync', String(x2), String(y2), 'mouseup', String(btnNum)];
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

const LINUX_EVDEV_CODES = {
  esc: 1, escape: 1, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  '-': 12, '=': 13, backspace: 14, delete: 14, tab: 15, q: 16, w: 17, e: 18, r: 19, t: 20, y: 21,
  u: 22, i: 23, o: 24, p: 25, '[': 26, ']': 27, enter: 28, return: 28, ctrl: 29, control: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ';': 39, "'": 40, '`': 41,
  shift: 42, '\\': 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ',': 51, '.': 52, '/': 53,
  alt: 56, option: 56, space: 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109,
  forwarddelete: 111, del: 111, super: 125, meta: 125, cmd: 125, command: 125, win: 125,
};

function linuxMouse(kind, opts = {}) {
  const x = Math.round(Number(opts.x) || 0);
  const y = Math.round(Number(opts.y) || 0);
  const x2 = Math.round(Number(opts.x2 != null ? opts.x2 : x));
  const y2 = Math.round(Number(opts.y2 != null ? opts.y2 : y));
  const rawBtn = opts.btn != null ? opts.btn : ({ left: 0, right: 1, middle: 2 }[opts.button] ?? 0);

  if (!process.env.WAYLAND_DISPLAY && linuxHas('xdotool')) {
    if (opts.glideFrom && (kind === 'move' || kind === 'click')) {
      for (const pt of computeGlidePoints(opts.glideFrom.x, opts.glideFrom.y, x, y, { maxSteps: 8 }).slice(0, -1)) {
        linuxExec('xdotool', ['mousemove', '--sync', String(pt.x), String(pt.y)]);
      }
    }
    if (kind === 'drag') {
      const btnNum = rawBtn === 1 ? '3' : rawBtn === 2 ? '2' : '1';
      linuxExec('xdotool', ['mousemove', '--sync', String(x), String(y), 'mousedown', btnNum]);
      for (const pt of computeGlidePoints(x, y, x2, y2, { maxSteps: 10 })) {
        linuxExec('xdotool', ['mousemove', '--sync', String(pt.x), String(pt.y)]);
      }
      linuxExec('xdotool', ['mouseup', btnNum]);
      return { ok: true, backend: 'xdotool' };
    }
    linuxExec('xdotool', buildLinuxMouseCommand(kind, opts));
    return { ok: true, backend: 'xdotool' };
  }
  if (linuxHas('ydotool')) {
    const downBtn = rawBtn === 1 ? '0x41' : rawBtn === 2 ? '0x42' : '0x40';
    const upBtn = rawBtn === 1 ? '0x81' : rawBtn === 2 ? '0x82' : '0x80';
    const clickBtn = rawBtn === 1 ? '0xC1' : rawBtn === 2 ? '0xC2' : '0xC0';
    if (kind === 'move') {
      linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
    } else if (kind === 'down') {
      linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
      linuxExec('ydotool', ['click', downBtn]);
    } else if (kind === 'up') {
      linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
      linuxExec('ydotool', ['click', upBtn]);
    } else if (kind === 'drag') {
      linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
      linuxExec('ydotool', ['click', downBtn]);
      for (const pt of computeGlidePoints(x, y, x2, y2, { maxSteps: 10 })) {
        linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(pt.x), '-y', String(pt.y)]);
      }
      linuxExec('ydotool', ['click', upBtn]);
    } else {
      const repeat = opts.triple ? 3 : (opts.double ? 2 : 1);
      linuxExec('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
      linuxExec('ydotool', ['click', '--repeat', String(repeat), clickBtn]);
    }
    return { ok: true, backend: 'ydotool' };
  }
  if (linuxHas('xdotool')) {
    linuxExec('xdotool', buildLinuxMouseCommand(kind, opts));
    return { ok: true, backend: 'xdotool' };
  }
  throw new Error('No Linux input automation tool found. Install `xdotool` (X11) or `ydotool` (Wayland).');
}

function linuxType(text) {
  const s = String(text);
  if (process.env.WAYLAND_DISPLAY && linuxHas('wtype')) {
    linuxExec('wtype', ['-d', '4', '-'], { input: s });
    return { ok: true, backend: 'wtype' };
  }
  if (!process.env.WAYLAND_DISPLAY && linuxHas('xdotool')) {
    linuxExec('xdotool', ['type', '--clearmodifiers', '--delay', '6', '--', s]);
    return { ok: true, backend: 'xdotool' };
  }
  if (linuxHas('ydotool')) {
    linuxExec('ydotool', ['type', s]);
    return { ok: true, backend: 'ydotool' };
  }
  if (linuxHas('xdotool')) {
    linuxExec('xdotool', ['type', '--clearmodifiers', '--delay', '6', '--', s]);
    return { ok: true, backend: 'xdotool' };
  }
  throw new Error('No Linux typing utility found (`xdotool`, `wtype`, or `ydotool`).');
}

function linuxKey(keys, holdMs = 0) {
  const parts = String(keys || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('keys is required');

  if (!process.env.WAYLAND_DISPLAY && linuxHas('xdotool')) {
    const combo = parts.map(linuxKeyToken).join('+');
    if (holdMs > 0) {
      linuxExec('xdotool', ['keydown', combo]);
      spawnSync('sleep', [String(holdMs / 1000)], { timeout: holdMs + 2000 });
      linuxExec('xdotool', ['keyup', combo]);
    } else {
      linuxExec('xdotool', ['key', '--clearmodifiers', combo]);
    }
    return { ok: true, backend: 'xdotool' };
  }
  if (process.env.WAYLAND_DISPLAY && linuxHas('wtype')) {
    const mods = [];
    const normals = [];
    const modMap = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', super: 'logo', meta: 'logo', cmd: 'logo', command: 'logo', win: 'logo' };
    for (const p of parts) {
      const low = p.toLowerCase();
      if (modMap[low]) mods.push(modMap[low]);
      else normals.push(linuxKeyToken(p));
    }
    const args = [];
    for (const m of mods) args.push('-M', m);
    for (const k of (normals.length ? normals : ['Return'])) args.push('-k', k);
    for (const m of [...mods].reverse()) args.push('-m', m);
    if (holdMs > 0) args.push('-s', String(Math.round(holdMs)));
    linuxExec('wtype', args);
    return { ok: true, backend: 'wtype' };
  }
  if (linuxHas('ydotool')) {
    const codes = parts.map((p) => LINUX_EVDEV_CODES[p.toLowerCase()]).filter((c) => c != null);
    if (!codes.length) throw new Error(`ydotool could not map key chord: ${keys}`);
    const args = ['key', ...codes.map((c) => `${c}:1`), ...[...codes].reverse().map((c) => `${c}:0`)];
    linuxExec('ydotool', args);
    return { ok: true, backend: 'ydotool' };
  }
  if (linuxHas('xdotool')) {
    const combo = parts.map(linuxKeyToken).join('+');
    linuxExec('xdotool', ['key', '--clearmodifiers', combo]);
    return { ok: true, backend: 'xdotool' };
  }
  throw new Error('No Linux key utility found (`xdotool`, `wtype`, or `ydotool`).');
}

function linuxScroll(direction = 'down', amount = 3) {
  const n = Math.max(1, Math.min(Number(amount) || 3, 60));
  if (!process.env.WAYLAND_DISPLAY && linuxHas('xdotool')) {
    const btn = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
    linuxExec('xdotool', ['click', '--repeat', String(n), btn]);
    return { ok: true, backend: 'xdotool' };
  }
  if (linuxHas('ydotool')) {
    const wy = direction === 'up' ? n : (direction === 'down' ? -n : 0);
    const wx = direction === 'right' ? n : (direction === 'left' ? -n : 0);
    linuxExec('ydotool', ['mousemove', '--wheel', '-x', String(wx), '-y', String(wy)]);
    return { ok: true, backend: 'ydotool' };
  }
  if (process.env.WAYLAND_DISPLAY && linuxHas('wtype')) {
    const keyName = direction === 'up' ? 'Page_Up' : (direction === 'left' ? 'Left' : (direction === 'right' ? 'Right' : 'Page_Down'));
    for (let i = 0; i < Math.min(n, 10); i++) linuxExec('wtype', ['-k', keyName]);
    return { ok: true, backend: 'wtype' };
  }
  if (linuxHas('xdotool')) {
    const btn = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
    linuxExec('xdotool', ['click', '--repeat', String(n), btn]);
    return { ok: true, backend: 'xdotool' };
  }
  throw new Error('xdotool or ydotool required for Linux scrolling.');
}

function linuxScreenPointsSync() {
  try {
    if (linuxHas('xdotool')) {
      const out = linuxExec('xdotool', ['getdisplaygeometry']);
      const m = /(\d+)\s+(\d+)/.exec(out);
      if (m) return { width: Number(m[1]), height: Number(m[2]), originX: 0, originY: 0, scale: 1 };
    }
    if (linuxHas('xrandr')) {
      const out = linuxExec('xrandr', ['--current']);
      const m = /current\s+(\d+)\s*x\s*(\d+)/.exec(out);
      if (m) return { width: Number(m[1]), height: Number(m[2]), originX: 0, originY: 0, scale: 1 };
    }
  } catch (_) {}
  return { width: 1920, height: 1080, originX: 0, originY: 0, scale: 1 };
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
  if (process.env.WAYLAND_DISPLAY && linuxHas('spectacle')) {
    linuxExec('spectacle', ['-b', '-n', '-f', '-o', file]);
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
  throw new Error('No Linux screenshot utility found (install `grim`, `spectacle`, `scrot`, or `imagemagick`).');
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

function linuxAxFind({ app = '', query = '', role = '', maxResults = 40 } = {}) {
  const py = linuxHas('python3');
  if (py) {
    const script = `
import json, sys
try:
  import gi
  gi.require_version('Atspi', '2.0')
  from gi.repository import Atspi
except Exception:
  print('null')
  sys.exit(0)
app_q = sys.argv[1].lower()
txt_q = sys.argv[2].lower()
role_q = sys.argv[3].lower()
limit = int(sys.argv[4])
desk = Atspi.get_desktop(0)
out = []
for i in range(desk.get_child_count()):
  a = desk.get_child_at_index(i)
  if not a: continue
  aname = (a.get_name() or '').lower()
  if app_q and app_q not in aname: continue
  q = [(a, 0)]
  inspected = 0
  while q and inspected < 240 and len(out) < limit:
    node, d = q.pop(0)
    inspected += 1
    try:
      r = node.get_role_name() or ''
      t = node.get_name() or ''
      comp = node.get_component_iface()
      rect = comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
      if rect and rect.width > 0 and rect.height > 0:
        if (not role_q or role_q in r.lower()) and (not txt_q or txt_q in t.lower()):
          out.append({'role': r, 'title': t[:120], 'x': int(rect.x), 'y': int(rect.y), 'width': int(rect.width), 'height': int(rect.height), 'centerX': int(rect.x + rect.width/2), 'centerY': int(rect.y + rect.height/2)})
      if d < 4:
        for k in range(min(node.get_child_count(), 40)):
          ch = node.get_child_at_index(k)
          if ch: q.append((ch, d + 1))
    except Exception:
      pass
print(json.dumps(out))
`;
    const r = spawnSync('python3', ['-c', script, String(app || ''), String(query || ''), String(role || ''), String(Math.min(100, Number(maxResults) || 40))], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const txt = String(r.stdout || '').trim();
    if (r.status === 0 && txt && txt !== 'null') {
      try {
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }
  }
  return linuxListWindows().slice(0, maxResults).map((w) => ({
    role: 'window',
    title: `${w.app}: ${w.title}`,
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
    centerX: Math.round(w.x + w.width / 2),
    centerY: Math.round(w.y + w.height / 2),
  }));
}

function probeWinLinuxCapabilities(platform = process.platform) {
  if (platform === 'win32') {
    const hasPs = !!spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).stdout;
    return {
      platform: 'win32',
      ready: hasPs,
      drivers: {
        powershell: hasPs,
        dpiAwareness: 'PerMonitorV2 (SetProcessDpiAwarenessContext -4)',
        input: 'SendInput Unicode + mouse_event',
        accessibility: 'UIAutomationClient',
        capture: 'System.Drawing + Electron desktopCapturer',
      },
    };
  }
  if (platform === 'linux') {
    const wayland = !!process.env.WAYLAND_DISPLAY;
    const tools = {
      xdotool: linuxHas('xdotool'),
      ydotool: linuxHas('ydotool'),
      wtype: linuxHas('wtype'),
      wmctrl: linuxHas('wmctrl'),
      grim: linuxHas('grim'),
      spectacle: linuxHas('spectacle'),
      scrot: linuxHas('scrot'),
      import: linuxHas('import'),
      wlCopy: linuxHas('wl-copy'),
      xclip: linuxHas('xclip'),
    };
    const inputReady = wayland ? (tools.ydotool || tools.wtype || tools.xdotool) : (tools.xdotool || tools.ydotool);
    return {
      platform: 'linux',
      session: wayland ? 'wayland' : 'x11',
      ready: inputReady,
      tools,
    };
  }
  return { platform };
}

module.exports = {
  runPS,
  WIN_USER32_PREAMBLE,
  computeGlidePoints,
  winKeyCodeFor,
  buildWinMousePs,
  buildWinUnicodeTypePs,
  buildWinKeyPs,
  winScreenPointsSync,
  winScreenshot,
  winListWindows,
  winAxFind,
  winAppMenu,
  linuxHas,
  linuxExec,
  buildLinuxMouseCommand,
  linuxKeyToken,
  linuxMouse,
  linuxType,
  linuxKey,
  linuxScroll,
  linuxScreenPointsSync,
  linuxScreenshot,
  linuxListWindows,
  linuxAxFind,
  probeWinLinuxCapabilities,
};
