// kagari (Lua 5.4 の SHIORI) を WebAssembly で動かすための口。
// - kagari の POSIX 版は kagari_load / kagari_request / kagari_unload (複数のゴースト向け) なので、DLL と同じ load / request / unload にする
// - ゴーストの Lua (kotori など) が require する C のモジュール (.dll / .so) は読めないので、代わりを package.preload に入れる
//     luachild                 dir() でディレクトリを列挙する (子プロセスは作れない)
//     lua-utf8                 Lua 5.4 の utf8 に、kotori が使う next() を足したもの
//     iconv                    new(to, from):iconv(str)。CP932 は engawa_iconv.c で変換する
//     saori_universal.native   SAORI の DLL を engawa_saori.c で開く
//     fh, ukagaka_misc.windows, conv.windows   使えないので、呼ばれたら失敗を返す
#include <dirent.h>
#include <sys/stat.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "engawa_iconv.h"
#include "engawa_saori.h"
#include "lua.hpp"

// LPeg (engines.mjs の deps で取ってきて、一緒に組む)
extern "C" int luaopen_lpeg(lua_State *L);

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

// ---------------------------------------------------------------- saori_universal.native

// kotori の saori_universal が使う。Native(path) が SAORI の DLL を開き、:load(dir) / :request(str) / :unload() で呼ぶ。
// DLL は engawa_saori.c が開く (JavaScript・WebAssembly で作り直した SAORI だけが使える)
const char *SAORI_META = "engawa.saori";

struct Saori {
  void *handle;
  int (*load)(char *, long);
  char *(*request)(char *, long *);
  int (*unload)();
};

char *dup_bytes(const char *s, size_t len) {
  char *p = static_cast<char *>(malloc(len + 1));
  memcpy(p, s, len);
  p[len] = 0;
  return p;
}

int saori_load(lua_State *L) {
  Saori *s = static_cast<Saori *>(luaL_checkudata(L, 1, SAORI_META));
  size_t len;
  const char *dir = luaL_checklstring(L, 2, &len);
  lua_pushboolean(L, s->load && s->load(dup_bytes(dir, len), (long)len));
  return 1;
}

int saori_request(lua_State *L) {
  Saori *s = static_cast<Saori *>(luaL_checkudata(L, 1, SAORI_META));
  size_t len;
  const char *req = luaL_checklstring(L, 2, &len);
  long n = (long)len;
  char *res = s->request ? s->request(dup_bytes(req, len), &n) : nullptr;
  if (!res) {
    lua_pushnil(L);
    return 1;
  }
  lua_pushlstring(L, res, n > 0 ? (size_t)n : 0);
  free(res);
  return 1;
}

int saori_unload(lua_State *L) {
  Saori *s = static_cast<Saori *>(luaL_checkudata(L, 1, SAORI_META));
  bool ok = s->unload && s->unload();
  if (s->handle) dlclose(s->handle);
  *s = Saori{};
  lua_pushboolean(L, ok);
  return 1;
}

int saori_gc(lua_State *L) {
  Saori *s = static_cast<Saori *>(luaL_checkudata(L, 1, SAORI_META));
  if (s->handle) dlclose(s->handle);
  *s = Saori{};
  return 0;
}

int saori_new(lua_State *L) {
  const char *path = luaL_checkstring(L, 1);
  Saori *s = static_cast<Saori *>(lua_newuserdatauv(L, sizeof(Saori), 0));
  *s = Saori{};
  luaL_setmetatable(L, SAORI_META);
  s->handle = dlopen(path, RTLD_LAZY);
  if (s->handle) {
    s->load = reinterpret_cast<int (*)(char *, long)>(dlsym(s->handle, "load"));
    s->request = reinterpret_cast<char *(*)(char *, long *)>(dlsym(s->handle, "request"));
    s->unload = reinterpret_cast<int (*)()>(dlsym(s->handle, "unload"));
  }
  return 1;
}

