// WebAssembly にする SHIORI の一覧と、それぞれのビルド設定 (native/build.mjs が読む)。
// commit を変えたら build.mjs で作り直し、src/assets/shiori/ の出来上がりも一緒にコミットする。

/** minato (Rust 製) のビルド設定。版ごとに commit だけが違う */
function minatoBuild() {
  return {
    licenses: [{ title: 'minato (MIT)', file: 'LICENSE' }],
    repo: 'https://github.com/mizuki-yura/minato.git',
    // ライブラリ (minato) だけを Emscripten 向けの静的ライブラリにする。
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
      // SAORI もスレッドで呼んで時間切れを見ていたが、スレッドを作れないのでそのまま呼ぶ (SAORI は Worker の中で同期で答える)
      'src/saori.rs': [
        [
          '    let (tx, rx) = mpsc::channel();\n',
          '    #[cfg(target_os = "emscripten")]\n' +
            '    {\n' +
            '        let _ = timeout;\n' +
            '        return Some(dll.request(&args));\n' +
            '    }\n' +
            '    let (tx, rx) = mpsc::channel();\n',
        ],
      ],
    },
    ldflags: ['-sSTACK_SIZE=16MB'],
  };
}

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
    name: 'satori1',
    label: '里々 1.x',
    licenses: [{ title: '里々 (BSD 2-Clause)', file: 'satoriya/LICENSE.txt' }],
    repo: 'https://github.com/ukatech/satoriya-shiori.git',
    // Mc172-3 (1.x の最後、master)。2.x (Unicode 版) は文字数の数え方が変わり、全角の自動ウェイトが半分になる・calc の比較が変わる
    // などがあるので、1.x の DLL を同梱しているゴーストにはこちらを使う (native-detect.ts が DLL の版で選ぶ)
    commit: 'a574669478e6086d85f63beb6c52a31c7dcc43cf',
    // satoriya/satori/makefile.emscripten と同じ。1.x は文字列を Shift_JIS のバイト列のまま扱うので、ソースは変換しない
    // (clang は UTF-8 でない文字列リテラルもそのままのバイトで残す。2バイト目が \ の文字は、ソースの側で \x.. と書いてある)
    includes: ['satoriya/satori', 'satoriya/_'],
    defines: ['POSIX', 'SATORI_DLL'],
    // 値を返さずに終わる関数は wasm では止まる (unreachable) ので、見逃さないようにエラーにする (下の edits で直したもの)
    cxxflags: ['-std=c++11', '-Wno-invalid-utf8', '-Wno-everything', '-Werror=return-type'],
    // _/charset.cpp は Windows の API で書かれているので入れず、使っている SJIStoUTF8 だけ native/shim に持つ
    shims: ['satori1_charset.cpp'],
    edits: {
      // POSIX 版の SAORI の呼び出しは、応答を受け取っても返していない (値を返さずに関数の終わりに来るので、wasm では止まる)
      'satoriya/satori/SakuraDLLClient.cpp': [['\t\tstring theResponse(static_cast<char*>(h), len);\n\t\tfree(h);\n', '\t\tstring theResponse(static_cast<char*>(h), len);\n\t\tfree(h);\n\t\treturn theResponse;\n']],
      // ログ (標準エラー) は Shift_JIS のバイト列のままなので、UTF-8 にしてから書く (Engawa は UTF-8 として読む)
      'satoriya/_/Sender.cpp': [
        ['#include\t"Sender.h"\n', '#include\t"Sender.h"\n#include\t"charset.h"\n'],
        ['fprintf(stderr, "%s", theBuf);', 'fprintf(stderr, "%s", SJIStoUTF8(theBuf).c_str());'],
        ['std::cerr << "error - SATORI : " << *i << std::endl;', 'std::cerr << "error - SATORI : " << SJIStoUTF8(*i) << std::endl;'],
        ['std::cerr << "error - SATORI : " << out << std::endl;', 'std::cerr << "error - SATORI : " << SJIStoUTF8(out) << std::endl;'],
      ],
      // ssu の lsimg も POSIX 版は中身が無く、値を返さない。2.x の POSIX 版 (opendir で画像の名前を集める) と同じにする
      'satoriya/satori/ssu.cpp': [
        ['#include\t<time.h>\n', '#include\t<time.h>\n#include\t<dirent.h>\n'],
        [
          '\treturn s;\n#else\n',
          '\treturn s;\n#else\n' +
            '\tDIR* dh = opendir(iArguments[0].c_str());\n' +
            '\tif (dh == NULL)\n' +
            '\t\treturn "0";\n' +
            '\tstruct dirent* ent;\n' +
            '\twhile ((ent = readdir(dh)) != NULL) {\n' +
            '\t\tstring lo(ent->d_name);\n' +
            '\t\tstd::transform(lo.begin(), lo.end(), lo.begin(), tolower);\n' +
            '\t\tif (compare_tail(lo, ".png") || compare_tail(lo, ".jpg") || compare_tail(lo, ".jpe") || compare_tail(lo, ".jpeg") || compare_tail(lo, ".bmp"))\n' +
            '\t\t\toValues.push_back(ent->d_name);\n' +
            '\t}\n' +
            '\tclosedir(dh);\n' +
            '\tchar s[32];\n' +
            '\tsprintf(s, "%d", (int)oValues.size());\n' +
            '\treturn s;\n',
        ],
      ],
    },
    sources: [
      ...['Sender', 'Utilities', 'calc', 'calc_float', 'stltool', 'random', 'mt19937ar'].map((n) => `satoriya/_/${n}.cpp`),
      ...[
        'SakuraCS', 'SakuraClient', 'SakuraDLLClient', 'SakuraDLLHost', 'SaoriClient', 'satori', 'satoriTranslate',
        'satori_AnalyzeRequest', 'satori_CreateResponce', 'satori_EventOperation', 'satori_Kakko',
        'satori_load_dict', 'satori_load_unload', 'satori_sentence', 'satori_tool', 'shiori_plugin', 'ssu',
      ].map((n) => `satoriya/satori/${n}.cpp`),
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
    licenses: [
      { title: '華和梨 9 (BSD 2-Clause)', file: 'LICENSE' },
      { title: 'uka_regexp (パブリックドメイン)', file: 'build/src/uka_regexp/LICENSE' },
    ],
    // 華和梨 Phase 9 (Ukagaka Tech Team による、華和梨 8 の後継)。8 の辞書をそのまま読める (README の「華和梨 8 からの乗り換え」)。
    // 新しいゴースト (『CLDSP2+』など) は 9 を同梱していて、8 とは ( ) を含む単語の読み方などが違う
    repo: 'https://github.com/ukatech/kawari.git',
    commit: 'cb8a52ab5c4f88b26cafb1646415ec9688cfb32f',
    // build/src/files.mak と gcc.mak・gcc-mach.mak (MACH_TYPE=js) と同じ。DLL の SAORI (SAORI_NATIVE) は gcc.mak の既定どおり入れる
    // (dlopen は native/shim/engawa_saori.c が受ける)。正規表現は submodule の uka_regexp、文字コードの変換は Emscripten の iconv
    defines: ['NDEBUG', 'ENABLE_SAORI_NATIVE'],
    undefines: ['WIN32', '_WIN32', '_Windows', '__CYGWIN__'],
    includes: ['build/src'],
    cxxflags: ['-std=c++11', '-Wno-everything'],
    edits: {
      // 本体との Direct SSTP (SAORI over DirectSSTP の callsaori "internal_…" など) は、js では送れないことになっている。
      // Engawa の内蔵モジュール (src/saori/internal.ts) に送る (native/shim/engawa_saori.c の engawa_direct_sstp)
      'build/src/misc/dsstp.cpp': [
        [
          'bool TBasewareLink::Send(const string &request, string &response, unsigned int timeout_ms) const\n{\n\tresponse.erase();\n\treturn false;\n}',
          'bool TBasewareLink::Send(const string &request, string &response, unsigned int timeout_ms) const\n{\n\tresponse.erase();\n\tif (handle==0) return false;\n\tlong n=0;\n\tchar *res=engawa_direct_sstp(request.data(), static_cast<int>(request.size()), &n);\n\tif (!res) return false;\n\tresponse.assign(res, static_cast<size_t>(n));\n\tstd::free(res);\n\treturn !response.empty();\n}',
        ],
        ['#include "misc/dsstp.h"', '#include "misc/dsstp.h"\n#include <cstdlib>'],
      ],
    },
    sources: [
      ...[
        'kawari_engine', 'kawari_ns', 'kawari_dict', 'kawari_code', 'kawari_codeset', 'kawari_codeexpr', 'kawari_codekis', 'kawari_vm', 'kawari_lexer',
        'kawari_compiler', 'kawari_log', 'kawari_diag', 'kawari_lint', 'kawari_rc', 'kawari_crypt',
      ].map((n) => `build/src/libkawari/${n}.cpp`),
      ...['misc', 'mt19937ar', 'phttp', 'dsstp', 'base64', 'charset', 'wfile'].map((n) => `build/src/misc/${n}.cpp`),
      'build/src/uka_regexp/uka_regexp.cpp',
      ...['saori', 'saori_module', 'saori_dsstp', 'saori_unique', 'saori_native'].map((n) => `build/src/saori/${n}.cpp`),
      ...['echo', 'dict', 'date', 'counter', 'file', 'escape', 'urllist', 'substitute', 'split', 'communicate', 'xargs', 'string', 'regex', 'help', 'saori', 'sstp', 'system'].map(
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
    // 0.3.0。0.3 から、呼んだ関数・トークから呼び出し元の let が見えなくなった (CHANGELOG.md)。
    // それより前の DLL を同梱しているゴーストには、下の minato02 を使う (native-detect.ts が DLL の版で選ぶ)
    commit: '80febc0b27a3bb189e6c1b7de36bee7d6f90d8ba',
    ...minatoBuild(),
  },
  {
    name: 'minato02',
    label: 'minato 0.2',
    // 0.2.2 (0.3 より前の最後)。0.1.x も、呼び出し元の let が見えるのは同じなのでこちらで動かす
    commit: '3b2d35af3d7e639e2df94c74582b89dad8f37ff1',
    ...minatoBuild(),
  },
  {
    name: 'pasta',
    label: 'pasta',
    licenses: [{ title: 'pasta (MIT)', file: 'LICENSE' }],
    repo: 'https://github.com/ekicyou/pasta.git',
    commit: '96adf83f36e978bf0dbd9c754b45607f918fedce',
    // Rust 製 (Pasta DSL を Lua にして動かす)。ワークスペースのうち SHIORI の pasta_shiori だけを静的ライブラリにする。
    //   - LuaJIT は WebAssembly にできないので、mlua を標準の Lua 5.4 で組む (pasta の Lua は標準の Lua でも動くように書かれている)
    //   - DLL の入口 (windows.rs) とアクターのスレッドは Windows 向けなので、スレッドを使わずに PastaShiori をそのまま呼ぶ入口を足す
    // pasta の台本は日本語の名前の変数・関数を使う (LuaJIT は許す) ので、Lua 5.4 も LUA_UCID で許すように組む
    rust: { lib: 'pasta', package: 'pasta_shiori', cflags: ['-DLUA_UCID'] },
    edits: {
      'Cargo.toml': [['mlua = { version = "0.12.2", features = ["luajit52", "vendored", "serialize"] }', 'mlua = { version = "0.12.2", features = ["lua54", "vendored", "serialize"] }']],
      // LuaJIT にしか無いライブラリ (jit・ffi・bit) は無いものとして扱う。Lua 5.4 の coroutine は別のライブラリ
      'crates/pasta_lua/src/runtime/runtime_config.rs': [
        ['"std_coroutine" => Ok(StdLib::NONE),', '"std_coroutine" => Ok(StdLib::COROUTINE),'],
        ['"std_jit" => Ok(StdLib::JIT),', '"std_jit" => Ok(StdLib::NONE),'],
        ['"std_ffi" => Ok(StdLib::FFI),', '"std_ffi" => Ok(StdLib::NONE),'],
        ['"std_bit" => Ok(StdLib::BIT),', '"std_bit" => Ok(StdLib::NONE),'],
      ],
      // Lua 5.4 には package.loaders (5.1 の名前) が無いので package.searchers を使う (並びは同じ4つ)
      'crates/pasta_lua/src/runtime/searcher.rs': [['    let loaders: Table = package.get("loaders")?;', '    let loaders: Table = package.get("searchers")?;']],
      'crates/pasta_shiori/src/lib.rs': [
        [
          '#[cfg(windows)]\npub use windows::{load, loadu, request, unload};',
          '#[cfg(windows)]\npub use windows::{load, loadu, request, unload};\n\n' +
            '/// Engawa (Emscripten) の入口。渡されるバイト列は malloc したもの (GlobalAlloc の代わり) で、こちらで free する。\n' +
            '/// Worker の中で1つだけ動くので、スレッドを使わずに PastaShiori をそのまま呼ぶ\n' +
            '#[cfg(target_os = "emscripten")]\n' +
            'mod engawa {\n' +
            '    use crate::shiori::{PastaShiori, Shiori};\n' +
            '    use std::cell::RefCell;\n' +
            '    use std::ffi::c_long;\n' +
            '    unsafe extern "C" {\n' +
            '        fn malloc(size: usize) -> *mut u8;\n' +
            '        fn free(ptr: *mut u8);\n' +
            '    }\n' +
            '    thread_local! {\n' +
            '        static SHIORI: RefCell<Option<PastaShiori>> = const { RefCell::new(None) };\n' +
            '    }\n' +
            '    unsafe fn take(ptr: *mut u8, len: usize) -> String {\n' +
            '        let s = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(ptr, len) }).into_owned();\n' +
            '        unsafe { free(ptr) };\n' +
            '        s\n' +
            '    }\n' +
            '    #[unsafe(no_mangle)]\n' +
            '    pub unsafe extern "C" fn load(h: *mut u8, len: c_long) -> i32 {\n' +
            '        let dir = unsafe { take(h, len.max(0) as usize) };\n' +
            '        let mut shiori = PastaShiori::default();\n' +
            '        let ok = shiori.load(0, dir.trim_end_matches(\'/\')).unwrap_or(false);\n' +
            '        SHIORI.with(|s| *s.borrow_mut() = Some(shiori));\n' +
            '        ok as i32\n' +
            '    }\n' +
            '    #[unsafe(no_mangle)]\n' +
            '    pub unsafe extern "C" fn request(h: *mut u8, len: *mut c_long) -> *mut u8 {\n' +
            '        let req = unsafe { take(h, (*len).max(0) as usize) };\n' +
            '        let res = SHIORI.with(|s| match s.borrow_mut().as_mut() {\n' +
            '            Some(shiori) => shiori.request(&req).unwrap_or_else(|e| e.to_shiori_response()),\n' +
            '            None => crate::error::MyError::NotInitialized.to_shiori_response(),\n' +
            '        });\n' +
            '        let bytes = res.into_bytes();\n' +
            '        let out = unsafe { malloc(bytes.len() + 1) };\n' +
            '        if out.is_null() {\n' +
            '            unsafe { *len = 0 };\n' +
            '            return out;\n' +
            '        }\n' +
            '        unsafe {\n' +
            '            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());\n' +
            '            *out.add(bytes.len()) = 0;\n' +
            '            *len = bytes.len() as c_long;\n' +
            '        }\n' +
            '        out\n' +
            '    }\n' +
            '    #[unsafe(no_mangle)]\n' +
            '    pub extern "C" fn unload() -> i32 {\n' +
            '        SHIORI.with(|s| drop(s.borrow_mut().take()));\n' +
            '        1\n' +
            '    }\n' +
            '}',
        ],
      ],
    },
    ldflags: ['-sSTACK_SIZE=16MB'],
  },
  {
    name: 'emo',
    label: 'emo',
    licenses: [
      { title: 'emo (MIT)', file: 'LICENSE' },
      { title: 'Lua 5.3 (MIT)', file: 'c/lua/lua.h', from: '* Copyright (C) 1994', to: '******************************************************************************/' },
    ],
    repo: 'https://github.com/ekicyou/emo-rs.git',
    // 0.5.2 (stable)。『えも？』(ekicyou/emo-gs) が同梱している emo.dll はこの版 (2020-08-10)
    commit: 'b4a252c4fd142ade10563b6ad99f07a966d1a420',
    // Rust 製 (rlua で Lua 5.3 を動かす。Lua はリポジトリの c/lua を build.rs が組む)。ゴーストの emo/・dic/ の Lua を読む。
    //   - DLL の入口 (windows.rs) は Windows 向けなので、Shiori をそのまま呼ぶ入口を足す
    //   - 使っていない rustyline (端末の行編集) はブラウザ向けに組めないので外す
    //   - Lua のモジュールを探すパスを \ でなく / で作る
    //   - shiori3 0.4.1 は Windows でしか組めない (api.rs と ANSI の変換が winapi を使う) ので、ほかでは Shiori3 の trait と
    //     UTF-8 の Encoding だけを持つようにする (元の enc.rs も「Windows 以外では UTF-8」としている)
    rust: {
      lib: 'emo',
      vendor: {
        // 今の Rust では、捨てる戻り値の型が ! と推論されて通らない (rlua 0.17 は古い推論のときのもの) ので、() と書く
        // lua_error は C では int を返す (戻らない) が、rlua は -> ! と書いている。wasm では型の違う関数は呼べない (罠になる) ので、
        // C と同じ型で宣言し、-> ! の lua_error はそれを呼ぶ関数にする
        rlua: {
          version: '0.17.1',
          note: 'Engawa で今の Rust と wasm で組めるように、型の書き方を直したもの',
          replace: [
            ['self.call(())?;', 'self.call::<_, ()>(())?;'],
            // Lua 5.3 の lua_setmetatable は int を返す (rlua は返さないと書いている。呼ぶ側は戻り値を使わない)
            ['    pub fn lua_setmetatable(state: *mut lua_State, index: c_int);', '    pub fn lua_setmetatable(state: *mut lua_State, index: c_int) -> c_int;'],
            ['    pub fn lua_error(state: *mut lua_State) -> !;', '    #[link_name = "lua_error"]\n    fn lua_error_c(state: *mut lua_State) -> c_int;'],
            [
              'pub type lua_Integer = c_longlong;',
              'pub type lua_Integer = c_longlong;\n\npub unsafe fn lua_error(state: *mut lua_State) -> ! {\n    lua_error_c(state);\n    std::process::abort()\n}',
            ],
          ],
        },
        // Cargo.toml の "0.4.1" は 0.4.2 になる (0.4.1 との違いはログの文字だけ)
        shiori3: {
          version: '0.4.2',
          note: 'Engawa で Windows 以外でも組めるように、Windows の API を使う部分を外したもの',
          replace: [
            [
              'mod api;',
              '#[cfg(windows)]\nmod api;\n' +
                '#[cfg(not(windows))]\n' +
                'mod api {\n' +
                '    use std::borrow::Cow;\n' +
                '    use std::path::Path;\n' +
                '    pub trait Shiori3: Sized {\n' +
                '        fn load<P: AsRef<Path>>(h_inst: usize, load_dir: P, load_dir_bytes: &[u8]) -> Result<Self, failure::Error>;\n' +
                "        fn request<'a, S: Into<&'a str>>(&mut self, req: S) -> Result<Cow<'a, str>, failure::Error>;\n" +
                '    }\n' +
                '}',
            ],
            ['pub use crate::api::RawShiori3;', '#[cfg(windows)]\npub use crate::api::RawShiori3;'],
            ['pub use crate::hglobal::enc::Encoder;', '#[cfg(windows)]\npub use crate::hglobal::enc::Encoder;'],
            [
              'pub use crate::hglobal::enc::Encoding;',
              '#[cfg(windows)]\npub use crate::hglobal::enc::Encoding;\n' +
                '#[cfg(not(windows))]\n' +
                'pub use crate::engawa_enc::{Encoder, Encoding};\n' +
                '#[cfg(not(windows))]\n' +
                'mod engawa_enc {\n' +
                '    use std::io::{Error, ErrorKind, Result};\n' +
                '    pub trait Encoder {\n' +
                '        fn to_string(&self, data: &[u8]) -> Result<String>;\n' +
                '        fn to_bytes(&self, data: &str) -> Result<Vec<u8>>;\n' +
                '    }\n' +
                '    pub enum Encoding {\n' +
                '        ANSI,\n' +
                '        OEM,\n' +
                '    }\n' +
                '    impl Encoder for Encoding {\n' +
                '        fn to_string(&self, data: &[u8]) -> Result<String> {\n' +
                '            String::from_utf8(data.to_vec()).map_err(|e| Error::new(ErrorKind::InvalidData, e))\n' +
                '        }\n' +
                '        fn to_bytes(&self, data: &str) -> Result<Vec<u8>> {\n' +
                '            Ok(data.as_bytes().to_vec())\n' +
                '        }\n' +
                '    }\n' +
                '}',
            ],
          ],
        },
      },
    },
    edits: {
      'Cargo.toml': [['rustyline = "6.2"\n', '']],
      'src/lua_path.rs': [
        ['add_path("\\\\?.");', 'add_path("/?.");'],
        ['add_path("\\\\?\\\\init.");', 'add_path("/?/init.");'],
        ['add_path("\\\\profile\\\\emo\\\\save");', 'add_path("/profile/emo/save");'],
        ['add_path("\\\\dic");', 'add_path("/dic");'],
        ['add_path("\\\\emo");', 'add_path("/emo");'],
      ],
      'src/lib.rs': [
        [
          'pub mod windows;',
          'pub mod windows;\n\n' +
            '/// Engawa (Emscripten) の入口。渡されるバイト列は malloc したもの (GlobalAlloc の代わり) で、こちらで free する。\n' +
            '/// 失敗は ErrorLevel・ErrorDescription を付けた 500 で返す\n' +
            '#[cfg(target_os = "emscripten")]\n' +
            'mod engawa {\n' +
            '    use crate::shiori::Shiori;\n' +
            '    use shiori3::Shiori3;\n' +
            '    use std::cell::RefCell;\n' +
            '    use std::os::raw::c_long;\n' +
            '    extern "C" {\n' +
            '        fn malloc(size: usize) -> *mut u8;\n' +
            '        fn free(ptr: *mut u8);\n' +
            '    }\n' +
            '    thread_local! {\n' +
            '        static SHIORI: RefCell<Option<Shiori>> = RefCell::new(None);\n' +
            '    }\n' +
            '    unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {\n' +
            '        let v = std::slice::from_raw_parts(ptr, len).to_vec();\n' +
            '        free(ptr);\n' +
            '        v\n' +
            '    }\n' +
            '    fn error_response(e: &dyn std::fmt::Display) -> String {\n' +
            '        let text = e.to_string().replace(|c| c == \'\\r\' || c == \'\\n\', " ");\n' +
            '        format!("SHIORI/3.0 500 Internal Server Error\\r\\nCharset: UTF-8\\r\\nSender: emo\\r\\nErrorLevel: error\\r\\nErrorDescription: {}\\r\\n\\r\\n", text)\n' +
            '    }\n' +
            '    #[no_mangle]\n' +
            '    pub unsafe extern "C" fn load(h: *mut u8, len: c_long) -> i32 {\n' +
            '        let bytes = take(h, len.max(0) as usize);\n' +
            '        let dir = String::from_utf8_lossy(&bytes).into_owned();\n' +
            '        match Shiori::load(0, &dir, &bytes) {\n' +
            '            Ok(shiori) => {\n' +
            '                SHIORI.with(|s| *s.borrow_mut() = Some(shiori));\n' +
            '                1\n' +
            '            }\n' +
            '            Err(e) => {\n' +
            '                eprintln!("emo load: {}", e);\n' +
            '                0\n' +
            '            }\n' +
            '        }\n' +
            '    }\n' +
            '    #[no_mangle]\n' +
            '    pub unsafe extern "C" fn request(h: *mut u8, len: *mut c_long) -> *mut u8 {\n' +
            '        let bytes = take(h, (*len).max(0) as usize);\n' +
            '        let req = String::from_utf8_lossy(&bytes).into_owned();\n' +
            '        let res = SHIORI.with(|s| match s.borrow_mut().as_mut() {\n' +
            '            Some(shiori) => match shiori.request(req.as_str()) {\n' +
            '                Ok(res) => res.into_owned(),\n' +
            '                Err(e) => error_response(&e),\n' +
            '            },\n' +
            '            None => error_response(&"emo is not loaded"),\n' +
            '        });\n' +
            '        let bytes = res.into_bytes();\n' +
            '        let out = malloc(bytes.len() + 1);\n' +
            '        if out.is_null() {\n' +
            '            *len = 0;\n' +
            '            return out;\n' +
            '        }\n' +
            '        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());\n' +
            '        *out.add(bytes.len()) = 0;\n' +
            '        *len = bytes.len() as c_long;\n' +
            '        out\n' +
            '    }\n' +
            '    #[no_mangle]\n' +
            '    pub extern "C" fn unload() -> i32 {\n' +
            '        SHIORI.with(|s| drop(s.borrow_mut().take()));\n' +
            '        1\n' +
            '    }\n' +
            '}',
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
      { title: 'LPeg (MIT)', file: '@lpeg/lpeg.html', from: 'Copyright &copy; 2007', to: '</div> <!-- id="content"', html: true },
    ],
    repo: 'https://github.com/Tatakinov/kagari_shiori.git',
    commit: 'ba87ccbd850c787aeeea7d31bed293d64bc09f01',
    // Lua 5.4.4 と sol2 3.2.2 (README の指定) はリポジトリに無いので、それぞれ取ってくる
    deps: [
      { name: 'lua', repo: 'https://github.com/lua/lua.git', commit: '5d708c3f9cae12820e415d4f89c9eacbe2ab964b' },
      { name: 'sol2', repo: 'https://github.com/ThePhD/sol2.git', commit: '288f4f4e73f379cca56f8eb7840a449adac0acb9' },
      // ゴーストが lib/lpeg.dll として持ってくることのある LPeg (1.1.0) は、組み込んで package.preload に入れる
      { name: 'lpeg', repo: 'https://github.com/roberto-ieru/LPeg.git', commit: '73a96935337d78d0e1015d7ccce6cf7470c192c4' },
    ],
    encoding: 'utf-8',
    includes: ['.', '@lua/.', '@sol2/include', '@lpeg/.'],
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
      ...['lpcap', 'lpcode', 'lpcset', 'lpprint', 'lptree', 'lpvm'].map((n) => `@lpeg/${n}.c`),
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
    // Windows 専用なので windows.h の代わりを使う。Windows 専用のモジュール (ukafmo・winrtmc) と sqlite は入れない。
    // SAORI などの DLL を呼ぶ ukadll は、本来は別の DLL (ukadll.dll) だが、組み込みのモジュールにする
    encoding: 'utf-8',
    win32Shim: true,
    includes: ['3rd/quickjs'],
    shimIncludes: ['quickshiori'],
    defines: ['_GNU_SOURCE', 'QUICKJS_NG_BUILD'],
    cxxflags: ['-std=c++20', '-Wno-everything'],
    cflags: ['-std=gnu11', '-Wno-everything'],
    edits: {
      // index.js が import する "ukadll"・"ukadll.dll" (と、ゴーストのディレクトリの DLL として探されたときの名前) を、組み込みの ukadll にする
      'src/quickshiori.cpp': [
        ['#include "quickshiori_module.h"\n', '#include "quickshiori_module.h"\nextern "C" JSModuleDef* engawa_ukadll_init_module(JSContext *ctx, const char *module_name);\n'],
        ['        strcmp(module_name, "quickshiori") == 0)', '        strcmp(module_name, "quickshiori") == 0 ||\n        strcmp(module_name, "ukadll")      == 0)'],
        [
          '    js_init_module_quickshiori(g_ctx, "quickshiori");\n',
          '    js_init_module_quickshiori(g_ctx, "quickshiori");\n' +
            '    engawa_ukadll_init_module(g_ctx, "ukadll");\n' +
            '    engawa_ukadll_init_module(g_ctx, "ukadll.dll");\n' +
            '    engawa_ukadll_init_module(g_ctx, (g_dir + "/ukadll.dll").c_str());\n',
        ],
      ],
      // DLL の入口 (js_init_module) を組み込みのモジュールの入口にする。いくつかの名前で登録するので、クラスは1度だけ作る
      'module/ukadll/quickjs_ukadll.cpp': [
        ['extern "C" __declspec(dllexport) JSModuleDef* js_init_module(', 'extern "C" JSModuleDef* engawa_ukadll_init_module('],
        [
          '    JS_NewClassID(rt, &js_ukadll_class_id);\n    JSClassDef class_def = { "UkaDll", js_ukadll_finalizer };\n    JS_NewClass(rt, js_ukadll_class_id, &class_def);\n',
          '    if (!JS_IsRegisteredClass(rt, js_ukadll_class_id)) {\n        JS_NewClassID(rt, &js_ukadll_class_id);\n        JSClassDef class_def = { "UkaDll", js_ukadll_finalizer };\n        JS_NewClass(rt, js_ukadll_class_id, &class_def);\n    }\n',
        ],
      ],
    },
    sources: [
      'src/quickshiori.cpp',
      'src/quickshiori_module.cpp',
      'module/ukadll/quickjs_ukadll.cpp',
      ...['dtoa', 'libregexp', 'libunicode', 'quickjs', 'quickjs-libc'].map((n) => `3rd/quickjs/${n}.c`),
    ],
  },
];
