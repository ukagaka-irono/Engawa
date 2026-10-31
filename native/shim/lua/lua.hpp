// Lua の配布物にある lua.hpp と同じ (GitHub の lua/lua には無い)。sol2 が読む
extern "C" {
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"
}