int open_saori(lua_State *L) {
  if (luaL_newmetatable(L, SAORI_META)) {
    lua_pushcfunction(L, saori_gc);
    lua_setfield(L, -2, "__gc");
    lua_newtable(L);
    lua_pushcfunction(L, saori_load);
    lua_setfield(L, -2, "load");
    lua_pushcfunction(L, saori_request);
    lua_setfield(L, -2, "request");
    lua_pushcfunction(L, saori_unload);
    lua_setfield(L, -2, "unload");
    lua_setfield(L, -2, "__index");
  }
  lua_pop(L, 1);
  lua_pushcfunction(L, saori_new);
  return 1;
}

// ---------------------------------------------------------------- Lua で書いたもの

// lua-utf8 のうちゴーストが使うもの。next(s, i) は i の次の文字の位置と符号 (i が無ければ最初の文字)、
// sub は文字単位の string.sub、width は表示幅 (東アジアの全角は 2、結合文字は 0。曖昧な幅の文字は 1)。
// kagari は Lua の utf8 ライブラリを開かないので、読み込むときに引数として渡す
const char *LUA_UTF8 =
    "local utf8 = ...\n"
    "local M = setmetatable({}, { __index = utf8 })\n"
    "function M.next(s, i)\n"
    "  local p = i == nil and 1 or utf8.offset(s, 2, i)\n"
    "  if p == nil or p > #s then return nil end\n"
    "  return p, utf8.codepoint(s, p)\n"
    "end\n"
    "function M.sub(s, i, j)\n"
    "  local n = utf8.len(s) or #s\n"
    "  i, j = i or 1, j or -1\n"
    "  if i < 0 then i = math.max(n + i + 1, 1) elseif i == 0 then i = 1 end\n"
    "  if j < 0 then j = n + j + 1 elseif j > n then j = n end\n"
    "  if i > j then return '' end\n"
    "  return s:sub(utf8.offset(s, i), (utf8.offset(s, j + 1) or #s + 1) - 1)\n"
    "end\n"
    "local wide = { 0x1100,0x115F, 0x2E80,0x303E, 0x3041,0x33FF, 0x3400,0x4DBF, 0x4E00,0x9FFF, 0xA000,0xA4CF, 0xAC00,0xD7A3,\n"
    "  0xF900,0xFAFF, 0xFE30,0xFE4F, 0xFF00,0xFF60, 0xFFE0,0xFFE6, 0x1F300,0x1F64F, 0x1F900,0x1F9FF, 0x20000,0x3FFFD }\n"
    "local function cwidth(c)\n"
    "  if (c >= 0x300 and c <= 0x36F) or (c >= 0x200B and c <= 0x200F) or (c >= 0xFE00 and c <= 0xFE0F) then return 0 end\n"
    "  for k = 1, #wide, 2 do if c >= wide[k] and c <= wide[k + 1] then return 2 end end\n"
    "  return 1\n"
    "end\n"
    "function M.width(s)\n"
    "  if type(s) == 'number' then return cwidth(s) end\n"
    "  local w = 0\n"
    "  for _, c in utf8.codes(s) do w = w + cwidth(c) end\n"
    "  return w\n"
    "end\n"
    "return M\n";

// ファイルハンドルなどの拡張は使えない。どの関数を呼んでも失敗 (nil と理由) を返す
const char *LUA_UNSUPPORTED =
    "return setmetatable({}, { __index = function() return function() return nil, 'not supported in Engawa (browser)' end end })\n";

