/*
 * SAORI (DLL) の読み込みを Engawa に渡す。native/build.mjs がすべての SHIORI のソースに -include で読ませる。
 *
 * ブラウザでは DLL を読めないので、dlopen・dlsym・dlclose (Win32 の代わりの LoadLibrary なども) を
 * engawa_saori.c の関数に差し替える。engawa_dlopen は Worker の SAORI の置き場 (src/saori/host.ts) に
 * 問い合わせ、JavaScript や WebAssembly で作り直した SAORI があれば、その持ち手を返す。
 * engawa_dlsym が返す load・request・unload は、その SAORI を呼ぶ関数。
 */
#ifndef ENGAWA_SAORI_H
#define ENGAWA_SAORI_H

#ifdef __cplusplus
extern "C" {
#endif

void *engawa_dlopen(const char *path, int flags);
void *engawa_dlsym(void *handle, const char *name);
int engawa_dlclose(void *handle);
char *engawa_dlerror(void);

#ifdef __cplusplus
}
#endif

/* 本物の宣言を先に読んでおき、そのあとの呼び出しを差し替える */
#include <dlfcn.h>
#define dlopen engawa_dlopen
#define dlsym engawa_dlsym
#define dlclose engawa_dlclose
#define dlerror engawa_dlerror

#endif
