/*
 * dlopen などの代わり (engawa_saori.h)。SAORI の本体は Worker の JavaScript (src/saori/host.ts) にあり、
 * Module.engawaSaori を通して呼ぶ。持ち手は SAORI ごとの番号 (1 から SLOTS まで、host.ts が決める)。
 *
 * SAORI の関数の形は2通りある。
 *   load(h, len) / request(h, *len) / unload()   ふつうの DLL (SSP)。持ち手を受け取らないので、番号ごとに関数を用意する
 *   <名前>_saori_load(h, len) -> id / <名前>_saori_request(id, h, *len) / <名前>_saori_unload(id)
 *                                                 POSIX 版の YAYA が使う、ninix の複数のインスタンス向けの形。id は番号と同じ
 * どちらも、渡された h は SAORI 側 (ここ) が解放し、request の答えは SHIORI のメモリに malloc で置く (解放は SHIORI 側)。
 */
#include "engawa_saori.h"

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define SLOTS 32

EM_JS(int, saori_js_open, (const char *path, int len), {
  var host = Module['engawaSaori'];
  return host ? host.open(HEAPU8.slice(path, path + len)) : 0;
});

EM_JS(int, saori_js_load, (int id, const char *dir, int len), {
  var host = Module['engawaSaori'];
  return host ? host.load(id, HEAPU8.slice(dir, dir + len)) : 0;
});

EM_JS(char *, saori_js_request, (int id, const char *req, int len, long *out_len), {
  var host = Module['engawaSaori'];
  var res = host ? host.request(id, HEAPU8.slice(req, req + len)) : null;
  if (!res) {
    HEAP32[out_len >> 2] = 0;
    return 0;
  }
  var p = _malloc(res.length + 1);
  HEAPU8.set(res, p);
  HEAPU8[p + res.length] = 0;
  HEAP32[out_len >> 2] = res.length;
  return p;
});

EM_JS(int, saori_js_unload, (int id), {
  var host = Module['engawaSaori'];
  return host ? host.unload(id) : 0;
});

EM_JS(void, saori_js_close, (int id), {
  var host = Module['engawaSaori'];
  if (host) host.close(id);
});

static char handles[SLOTS];
static const char *last_error = NULL;

static int id_of(void *handle) {
  char *h = (char *)handle;
  return h >= handles && h < handles + SLOTS ? (int)(h - handles) + 1 : 0;
}

static int saori_load(int id, char *h, long len) {
  int ok = saori_js_load(id, h, (int)len);
  free(h);
  return ok;
}

static char *saori_request(int id, char *h, long *len) {
  char *res = saori_js_request(id, h, (int)*len, len);
  free(h);
  return res;
}

static int saori_unload(int id) { return saori_js_unload(id); }

/* 番号 (id) ごとの load・request・unload (ふつうの DLL の形) と、ninix の形の load。name は関数の名前に付ける印 */
#define SLOT(name, id)                                                                    \
  static int load_##name(char *h, long len) { return saori_load(id, h, len); }            \
  static char *request_##name(char *h, long *len) { return saori_request(id, h, len); }   \
  static int unload_##name(void) { return saori_unload(id); }                             \
  static long multi_load_##name(char *h, long len) {                                      \
    saori_load(id, h, len);                                                               \
    return id;                                                                            \
  }
#define SLOTS8(n, base)                                                                     \
  SLOT(n##0, base + 1) SLOT(n##1, base + 2) SLOT(n##2, base + 3) SLOT(n##3, base + 4)       \
  SLOT(n##4, base + 5) SLOT(n##5, base + 6) SLOT(n##6, base + 7) SLOT(n##7, base + 8)
SLOTS8(a, 0)
SLOTS8(b, 8)
SLOTS8(c, 16)
SLOTS8(d, 24)
#define TABLE8(f, n) f##n##0, f##n##1, f##n##2, f##n##3, f##n##4, f##n##5, f##n##6, f##n##7
#define TABLE(f) {TABLE8(f, a), TABLE8(f, b), TABLE8(f, c), TABLE8(f, d)}

static int (*const load_of[SLOTS])(char *, long) = TABLE(load_);
static char *(*const request_of[SLOTS])(char *, long *) = TABLE(request_);
static int (*const unload_of[SLOTS])(void) = TABLE(unload_);
static long (*const multi_load_of[SLOTS])(char *, long) = TABLE(multi_load_);

static char *multi_request(long id, char *h, long *len) { return saori_request((int)id, h, len); }
static int multi_unload(long id) { return saori_unload((int)id); }

static int ends_with(const char *s, const char *suffix) {
  size_t n = strlen(s), m = strlen(suffix);
  return n >= m && strcmp(s + n - m, suffix) == 0;
}

void *engawa_dlopen(const char *path, int flags) {
  (void)flags;
  int id = path ? saori_js_open(path, (int)strlen(path)) : 0;
  if (id < 1 || id > SLOTS) {
    last_error = "this SAORI is not available in Engawa (browser)";
    return NULL;
  }
  return handles + id - 1;
}

void *engawa_dlsym(void *handle, const char *name) {
  int id = id_of(handle);
  if (!id || !name) return NULL;
  /* 華和梨 7 などは先頭に _ を付けた名前で探す */
  const char *bare = name[0] == '_' ? name + 1 : name;
  if (strcmp(bare, "load") == 0 || strcmp(bare, "loadu") == 0) return (void *)load_of[id - 1];
  if (strcmp(bare, "request") == 0) return (void *)request_of[id - 1];
  if (strcmp(bare, "unload") == 0) return (void *)unload_of[id - 1];
  if (ends_with(name, "_saori_load")) return (void *)multi_load_of[id - 1];
  if (ends_with(name, "_saori_request")) return (void *)multi_request;
  if (ends_with(name, "_saori_unload")) return (void *)multi_unload;
  return NULL;
}

int engawa_dlclose(void *handle) {
  int id = id_of(handle);
  if (!id) return -1;
  saori_js_close(id);
  return 0;
}

char *engawa_dlerror(void) {
  const char *e = last_error;
  last_error = NULL;
  return (char *)e;
}
