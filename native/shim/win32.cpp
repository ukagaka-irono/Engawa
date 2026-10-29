// windows.h の代わり (native/shim/win32/windows.h) の中身。POSIX (Emscripten) の上に作る。
#include "win32/windows.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <string>

#include "engawa_iconv.h"
#include "engawa_saori.h"

namespace {

DWORD last_error = 0;

// 1601-01-01 から 1970-01-01 までの 100ns 単位
const ULONGLONG EPOCH_DIFF = 116444736000000000ULL;

FILETIME to_filetime(ULONGLONG t) {
  FILETIME f;
  f.dwLowDateTime = (DWORD)(t & 0xffffffffULL);
  f.dwHighDateTime = (DWORD)(t >> 32);
  return f;
}

/* wchar_t (UTF-32) のパスを UTF-8 にし、\ を / にする */
std::string path_of(LPCWSTR name) {
  std::string out;
  for (; name && *name; name++) {
    unsigned c = (unsigned)*name;
    if (c == '\\') c = '/';
    if (c < 0x80) out += (char)c;
    else if (c < 0x800) {
      out += (char)(0xc0 | (c >> 6));
      out += (char)(0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out += (char)(0xe0 | (c >> 12));
      out += (char)(0x80 | ((c >> 6) & 0x3f));
      out += (char)(0x80 | (c & 0x3f));
    } else {
      out += (char)(0xf0 | (c >> 18));
      out += (char)(0x80 | ((c >> 12) & 0x3f));
      out += (char)(0x80 | ((c >> 6) & 0x3f));
      out += (char)(0x80 | (c & 0x3f));
    }
  }
  return out;
}

int fd_of(HANDLE h) { return (int)(intptr_t)h; }

/* UTF-8 の1文字を読む (読んだバイト数、0 = 不正) */
int read_utf8(const unsigned char *s, size_t left, unsigned *cp) {
  unsigned b = s[0];
  int n;
  if (b < 0x80) {
    *cp = b;
    return 1;
  }
  if ((b & 0xe0) == 0xc0) n = 2, *cp = b & 0x1f;
  else if ((b & 0xf0) == 0xe0) n = 3, *cp = b & 0x0f;
  else if ((b & 0xf8) == 0xf0) n = 4, *cp = b & 0x07;
  else return 0;
  if ((size_t)n > left) return 0;
  for (int i = 1; i < n; i++) {
    if ((s[i] & 0xc0) != 0x80) return 0;
    *cp = (*cp << 6) | (s[i] & 0x3f);
  }
  return n;
}

int write_utf8(unsigned c, unsigned char *out) {
  if (c < 0x80) return out[0] = (unsigned char)c, 1;
  if (c < 0x800) return out[0] = (unsigned char)(0xc0 | (c >> 6)), out[1] = (unsigned char)(0x80 | (c & 0x3f)), 2;
  if (c < 0x10000) {
    out[0] = (unsigned char)(0xe0 | (c >> 12));
    out[1] = (unsigned char)(0x80 | ((c >> 6) & 0x3f));
    out[2] = (unsigned char)(0x80 | (c & 0x3f));
    return 3;
  }
  out[0] = (unsigned char)(0xf0 | (c >> 18));
  out[1] = (unsigned char)(0x80 | ((c >> 12) & 0x3f));
  out[2] = (unsigned char)(0x80 | ((c >> 6) & 0x3f));
  out[3] = (unsigned char)(0x80 | (c & 0x3f));
  return 4;
}

}  // namespace

extern "C" {

HGLOBAL GlobalAlloc(UINT flags, SIZE_T size) { return (flags & GMEM_ZEROINIT) ? calloc(1, size ? size : 1) : malloc(size ? size : 1); }

HGLOBAL GlobalFree(HGLOBAL mem) {
  free(mem);
  return NULL;
}

HANDLE CreateFileW(LPCWSTR name, DWORD access, DWORD, void *, DWORD disposition, DWORD, HANDLE) {
  const bool writing = (access & (GENERIC_WRITE | FILE_APPEND_DATA)) != 0;
  int flags = writing ? ((access & GENERIC_READ) ? O_RDWR : O_WRONLY) : O_RDONLY;
  if ((access & FILE_APPEND_DATA) && !(access & GENERIC_WRITE)) flags |= O_APPEND;
  switch (disposition) {
    case CREATE_NEW: flags |= O_CREAT | O_EXCL; break;
    case CREATE_ALWAYS: flags |= O_CREAT | O_TRUNC; break;
    case OPEN_ALWAYS: flags |= O_CREAT; break;
    case TRUNCATE_EXISTING: flags |= O_TRUNC; break;
    default: break;
  }
  int fd = open(path_of(name).c_str(), flags, 0644);
  if (fd < 0) {
    last_error = (DWORD)errno;
    return INVALID_HANDLE_VALUE;
  }
  return (HANDLE)(intptr_t)fd;
}

BOOL ReadFile(HANDLE file, LPVOID buf, DWORD size, LPDWORD read_count, void *) {
  ssize_t n = read(fd_of(file), buf, size);
  if (read_count) *read_count = n > 0 ? (DWORD)n : 0;
  return n >= 0;
}

BOOL WriteFile(HANDLE file, LPCVOID buf, DWORD size, LPDWORD written, void *) {
  ssize_t n = write(fd_of(file), buf, size);
  if (written) *written = n > 0 ? (DWORD)n : 0;
  return n >= 0;
}

BOOL CloseHandle(HANDLE h) {
  if (h == NULL || h == INVALID_HANDLE_VALUE) return FALSE;
  return close(fd_of(h)) == 0;
}

BOOL GetFileSizeEx(HANDLE file, LARGE_INTEGER *size) {
  struct stat st;
  if (fstat(fd_of(file), &st) != 0) return FALSE;
  size->QuadPart = st.st_size;
  return TRUE;
}

DWORD SetFilePointer(HANDLE file, LONG distance, LONG *, DWORD method) {
  off_t r = lseek(fd_of(file), distance, method == FILE_END ? SEEK_END : method == FILE_CURRENT ? SEEK_CUR : SEEK_SET);
  return r < 0 ? INVALID_SET_FILE_POINTER : (DWORD)r;
}

DWORD GetFileAttributesW(LPCWSTR name) { return GetFileAttributesA(path_of(name).c_str()); }

/* A 版のパスは UTF-8 のまま受け取る (メモリ上のファイルシステムのパスは UTF-8) */
DWORD GetFileAttributesA(LPCSTR name) {
  std::string path = name;
  for (char &c : path)
    if (c == '\\') c = '/';
  struct stat st;
  if (stat(path.c_str(), &st) != 0) return INVALID_FILE_ATTRIBUTES;
  return S_ISDIR(st.st_mode) ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
}

BOOL GetFileAttributesExW(LPCWSTR name, GET_FILEEX_INFO_LEVELS, LPVOID info) {
  struct stat st;
  if (stat(path_of(name).c_str(), &st) != 0) return FALSE;
  WIN32_FILE_ATTRIBUTE_DATA *d = (WIN32_FILE_ATTRIBUTE_DATA *)info;
  d->dwFileAttributes = S_ISDIR(st.st_mode) ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
  ULONGLONG mtime = (ULONGLONG)st.st_mtime * 10000000ULL + EPOCH_DIFF;
  d->ftCreationTime = d->ftLastAccessTime = d->ftLastWriteTime = to_filetime(mtime);
  d->nFileSizeHigh = (DWORD)((ULONGLONG)st.st_size >> 32);
  d->nFileSizeLow = (DWORD)(st.st_size & 0xffffffffULL);
  return TRUE;
}

/* CP_ACP / CP_OEMCP は CP932 (日本語の Windows と同じ)。dst が無ければ必要な長さを返す */
int MultiByteToWideChar(UINT codepage, DWORD, LPCSTR src, int srclen, LPWSTR dst, int dstlen) {
  size_t len = srclen < 0 ? strlen(src) + 1 : (size_t)srclen;
  const unsigned char *s = (const unsigned char *)src;
  int count = 0;
  for (size_t i = 0; i < len;) {
    unsigned cp;
    int n = codepage == CP_UTF8 ? read_utf8(s + i, len - i, &cp) : engawa_cp932_to_unicode(s + i, len - i, &cp);
    if (n <= 0) {
      cp = 0xfffd;
      n = 1;
    }
    if (dst) {
      if (count >= dstlen) return 0;
      dst[count] = (wchar_t)cp;
    }
    count++;
    i += (size_t)n;
  }
  return count;
}

int WideCharToMultiByte(UINT codepage, DWORD, LPCWSTR src, int srclen, LPSTR dst, int dstlen, LPCSTR, BOOL *useddef) {
  size_t len = srclen < 0 ? wcslen(src) + 1 : (size_t)srclen;
  int count = 0;
  if (useddef) *useddef = FALSE;
  for (size_t i = 0; i < len; i++) {
    unsigned char buf[4];
    int n = codepage == CP_UTF8 ? write_utf8((unsigned)src[i], buf) : engawa_unicode_to_cp932((unsigned)src[i], buf);
    if (n == 0) {
      buf[0] = '?';
      n = 1;
      if (useddef) *useddef = TRUE;
    }
    if (dst) {
      if (count + n > dstlen) return 0;
      memcpy(dst + count, buf, (size_t)n);
    }
    count += n;
  }
  return count;
}

void GetLocalTime(SYSTEMTIME *t) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  time_t sec = tv.tv_sec;
  struct tm tm;
  localtime_r(&sec, &tm);
  t->wYear = (WORD)(tm.tm_year + 1900);
  t->wMonth = (WORD)(tm.tm_mon + 1);
  t->wDayOfWeek = (WORD)tm.tm_wday;
  t->wDay = (WORD)tm.tm_mday;
  t->wHour = (WORD)tm.tm_hour;
  t->wMinute = (WORD)tm.tm_min;
  t->wSecond = (WORD)tm.tm_sec;
  t->wMilliseconds = (WORD)(tv.tv_usec / 1000);
}

void GetSystemTimeAsFileTime(FILETIME *t) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  *t = to_filetime((ULONGLONG)tv.tv_sec * 10000000ULL + (ULONGLONG)tv.tv_usec * 10ULL + EPOCH_DIFF);
}