// LuaSocket の socket.core。ブラウザからはソケットを開けないので、つなぐものはいつも失敗 (nil と理由) を返す。
// ゴーストは index.lua で開発用のログの送り先 (localhost) につなぎにいき、つながらなければそのまま進む。
// socket.lua が読み込むときに使う newtry・protect は本物と同じにする
const char *LUA_SOCKET_CORE =
    "local M = { _VERSION = 'LuaSocket 3.0.0 (Engawa)' }\n"
    "local function fail() return nil, 'not supported in Engawa (browser)' end\n"
    "M.connect, M.tcp, M.tcp4, M.tcp6, M.udp, M.udp4, M.udp6, M.bind = fail, fail, fail, fail, fail, fail, fail, fail\n"
    "M.dns = setmetatable({}, { __index = function() return fail end })\n"
    "function M.gettime() return os.time() + os.clock() % 1 end\n"
    "function M.sleep() end\n"
    "function M.select() return {}, {}, 'timeout' end\n"
    "function M.skip(n, ...) return select(n + 1, ...) end\n"
    "function M.newtry(finalizer)\n"
    "  return function(...)\n"
    "    if not (...) then\n"
    "      if finalizer then pcall(finalizer) end\n"
    "      error({ (select(2, ...)) }, 0)\n"
    "    end\n"
    "    return ...\n"
    "  end\n"
    "end\n"
    "function M.protect(f)\n"
    "  return function(...)\n"
    "    local r = table.pack(pcall(f, ...))\n"
    "    if r[1] then return table.unpack(r, 2, r.n) end\n"
    "    if type(r[2]) == 'table' then return nil, r[2][1] end\n"
    "    error(r[2], 0)\n"
    "  end\n"
    "end\n"
    "return M\n";

// Lua Lanes (別のスレッドで Lua を動かす)。ブラウザの wasm ではスレッドを作れないので、lane は作るが動かさない
// (status は "error"、join は nil と理由)。ゴーストの lanes/init.lua は C の部分に深く頼っているので、lanes ごと置き換える
const char *LUA_LANES =
    "local M = {}\n"
    "local function fail() return nil, 'not supported in Engawa (browser)' end\n"
    "local lane = { __index = function(_, k) if k == 'join' or k == 'cancel' then return fail end end }\n"
    "function M.configure() return M end\n"
    "function M.gen() return function() return setmetatable({ status = 'error' }, lane) end end\n"
    "function M.linda() return setmetatable({}, { __index = function() return fail end }) end\n"
    "function M.now_secs() return os.time() end\n"
    "function M.sleep() end\n"
    "M.timer, M.timers, M.genlock, M.genatomic, M.require = fail, fail, fail, fail, require\n"
    "return M\n";

// 『盤上の隅っこで』などの rand.native (種を決められる乱数)。Native(seed) が返すものを呼ぶと 0〜2^32-1 を返す。
// 中身は xorshift32 (元の DLL と同じ並びにはならない)
const char *LUA_RAND_NATIVE =
    "local PRNG = {}\n"
    "PRNG.__index = PRNG\n"
    "local function next32(self)\n"
    "  local x = self.x\n"
    "  x = x ~ ((x << 13) & 0xffffffff)\n"
    "  x = x ~ (x >> 17)\n"
    "  x = x ~ ((x << 5) & 0xffffffff)\n"
    "  self.x = x\n"
    "  return x\n"
    "end\n"
    "PRNG.__call = next32\n"
    "function PRNG:uniform(max) return next32(self) % max + 1 end\n"
    "function PRNG:normal_distribution(ave, dev)\n"
    "  local u1, u2 = (next32(self) + 1) / 4294967297, next32(self) / 4294967296\n"
    "  return ave + dev * math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)\n"
    "end\n"
    "return setmetatable({}, { __call = function(_, seed)\n"
    "  local n = math.tointeger(tonumber(seed))\n"
    "  if not n then n = 0; for i = 1, #tostring(seed) do n = (n * 31 + tostring(seed):byte(i)) & 0xffffffff end end\n"
    "  n = n & 0xffffffff\n"
    "  return setmetatable({ x = n ~= 0 and n or 0x9e3779b9 }, PRNG)\n"
    "end })\n";

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
int open_socket_core(lua_State *L) { return open_lua(L, LUA_SOCKET_CORE, "=socket.core"); }
int open_lanes(lua_State *L) { return open_lua(L, LUA_LANES, "=lanes"); }
int open_rand_native(lua_State *L) { return open_lua(L, LUA_RAND_NATIVE, "=rand.native"); }

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
      {"saori_universal.native", open_saori},
      {"ukagaka_misc.windows", open_unsupported},
      {"conv.windows", open_unsupported},
      {"socket.core", open_socket_core},
      {"mime.core", open_unsupported},
      {"ssl.core", open_unsupported},
      {"lanes", open_lanes},
      {"lpeg", luaopen_lpeg},
      {"rand.native", open_rand_native},
      {"clipboard", open_unsupported},
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
