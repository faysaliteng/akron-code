#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <objbase.h>
#include <atomic>
#include <string>
#include <thread>
#include "WebView2.h"

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

static constexpr UINT WM_HOST_READY = WM_APP + 101;
static constexpr UINT WM_HOST_FAILED = WM_APP + 102;

using FnCreateCoreWebView2Env = HRESULT(STDAPICALLTYPE*)(
    PCWSTR browserExecutableFolder,
    PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* environmentOptions,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* environmentCreatedHandler);

static HWND g_hwnd = nullptr;
static ICoreWebView2Controller* g_controller = nullptr;
static ICoreWebView2* g_webview = nullptr;
static HANDLE g_job = nullptr;
static PROCESS_INFORMATION g_nodeProc = {};
static std::wstring g_appUrl;
static std::wstring g_hostErr;
static int g_readyPort = 0;

static std::wstring ExeDir() {
  wchar_t buf[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  PathRemoveFileSpecW(buf);
  return std::wstring(buf);
}

static std::wstring GetEnvW(const wchar_t* name) {
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  if (!n) return L"";
  std::wstring out(n, L'\0');
  GetEnvironmentVariableW(name, out.data(), n);
  if (!out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

static void ResizeWebView() {
  if (!g_controller || !g_hwnd) return;
  RECT rc;
  GetClientRect(g_hwnd, &rc);
  g_controller->put_Bounds(rc);
}

// Lightweight COM refcounted callbacks (zero WRL dependency)
class NewWindowHandler final : public ICoreWebView2NewWindowRequestedEventHandler {
  std::atomic<ULONG> ref_{1};
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_ICoreWebView2NewWindowRequestedEventHandler)) {
      *ppv = static_cast<ICoreWebView2NewWindowRequestedEventHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) override {
    LPWSTR uri = nullptr;
    if (args && SUCCEEDED(args->get_Uri(&uri)) && uri) {
      args->put_Handled(TRUE);
      ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
      CoTaskMemFree(uri);
    }
    return S_OK;
  }
};

class CtrlHandler final : public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
  std::atomic<ULONG> ref_{1};
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)) {
      *ppv = static_cast<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) override {
    if (FAILED(result) || !controller) return result;
    g_controller = controller;
    g_controller->AddRef();
    g_controller->get_CoreWebView2(&g_webview);
    ResizeWebView();
    g_controller->put_IsVisible(TRUE);

    if (g_webview) {
      ICoreWebView2Settings* settings = nullptr;
      if (SUCCEEDED(g_webview->get_Settings(&settings)) && settings) {
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDefaultContextMenusEnabled(TRUE);
        settings->put_AreDevToolsEnabled(TRUE);
        settings->Release();
      }
      EventRegistrationToken tok{};
      g_webview->add_NewWindowRequested(new NewWindowHandler(), &tok);
      if (!g_appUrl.empty()) {
        g_webview->Navigate(g_appUrl.c_str());
      }
    }
    return S_OK;
  }
};

class EnvHandler final : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
  std::atomic<ULONG> ref_{1};
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler)) {
      *ppv = static_cast<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* env) override {
    if (FAILED(result) || !env) {
      MessageBoxW(g_hwnd, L"Microsoft Edge WebView2 failed to initialize.", L"Akron Code", MB_ICONERROR);
      return result;
    }
    env->CreateCoreWebView2Controller(g_hwnd, new CtrlHandler());
    return S_OK;
  }
};

