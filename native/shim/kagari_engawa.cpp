// kagari (Lua 5.4 の SHIORI) を WebAssembly で動かすための口。
// - kagari の POSIX 版は kagari_load / kagari_request / kagari_unload (複数のゴースト向け) なので、DLL と同じ load / request / unload にする
// - ゴーストの Lua (kotori など) が require する C のモジュール (.dll / .so) は読めないので、代わりを package.preload に入れる
//     luachild                 dir() でディレクトリを列挙する (子プロセスは作れない)
//     lua-utf8                 Lua 5.4 の utf8 に、kotori が使う next() を足したもの
//     iconv                    new(to, from):iconv(str)。CP932 は engawa_iconv.c で変換する
//     fh, saori_universal.native, ukagaka_misc.windows   SAORI などは使えないので、呼ばれたら失敗を返す
#include <dirent.h>
#include <sys/stat.h>

#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

#include "engawa_iconv.h"
#include "lua.hpp"

extern "C" {
int kagari_load(char *path, long len);
int kagari_unload(int id);
char *kagari_request(int id, char *req, long *len);
}

namespace {

int instance = -1;

// ---------------------------------------------------------------- luachild

int luachild_dir_next(lua_State *L) {
  // 上位値: 1 = 名前と種類の表、2 = 次の番号
  lua_Integer i = lua_tointeger(L, lua_upvalueindex(2));
  if (lua_rawgeti(L, lua_upvalueindex(1), i) == LUA_TNIL) return 1;
  lua_pushinteger(L, i + 1);
  lua_replace(L, lua_upvalueindex(2));
  return 1;
}

int luachild_dir(lua_State *L) {
  std::string path = luaL_checkstring(L, 1);
  DIR *d = opendir(path.c_str());
  if (!d) return luaL_error(L, "cannot open %s: %s", path.c_str(), strerror(errno));
  lua_newtable(L);
  lua_Integer n = 0;
  while (struct dirent *e = readdir(d)) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    struct stat st;
    std::string full = path + "/" + e->d_name;
    const char *type = stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode) ? "directory" : "file";
    lua_createtable(L, 0, 2);
    lua_pushstring(L, e->d_name);
    lua_setfield(L, -2, "name");
    lua_pushstring(L, type);
    lua_setfield(L, -2, "type");
    lua_rawseti(L, -2, ++n);
  }
  closedir(d);
  lua_pushinteger(L, 1);
  lua_pushcclosure(L, luachild_dir_next, 2);
  return 1;
}

int unsupported(lua_State *L) {
  lua_pushnil(L);
  lua_pushstring(L, "not supported in Engawa (browser)");
  return 2;
}

int open_luachild(lua_State *L) {
  lua_newtable(L);
  lua_pushcfunction(L, luachild_dir);
  lua_setfield(L, -2, "dir");
  // 子プロセス・パイプは作れない
  for (const char *name : {"spawn", "pipe", "wait", "setenv", "getenv", "unsetenv", "currentdir", "chdir"}) {
    lua_pushcfunction(L, unsupported);
    lua_setfield(L, -2, name);
  }
  return 1;
}

// ---------------------------------------------------------------- iconv

const char *ICONV_META = "engawa.iconv";

int iconv_convert(lua_State *L) {
  iconv_t *cd = static_cast<iconv_t *>(luaL_checkudata(L, 1, ICONV_META));
  size_t len;
  const char *in = luaL_checklstring(L, 2, &len);
  std::string out;
  std::vector<char> buf(len * 4 + 16);
  char *inp = const_cast<char *>(in);
  size_t inleft = len;
  iconv(*cd, nullptr, nullptr, nullptr, nullptr);
  while (inleft > 0) {
    char *outp = buf.data();
    size_t outleft = buf.size();
    size_t r = iconv(*cd, &inp, &inleft, &outp, &outleft);
    out.append(buf.data(), buf.size() - outleft);
    if (r == (size_t)-1 && errno != E2BIG) {
      lua_pushstring(L, out.c_str());
      lua_pushstring(L, errno == EILSEQ ? "invalid" : "incomplete");
      return 2;
    }
  }
  lua_pushlstring(L, out.data(), out.size());
  return 1;
}

