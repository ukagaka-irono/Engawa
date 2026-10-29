/*
 * Windows 専用に書かれた SHIORI (なし栞など) を Emscripten でビルドするための、windows.h の代わり。
 * engines.mjs で win32Shim を指定したものだけがこれを読む。使われているものだけを、POSIX の上に作る (win32.cpp)。
 *   ファイル            open/read/write (パスの \ は / にする)
 *   文字コード          CP932 (CP_ACP) と UTF-8 を、engawa_iconv.c と同じ表で変換する。wchar_t は4バイト (UTF-32)
 *   時刻                localtime_r / clock_gettime
 *   スレッド・排他      ブラウザの Worker は1本なので、何もしない (スレッドは作れない)
 *   DLL (SAORI)         読めないので失敗を返す
 */
#ifndef ENGAWA_WINDOWS_H
#define ENGAWA_WINDOWS_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>

#define WINAPI
#define APIENTRY
#define CALLBACK
#define __cdecl
#define __stdcall
#define __declspec(x)

typedef int BOOL;
typedef unsigned long DWORD;
typedef unsigned short WORD;
typedef unsigned char BYTE;
typedef unsigned int UINT;
typedef long LONG;
typedef long long LONGLONG;
typedef unsigned long long ULONGLONG;
typedef size_t SIZE_T;
typedef wchar_t WCHAR;
typedef const wchar_t *LPCWSTR;
typedef wchar_t *LPWSTR;
typedef const char *LPCSTR;
typedef char *LPSTR;
typedef void *LPVOID;
typedef const void *LPCVOID;
typedef DWORD *LPDWORD;
typedef void *HANDLE;
typedef void *HGLOBAL;
typedef void *HMODULE;
typedef HMODULE HINSTANCE;
typedef int (*FARPROC)(void);
typedef DWORD (*LPTHREAD_START_ROUTINE)(void *);

#define TRUE 1
#define FALSE 0
#define MAX_PATH 260
#define INFINITE 0xFFFFFFFFUL
#define WAIT_OBJECT_0 0UL
#define WAIT_TIMEOUT 258UL
#define WAIT_FAILED 0xFFFFFFFFUL
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define INVALID_FILE_ATTRIBUTES ((DWORD)-1)
#define INVALID_SET_FILE_POINTER ((DWORD)-1)
#define FILE_ATTRIBUTE_DIRECTORY 0x10
#define FILE_ATTRIBUTE_NORMAL 0x80
#define GENERIC_READ 0x80000000UL
#define GENERIC_WRITE 0x40000000UL
#define FILE_APPEND_DATA 0x0004
#define FILE_SHARE_READ 1
#define FILE_SHARE_WRITE 2
#define CREATE_NEW 1
#define CREATE_ALWAYS 2
#define OPEN_EXISTING 3
#define OPEN_ALWAYS 4
#define TRUNCATE_EXISTING 5
#define FILE_BEGIN 0
#define FILE_CURRENT 1
#define FILE_END 2
#define GMEM_FIXED 0
#define GMEM_ZEROINIT 0x40
#define GPTR 0x40
#define CP_ACP 0
#define CP_OEMCP 1
#define CP_UTF8 65001
#define DLL_PROCESS_DETACH 0
#define DLL_PROCESS_ATTACH 1
#define DLL_THREAD_ATTACH 2
#define DLL_THREAD_DETACH 3

typedef struct {
  WORD wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds;
} SYSTEMTIME;

typedef struct {
  DWORD dwLowDateTime, dwHighDateTime;
} FILETIME;

typedef union {
  struct {
    DWORD LowPart;
    LONG HighPart;
  };
  LONGLONG QuadPart;
} LARGE_INTEGER;

typedef struct {
  int unused;
} CRITICAL_SECTION;

typedef struct {
  LPVOID BaseAddress, AllocationBase;
  DWORD AllocationProtect;
  SIZE_T RegionSize;
  DWORD State, Protect, Type;
} MEMORY_BASIC_INFORMATION;

