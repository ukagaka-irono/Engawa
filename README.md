# Engawa

ブラウザで動く伺か (ukagaka) のベースウェアです。SSP の動作をブラウザ上で再現することを目指しています。

インストールしたゴーストはブラウザ内 (IndexedDB) に保存され、次に開いたときもそのまま起動します。
初回はサンプルゴースト「ゆかりとちゅん」が自動でインストールされます。

## 使い方

ビルドすると、すべてを1つにまとめた `dist/index.html` ができます。サーバーは要らず、このファイルをブラウザで開く (ダブルクリックする) だけで起動します。
ほかの場所に置いたり人に渡したりするときも、この1ファイルだけで動きます。

```bash
npm install
npm run build
```

開発中は Vite の開発サーバーを使います。

```bash
npm run dev
```

`file://` で開いたページで IndexedDB が使えないブラウザでは、メモリに保存して動きます (その旨を通知し、インストールしたものはページを閉じると消えます)。Chrome と Edge では `file://` でも保存されます。

- **インストール**: `.nar` / `.zip` ファイルやゴーストのフォルダを画面にドロップします。メニューの「インストール」からも選べます。
- **メニュー**: キャラクターかバルーンを右クリックするか、画面下のタスクバーの右端にある「縁」アイコンを押します。メニューを開いているときは、項目の後ろの文字 (「ゴースト切り替え(G)」の G など) を押しても選べます。
- **ヘルプ**: メニューの「ヘルプ」で、この説明を開けます。
- **スマートフォン・タブレット**: キャラクターを長押しするとメニュー、2回続けてタップするとダブルクリックになります。
- **キャラクターの移動**: ドラッグします (`seriko.alignmenttodesktop,free` のシェルは上下にも動かせます)。

## よそのページに埋め込む (ななろだのおためし起動など)

