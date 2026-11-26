#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <commctrl.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <objbase.h>
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

static constexpr int IDC_INSTALL_BTN = 1001;
static constexpr int IDC_PROGRESS = 1002;
static constexpr int IDC_STATUS = 1003;
static constexpr UINT WM_INSTALL_DONE = WM_APP + 201;

static HWND g_hwnd = nullptr;
static HWND g_btn = nullptr;
static HWND g_prog = nullptr;
static HWND g_status = nullptr;
static bool g_done = false;
static bool g_installing = false;
static std::wstring g_installDir;
static std::wstring g_err;

static std::wstring GetEnvW(const wchar_t* name) {
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  if (!n) return L"";
  std::wstring out(n, L'\0');
  GetEnvironmentVariableW(name, out.data(), n);
  if (!out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

static bool CreateShortcut(const std::wstring& lnkPath, const std::wstring& targetPath, const std::wstring& workDir, const std::wstring& iconPath, const std::wstring& desc) {
  IShellLinkW* psl = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, (void**)&psl);
  if (FAILED(hr) || !psl) return false;
  psl->SetPath(targetPath.c_str());
  psl->SetWorkingDirectory(workDir.c_str());
  psl->SetDescription(desc.c_str());
  if (!iconPath.empty()) psl->SetIconLocation(iconPath.c_str(), 0);
  IPersistFile* ppf = nullptr;
  bool ok = false;
  if (SUCCEEDED(psl->QueryInterface(IID_IPersistFile, (void**)&ppf)) && ppf) {
    ok = SUCCEEDED(ppf->Save(lnkPath.c_str(), TRUE));
    ppf->Release();
  }
  psl->Release();
  return ok;
}

static bool ExtractEmbeddedPayload(const std::wstring& destDir, std::wstring& outErr) {
  wchar_t selfPath[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, selfPath, MAX_PATH);
  HANDLE hf = CreateFileW(selfPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hf == INVALID_HANDLE_VALUE) { outErr = L"Cannot open setup executable."; return false; }

  LARGE_INTEGER fsize = {};
  if (!GetFileSizeEx(hf, &fsize) || fsize.QuadPart < 32) {
    CloseHandle(hf); outErr = L"Corrupted installer image."; return false;
  }

  // Read 16-byte trailer: [uint64_t payloadOffset LE][char magic[8] = "AKRNEND1"]
  LARGE_INTEGER seekPos = {};
  seekPos.QuadPart = fsize.QuadPart - 16;
  SetFilePointerEx(hf, seekPos, nullptr, FILE_BEGIN);
  uint64_t payloadOffset = 0;
  char magic[8] = {};
  DWORD rd = 0;
  ReadFile(hf, &payloadOffset, 8, &rd, nullptr);
  ReadFile(hf, magic, 8, &rd, nullptr);
  if (memcmp(magic, "AKRNEND1", 8) != 0 || payloadOffset == 0 || payloadOffset >= (uint64_t)(fsize.QuadPart - 16)) {
    CloseHandle(hf); outErr = L"Embedded payload signature not found."; return false;
  }

  uint64_t payloadSize = (uint64_t)(fsize.QuadPart - 16) - payloadOffset;
  wchar_t tmpDir[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmpDir);
  std::wstring tmpTar = std::wstring(tmpDir) + L"akron-code-payload.tar.gz";

  HANDLE hOut = CreateFileW(tmpTar.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hOut == INVALID_HANDLE_VALUE) { CloseHandle(hf); outErr = L"Cannot create temp archive."; return false; }

  seekPos.QuadPart = (LONGLONG)payloadOffset;
  SetFilePointerEx(hf, seekPos, nullptr, FILE_BEGIN);
  char buf[65536];
  uint64_t left = payloadSize;
  while (left > 0) {
    DWORD chunk = (left > sizeof(buf)) ? (DWORD)sizeof(buf) : (DWORD)left;
    DWORD got = 0, wr = 0;
    if (!ReadFile(hf, buf, chunk, &got, nullptr) || got == 0) break;
    WriteFile(hOut, buf, got, &wr, nullptr);
    left -= got;
  }
  CloseHandle(hOut);
  CloseHandle(hf);

  // Create target install directories recursively
  SHCreateDirectoryExW(nullptr, destDir.c_str(), nullptr);

  // Extract with Windows 11 built-in C:\Windows\System32\tar.exe cleanly hidden
  std::wstring cmd = L"C:\\Windows\\System32\\tar.exe -xzf \"" + tmpTar + L"\" -C \"" + destDir + L"\"";
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi = {};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    DeleteFileW(tmpTar.c_str());
    outErr = L"Failed to launch tar.exe for extraction.";
    return false;
  }
  WaitForSingleObject(pi.hProcess, 180000);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  DeleteFileW(tmpTar.c_str());
  if (code != 0) { outErr = L"Payload extraction exited with code " + std::to_wstring(code); return false; }
  return true;
}

