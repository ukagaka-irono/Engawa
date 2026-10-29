// WebAssembly にする SHIORI の一覧と、それぞれのビルド設定 (native/build.mjs が読む)。
// commit を変えたら build.mjs で作り直し、src/assets/shiori/ の出来上がりも一緒にコミットする。

export const ENGINES = [
  {
    name: 'yaya',
    label: 'YAYA',
    licenses: [
      { title: 'YAYA (BSD 3-Clause)', file: 'LICENSE' },
      { title: 'parson (MIT)', file: 'parson/LICENSE' },
      { title: 'TinyXML-2 (zlib)', file: 'tinyxml2/LICENSE.txt' },
      { title: 'Gumbo (Apache License 2.0。条文は COMMON の Apache License 2.0)', file: 'gumbo/src/parser.c', to: '// Author:' },
      { title: 'uka_regexp (Unlicense)', file: 'uka_regexp/LICENSE' },
      { title: 'SQLite (Public Domain)', file: 'sqlite/LICENSE' },
    ],
    repo: 'https://github.com/YAYA-shiori/yaya-shiori.git',
    commit: '3ccd7c26f23e56d71a305f1a80e5937588d27cb5',
    // makefile.emscripten / makefile.posix と同じ。.cpp は Shift_JIS (ヘッダの非 ASCII はコメントだけ)
    encoding: 'shift_jis',
    defines: ['POSIX', '_FILE_OFFSET_BITS=64'],
    includes: ['.'],
    cxxflags: ['-std=c++11', '-Wno-invalid-utf8', '-Wno-everything'],
    cflags: ['-Wno-everything'],
    edits: {
      // POSIX 版の request は、成功したときに要求のバッファを解放しない (Windows 版は GlobalFree する)。
      // 毎秒の OnSecondChange で漏れ続けるので、読み取った直後に解放する
      'basis.cpp': [['\tstd::string istr(h, *len);', '\tstd::string istr(h, *len); free(h); h = NULL;']],
    },
    sources: [
      'aya5.cpp', 'ayavm.cpp', 'basis.cpp', 'ccct.cpp', 'comment.cpp', 'digest.cpp', 'dir_enum.cpp', 'duplevinfo.cpp',
      'file.cpp', 'file1.cpp', 'function.cpp', 'globalvariable.cpp', 'html.cpp', 'jsonxml.cpp', 'lib.cpp', 'lib1.cpp',
      'localvariable.cpp', 'log.cpp', 'logexcode.cpp', 'manifest.cpp', 'messages.cpp', 'misc.cpp', 'mt19937ar.cpp',
      'parser0.cpp', 'parser1.cpp', 'selecter.cpp', 'sqlitedb.cpp', 'sysfunc.cpp', 'value.cpp', 'variable.cpp',
      'wsex.cpp', 'yamltoml.cpp', 'posix_utils.cpp',
      { file: 'tinyxml2/tinyxml2.cpp', encoding: 'utf-8' },
      { file: 'uka_regexp/uka_regexp.cpp', encoding: 'utf-8' },
      // makefile と同じく parson は C++ として、SQLite と Gumbo は C として
      { file: 'parson/parson.c', lang: 'c++' },
      'sqlite3_yaya.c',
      ...['attribute', 'char_ref', 'char_ref_gperf', 'error', 'parser', 'string_buffer', 'string_piece', 'tag', 'tokenizer', 'utf8', 'util', 'vector'].map(
        (n) => `gumbo/src/${n}.c`,
      ),
    ],
  },
  {
    name: 'satori',
    label: '里々',
    licenses: [
      { title: '里々 (BSD 2-Clause)', file: 'satoriya/LICENSE.txt' },
      { title: 'uka_regexp (Unlicense)', file: 'satoriya/uka_regexp/LICENSE' },
    ],
    repo: 'https://github.com/ukatech/satoriya-shiori.git',
    commit: '9742b7b3fb2d4062ffa0dc96e94b5ecba49668dd',
    // satoriya/satori/makefile.emscripten と同じ。ソースもヘッダも Shift_JIS
    encoding: 'shift_jis',
    headerDirs: ['satoriya/satori', 'satoriya/_', 'satoriya/uka_regexp'],
    defines: ['POSIX', 'SATORI_DLL'],
    cxxflags: ['-std=c++11', '-Wno-everything'],
    sources: [
      ...['Sender', 'charset', 'Utilities', 'calc', 'calc_float', 'stltool', 'random', 'mt19937ar'].map((n) => `satoriya/_/${n}.cpp`),
      ...[
        'SakuraCS', 'SakuraClient', 'SakuraDLLClient', 'SakuraDLLHost', 'SaoriClient', 'satori', 'satoriTranslate',
        'satori_AnalyzeRequest', 'satori_builtin', 'satori_CreateResponce', 'satori_EventOperation', 'satori_Kakko',
        'satori_load_dict', 'satori_lint', 'satori_load_unload', 'satori_sentence', 'satori_tool', 'shiori_plugin', 'ssu',
      ].map((n) => `satoriya/satori/${n}.cpp`),
      'satoriya/uka_regexp/uka_regexp.cpp',
    ],
  },
  {
    name: 'kawari',
    label: '華和梨',
    licenses: [{ title: '華和梨 8 (修正 BSD)', file: 'LICENSE' }],
    repo: 'https://github.com/kawari/kawari.git',
    commit: '3d21bdc4c7249175388606899bad6fe9ce955d86',
    // build/src/files.mak と gcc.mak (MACH_TYPE=js) と同じ。DLL の SAORI (SAORI_NATIVE) は使えないので外す。
    // ソースは EUC-JP だが、ASCII でないのはコメントだけ
    defines: ['NDEBUG'],
    includes: ['build/src'],
    cxxflags: ['-std=c++11', '-Wno-everything'],
    sources: [
      ...['kawari_engine', 'kawari_ns', 'kawari_dict', 'kawari_code', 'kawari_codeset', 'kawari_codeexpr', 'kawari_codekis', 'kawari_vm', 'kawari_lexer', 'kawari_compiler', 'kawari_log', 'kawari_rc', 'kawari_crypt'].map(
        (n) => `build/src/libkawari/${n}.cpp`,
      ),
      ...['misc', 'mt19937ar', 'l10n', 'phttp', 'base64'].map((n) => `build/src/misc/${n}.cpp`),
      ...['saori', 'saori_module', 'saori_unique'].map((n) => `build/src/saori/${n}.cpp`),
      ...['echo', 'dict', 'date', 'counter', 'file', 'escape', 'urllist', 'substitute', 'split', 'communicate', 'xargs', 'string', 'help', 'saori', 'system'].map(
        (n) => `build/src/kis/kis_${n}.cpp`,
      ),
      ...['kawari_shiori', 'shiori_object', 'shiori'].map((n) => `build/src/shiori/${n}.cpp`),
    ],
  },
  {
    name: 'kawari7',
    label: '華和梨 7',
    licenses: [{ title: '華和梨 7 (修正 BSD)', file: 'license.txt', encoding: 'shift_jis' }],
    repo: 'https://github.com/kawari/kawari7.git',
    commit: '6b2586c4579e6071b5bedc58fc091d1b46a3c8af',
    // src/emscripten_kawari.mak と同じ。華和梨 7 は文字列を Shift_JIS のバイト列のまま扱うので、ソースは変換しない
    // (clang は UTF-8 でない文字列リテラルもそのままのバイトで残す)
    // 古い Emscripten は EMSCRIPTEN も定義していた (今は __EMSCRIPTEN__ だけ)。saori.h がそれを見る
    defines: ['USEKDB', 'I18N_HACK', 'EMSCRIPTEN'],
    undefines: ['WIN32', '_WIN32', '_Windows', '__CYGWIN__'],
    includes: ['src'],
    cxxflags: ['-std=c++03', '-Wno-everything'],
    edits: {
      // libc++ では tolower が多重定義なので、関数を渡すときは C の ::tolower と書く
      'src/misc/i18n.cpp': [
        ['transform(ret.begin(), ret.end(), ret.begin(), tolower);', 'transform(ret.begin(), ret.end(), ret.begin(), ::tolower);'],
        ['transform(enc.begin(), enc.end(), enc.begin(), tolower);', 'transform(enc.begin(), enc.end(), enc.begin(), ::tolower);'],
      ],
    },
    sources: [
      ...['kawari', 'kawari_engine', 'kawari_dict', 'kawari_code', 'kawari_iscript', 'kawari_lexer', 'kawari_matchdict', 'kawari_matchcode', 'sequence_gen', 'kawari_crypt'].map(
        (n) => `src/libkawari/${n}.cpp`,
      ),
      ...['misc', 'mt19937ar', 'phttp', 'i18n', 'base64'].map((n) => `src/misc/${n}.cpp`),
      'src/saori/saori.cpp',
      'src/saori/saori_win32.cpp',
      ...['echo', 'dict', 'test', 'date', 'counter', 'cpiro', 'expr', 'file', 'escape', 'help', 'urllist', 'saori', 'substitute'].map((n) => `src/kis/kis_${n}.cpp`),
      'src/shiori/shiori_interface.cpp',
      'src/shiori_js/shiori.cpp',
    ],
  },
  {
    name: 'nashi',
    label: 'なし栞',
    licenses: [{ title: 'なし栞 (なしライセンス 1.1)', file: 'LICENSE' }],
    repo: 'https://github.com/yanashi-interface/nashi-shiori-studio.git',
    commit: '970146932de3dc6d9212be5a7ba80a9138f13638',
    // shiori/build.ps1 (MSVC) と同じソース。Windows 専用なので windows.h の代わり (native/shim/win32) で組む。
    // tinycrt.cpp (古い Windows 向けの自前の C ランタイム) は使わない
    encoding: 'utf-8',
    win32Shim: true,
    shims: ['nashi.cpp'],
    cxxflags: ['-std=c++17', '-Wno-everything'],
    sources: ['dllmain', 'interp', 'json', 'program', 'saori', 'shiori', 'util'].map((n) => `shiori/src/${n}.cpp`),
  },
  {
    name: 'aya5',
    label: '文',
    // ライセンスは readme.txt の中にある
    licenses: [{ title: '文 (AYA version 5。readme.txt より)', file: 'readme.txt', encoding: 'shift_jis', from: '配布パッケージに含まれているすべてのファイルを', to: '----------------' }],
    repo: 'https://github.com/ponapalt/aya5-shiori.git',
    commit: '6c48c4a57154376987b35bcff5335b4d3d472ac7',
    // makefile.posix と同じ。古い Boost.Regex の代わりは native/shim/boost-compat (C++11 の <regex>)。
    // ほとんどは Shift_JIS、POSIX 用に足された一部のファイルだけ EUC-JP。ヘッダにも Shift_JIS の文字列がある
    encoding: 'shift_jis',
    encodings: { 'posix_charconv.cpp': 'euc-jp', 'strconv.cpp': 'euc-jp', 'strconv.h': 'euc-jp', 'posix_utils.h': 'euc-jp' },
    headerDirs: ['.'],
    defines: ['POSIX'],
    // 関数表のグローバル変数 function と std::function がぶつかるのを避ける (native/shim/aya5_prelude.h)
    prelude: 'aya5_prelude.h',
    includes: ['.'],
    shimIncludes: ['boost-compat'],
    // VC6 向けの書き方 (クラスの中の CSerial::CSerial のような余分な修飾) を clang でも通す
    cxxflags: ['-std=c++11', '-fms-extensions', '-Wno-everything'],
    edits: {
      // YAYA と同じく、POSIX 版の request は成功したときに要求のバッファを解放しないので、読み取った直後に解放する
      'basis.cpp': [['    string istr(h, *len);', '    string istr(h, *len); free(h); h = NULL;']],
    },
    sources: [
      'aya5', 'basis', 'comment', 'duplevinfo', 'file', 'file1', 'function', 'globalvariable', 'lib', 'lib1', 'localvariable',
      'log', 'logexcode', 'misc', 'mt19937ar', 'parser0', 'parser1', 'selecter', 'sysfunc', 'value', 'valuesub', 'wsex',
      'posix_utils', 'posix_charconv', 'strconv', 'strconv_cp932', 'wordmatch',
    ].map((n) => `${n}.cpp`),
  },
  {
    name: 'minato',
    label: 'minato',
    licenses: [{ title: 'minato (MIT)', file: 'LICENSE' }],
    repo: 'https://github.com/mizuki-yura/minato.git',
    commit: '3b2d35af3d7e639e2df94c74582b89dad8f37ff1',
    // Rust 製。ライブラリ (minato) だけを Emscripten 向けの静的ライブラリにする。
    // Windows 専用の winapi (GlobalAlloc・LoadLibraryW) は native/shim/rust-winapi に差し替える
    rust: { lib: 'minato', patch: { winapi: 'rust-winapi' } },
    edits: {
      // 構文チェッカーの GUI (eframe・wgpu) はビルドしない
      'Cargo.toml': [['members = [".", "minato-checker-gui"]', 'members = ["."]']],
      // スレッドを作れないので、16MB のスタックで動かしていたパーサーをそのまま呼ぶ (スタックはリンクの設定で 16MB にする)
      'src/lib.rs': [
        [
          '    let main = main.to_path_buf();\n',
          '    let main = main.to_path_buf();\n' +
            '    #[cfg(target_os = "emscripten")]\n' +
            '    {\n' +
            '        let mut visited = HashSet::new();\n' +
            '        return std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| load_program(&main, &mut visited))).unwrap_or_else(|_| {\n' +
            '            Err(LoadError::PreprocessError(Diagnostic::error("パース中に内部エラーが発生しました。")))\n' +
            '        });\n' +
            '    }\n',
        ],
      ],
    },
    ldflags: ['-sSTACK_SIZE=16MB'],
  },
  {
    name: 'kagari',
    label: 'kagari',
    licenses: [
      { title: 'kagari (MIT)', file: 'LICENSE' },
      { title: 'Lua 5.4 (MIT)', file: '@lua/lua.h', from: '* Copyright (C) 1994', to: '*******************************************************************************/' },
      { title: 'sol2 (MIT)', file: '@sol2/LICENSE.txt' },
    ],
    repo: 'https://github.com/Tatakinov/kagari_shiori.git',
    commit: 'ba87ccbd850c787aeeea7d31bed293d64bc09f01',
    // Lua 5.4.4 と sol2 3.2.2 (README の指定) はリポジトリに無いので、それぞれ取ってくる
    deps: [
      { name: 'lua', repo: 'https://github.com/lua/lua.git', commit: '5d708c3f9cae12820e415d4f89c9eacbe2ab964b' },
      { name: 'sol2', repo: 'https://github.com/ThePhD/sol2.git', commit: '288f4f4e73f379cca56f8eb7840a449adac0acb9' },
    ],
    encoding: 'utf-8',
    includes: ['.', '@lua/.', '@sol2/include'],
    // lua.hpp (Lua の配布物にあるもの) と、DLL の口・ゴーストの Lua が require する C モジュールの代わり
    shimIncludes: ['lua'],
    shims: ['kagari_engawa.cpp'],
    defines: ['LUA_USE_POSIX'],
    cxxflags: ['-std=c++17', '-Wno-everything'],
    cflags: ['-Wno-everything'],
    edits: {
      // ゴーストの index.lua を読む前に、C モジュールの代わり (kagari_engawa.cpp) を package.preload に入れる
      'kagari.cpp': [
        ['#include "kagari.h"', '#include "kagari.h"\nextern "C" void engawa_kagari_preload(lua_State *L);'],
        ['lua_["package"]["cpath"] = package_cpath;', 'lua_["package"]["cpath"] = package_cpath;\n    engawa_kagari_preload(lua_.lua_state());'],
      ],
      // sol2 3.2.2 の optional<T&>::emplace は無い construct() を呼んでいて、新しい clang では通らない (よく知られた直し方)
      '@sol2/include/sol/optional_implementation.hpp': [
        [
          'T& emplace(Args&&... args) noexcept {\n\t\t\tstatic_assert(std::is_constructible<T, Args&&...>::value, "T must be constructible with Args");\n\n\t\t\t*this = nullopt;\n\t\t\tthis->construct(std::forward<Args>(args)...);\n\t\t}',
          'T& emplace(Args&&... args) noexcept {\n\t\t\tstatic_assert(std::is_constructible<T, Args&&...>::value, "T must be constructible with Args");\n\n\t\t\t*this = nullopt;\n\t\t\tnew (static_cast<void*>(this)) optional(std::in_place, std::forward<Args>(args)...);\n\t\t\treturn **this;\n\t\t}',
        ],
      ],
    },
    sources: [
      'kagari.cpp',
      'kagari_unix.cpp',
      ...[
        'lapi', 'lcode', 'lctype', 'ldebug', 'ldo', 'ldump', 'lfunc', 'lgc', 'llex', 'lmem', 'lobject', 'lopcodes', 'lparser', 'lstate',
        'lstring', 'ltable', 'ltm', 'lundump', 'lvm', 'lzio', 'lauxlib', 'lbaselib', 'lcorolib', 'ldblib', 'liolib', 'lmathlib',
        'loadlib', 'loslib', 'lstrlib', 'ltablib', 'lutf8lib', 'linit',
      ].map((n) => `@lua/${n}.c`),
    ],
  },
  {
    name: 'quickshiori',
    label: 'quickshiori',
    licenses: [
      { title: 'quickshiori (BSD 3-Clause)', file: 'LICENSE' },
      { title: 'QuickJS-NG (MIT)', file: '3rd/quickjs/LICENSE' },
    ],
    repo: 'https://github.com/cronfox/quickshiori.git',
    commit: '150bb24dcff08c246b179386d247a9b1e83bc129',
    // JavaScript (QuickJS-NG) の SHIORI。src/CMakeLists.txt の quickshiori.dll と、QuickJS-NG の qjs・qjs-libc を一緒に組む。
    // Windows 専用なので windows.h の代わりを使う。Windows 専用のモジュール (ukadll・ukafmo・winrtmc) と sqlite は入れない
    encoding: 'utf-8',
    win32Shim: true,
    includes: ['3rd/quickjs'],
    shimIncludes: ['quickshiori'],
    defines: ['_GNU_SOURCE', 'QUICKJS_NG_BUILD'],
    cxxflags: ['-std=c++20', '-Wno-everything'],
    cflags: ['-std=gnu11', '-Wno-everything'],
    sources: [
      'src/quickshiori.cpp',
      'src/quickshiori_module.cpp',
      ...['dtoa', 'libregexp', 'libunicode', 'quickjs', 'quickjs-libc'].map((n) => `3rd/quickjs/${n}.c`),
    ],
  },
];
