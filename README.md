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
- **メニュー**: キャラクターかデスクトップを右クリックするか、画面下のタスクバーの右端にある「縁」アイコンを押します。メニューを開いているときは、項目の後ろの文字 (「ゴースト切り替え(G)」の G など) を押しても選べます。
- **ヘルプ**: メニューの「ヘルプ」で、この説明を開けます。
- **キャラクターの移動**: ドラッグします (`seriko.alignmenttodesktop,free` のシェルは上下にも動かせます)。

## 対応状況

| 分野 | 対応しているもの |
|---|---|
| パッケージ | .nar / .zip / フォルダ、`install.txt` (ghost / balloon / shell / supplement、`accept`、`refresh` / `refreshundeletemask`、`balloon.directory` と番号付きの `balloonN.directory` 同梱)、Shift_JIS / UTF-8 の自動判定 (zip の UTF-8 フラグと Unicode Path 拡張を含む) |
| SHIORI | SHIORI/3.0 (GET / NOTIFY)、JavaScript 製 SHIORI (Web Worker 内で実行)、セーブデータの書き込み |
| シェル | `surfaces.txt` / `surfaces*.txt` (新旧書式、MATERIA 式の見出し、`surface.append`、範囲指定、数字と名前のエイリアス)、element 合成 (element0 が無ければ surfaceN.png の上に重ねる)、`.pna` / `use_self_alpha` (1・true・full) / 左上色の透過、collision / collisionex |
| SERIKO | sometimes / rarely / random / periodic / always / runonce / talk / yen-e / never / bind、overlay・overlay-fast・base・replace・interpolate・reduce・asis・move・start・stop・alternativestart など、`-1` / `-2`、`option,exclusive` (ID 指定可) / `background` |
| 着せ替え | `bindgroup` (メニューと `\![bind]`) |
| バルーン | 画像バルーン (`balloons*.png` / `balloonk*.png`、descript と画像ごとの `balloons*s.txt`)、内蔵バルーン、左右の自動切り替え (キャラクターに被らない側) |
| さくらスクリプト | `\0 \1 \p \s \i \b \n \n[half] \n[150] \w \_w \__w \_q \_s \c \x \e \- \q (新旧書式) \__q \_a \f \_l \_b \& \_u \_m \8 \_v \_V \j \__c \* \_?`、`%` 環境変数、`%property[]` |
| `\![...]` | raise / notify / timerraise / timernotify / change,ghost・shell・balloon / call,ghost / open,inputbox・passwordinput・communicatebox・browser / bind / anim / sound / get,property / set,balloontimeout・choicetimeout |
| イベント | 起動・終了・切り替え・呼び出し (OnGhostCallComplete / OnOtherGhostBooted / OnOtherGhostClosed)、マウス (クリック・ダブルクリック・移動・ホイール・出入り。重なったキャラクターはピクセル単位で判定)、キー、OnSecondChange / OnMinuteChange、OnSurfaceRestore、選択肢・アンカー (Ex を含む)、入力ボックス、シェル・バルーン・着せ替えの変更、インストール (Begin / Complete / Failure / Refuse) |

### SHIORI について

ブラウザでは Windows の DLL を実行できないため、YAYA・里々などの DLL 製 SHIORI は動きません。
その場合はシェルの表示とメニューだけが使え、起動時にその旨をバルーンで知らせます。

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
  shiori/    SHIORI/3.0 プロトコル、JS SHIORI (Web Worker)
  shell/     surfaces.txt の解析、サーフェス合成、SERIKO、キャラクター表示
  balloon/   バルーンのスキンと表示
  sakura/    さくらスクリプトの字句解析と再生
  ghost/     ゴースト本体 (イベント処理)、ベースウェア全体の管理、設定
  ui/        メニュー (シェルの menu.* に対応)、ダイアログ、ヘルプ
sample/      サンプルゴーストのテキスト (画像は tools/ で生成)
tools/       サンプルゴーストの .nar を作るスクリプト
```

サンプルゴーストを編集したら `npm run sample` で `src/assets/engawa.nar` を作り直します (ビルドで `index.html` に埋め込まれます)。
(インストール済みのサンプルを更新するには、オプションから削除して読み込み直してください。)

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー |
| `npm run build` | 型チェックと本番ビルド (開くだけで動く `dist/index.html` 1ファイル) |
| `npm test` | 単体テスト |
| `npm run sample` | サンプルゴーストの .nar を生成 |
