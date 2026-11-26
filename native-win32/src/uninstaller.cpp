#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <string>

static std::wstring GetEnv(const wchar_t* name) {
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  if (!n) return L"";
  std::wstring buf(n, L'\0');
  GetEnvironmentVariableW(name, buf.data(), n);
  if (!buf.empty() && buf.back() == L'\0') buf.pop_back();
  return buf;
}

static void DeleteLinkIfExists(const std::wstring& p) {
  if (!p.empty()) DeleteFileW(p.c_str());
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR cmdLine, int) {
  bool silent = false;
  if (cmdLine) {
    std::wstring args(cmdLine);
    if (args.find(L"--silent") != std::wstring::npos || args.find(L"/S") != std::wstring::npos) {
      silent = true;
    }
  }
  if (!silent) {
    int ans = MessageBoxW(nullptr,
      L"Remove Akron Code from this computer?\nYour ~/.autobot configuration and conversations remain untouched.",
      L"Uninstall Akron Code", MB_YESNO | MB_ICONQUESTION);
    if (ans != IDYES) return 0;
  }

  // Stop any running AkronCode process cleanly
  system("taskkill /IM AkronCode.exe /F >nul 2>&1");

  wchar_t desk[MAX_PATH] = {0};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_DESKTOPDIRECTORY, nullptr, 0, desk))) {
    DeleteLinkIfExists(std::wstring(desk) + L"\\Akron Code.lnk");
  }
  wchar_t sm[MAX_PATH] = {0};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_PROGRAMS, nullptr, 0, sm))) {
    DeleteLinkIfExists(std::wstring(sm) + L"\\Akron Code.lnk");
    DeleteLinkIfExists(std::wstring(sm) + L"\\Akron Code\\Akron Code.lnk");
    RemoveDirectoryW((std::wstring(sm) + L"\\Akron Code").c_str());
  }

  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AkronCode");

  std::wstring localApp = GetEnv(L"LOCALAPPDATA");
  std::wstring installDir = localApp + L"\\Programs\\Akron Code";
  if (!localApp.empty()) {
    std::wstring cmd = L"/c ping 127.0.0.1 -n 2 >nul & rmdir /s /q \"" + installDir + L"\"";
    ShellExecuteW(nullptr, L"open", L"cmd.exe", cmd.c_str(), nullptr, SW_HIDE);
  }

  if (!silent) {
    MessageBoxW(nullptr, L"Akron Code has been uninstalled.", L"Uninstall Akron Code", MB_OK | MB_ICONINFORMATION);
  }
  return 0;
}
