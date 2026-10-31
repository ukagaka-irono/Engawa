// WebAssembly にする SAORI の一覧と、それぞれのビルド設定 (native/build.mjs が読む。書き方は engines.mjs と同じ)。
// 出来上がりは src/assets/saori/。どの DLL がどれに当たるかは src/saori/detect.ts、読み込みは src/saori/wasm.ts。

/**
 * CSaori (ukatech/csaori) の SAORI に共通の設定。Windows 専用なので windows.h の代わりで組む。
 * ソースは Shift_JIS (L"…" の日本語もあるので UTF-8 にして読む)。MSVC の書き方は native/shim/csaori_prelude.h で補う
 */
const CSAORI = {
  repo: 'https://github.com/ukatech/csaori.git',
  commit: '1ddb8c9024bb4716fa3ac25d05c819fad224e459',
  source: 'csaori',
  encoding: 'shift_jis',
  win32Shim: true,
  prelude: 'csaori_prelude.h',
  headerDirs: ['.'],
  includes: ['.'],
  // process.h など、MSVC にだけあるヘッダの代わり
  shimIncludes: ['csaori'],
  cxxflags: ['-std=c++11', '-fms-extensions', '-Wno-everything'],
  cflags: ['-Wno-everything'],
};
const CSAORI_BASE = ['csaori.cpp', 'csaori_base.cpp', 'csaori_util.cpp'];
/** CSaori の SAORI ごとの license.txt (テンプレートに名前を入れたもの) */
const csaoriLicense = (dir, title) => ({ title: `${title} (CSaori。伺かで使うときは無条件、それ以外は修正 BSD)`, file: `impl_saori/${dir}/license.txt`, encoding: 'shift_jis' });

/** Tatakinov さんの SAORI に共通の設定 (ソースは UTF-8、C++17) */
const TATAKINOV = {
  encoding: 'utf-8',
  win32Shim: true,
  includes: ['.'],
  cxxflags: ['-std=c++17', '-Wno-everything'],
};
/** util.h などの「Windows でなければ #error」を、Emscripten でも Windows 版を使うようにする */
const WINDOWS_ONLY = ['#if defined(_WIN32)', '#if defined(_WIN32) || defined(__EMSCRIPTEN__)'];

/**
 * 月波 清火さんの Rust 製 SAORI (と同じ作りのもの) に共通の直し。どれも src/lib.rs と src/chars.rs が同じ。
 *   - Windows だけの依存 (winapi) を Emscripten でも使い、native/shim/rust-winapi に差し替える (文字コードの変換もそこにある)
 *   - DLL のパスは DllMain の GetModuleFileNameW で知るが、呼ばれないので、load に渡されたディレクトリを使う
 *   - extern "cdecl" は x86 だけのものなので、extern "C" にする
 */
const TUKINAMI_EDITS = {
  'Cargo.toml': [["[target.'cfg(windows)'.dependencies]", "[target.'cfg(any(windows, target_os = \"emscripten\"))'.dependencies]"]],
  'src/lib.rs': [
    [
      'pub unsafe extern "cdecl" fn load(h: HGLOBAL, _len: c_long) -> BOOL {\n',
      'pub unsafe extern "C" fn load(h: HGLOBAL, _len: c_long) -> BOOL {\n' +
        '    #[cfg(target_os = "emscripten")]\n' +
        '    let _ = DLL_PATH.set(String::from_utf8_lossy(unsafe { slice::from_raw_parts(h as *const u8, _len as usize) }).into_owned());\n',
    ],
    ['pub extern "cdecl" fn unload()', 'pub extern "C" fn unload()'],
    ['pub unsafe extern "cdecl" fn request(', 'pub unsafe extern "C" fn request('],
  ],
};
/** image クレートの、純粋な Rust でスレッドを使わない形式 */
const PURE_IMAGE = JSON.stringify(['bmp', 'dds', 'ff', 'gif', 'hdr', 'ico', 'jpeg', 'png', 'pnm', 'tga', 'tiff', 'webp']);
const tukinami = (crate, lib, commit, extraEdits = {}) => ({
  repo: `https://github.com/tukinami/${crate}.git`,
  commit,
  licenses: [{ title: `${crate} (MIT)`, file: 'LICENSE' }],
  rust: { lib, patch: { winapi: 'rust-winapi' } },
  edits: { ...TUKINAMI_EDITS, ...Object.fromEntries(Object.entries(extraEdits).map(([f, e]) => [f, [...(TUKINAMI_EDITS[f] ?? []), ...e]])) },
});

