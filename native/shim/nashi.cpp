// なし栞の DllMain が呼ぶ自前の C ランタイムの初期化 (tinycrt.cpp)。
// Emscripten では普通の C ランタイムが静的な変数の組み立てと後片づけをするので、何もしない
namespace nashi {
void TinyCrtStartup() {}
void TinyCrtShutdown() {}
}  // namespace nashi