DWORD GetTickCount(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (DWORD)((ULONGLONG)ts.tv_sec * 1000ULL + (ULONGLONG)ts.tv_nsec / 1000000ULL);
}

BOOL QueryPerformanceCounter(LARGE_INTEGER *count) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  count->QuadPart = (LONGLONG)ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
  return TRUE;
}

BOOL QueryPerformanceFrequency(LARGE_INTEGER *freq) {
  freq->QuadPart = 1000000;
  return TRUE;
}

void InitializeCriticalSection(CRITICAL_SECTION *) {}
void DeleteCriticalSection(CRITICAL_SECTION *) {}
void EnterCriticalSection(CRITICAL_SECTION *) {}
void LeaveCriticalSection(CRITICAL_SECTION *) {}
LONG InterlockedIncrement(LONG volatile *v) { return ++*v; }
LONG InterlockedDecrement(LONG volatile *v) { return --*v; }

// スレッドは作れないので、その場で最後まで走らせ、もう終わったスレッドの持ち手を返す
// (なし栞の非同期の SAORI 呼び出しは、呼んだときに済んでいることになる)。持ち手は閉じても何もしない番号
HANDLE CreateThread(void *, SIZE_T, LPTHREAD_START_ROUTINE start, LPVOID param, DWORD, LPDWORD id) {
  if (id) *id = 1;
  start(param);
  return (HANDLE)(intptr_t)-2;
}