static bool PerformInstall(std::wstring& outErr, bool withProgress) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  g_installDir = GetEnvW(L"LOCALAPPDATA") + L"\\Programs\\Akron Code";

  // Stop any prior AkronCode instance
  system("taskkill /IM AkronCode.exe /F >nul 2>&1");
  if (withProgress && g_prog) SendMessageW(g_prog, PBM_SETPOS, 20, 0);

  if (!ExtractEmbeddedPayload(g_installDir, outErr)) {
    CoUninitialize();
    return false;
  }
  if (withProgress && g_prog) SendMessageW(g_prog, PBM_SETPOS, 78, 0);

  std::wstring exePath = g_installDir + L"\\AkronCode.exe";
  std::wstring uninstPath = g_installDir + L"\\AkronCode-Uninstall.exe";
  std::wstring icoPath = g_installDir + L"\\akron.ico";
  if (GetFileAttributesW(icoPath.c_str()) == INVALID_FILE_ATTRIBUTES) icoPath = exePath;

  wchar_t desk[MAX_PATH] = {0};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_DESKTOPDIRECTORY, nullptr, 0, desk))) {
    CreateShortcut(std::wstring(desk) + L"\\Akron Code.lnk", exePath, g_installDir, icoPath, L"Akron Code by Akronlogic.com");
  }
  wchar_t sm[MAX_PATH] = {0};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_PROGRAMS, nullptr, 0, sm))) {
    CreateShortcut(std::wstring(sm) + L"\\Akron Code.lnk", exePath, g_installDir, icoPath, L"Akron Code by Akronlogic.com");
  }

  HKEY hKey = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AkronCode", 0, nullptr, 0, KEY_WRITE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
    auto setStr = [&](const wchar_t* name, const std::wstring& val) {
      RegSetValueExW(hKey, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(val.c_str()), (DWORD)((val.size() + 1) * sizeof(wchar_t)));
    };
    setStr(L"DisplayName", L"Akron Code");
    setStr(L"Publisher", L"AkronLogic (akronlogic.com)");
    setStr(L"DisplayVersion", L"1.0.0");
    setStr(L"InstallLocation", g_installDir);
    setStr(L"DisplayIcon", icoPath);
    setStr(L"UninstallString", L"\"" + uninstPath + L"\"");
    DWORD noModify = 1;
    RegSetValueExW(hKey, L"NoModify", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&noModify), sizeof(noModify));
    RegCloseKey(hKey);
  }
  if (withProgress && g_prog) SendMessageW(g_prog, PBM_SETPOS, 100, 0);
  CoUninitialize();
  return true;
}

static LRESULT CALLBACK SetupWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CTLCOLORSTATIC: {
      HDC hdc = (HDC)wp;
      SetTextColor(hdc, RGB(244, 244, 246));
      SetBkColor(hdc, RGB(19, 19, 22));
      static HBRUSH hBr = CreateSolidBrush(RGB(19, 19, 22));
      return (LRESULT)hBr;
    }
    case WM_COMMAND:
      if (LOWORD(wp) == IDC_INSTALL_BTN) {
        if (g_done) {
          std::wstring exe = g_installDir + L"\\AkronCode.exe";
          ShellExecuteW(nullptr, L"open", exe.c_str(), nullptr, g_installDir.c_str(), SW_SHOWNORMAL);
          DestroyWindow(hwnd);
          return 0;
        }
        if (g_installing) return 0;
        g_installing = true;
        EnableWindow(g_btn, FALSE);
        SetWindowTextW(g_status, L"Installing Akron Code into AppData\\Local\\Programs\\Akron Code...");
        std::thread([hwnd]() {
          std::wstring err;
          bool ok = PerformInstall(err, true);
          g_err = err;
          PostMessageW(hwnd, WM_INSTALL_DONE, ok ? 1 : 0, 0);
        }).detach();
      }
      return 0;
    case WM_INSTALL_DONE: {
      g_installing = false;
      EnableWindow(g_btn, TRUE);
      if (wp == 1) {
        g_done = true;
        SetWindowTextW(g_status, L"Installed cleanly! Desktop & Start Menu shortcuts ready.");
        SetWindowTextW(g_btn, L"Launch Akron Code");
      } else {
        SetWindowTextW(g_status, (L"Install failed: " + g_err).c_str());
        SetWindowTextW(g_btn, L"Retry Install");
      }
      return 0;
    }
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static void EnablePerMonitorDpi() {
  HMODULE u32 = GetModuleHandleW(L"user32.dll");
  if (u32) {
    using FnDpi = BOOL(WINAPI*)(HANDLE);
    auto fn = reinterpret_cast<FnDpi>(GetProcAddress(u32, "SetProcessDpiAwarenessContext"));
    if (fn && fn((HANDLE)(INT_PTR)-4)) return;
  }
  SetProcessDPIAware();
}

