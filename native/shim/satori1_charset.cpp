/*
 * 里々 1.x の SJIStoUTF8・UTF8toSJIS (satoriya/_/charset.cpp のもの)。charset.cpp は Windows の API (mbctype.h・windows.h) で
 * 書かれていて、上流の makefile.emscripten もこれを入れていない。UTF-8 の辞書を読むときと、セーブデータを UTF-8 で書くときに使う。
 * 変換は engawa_iconv.c の CP932 の表で行う。変換できない文字は ? にする。
 */
#include <string>

#include "engawa_iconv.h"

std::string SJIStoUTF8(const std::string &str) {
  std::string out;
  const unsigned char *p = reinterpret_cast<const unsigned char *>(str.data());
  size_t left = str.size();
  while (left > 0) {
    unsigned cp = 0;
    int n = engawa_cp932_to_unicode(p, left, &cp);
    if (n <= 0) {
      out += '?';
      n = 1;
    } else if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
    p += n;
    left -= static_cast<size_t>(n);
  }
  return out;
}

std::string UTF8toSJIS(const std::string &str) {
  std::string out;
  const unsigned char *p = reinterpret_cast<const unsigned char *>(str.data());
  const unsigned char *end = p + str.size();
  // charset.cpp と同じく BOM は飛ばす
  if (end - p >= 3 && p[0] == 0xEF && p[1] == 0xBB && p[2] == 0xBF) p += 3;
  while (p < end) {
    unsigned cp = *p;
    int n = cp < 0x80 ? 1 : cp >= 0xF0 ? 4 : cp >= 0xE0 ? 3 : cp >= 0xC0 ? 2 : 0;
    if (n == 0 || end - p < n) {
      out += '?';
      p++;
      continue;
    }
    if (n > 1) cp &= 0x7F >> n;
    bool ok = true;
    for (int i = 1; i < n; i++) {
      if ((p[i] & 0xC0) != 0x80) ok = false;
      cp = (cp << 6) | (p[i] & 0x3F);
    }
    if (!ok) {
      out += '?';
      p++;
      continue;
    }
    p += n;
    unsigned char sjis[2];
    int m = engawa_unicode_to_cp932(cp, sjis);
    if (m <= 0) out += '?';
    else out.append(reinterpret_cast<char *>(sjis), static_cast<size_t>(m));
  }
  return out;
}
