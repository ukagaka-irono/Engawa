/*
 * CP932 ⇄ UTF-8 の iconv (engawa_iconv.h を参照)。表 cp932_table.h は native/build.mjs が
 * Encoding Standard の Shift_JIS デコーダ (Windows の CP932 と同じ) から作る。
 * iconv の決まりどおり、変換できない文字は EILSEQ、途中で切れた文字は EINVAL、出力が足りなければ E2BIG で、
 * そのとき *in は問題の文字を指したままにする。
 */
#define ENGAWA_ICONV_IMPL
#include "engawa_iconv.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "cp932_table.h"

enum { TO_UTF8 = 1, FROM_UTF8 = 2 };

/* engawa_iconv_open が返したものか見分けるため、自分の変換器は先頭に印を持つ */
#define MAGIC 0x45474157 /* 'EGAW' */
struct cd {
  int magic;
  int dir;
};

static int name_is(const char *name, const char *const *list) {
  /* "CP932//TRANSLIT" のような後ろの指定は見ない */
  size_t len = strcspn(name, "/");
  for (; *list; list++)
    if (strlen(*list) == len && strncasecmp(name, *list, len) == 0) return 1;
  return 0;
}

static const char *const CP932_NAMES[] = {"CP932", "WINDOWS-31J", "SHIFT_JIS", "SHIFT-JIS", "SJIS", "MS932", "MS_KANJI", "CSSHIFTJIS", "CSWINDOWS31J", 0};
static const char *const UTF8_NAMES[] = {"UTF-8", "UTF8", 0};

static struct cd *ours(iconv_t cd) {
  struct cd *c = (struct cd *)cd;
  /* musl の iconv_t は小さな整数のこともあるので、ポインタとして読める値か先に確かめる */
  if ((size_t)cd < 4096 || ((size_t)cd & 3) != 0) return 0;
  return c->magic == MAGIC ? c : 0;
}

iconv_t engawa_iconv_open(const char *to, const char *from) {
  int dir = 0;
  if (name_is(from, CP932_NAMES) && name_is(to, UTF8_NAMES)) dir = TO_UTF8;
  else if (name_is(from, UTF8_NAMES) && name_is(to, CP932_NAMES)) dir = FROM_UTF8;
  if (!dir) return iconv_open(to, from);
  struct cd *c = (struct cd *)malloc(sizeof *c);
  if (!c) {
    errno = ENOMEM;
    return (iconv_t)-1;
  }
  c->magic = MAGIC;
  c->dir = dir;
  return (iconv_t)c;
}

int engawa_iconv_close(iconv_t cd) {
  struct cd *c = ours(cd);
  if (!c) return iconv_close(cd);
  c->magic = 0;
  free(c);
  return 0;
}

/* windows.h の代わり (win32.cpp) からも使う */
int engawa_unicode_to_cp932(unsigned cp, unsigned char *out) {
  if (cp < 0x80) {
    out[0] = (unsigned char)cp;
    return 1;
  }
  if (cp == 0xa5) { /* ¥ と ‾ は Encoding Standard と同じく ASCII に */
    out[0] = 0x5c;
    return 1;
  }
  if (cp == 0x203e) {
    out[0] = 0x7e;
    return 1;
  }
  if (cp >= 0xff61 && cp <= 0xff9f) {
    out[0] = (unsigned char)(cp - 0xff61 + 0xa1);
    return 1;
  }
  size_t lo = 0, hi = sizeof cp932_enc / sizeof cp932_enc[0];
  while (lo < hi) {
    size_t mid = (lo + hi) / 2;
    if (cp932_enc[mid][0] < cp) lo = mid + 1;
    else hi = mid;
  }
  if (lo < sizeof cp932_enc / sizeof cp932_enc[0] && cp932_enc[lo][0] == cp) {
    out[0] = (unsigned char)(cp932_enc[lo][1] >> 8);
    out[1] = (unsigned char)(cp932_enc[lo][1] & 0xff);
    return 2;
  }
  return 0;
}