static bool StartNodeHostAndWaitAsync(HWND hwnd) {
  std::wstring base = ExeDir();
  std::wstring nodeExe = base + L"\\runtime\\node.exe";
  std::wstring hostJs = base + L"\\app\\electron\\win-host.js";
  if (GetFileAttributesW(nodeExe.c_str()) == INVALID_FILE_ATTRIBUTES) {
    // Support running beside repo during dev if runtime is next to repo
    nodeExe = L"node.exe";
  }

  g_job = CreateJobObjectW(nullptr, nullptr);
  if (g_job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
  }

  SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
  HANDLE hRead = nullptr, hWrite = nullptr;
  if (!CreatePipe(&hRead, &hWrite, &sa, 0)) return false;
  SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);

  std::wstring cmd = L"\"" + nodeExe + L"\" \"" + hostJs + L"\"";
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.hStdOutput = hWrite;
  si.hStdError = hWrite;
  si.wShowWindow = SW_HIDE;

  BOOL ok = CreateProcessW(
      nullptr, cmd.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, (base + L"\\app").c_str(), &si, &g_nodeProc);
  if (!ok) {
    ok = CreateProcessW(
        nullptr, cmd.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW, nullptr, (base + L"\\app").c_str(), &si, &g_nodeProc);
  }
  CloseHandle(hWrite);
  if (!ok) {
    CloseHandle(hRead);
    g_hostErr = L"Failed to start embedded Node runtime (" + nodeExe + L")";
    PostMessageW(hwnd, WM_HOST_FAILED, 0, 0);
    return false;
  }
  if (g_job) AssignProcessToJobObject(g_job, g_nodeProc.hProcess);

  std::thread([hwnd, hRead]() {
    std::string acc;
    char buf[1024];
    DWORD readBytes = 0;
    int port = 0;
    while (ReadFile(hRead, buf, sizeof(buf) - 1, &readBytes, nullptr) && readBytes > 0) {
      buf[readBytes] = '\0';
      acc += buf;
      size_t pos = acc.find("AKRON_HOST_READY");
      if (pos != std::string::npos) {
        size_t pPos = acc.find("\"port\":", pos);
        if (pPos != std::string::npos) {
          port = atoi(acc.c_str() + pPos + 7);
          if (port > 0) {
            g_readyPort = port;
            // Record active host port for tooling / verification checks
            std::wstring portFile = GetEnvW(L"LOCALAPPDATA") + L"\\Akron Code";
            CreateDirectoryW(portFile.c_str(), nullptr);
            portFile += L"\\win-host-port.txt";
            HANDLE hf = CreateFileW(portFile.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (hf != INVALID_HANDLE_VALUE) {
              std::string ps = std::to_string(port);
              DWORD wr = 0;
              WriteFile(hf, ps.data(), (DWORD)ps.size(), &wr, nullptr);
              CloseHandle(hf);
            }
            PostMessageW(hwnd, WM_HOST_READY, (WPARAM)port, 0);
            break;
          }
        }
      }
      if (acc.size() > 65536) acc = acc.substr(acc.size() - 8192);
    }
    if (port <= 0) {
      g_hostErr = L"Akron Code backend did not signal readiness.";
      PostMessageW(hwnd, WM_HOST_FAILED, 0, 0);
    }
    // Keep draining pipe so child never blocks on stdout writes
    while (ReadFile(hRead, buf, sizeof(buf), &readBytes, nullptr) && readBytes > 0) {}
    CloseHandle(hRead);
  }).detach();

  return true;
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      ResizeWebView();
      return 0;
    case WM_HOST_READY: {
      int port = (int)wp;
      g_appUrl = L"http://127.0.0.1:" + std::to_wstring(port) + L"/index.html";
      if (g_webview) {
        g_webview->Navigate(g_appUrl.c_str());
      } else {
        std::wstring base = ExeDir();
        std::wstring loaderPath = base + L"\\WebView2Loader.dll";
        HMODULE hMod = LoadLibraryW(loaderPath.c_str());
        if (!hMod) hMod = LoadLibraryW(L"WebView2Loader.dll");
        auto createEnv = hMod ? reinterpret_cast<FnCreateCoreWebView2Env>(
            GetProcAddress(hMod, "CreateCoreWebView2EnvironmentWithOptions")) : nullptr;
        if (!createEnv) {
          MessageBoxW(hwnd, L"WebView2Loader.dll could not be loaded.", L"Akron Code", MB_ICONERROR);
          return 0;
        }
        std::wstring wvData = GetEnvW(L"LOCALAPPDATA") + L"\\Akron Code\\WebView2";
        CreateDirectoryW((GetEnvW(L"LOCALAPPDATA") + L"\\Akron Code").c_str(), nullptr);
        CreateDirectoryW(wvData.c_str(), nullptr);
        createEnv(nullptr, wvData.c_str(), nullptr, new EnvHandler());
      }
      return 0;
    }
    case WM_HOST_FAILED:
      MessageBoxW(hwnd, g_hostErr.c_str(), L"Akron Code", MB_ICONERROR);
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      if (g_controller) { g_controller->Close(); g_controller->Release(); g_controller = nullptr; }
      if (g_webview) { g_webview->Release(); g_webview = nullptr; }
      if (g_nodeProc.hProcess) { TerminateProcess(g_nodeProc.hProcess, 0); CloseHandle(g_nodeProc.hProcess); }
      if (g_nodeProc.hThread) CloseHandle(g_nodeProc.hThread);
      if (g_job) { CloseHandle(g_job); g_job = nullptr; }
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
  HDC hdc = GetDC(nullptr);
  UINT dpi = hdc ? (UINT)GetDeviceCaps(hdc, LOGPIXELSX) : 96;
  if (hdc) ReleaseDC(nullptr, hdc);
  return dpi >= 96 ? dpi : 96;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int nCmdShow) {
  EnablePerMonitorDpi();
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  const wchar_t* clsName = L"AkronCodeMainWindow";
  std::wstring icoPath = ExeDir() + L"\\akron.ico";
  HICON hIco = (HICON)LoadImageW(nullptr, icoPath.c_str(), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
  if (!hIco) hIco = LoadIconW(nullptr, IDI_APPLICATION);
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hIcon = hIco;
  wc.hIconSm = hIco;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(19, 19, 22)); // #131316 obsidian match
  wc.lpszClassName = clsName;
  RegisterClassExW(&wc);

  UINT dpi = GetSysDpi();
  RECT wa = { 0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN) };
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
  int waW = wa.right - wa.left;
  int waH = wa.bottom - wa.top;
  int pad = MulDiv(48, (int)dpi, 96);
  int w = MulDiv(1280, (int)dpi, 96);
  int h = MulDiv(820, (int)dpi, 96);
  if (w > waW - pad) w = waW - pad;
  if (h > waH - pad) h = waH - pad;
  int x = wa.left + (waW - w) / 2;
  int y = wa.top + (waH - h) / 2;

  g_hwnd = CreateWindowExW(
      0, clsName, L"Akron Code \u2014 by Akronlogic.com",
      WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
      x, y, w, h, nullptr, nullptr, hInst, nullptr);

  BOOL dark = TRUE;
  DwmSetWindowAttribute(g_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));

  ShowWindow(g_hwnd, nCmdShow ? nCmdShow : SW_SHOWNORMAL);
  SetForegroundWindow(g_hwnd);
  UpdateWindow(g_hwnd);

  StartNodeHostAndWaitAsync(g_hwnd);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  CoUninitialize();
  return (int)msg.wParam;
}
