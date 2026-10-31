/*
 * CSaori (ukatech/csaori) の SAORI を Emscripten で組むための前置き (native/saoris.mjs の prelude)。
 * MSVC にだけある関数の名前を、POSIX のものに読み替える。wchar_t は4バイト (UTF-32)。
 */
#ifndef ENGAWA_CSAORI_PRELUDE_H
#define ENGAWA_CSAORI_PRELUDE_H

#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <wchar.h>
#include <wctype.h>

#ifdef __cplusplus
extern "C" {
#endif

static inline int engawa_wcsnicmp(const wchar_t *a, const wchar_t *b, size_t n) {
  for (; n; n--, a++, b++) {
    wint_t x = towlower(*a), y = towlower(*b);
    if (x != y) return x < y ? -1 : 1;
    if (!x) return 0;
  }
  return 0;
}
static inline int engawa_wcsicmp(const wchar_t *a, const wchar_t *b) { return engawa_wcsnicmp(a, b, (size_t)-1); }
static inline int engawa_wtoi(const wchar_t *s) { return (int)wcstol(s, NULL, 10); }

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
#include <stdarg.h>
#include <string>

/*
 * MSVC の swprintf。大きさを書かない形 (buf, fmt, …) があり、%s・%c は wchar_t の文字列・文字を表す (POSIX は %ls・%lc)。
 * 書式の %s・%c を %ls・%lc に直してから vswprintf に渡す。大きさを書かない形は、呼び出し側の配列が足りる前提 (MSVC と同じ)
 */
static inline std::wstring engawa_msvc_format(const wchar_t *fmt) {
  std::wstring out;
  for (const wchar_t *p = fmt; *p; p++) {
    out += *p;
    if (*p != L'%') continue;
    if (p[1] == L'%') {
      out += *++p;
      continue;
    }
    // 旗・幅・精度
    while (p[1] && wcschr(L"-+ #0123456789.*", p[1])) out += *++p;
    // h・l などがあれば、そのまま
    if (p[1] == L's' || p[1] == L'c') out += L'l';
  }
  return out;
}
static inline int engawa_vswprintf(wchar_t *buf, size_t n, const wchar_t *fmt, va_list ap) {
  return vswprintf(buf, n, engawa_msvc_format(fmt).c_str(), ap);
}
static inline int engawa_swprintf(wchar_t *buf, size_t n, const wchar_t *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = engawa_vswprintf(buf, n, fmt, ap);
  va_end(ap);
  return r;
}
static inline int engawa_swprintf(wchar_t *buf, const wchar_t *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = engawa_vswprintf(buf, 4096, fmt, ap);
  va_end(ap);
  return r;
}
#define swprintf engawa_swprintf
#endif

#define wcsicmp engawa_wcsicmp
#define _wcsicmp engawa_wcsicmp
#define _wcsnicmp engawa_wcsnicmp
#define wcsnicmp engawa_wcsnicmp
#define _wtoi engawa_wtoi
#define _wtol(s) wcstol((s), NULL, 10)
#define stricmp strcasecmp
#define _stricmp strcasecmp
#define strnicmp strncasecmp
#define _strnicmp strncasecmp

#endif