static UINT GetSysDpi() {
  HMODULE u32 = GetModuleHandleW(L"user32.dll");
  if (u32) {
    using FnGetDpi = UINT(WINAPI*)();
    auto fn = reinterpret_cast<FnGetDpi>(GetProcAddress(u32, "GetDpiForSystem"));
    if (fn) {
      UINT d = fn();
      if (d >= 96) return d;
    }
  }
  return 96;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR cmdLine, int nCmdShow) {
  EnablePerMonitorDpi();
  if (cmdLine) {
    std::wstring args(cmdLine);
    if (args.find(L"--silent") != std::string::npos || args.find(L"/S") != std::string::npos) {
      std::wstring err;
      return PerformInstall(err, false) ? 0 : 1;
    }
  }

  INITCOMMONCONTROLSEX icc = { sizeof(icc), ICC_PROGRESS_CLASS };
  InitCommonControlsEx(&icc);

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = SetupWndProc;
  wc.hInstance = hInst;
  wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(101));
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(19, 19, 22));
  wc.lpszClassName = L"AkronCodeSetupWnd";
  RegisterClassExW(&wc);

  int dpi = (int)GetSysDpi();
  auto S = [dpi](int v) { return MulDiv(v, dpi, 96); };
  int w = S(520), h = S(250);
  int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
  int y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
  g_hwnd = CreateWindowExW(0, L"AkronCodeSetupWnd", L"Akron Code Setup v1.0",
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
    x, y, w, h, nullptr, nullptr, hInst, nullptr);
  BOOL dark = TRUE;
  DwmSetWindowAttribute(g_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));

  HFONT hFontTitle = CreateFontW(-S(20), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  HFONT hFontBody = CreateFontW(-S(14), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

  HWND hTitle = CreateWindowW(L"STATIC", L"Akron Code \u2014 Desktop IDE Setup", WS_CHILD | WS_VISIBLE, S(28), S(22), S(460), S(28), g_hwnd, nullptr, hInst, nullptr);
  g_status = CreateWindowW(L"STATIC", L"by Akronlogic.com \u2022 Ready to install into LocalAppData\\Programs\\Akron Code", WS_CHILD | WS_VISIBLE, S(28), S(56), S(460), S(40), g_hwnd, (HMENU)(INT_PTR)IDC_STATUS, hInst, nullptr);
  g_prog = CreateWindowExW(0, PROGRESS_CLASSW, nullptr, WS_CHILD | WS_VISIBLE, S(28), S(108), S(460), S(18), g_hwnd, (HMENU)(INT_PTR)IDC_PROGRESS, hInst, nullptr);
  g_btn = CreateWindowW(L"BUTTON", L"Install Akron Code", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, S(328), S(152), S(160), S(36), g_hwnd, (HMENU)(INT_PTR)IDC_INSTALL_BTN, hInst, nullptr);
  SendMessageW(g_prog, PBM_SETRANGE, 0, MAKELPARAM(0, 100));
  SendMessageW(hTitle, WM_SETFONT, (WPARAM)hFontTitle, TRUE);
  SendMessageW(g_status, WM_SETFONT, (WPARAM)hFontBody, TRUE);
  SendMessageW(g_btn, WM_SETFONT, (WPARAM)hFontBody, TRUE);

  ShowWindow(g_hwnd, nCmdShow ? nCmdShow : SW_SHOWNORMAL);
  UpdateWindow(g_hwnd);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