int iconv_gc(lua_State *L) {
  iconv_t *cd = static_cast<iconv_t *>(luaL_checkudata(L, 1, ICONV_META));
  if (*cd != (iconv_t)-1) iconv_close(*cd);
  *cd = (iconv_t)-1;
  return 0;
}

int iconv_new(lua_State *L) {
  const char *to = luaL_checkstring(L, 1);
  const char *from = luaL_checkstring(L, 2);
  iconv_t c = iconv_open(to, from);
  if (c == (iconv_t)-1) {
    lua_pushnil(L);
    return 1;
  }
  iconv_t *cd = static_cast<iconv_t *>(lua_newuserdatauv(L, sizeof(iconv_t), 0));
  *cd = c;
  luaL_setmetatable(L, ICONV_META);
  return 1;
}

int open_iconv(lua_State *L) {
  if (luaL_newmetatable(L, ICONV_META)) {
    lua_pushcfunction(L, iconv_gc);
    lua_setfield(L, -2, "__gc");
    lua_newtable(L);
    lua_pushcfunction(L, iconv_convert);
    lua_setfield(L, -2, "iconv");
    lua_setfield(L, -2, "__index");
  }
  lua_pop(L, 1);
  lua_newtable(L);
  lua_pushcfunction(L, iconv_new);
  lua_setfield(L, -2, "new");
  lua_pushcfunction(L, iconv_new);
  lua_setfield(L, -2, "open");
  return 1;
}

// ---------------------------------------------------------------- Lua で書いたもの

// lua-utf8 のうち kotori が使うもの。next(s, i) は i の次の文字の位置と符号 (i が無ければ最初の文字)。
// kagari は Lua の utf8 ライブラリを開かないので、読み込むときに引数として渡す
const char *LUA_UTF8 =
    "local utf8 = ...\n"
    "local M = setmetatable({}, { __index = utf8 })\n"
    "function M.next(s, i)\n"
    "  local p = i == nil and 1 or utf8.offset(s, 2, i)\n"
    "  if p == nil or p > #s then return nil end\n"
    "  return p, utf8.codepoint(s, p)\n"
    "end\n"
    "return M\n";

// SAORI やファイルハンドルの拡張は使えない。どの関数を呼んでも失敗 (nil と理由) を返す
const char *LUA_UNSUPPORTED =
    "return setmetatable({}, { __index = function() return function() return nil, 'not supported in Engawa (browser)' end end })\n";

int open_lua(lua_State *L, const char *code, const char *name) {
  if (luaL_loadbuffer(L, code, strlen(code), name) != LUA_OK) return lua_error(L);
  lua_call(L, 0, 1);
  return 1;
}

int open_lua_utf8(lua_State *L) {
  if (luaL_loadbuffer(L, LUA_UTF8, strlen(LUA_UTF8), "=lua-utf8") != LUA_OK) return lua_error(L);
  luaL_requiref(L, "utf8", luaopen_utf8, 0);
  lua_call(L, 1, 1);
  return 1;
}
int open_unsupported(lua_State *L) { return open_lua(L, LUA_UNSUPPORTED, "=unsupported"); }

}  // namespace

extern "C" {

// kagari.cpp の Shiori::load が、ゴーストの index.lua を読む前に呼ぶ (engines.mjs の edits で差し込む)
void engawa_kagari_preload(lua_State *L) {
  luaL_getsubtable(L, LUA_REGISTRYINDEX, LUA_PRELOAD_TABLE);
  const struct {
    const char *name;
    lua_CFunction open;
  } modules[] = {
      {"luachild", open_luachild},
      {"lua-utf8", open_lua_utf8},
      {"iconv", open_iconv},
      {"fh", open_unsupported},
      {"saori_universal.native", open_unsupported},
      {"ukagaka_misc.windows", open_unsupported},
      {"conv.windows", open_unsupported},
  };
  for (const auto &m : modules) {
    lua_pushcfunction(L, m.open);
    lua_setfield(L, -2, m.name);
  }
  lua_pop(L, 1);
}

int load(char *h, long len) {
  if (instance >= 0) kagari_unload(instance);
  instance = kagari_load(h, len);
  return instance >= 0;
}

int unload() {
  if (instance < 0) return 1;
  kagari_unload(instance);
  instance = -1;
  return 1;
}

char *request(char *h, long *len) { return kagari_request(instance, h, len); }

}  // extern "C"