/* CP932 の1文字を読む。読んだバイト数 (0 = 不正、-1 = 途中で切れている) */
int engawa_cp932_to_unicode(const unsigned char *in, size_t left, unsigned *cp) {
  unsigned b = in[0];
  if (b <= 0x80) {
    *cp = b;
    return 1;
  }
  if (b >= 0xa1 && b <= 0xdf) {
    *cp = 0xff61 + (b - 0xa1);
    return 1;
  }
  if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
    if (left < 2) return -1;
    unsigned t = in[1];
    if (t < 0x40 || t > 0xfc || t == 0x7f) return 0;
    unsigned pointer = (b - (b < 0xa0 ? 0x81 : 0xc1)) * 188 + (t - (t < 0x7f ? 0x40 : 0x41));
    unsigned v = pointer < sizeof cp932_dec / sizeof cp932_dec[0] ? cp932_dec[pointer] : 0;
    if (!v) return 0;
    *cp = v;
    return 2;
  }
  return 0;
}

static int encode_utf8(unsigned cp, unsigned char *out) {
  if (cp < 0x80) {
    out[0] = (unsigned char)cp;
    return 1;
  }
  if (cp < 0x800) {
    out[0] = (unsigned char)(0xc0 | (cp >> 6));
    out[1] = (unsigned char)(0x80 | (cp & 0x3f));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (unsigned char)(0xe0 | (cp >> 12));
    out[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3f));
    out[2] = (unsigned char)(0x80 | (cp & 0x3f));
    return 3;
  }
  out[0] = (unsigned char)(0xf0 | (cp >> 18));
  out[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3f));
  out[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3f));
  out[3] = (unsigned char)(0x80 | (cp & 0x3f));
  return 4;
}

/* UTF-8 の1文字を読む。読んだバイト数 (0 = 不正、-1 = 途中で切れている) */
static int decode_utf8(const unsigned char *in, size_t left, unsigned *cp) {
  unsigned b = in[0];
  int n;
  unsigned min;
  if (b < 0x80) {
    *cp = b;
    return 1;
  }
  if ((b & 0xe0) == 0xc0) n = 2, *cp = b & 0x1f, min = 0x80;
  else if ((b & 0xf0) == 0xe0) n = 3, *cp = b & 0x0f, min = 0x800;
  else if ((b & 0xf8) == 0xf0) n = 4, *cp = b & 0x07, min = 0x10000;
  else return 0;
  for (int i = 1; i < n; i++) {
    if ((size_t)i >= left) return -1;
    if ((in[i] & 0xc0) != 0x80) return 0;
    *cp = (*cp << 6) | (in[i] & 0x3f);
  }
  if (*cp < min || *cp > 0x10ffff || (*cp >= 0xd800 && *cp <= 0xdfff)) return 0;
  return n;
}

size_t engawa_iconv(iconv_t cd, char **in, size_t *inleft, char **out, size_t *outleft) {
  struct cd *c = ours(cd);
  if (!c) return iconv(cd, in, inleft, out, outleft);
  /* 状態を持たない変換なので、リセットの呼び出しは何もしない */
  if (!in || !*in) return 0;
  while (*inleft > 0) {
    const unsigned char *src = (const unsigned char *)*in;
    unsigned cp;
    int n = c->dir == TO_UTF8 ? engawa_cp932_to_unicode(src, *inleft, &cp) : decode_utf8(src, *inleft, &cp);
    if (n == 0) {
      errno = EILSEQ;
      return (size_t)-1;
    }
    if (n < 0) {
      errno = EINVAL;
      return (size_t)-1;
    }
    unsigned char buf[4];
    int m = c->dir == TO_UTF8 ? encode_utf8(cp, buf) : engawa_unicode_to_cp932(cp, buf);
    if (m == 0) {
      errno = EILSEQ;
      return (size_t)-1;
    }
    if ((size_t)m > *outleft) {
      errno = E2BIG;
      return (size_t)-1;
    }
    memcpy(*out, buf, (size_t)m);
    *out += m;
    *outleft -= (size_t)m;
    *in += n;
    *inleft -= (size_t)n;
  }
  return 0;
}