export const SAORIS = [
  // 里々に付いてくる文字列・計算の SAORI (ssu.dll)。satoriya の ssu.vcxproj と同じソースを、里々の POSIX 版と同じく組む
  {
    name: 'ssu',
    label: 'ssu',
    licenses: [
      { title: '里々 (ssu、BSD 2-Clause)', file: 'satoriya/LICENSE.txt' },
      { title: 'uka_regexp (Unlicense)', file: 'satoriya/uka_regexp/LICENSE' },
    ],
    repo: 'https://github.com/ukatech/satoriya-shiori.git',
    commit: '9742b7b3fb2d4062ffa0dc96e94b5ecba49668dd',
    // 里々 (engines.mjs の satori) と同じリポジトリ
    source: 'satori',
    encoding: 'shift_jis',
    headerDirs: ['satoriya/satori', 'satoriya/_', 'satoriya/uka_regexp'],
    defines: ['POSIX', 'SSU_SAORI_CALL_INTERFACE'],
    cxxflags: ['-std=c++11', '-Wno-everything'],
    edits: {
      // POSIX 版の SakuraDLLHost は実体を表 (vector) で持つ (里々の satori.cpp と同じ書き方にする)。
      // TimeCommands.cpp (Windows の時刻の命令) は Windows だけのものなので組まない
      'satoriya/satori/ssu.cpp': [
        [
          'SakuraDLLHost* SakuraDLLHost::m_dll = new ssu;',
          '#ifdef POSIX\nint SakuraDLLHost::m_id = 0;\nstd::vector<SakuraDLLHost *> SakuraDLLHost::m_dll(1, new ssu);\n#else\nSakuraDLLHost* SakuraDLLHost::m_dll = new ssu;\n#endif',
        ],
      ],
    },
    sources: [
      ...['calc', 'calc_float', 'mt19937ar', 'random', 'Sender', 'stltool', 'Utilities', 'charset'].map((n) => `satoriya/_/${n}.cpp`),
      ...['SakuraCS', 'SakuraDLLHost', 'SaoriHost', 'ssu'].map((n) => `satoriya/satori/${n}.cpp`),
      'satoriya/uka_regexp/uka_regexp.cpp',
    ],
  },
  // 四則演算 (calcs.dll)
  { name: 'calcs', label: 'saori-calcs', ...tukinami('saori-calcs', 'calcs', 'a22004b02703b86309a196f4612e12f42901dae5') },
  // 西暦から和暦 (japanesegengou.dll)。元号の表 (gengou_lists) はゴーストが DLL と一緒に置く
  { name: 'gengou', label: 'saori-japanese-gengou', ...tukinami('saori-japanese-gengou', 'japanesegengou', '8c858fa2c5909e834f82795a45bd274e2ef3e3d0') },
  // 画像を縮めた PNG にする (resizedpng.dll)。image の既定の機能はスレッド (rayon) や C のライブラリ (AVIF) を使うので、
  // 純粋な Rust の形式だけにする (AVIF・OpenEXR は読めない)。
  // fast_image_resize は wasm32 ならいつも SIMD を使う (Safari 16.4 から) ので、wasm32 向けの部分を外して作り直す
  {
    name: 'resizedpng',
    label: 'saori-resized-png',
    ...tukinami('saori-resized-png', 'resizedpng', '0349d337c2d0d4ae8f9afc9df86c106c3db168f0', {
      'Cargo.toml': [['image = "0.25.10"', `image = { version = "0.25.10", default-features = false, features = ${PURE_IMAGE} }`]],
    }),
    rust: {
      lib: 'resizedpng',
      patch: { winapi: 'rust-winapi' },
      vendor: { fast_image_resize: { version: '6.1.0', replace: [['target_arch = "wasm32"', 'target_arch = "engawa_no_simd"']] } },
    },
  },
  // 円グラフの PNG を作る (piechart.dll)。文字は SVG を resvg で描く
  { name: 'piechart', label: 'saori-pie-chart', ...tukinami('saori-pie-chart', 'piechart', '257bca97f5625e2d09139d587af1d48a9e657a96') },
  // 小さい版 (resizedpngmini.dll。BMP・GIF・JPEG・PNG・WebP)
  { name: 'resizedpngmini', label: 'saori-resized-png-mini', ...tukinami('saori-resized-png-mini', 'resizedpngmini', 'af3e69a42bf6cba73fcee975f99548d87f12af65') },
  // QR コードを PNG やアスキーアートにする (saori_qrcode.dll。nikolat さん。作りは月波さんのものと同じ)
  {
    name: 'qrcode',
    label: 'saori-qrcode',
    ...tukinami('saori-qrcode', 'saori_qrcode', '8e392cf7bfe3d99b6e34f4e0c293b784a561655d', {
      'Cargo.toml': [['image = "0.25.1"', 'image = { version = "0.25.1", default-features = false, features = ["png"] }']],
    }),
    repo: 'https://github.com/nikolat/saori-qrcode.git',
    licenses: [{ title: 'saori-qrcode (CC0 1.0)', file: 'LICENSE' }],
  },
  {
    ...CSAORI,
    name: 'timebkn',
    label: 'timebkn',
    licenses: [csaoriLicense('timebkn', 'timebkn')],
    headerDirs: ['.', 'impl_saori/timebkn'],
    sources: [...CSAORI_BASE, 'impl_saori/timebkn/timebkn.cpp', 'impl_saori/timebkn/qreki.cpp'],
  },
  {
    ...CSAORI,
    // XPath で XML を読む。DLL の名前は xaoric.dll (make_xaoric.bat)
    name: 'xaoric',
    label: 'XAORIC (XPath)',
    licenses: [
      { title: 'XAORIC (CSaori。伺かで使うときは無条件、それ以外は修正 BSD)', file: 'impl_saori/XPath/license.txt', encoding: 'shift_jis' },
      { title: 'TinyXPath (zlib)', file: 'impl_saori/XPath/tinyxpath/xpath_processor.h', from: 'www.sourceforge.net', to: '*/' },
      { title: 'TinyXML (zlib)', file: 'impl_saori/XPath/tinyxpath/tinyxml.h', from: 'www.sourceforge.net', to: '*/' },
    ],
    headerDirs: ['.', 'impl_saori/XPath'],
    includes: ['.', 'impl_saori/XPath/tinyxpath'],
    edits: {
      // 「xpath_processor xpath(…, xpath.c_str())」の xpath は、clang では作っている途中の変数を指す (古い MSVC は外の文字列)
      'impl_saori/XPath/XPath.cpp': [
        ['std::string xpath = SAORI_FUNC::UnicodeToMultiByte(in.args[2],(**it).cp);', 'std::string xpath_text = SAORI_FUNC::UnicodeToMultiByte(in.args[2],(**it).cp);'],
        ['xpath.c_str()', 'xpath_text.c_str()'],
      ],
    },
    sources: [
      ...CSAORI_BASE,
      'impl_saori/XPath/XPath.cpp',
      ...[
        'action_store', 'lex_util', 'node_set', 'tinystr', 'tinyxml', 'tinyxmlerror', 'tinyxmlparser', 'tokenlist', 'xml_util',
        'xpath_expression', 'xpath_processor', 'xpath_stack', 'xpath_static', 'xpath_stream', 'xpath_syntax',
      ].map((n) => ({ file: `impl_saori/XPath/tinyxpath/${n}.cpp`, encoding: 'utf-8' })),
    ],
  },
  {
    ...CSAORI,
    // SQLite のデータベース (DLL のあるディレクトリの sqlori.db など) を読み書きする
    name: 'sqlori',
    label: 'sqlori',
    licenses: [
      { title: 'sqlori (readme.txt より。だれでも自由に使い、変えてよい)', file: 'impl_saori/sqlori/readme.txt', to: '1. Update' },
      { title: 'SQLite (Public Domain)', file: 'impl_saori/sqlori/sqlite3.h', from: '** The author disclaims copyright', to: '*****' },
    ],
    headerDirs: ['.', 'impl_saori/sqlori'],
    defines: ['SQLITE_THREADSAFE=0', 'SQLITE_OMIT_LOAD_EXTENSION'],
    sources: [...CSAORI_BASE, 'impl_saori/sqlori/csaori_interface.cpp', 'impl_saori/sqlori/sqlori.cpp', 'impl_saori/sqlori/sqlite3.c'],
  },
  {
    ...CSAORI,
    // SQLite 2.8 で組んだ古い sqlori (sqlori-sqlite2)。データベースのファイルが SQLite 3 と違うので、別に組む
    name: 'sqlori2',
    label: 'sqlori (SQLite 2)',
    licenses: [
      { title: 'sqlori-sqlite2 (readme.txt より。だれでも自由に使い、変えてよい)', file: 'impl_saori/sqlori_sqlite2/readme.txt', to: '1. Update' },
      { title: 'SQLite 2 (Public Domain)', file: 'impl_saori/sqlori_sqlite2/sqlite2/sqlite.h', from: '** The author disclaims copyright', to: '*****' },
    ],
    headerDirs: ['.', 'impl_saori/sqlori_sqlite2'],
    includes: ['.', 'impl_saori/sqlori_sqlite2/sqlite2'],
    defines: ['OS_UNIX=1', 'OS_WIN=0', 'OS_MAC=0', 'NO_TCL=1', 'THREADSAFE=0'],
    edits: {
      // パーサーの宣言の戻り値の型が定義 (parse.c の void) と違う (wasm では呼んだところで止まる)
      'impl_saori/sqlori_sqlite2/sqlite2/tokenize.c': [['  extern int sqliteParser(void*, int, Token, Parse*);', '  extern void sqliteParser(void*, int, Token, Parse*);']],
    },
    sources: [
      ...CSAORI_BASE,
      'impl_saori/sqlori_sqlite2/csaori_interface.cpp',
      'impl_saori/sqlori_sqlite2/sqlori.cpp',
      ...['attach', 'auth', 'btree', 'btree_rb', 'build', 'copy', 'date', 'delete', 'encode', 'expr', 'func', 'hash', 'insert', 'main', 'opcodes', 'os', 'pager', 'parse', 'pragma', 'printf', 'random', 'select', 'table', 'tokenize', 'trigger', 'update', 'util', 'vacuum', 'vdbe', 'vdbeaux', 'where'].map((n) => `impl_saori/sqlori_sqlite2/sqlite2/${n}.c`),
    ],
  },
  {
    ...CSAORI,
    // MeCab で形態素解析をする (kisaragi.dll)。MeCab の本体 (libmecab.dll) はリポジトリに無いので taku910/mecab から組む。
    // 辞書 (dic/) はゴーストが DLL と一緒に置く
    name: 'kisaragi',
    label: 'kisaragi (MeCab)',
    deps: [{ name: 'mecab', repo: 'https://github.com/taku910/mecab.git', commit: '61b90ba6e669dc2d7d533d4a80d206f3b31d52b1' }],
    licenses: [csaoriLicense('kisaragi', 'kisaragi'), { title: 'MeCab (BSD)', file: '@mecab/mecab/BSD' }],
    headerDirs: ['.', 'impl_saori/kisaragi'],
    includes: ['.', '@mecab/mecab/src'],
    defines: ['CUSTOM_CREATE_INSTANCE', 'VERSION="0.996"', 'PACKAGE="mecab"', 'DIC_VERSION=102', 'MECAB_DEFAULT_RC="/dev/null"', 'HAVE_UNISTD_H', 'HAVE_FCNTL_H', 'HAVE_SYS_STAT_H', 'HAVE_SYS_TYPES_H', 'HAVE_SYS_MMAN_H', 'HAVE_MMAP', 'HAVE_STRING_H', 'HAVE_STDINT_H', 'HAVE_DIRENT_H', 'HAVE_GETENV'],
    edits: {
      // MeCab は DLL ではなく一緒に組む。一時ファイル・環境変数は POSIX のもので書く。辞書のパスの \ は / にする
      'impl_saori/kisaragi/kisaragi.cpp': [
        ['#include "mecab/sdk/mecab.h"', '#include "mecab.h"\n#include <algorithm>\n#include <cstdio>'],
        ['m_dicDir(L"dic\\\\")', 'm_dicDir(L"dic/")'],
        ['\tm_hMeCabDLL = ::LoadLibrary(dll_path.c_str());', '\tm_hMeCabDLL = NULL;\n\t(void)dll_path;'],
        ['\t\t::FreeLibrary(m_hMeCabDLL);', '\t\tm_hMeCabDLL = NULL;'],
        [
          '\tstring_t fullPath = checkAndModifyPathW(m_dicDir);\n',
          "\tstring_t fullPath = checkAndModifyPathW(m_dicDir);\n\tstd::replace(fullPath.begin(), fullPath.end(), L'\\\\', L'/');\n",
        ],
        [
          '\tchar tempPath[MAX_PATH];\n\t::GetTempPath(MAX_PATH,tempPath);\n\n\tchar tempFile[MAX_PATH];\n\t::GetTempFileName(tempPath,"KSG",0,tempFile);',
          '\tconst char *tempFile = "/tmp/kisaragi_mecabrc";',
        ],
        [
          '\tchar oldMecabRC[MAX_PATH] = "";\n\t::GetEnvironmentVariable("MECABRC",oldMecabRC,sizeof(oldMecabRC));\n\t::SetEnvironmentVariable("MECABRC",tempFile);',
          '\tsetenv("MECABRC",tempFile,1);',
        ],
        [
          '\t\tfullPath = checkAndModifyPathW(m_userDic);\n',
          "\t\tfullPath = checkAndModifyPathW(m_userDic);\n\t\tstd::replace(fullPath.begin(), fullPath.end(), L'\\\\', L'/');\n",
        ],
        [
          '\tHANDLE h = ::CreateFile(tempFile,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL|FILE_ATTRIBUTE_TEMPORARY,NULL);',
          '\tFILE *h = fopen(tempFile,"wb");',
        ],
        [
          '\tDWORD written = 0;\n\t::WriteFile(h,buffer.c_str(),buffer.size(),&written,NULL);\n\t::CloseHandle(h);',
          '\tif ( h ) { fwrite(buffer.c_str(),1,buffer.size(),h); fclose(h); }',
        ],
        ['\t::DeleteFile(tempFile);\n\t::SetEnvironmentVariable("MECABRC",oldMecabRC);', '\tremove(tempFile);\n\tunsetenv("MECABRC");'],
      ],
      // Windows 向けの辞書の dicrc は改行が CRLF (Windows の MeCab はテキストモードで読むので \r が消える)
      '@mecab/mecab/src/param.cpp': [
        ['  while (std::getline(ifs, line)) {\n', "  while (std::getline(ifs, line)) {\n    if (line.size() && line[line.size() - 1] == '\\r') line.erase(line.size() - 1);\n"],
      ],
    },
    sources: [
      ...CSAORI_BASE,
      'impl_saori/kisaragi/kisaragi.cpp',
      ...['char_property', 'connector', 'context_id', 'dictionary', 'dictionary_compiler', 'dictionary_generator', 'dictionary_rewriter', 'eval', 'feature_index', 'iconv_utils', 'lbfgs', 'learner', 'learner_tagger', 'libmecab', 'nbest_generator', 'param', 'string_buffer', 'tagger', 'tokenizer', 'utils', 'viterbi', 'writer'].map((n) => ({ file: `@mecab/mecab/src/${n}.cpp`, encoding: 'utf-8' })),
    ],
  },
  {
    ...CSAORI,
    // 麻雀の向聴数・待ち・点数。CSaori を同梱した別のリポジトリで、ソースは UTF-8
    name: 'mahjongutil',
    label: 'MahjongUtil',
    repo: 'https://github.com/nikolat/MahjongUtil.git',
    commit: '61893856750618f586f282cc8655701e62cb714e',
    source: undefined,
    encoding: 'utf-8',
    licenses: [{ title: 'MahjongUtil (伺かで使うときは無条件、それ以外は修正 BSD)', file: 'license.txt' }],
    headerDirs: [],
    includes: ['MahjongUtil'],
    // CreateInstance は MahjongUtil.cpp が作る (MahjongUtil.vcxproj と同じ)
    defines: ['CUSTOM_CREATE_INSTANCE'],
    sources: ['MahjongUtil', 'csaori', 'csaori_base', 'csaori_util', 'mj_common', 'mj_machi', 'mj_score', 'mj_shanten'].map((n) => `MahjongUtil/${n}.cpp`),
  },
  // Tatakinov さんの SAORI。Makefile (clang++ で Windows 向け) と同じソースを、windows.h の代わりで組む。
  // 文字コードの変換 (util.h) は Windows だけなので、Emscripten でも Windows 版を使う
  {
    ...TATAKINOV,
    // テキサスホールデムの役とモンテカルロ法での勝率
    name: 'texasholdem',
    label: 'TexasHoldemUtil',
    repo: 'https://github.com/Tatakinov/TexasHoldemUtil.git',
    commit: 'd9faa40c01f86319507088881a5af6e937b0f627',
    licenses: [{ title: 'TexasHoldemUtil (MIT)', file: 'LICENSE' }],
    sources: ['saori', 'saori_windows', 'header', 'request', 'response', 'estimate'].map((n) => `${n}.cc`),
  },
  {
    ...TATAKINOV,
    // 麻雀の向聴数と役 (nodoka.dll)
    name: 'nodoka',
    label: 'mahjong_nodoka',
    repo: 'https://github.com/Tatakinov/mahjong_nodoka.git',
    commit: '1685b7496beacd139634b951d5f5cc5aadb5f1e7',
    licenses: [{ title: 'mahjong_nodoka (MIT)', file: 'LICENSE' }],
    headerDirs: ['.'],
    edits: { 'util.h': [WINDOWS_ONLY] },
    // util.cc は Windows のとき windows/util.cc を読むだけなので、windows/util.cc を組む
    sources: ['nodoka.cc', 'lib.cc', 'windows/util.cc', 'windows/dll.cc', 'base/header.cc'],
  },
  {
    ...TATAKINOV,
    // BudouX で文を区切る。辞書 (model.json) はゴーストが DLL と一緒に置く。JSON は nlohmann/json で読む
    name: 'budoux',
    label: 'saori_budoux',
    repo: 'https://github.com/Tatakinov/saori_budoux.git',
    commit: 'bb86a774ec0ff60b96f22200c6084bb214ab8e67',
    deps: [{ name: 'json', repo: 'https://github.com/nlohmann/json.git', commit: '9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03' }],
    licenses: [
      { title: 'saori_budoux (MIT)', file: 'LICENSE' },
      { title: 'JSON for Modern C++ (nlohmann/json、MIT)', file: '@json/LICENSE.MIT' },
    ],
    includes: ['.', '@json/single_include'],
    headerDirs: ['.'],
    edits: { 'util.h': [WINDOWS_ONLY] },
    sources: ['saori.cc', 'budoux.cc', 'windows/dll.cc', 'windows/util.cc', 'sstp/header.cc', 'sstp/request.cc', 'sstp/response.cc'],
  },
];