`npm run build` では、`dist/index.html` のほかに、よそのページに読み込ませて使う `dist/engawa-embed.js` もできます。
[Ikagaka.demo](https://ikagaka.github.io/Ikagaka.demo/) と同じ名前の関数を出すので、Ikagaka でゴーストのおためし起動をしているページ (ななろだなど) で、その代わりに使えます。

| 関数 | 内容 |
|---|---|
| `install_nar(file, dirpath, sakuraname, type)` | nar を入れる (起動はしない)。`type` が `"url"` なら `file` は URL、それ以外は Blob |
| `boot_nanikamanager()` | 入れたゴーストを起動する |
| `halt_nanikamanager()` | すべて閉じる |
| `delete_storage()` / `delete_database()` | 入れたものを全部消す |

読み込み終わると `window.onIkagakaReady()` を呼びます。どの関数も Promise を返します (`install_nar` は失敗しても reject せず `null`)。

- キャラクターとバルーンはページの上に重なります。タスクバーは出さず、メニューはキャラクターの右クリック (タッチでは長押し) で開きます。
- Engawa の CSS は `.engawa-embed` の中だけに効くようにしてあり、ページの見た目を変えません。キャラクターのいない所の入力 (スクロール・リンク・文字の選択) はページに届きます。
- おためしなので、インストールしたものや設定は保存しません (ページを閉じると消えます)。IndexedDB も localStorage も使いません。
- nar はページと同じサイトから読みます (よそのサイトの nar は、そのサイトが CORS を許していれば読めます)。

ななろだでは、ゴーストのページが `/ikagaka/` 以下の Ikagaka のスクリプトを順に読み込み、`onIkagakaReady` を待ってから
`delete_database()` → `install_nar(nar の URL, "", "", "url")` → `boot_nanikamanager()` と呼び、「終了」で `halt_nanikamanager()` を呼んでいます。
読み込むスクリプトの一覧を `engawa-embed.js` 1本に変えれば、そのまま Engawa で動きます (呼び出し方は変えなくてかまいません)。

## 対応ブラウザ

Firefox、Google Chrome (Android 版を含む)、Safari (iOS 12 以降)。Edge など Chrome と同じエンジンのブラウザでも動きます。
Internet Explorer には対応していません。

古い Safari に無い機能は Engawa の側で補っています (ダイアログ、タッチ操作など)。

## 対応状況

| 分野 | 対応しているもの |
|---|---|
| パッケージ | .nar / .zip / フォルダ、`install.txt` (ghost / balloon / shell / supplement、`accept`、`refresh` / `refreshundeletemask`、`balloon.directory` と番号付きの `balloonN.directory` 同梱)、Shift_JIS / UTF-8 の自動判定 (zip の UTF-8 フラグと Unicode Path 拡張を含む) |
| SHIORI | SHIORI/3.0 (GET / NOTIFY)、SHIORI/2.x (読み替え)、DLL 製 SHIORI を WebAssembly にしたもの (下記)、JavaScript 製 SHIORI (Web Worker 内で実行)、セーブデータの書き込み |
| SAORI | SAORI/1.0。JavaScript で作り直したものと、WebAssembly にしたもの (下記)。どの SHIORI からも呼べる |
| シェル | `surfaces.txt` / `surfaces*.txt` (新旧書式、MATERIA 式の見出し、`surface.append`、範囲指定、数字と名前のエイリアス)、element 合成 (element0 が無ければ surfaceN.png の上に重ねる)、`.pna` / `use_self_alpha` (1・true・full) / 左上色の透過、collision / collisionex |
| SERIKO | sometimes / rarely / random / periodic / always / runonce / talk / yen-e / never / bind、overlay・overlay-fast・base・replace・interpolate・reduce・asis・move・start・stop・alternativestart など、`-1` / `-2`、`option,exclusive` (ID 指定可) / `background` |
| 着せ替え | `bindgroup` (メニューと `\![bind]`) |
| バルーン | 画像バルーン (`balloons*.png` / `balloonk*.png`、descript と画像ごとの `balloons*s.txt`)、内蔵バルーン、左右の自動切り替え (キャラクターに被らない側) |
| さくらスクリプト | `\0 \1 \p \s \i \b \n \n[half] \n[150] \w \_w \__w \_q \_s \c \x \e \- \q (新旧書式) \__q \_a \f \_l \_b \& \_u \_m \8 \_v \_V \j \__c \* \_?`、`%` 環境変数、`%property[]` |
| `\![...]` | raise / notify / timerraise / timernotify / change,ghost・shell・balloon / call,ghost / open,inputbox・passwordinput・communicatebox・browser / bind / anim / sound / get,property / set,balloontimeout・choicetimeout |
| イベント | 起動・終了・切り替え・呼び出し (OnGhostCallComplete / OnOtherGhostBooted / OnOtherGhostClosed)、マウス (クリック・ダブルクリック・移動・ホイール・出入り。重なったキャラクターはピクセル単位で判定)、キー、OnSecondChange / OnMinuteChange、OnSurfaceRestore、選択肢・アンカー (Ex を含む)、入力ボックス、シェル・バルーン・着せ替えの変更、インストール (Begin / Complete / Failure / Refuse) |

### SHIORI について

ブラウザでは Windows の DLL をそのまま実行できないので、各 SHIORI のソースを WebAssembly にしたものを `index.html` に組み込んでいます。
ゴーストの `descript.txt` の `shiori` と、ゴーストが同梱している DLL の中身から、どれで動かすかを決めます (`shiori.dll` などに名前を変えてあっても分かります)。

| SHIORI | DLL | ソース |
|---|---|---|
| YAYA | yaya.dll | [YAYA-shiori/yaya-shiori](https://github.com/YAYA-shiori/yaya-shiori) |
| 文 (AYA5) | aya5.dll | [ponapalt/aya5-shiori](https://github.com/ponapalt/aya5-shiori) |
| 里々 | satori.dll | [ukatech/satoriya-shiori](https://github.com/ukatech/satoriya-shiori) |
| 華和梨 8 | shiori.dll (kawarirc.kis) | [kawari/kawari](https://github.com/kawari/kawari) |
| 華和梨 7 | shiori.dll (kawari.ini)。SHIORI/2.x で話す | [kawari/kawari7](https://github.com/kawari/kawari7) |
| なし栞 | nashi.dll | [yanashi-interface/nashi-shiori-studio](https://github.com/yanashi-interface/nashi-shiori-studio) |
| minato (Rust) | shiori.dll (talks/main.mnt) | [mizuki-yura/minato](https://github.com/mizuki-yura/minato) |
| kagari (Lua 5.4。kotori を含む) | kagari.dll | [Tatakinov/kagari_shiori](https://github.com/Tatakinov/kagari_shiori) |
| quickshiori (QuickJS) | quickshiori.dll | [cronfox/quickshiori](https://github.com/cronfox/quickshiori) |

できないこと:

- **下の表に無い SAORI と、プラグイン** (DLL や外部のプログラム) は読めません。呼ぶと失敗として返ります。
- **.NET (dnproxy)・PowerShell (powershiori) の SHIORI** は、ブラウザで動く実行環境が無いので動きません。
- minato が内部でパニックした場合、その SHIORI はそこで止まります (Safari 12 で動かすため、Rust の例外処理を使わずに組んでいます)。

上のどれにも当たらない SHIORI のゴーストは、シェルの表示とメニューだけが使え、起動時にその旨をバルーンで知らせます。
SHIORI のセーブデータは、ゴーストを閉じたとき・ページを閉じたり隠したりしたときに保存します。

組み込んでいる SHIORI・SAORI とライブラリのライセンスは、メニューの「ライセンス」で見られます。

### SAORI について

ゴーストが同梱している SAORI の DLL は、DLL の中身 (書き出し表にある DLL じしんの名前) とファイル名で見分け、
ブラウザで作り直したものに差し替えて呼びます。SHIORI が DLL を開くところ (dlopen・LoadLibrary など) を Engawa が受けるので、
上のどの SHIORI からも、Windows と同じ書き方で呼べます。

WebAssembly にしたもの (ソースからビルドして `index.html` に組み込んでいます):

| SAORI | DLL | ソース |
|---|---|---|
| ssu (里々に付いてくるもの) | ssu.dll | [ukatech/satoriya-shiori](https://github.com/ukatech/satoriya-shiori) |
| timebkn (時刻・旧暦) | timebkn.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| XAORIC (XPath) | xaoric.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| sqlori (SQLite) | sqlori.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| MahjongUtil (麻雀) | MahjongUtil.dll | [nikolat/MahjongUtil](https://github.com/nikolat/MahjongUtil) |
| mahjong_nodoka (麻雀) | nodoka.dll | [Tatakinov/mahjong_nodoka](https://github.com/Tatakinov/mahjong_nodoka) |
| TexasHoldemUtil (ポーカー) | TexasHoldemUtil.dll | [Tatakinov/TexasHoldemUtil](https://github.com/Tatakinov/TexasHoldemUtil) |
| saori_budoux (文の区切り) | budoux.dll | [Tatakinov/saori_budoux](https://github.com/Tatakinov/saori_budoux) |
| saori-calcs (四則演算) | calcs.dll | [tukinami/saori-calcs](https://github.com/tukinami/saori-calcs) |
| saori-japanese-gengou (和暦) | japanesegengou.dll | [tukinami/saori-japanese-gengou](https://github.com/tukinami/saori-japanese-gengou) |
| saori-resized-png (画像の縮小) | resizedpng.dll | [tukinami/saori-resized-png](https://github.com/tukinami/saori-resized-png) |
| saori-resized-png-mini (画像の縮小) | resizedpngmini.dll | [tukinami/saori-resized-png-mini](https://github.com/tukinami/saori-resized-png-mini) |
| saori-pie-chart (円グラフ) | piechart.dll | [tukinami/saori-pie-chart](https://github.com/tukinami/saori-pie-chart) |
| saori-qrcode (QR コード) | saori_qrcode.dll | [nikolat/saori-qrcode](https://github.com/nikolat/saori-qrcode) |
| yaya-as-saori (YAYA を SAORI として使う) | yaya.dll | [YAYA-shiori/yaya-as-saori](https://github.com/YAYA-shiori/yaya-as-saori) (中身は上の YAYA) |

JavaScript で作り直したもの (ブラウザでできることで答えます):

| SAORI | DLL | ブラウザでの動き |
|---|---|---|
| textcopy2・clipcopy | textcopy2.dll・clipcopy.dll | クリップボードに写す (ページの操作の直後でないと、ブラウザに断られることがあります) |
| PlayWavSound | PlayWavSound.dll | ゴーストの WAV などを鳴らす (`system:` の Windows の音は鳴らしません) |
| ccpuid | ccpuid.dll・saori_cpuid.dll | 論理プロセッサの数・おおよそのメモリ・OS だけを答え、ほかは `<unknown>` など |
| advanced_sysinfo | advanced_sysinfo.dll | 特別なフォルダ・ドライブは無いと答える |
| window_info | window_info.dll | Engawa のページだけを1つの窓として答える |
| GetDesktopInfo | GetDesktopInfo.dll | デスクトップのアイコンは無し、ごみ箱は空と答える |
| bignum | bignum.dll | 任意の桁の計算 ([decimal.js](https://github.com/MikeMcl/decimal.js)) |
| totp_saori | totp_saori.dll | ワンタイムパスワード (TOTP) |
| KeywordReg | KeywordReg.dll | `keyword.txt` のキーワードを探す。漢字の読みは分からない (IME が無い) ので、カタカナとひらがなをそろえるだけ |

SAORI について、できないこと・違うこと:

- SAORI は SHIORI と同じ Worker の中で、同期で答えます。ブラウザに聞かないと分からないこと (クリップボード・音) は、答えを待たずにページに頼みます。
- SAORI が書いたファイル (sqlori のデータベース、作った画像など) は、すぐに表示に使え、セーブデータと同じく保存されます。
- SAORI どうしはファイルを分け合わないので、ある SAORI が作った画像を、別の SAORI が続けて読むことはできません。
- saori-pie-chart は字体が無いので、円グラフの文字 (ラベル) を描きません。
- saori-resized-png は、AVIF と OpenEXR の画像を読めません (C のライブラリやスレッドを使うため)。
- saori-japanese-gengou の「今日」は、世界時 (UTC) の日付になります。
- WebAssembly の SAORI を組み込んだので、`index.html` と `engawa-embed.js` はそれぞれ約 11.5 MB です (SAORI の分が約 5.6 MB)。

#### JavaScript で SHIORI を書く

JavaScript で SHIORI を書く場合は、`ghost/master/descript.txt` に `shiori,shiori.js` と書き、
次の関数を export する ES モジュールを置きます。

```js
export function load(dir) {}
export function request(text) {
  // text は SHIORI/3.0 の要求文字列。応答文字列を返す (Promise でもよい)
  return 'SHIORI/3.0 204 No Content\r\nCharset: UTF-8\r\n\r\n';
}
export function unload() {}
```

Web Worker の中で ES モジュールを読めないブラウザ (Safari 14 以前など) では、行頭の `export` を書き換えて普通のスクリプトとして動かします。
そのため `import` 文と `export ... from` は使えません。別のファイルは `engawa.importModule()` で読み込んでください。

SHIORI からは `globalThis.engawa` でゴーストのファイルを読み書きできます (パスは `ghost/master` からの相対)。

| 関数 | 内容 |
|---|---|
| `readText(path, charset?)` / `readBinary(path)` | ファイルを読む |
| `writeText(path, text)` / `writeBinary(path, data)` | ファイルを書く (ブラウザ内に保存される) |
| `exists(path)` / `list(prefix?)` | ファイルの有無・一覧 |
| `importModule(path)` | ゴースト内の別の JS モジュールを読み込む |
| `log(...args)` | ブラウザのコンソールに出す |

サンプルは [sample/engawa/ghost/master/shiori.js](sample/engawa/ghost/master/shiori.js) にあります。

### 開発用 API

ブラウザのコンソールから、前面のゴーストにスクリプトを送れます (SSTP の代わり)。

```js
engawa.send('\\0\\s[5]こんにちは。\\e');
engawa.raise('OnBoot');
```

## 構成

```
src/
  vfs/       ファイルツリー、zip 展開、IndexedDB への保存
  package/   descript.txt の解析、インストール
  shiori/    SHIORI/3.0 プロトコル、SHIORI/2.x の読み替え、JS SHIORI と WebAssembly の SHIORI (Web Worker)
  assets/shiori/  WebAssembly にした SHIORI (native/build.mjs が作る) とそのライセンス
  saori/     SAORI の置き場 (SHIORI の Worker の中)、SAORI/1.0、JavaScript で作り直した SAORI
  assets/saori/   WebAssembly にした SAORI (native/build.mjs が作る) とそのライセンス
  shell/     surfaces.txt の解析、サーフェス合成、SERIKO、キャラクター表示
  balloon/   バルーンのスキンと表示
  sakura/    さくらスクリプトの字句解析と再生
  ghost/     ゴースト本体 (イベント処理)、ベースウェア全体の管理、設定
  ui/        メニュー (シェルの menu.* に対応)、ダイアログ、ヘルプ、画面の骨組み
  embed.ts   よそのページに埋め込む版の入口 (Ikagaka.demo と同じ関数を出す。ビルドは vite.embed.config.ts)
sample/      サンプルゴーストのテキスト (画像は tools/ で生成)
tools/       サンプルゴーストの .nar を作るスクリプト
native/      SHIORI・SAORI を WebAssembly にするビルド (engines.mjs・saoris.mjs にソースのコミットと設定、shim/ に Windows の API などの代わり)
```

サンプルゴーストを編集したら `npm run sample` で `src/assets/engawa.nar` を作り直します (ビルドで `index.html` に埋め込まれます)。
(インストール済みのサンプルを更新するには、オプションから削除して読み込み直してください。)

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー |
| `npm run build` | 型チェックと本番ビルド (開くだけで動く `dist/index.html` 1ファイルと、埋め込み用の `dist/engawa-embed.js`) |
| `npm test` | 単体テスト |
| `npm run sample` | サンプルゴーストの .nar を生成 |
| `node native/build.mjs [名前...]` | SHIORI・SAORI を WebAssembly にし直す (下記) |

### SHIORI・SAORI を WebAssembly にし直す

`src/assets/shiori/`・`src/assets/saori/` の出来上がりはリポジトリに入っているので、Engawa をビルドするだけなら次のものは要りません。
版を上げるときは、`native/engines.mjs` (SHIORI)・`native/saoris.mjs` (SAORI) のコミットを変えてから `node native/build.mjs` を実行します。

- [Emscripten](https://emscripten.org/) 5.0.x (`~/emsdk` か環境変数 `EMSDK`)。6.0 以降は Safari 15 より古いブラウザ向けに出力できないので使えません。
- Rust の nightly と rust-src (`rustup toolchain install nightly --component rust-src`、Rust 製の SHIORI・SAORI 用)。標準ライブラリごと例外処理なしで作り直すためです。