DWORD WaitForSingleObject(HANDLE, DWORD) { return WAIT_OBJECT_0; }

HMODULE LoadLibraryW(LPCWSTR name) { return (HMODULE)engawa_dlopen(path_of(name).c_str(), 0); }
HMODULE LoadLibraryA(LPCSTR name) { return (HMODULE)engawa_dlopen(name, 0); }
FARPROC GetProcAddress(HMODULE module, LPCSTR name) { return (FARPROC)engawa_dlsym(module, name); }
BOOL FreeLibrary(HMODULE module) { return engawa_dlclose(module) == 0; }
HMODULE GetModuleHandleA(LPCSTR) { return NULL; }

// 窓は出せない。内容はログに出し、OK が押されたことにする
int MessageBoxW(HWND, LPCWSTR text, LPCWSTR caption, UINT) {
  fprintf(stderr, "[%s] %s\n", path_of(caption).c_str(), path_of(text).c_str());
  return IDOK;
}

// Windows 10 と答える
BOOL GetVersionExW(OSVERSIONINFOW *info) {
  info->dwMajorVersion = 10;
  info->dwMinorVersion = 0;
  info->dwBuildNumber = 19045;
  info->dwPlatformId = 2;
  info->szCSDVersion[0] = 0;
  return TRUE;
}

// 走らせたスレッドの最後に呼ばれる。スレッドはその場で走らせているので、終わらせずに戻る
void FreeLibraryAndExitThread(HMODULE module, DWORD) {
  if (module) FreeLibrary(module);
}

DWORD GetModuleFileNameW(HMODULE, LPWSTR buf, DWORD size) {
  if (size) buf[0] = 0;
  return 0;
}

SIZE_T VirtualQuery(LPCVOID, MEMORY_BASIC_INFORMATION *, SIZE_T) { return 0; }
BOOL DisableThreadLibraryCalls(HMODULE) { return TRUE; }
DWORD GetCurrentProcessId(void) { return 1; }
DWORD GetLastError(void) { return last_error; }
void OutputDebugStringA(LPCSTR text) { fputs(text, stderr); }
void OutputDebugStringW(LPCWSTR text) { fputs(path_of(text).c_str(), stderr); }

}  // extern "C"
