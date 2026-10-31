// 文 (AYA5) のソースの前に読む (-include)。関数表のグローバル変数 function が、
// C++11 の標準ヘッダの std::function と (using namespace std で) ぶつかるので、名前を aya5_function に置き換える。
// 先に標準ヘッダを読んでおけば、std::function の名前は変わらず、後から読む AYA5 のコードだけが置き換わる
#ifndef ENGAWA_AYA5_PRELUDE_H
#define ENGAWA_AYA5_PRELUDE_H
#ifdef __cplusplus
#include <algorithm>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <vector>
#define function aya5_function
#endif
#endif
