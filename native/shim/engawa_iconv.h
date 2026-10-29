/*
 * すべての SHIORI のソースに -include で読ませる。iconv を engawa_iconv.c のものに差し替える。
 * Emscripten (musl) の iconv の Shift_JIS は JIS X 0208 だけで、Windows の CP932 にある
 * NEC 特殊文字 (①・㈱) や IBM 拡張 (ⅰ・髙)、全角チルダ (～) を変換できないため。
 * CP932 と UTF-8 の間だけを自前で変換し、それ以外は musl の iconv に任せる。
 */
#ifndef ENGAWA_ICONV_H
#define ENGAWA_ICONV_H

#include <stddef.h>
#include <iconv.h>

#ifdef __cplusplus
extern "C" {
#endif
iconv_t engawa_iconv_open(const char *to, const char *from);
size_t engawa_iconv(iconv_t cd, char **in, size_t *inleft, char **out, size_t *outleft);
int engawa_iconv_close(iconv_t cd);
/* CP932 の1文字を Unicode に (読んだバイト数、0 = 不正、-1 = 途中で切れている) / Unicode の1文字を CP932 に (書いたバイト数、0 = 表に無い) */
int engawa_cp932_to_unicode(const unsigned char *in, size_t left, unsigned *cp);
int engawa_unicode_to_cp932(unsigned cp, unsigned char *out);
#ifdef __cplusplus
}
#endif

#ifndef ENGAWA_ICONV_IMPL
#define iconv_open engawa_iconv_open
#define iconv engawa_iconv
#define iconv_close engawa_iconv_close
#endif

#endif