typedef struct {
  DWORD dwFileAttributes;
  FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
  DWORD nFileSizeHigh, nFileSizeLow;
} WIN32_FILE_ATTRIBUTE_DATA;

typedef enum { GetFileExInfoStandard } GET_FILEEX_INFO_LEVELS;

#ifdef __cplusplus
extern "C" {
#endif

HGLOBAL GlobalAlloc(UINT flags, SIZE_T size);
HGLOBAL GlobalFree(HGLOBAL mem);

HANDLE CreateFileW(LPCWSTR name, DWORD access, DWORD share, void *security, DWORD disposition, DWORD flags, HANDLE templ);
BOOL ReadFile(HANDLE file, LPVOID buf, DWORD size, LPDWORD read, void *overlapped);
BOOL WriteFile(HANDLE file, LPCVOID buf, DWORD size, LPDWORD written, void *overlapped);
BOOL CloseHandle(HANDLE h);
BOOL GetFileSizeEx(HANDLE file, LARGE_INTEGER *size);
DWORD SetFilePointer(HANDLE file, LONG distance, LONG *high, DWORD method);
DWORD GetFileAttributesW(LPCWSTR name);
DWORD GetFileAttributesA(LPCSTR name);
BOOL GetFileAttributesExW(LPCWSTR name, GET_FILEEX_INFO_LEVELS level, LPVOID info);

int MultiByteToWideChar(UINT codepage, DWORD flags, LPCSTR src, int srclen, LPWSTR dst, int dstlen);
int WideCharToMultiByte(UINT codepage, DWORD flags, LPCWSTR src, int srclen, LPSTR dst, int dstlen, LPCSTR defchar, BOOL *useddef);

void GetLocalTime(SYSTEMTIME *t);
void GetSystemTimeAsFileTime(FILETIME *t);
DWORD GetTickCount(void);
BOOL QueryPerformanceCounter(LARGE_INTEGER *count);
BOOL QueryPerformanceFrequency(LARGE_INTEGER *freq);

void InitializeCriticalSection(CRITICAL_SECTION *cs);
void DeleteCriticalSection(CRITICAL_SECTION *cs);
void EnterCriticalSection(CRITICAL_SECTION *cs);
void LeaveCriticalSection(CRITICAL_SECTION *cs);
LONG InterlockedIncrement(LONG volatile *v);
LONG InterlockedDecrement(LONG volatile *v);
HANDLE CreateThread(void *security, SIZE_T stack, LPTHREAD_START_ROUTINE start, LPVOID param, DWORD flags, LPDWORD id);
DWORD WaitForSingleObject(HANDLE h, DWORD ms);

HMODULE LoadLibraryW(LPCWSTR name);
FARPROC GetProcAddress(HMODULE module, LPCSTR name);
BOOL FreeLibrary(HMODULE module);
void FreeLibraryAndExitThread(HMODULE module, DWORD code);
DWORD GetModuleFileNameW(HMODULE module, LPWSTR buf, DWORD size);
SIZE_T VirtualQuery(LPCVOID addr, MEMORY_BASIC_INFORMATION *info, SIZE_T size);
BOOL DisableThreadLibraryCalls(HMODULE module);
DWORD GetCurrentProcessId(void);
DWORD GetLastError(void);
void OutputDebugStringA(LPCSTR text);
void OutputDebugStringW(LPCWSTR text);

#ifdef __cplusplus
}

/* MSVC の配列版 sprintf_s / strcpy_s (大きさは配列から) */
template <size_t N>
inline int sprintf_s(char (&buf)[N], const char *format, ...) {
  va_list ap;
  va_start(ap, format);
  int n = vsnprintf(buf, N, format, ap);
  va_end(ap);
  return n;
}
template <size_t N>
inline int strcpy_s(char (&buf)[N], const char *src) {
  strncpy(buf, src, N - 1);
  buf[N - 1] = 0;
  return 0;
}
#endif

#endif
