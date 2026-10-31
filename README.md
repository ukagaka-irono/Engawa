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
| パッケージ | .nar / .zip / フォルダ、`install.txt` (ghost / balloon / shell / supplement / package、`accept`、`refresh` / `refreshundeletemask`、`balloon.directory`・`plugin.directory` など番号付きを含む同梱)、plugin (下の「プラグインについて」)、headline・calendar・language は保存だけ (動かない)、`delete.txt`、Shift_JIS / UTF-8 の自動判定 (zip の UTF-8 フラグと Unicode Path 拡張を含む)、URL からのインストール (`\![execute,install,url]`・URL のドロップ)、インストール後の readme、ネットワーク更新 (`updates2.dau` / `updates.txt`。シェル・バルーンの OnUpdateOther…、`\![updateother,--balloon=…]`、checkonly・testonly・recovery、結果のまとめの OnUpdateResult(Ex)。配布先が CORS を許しているときだけ)、ゴーストキャッシュ (切り替えたゴーストを2体まで取っておく)、消滅 (`\![vanishbymyself]`・メニューの消滅指示) |
| SHIORI | SHIORI/3.0 (GET / NOTIFY)、SHIORI/2.x (読み替え)、DLL 製 SHIORI を WebAssembly にしたもの (下記)、JavaScript 製 SHIORI (Web Worker 内で実行)、セーブデータの書き込み |
| SAORI | SAORI/1.0。JavaScript で作り直したものと、WebAssembly にしたもの (下記)。どの SHIORI からも呼べる |
| シェル | `surfaces.txt` / `surfaces*.txt` (新旧書式、MATERIA 式の見出し、`surface.append`、範囲指定、数字と名前のエイリアス)、element 合成 (element0 が無ければ surfaceN.png の上に重ねる、`--option` の切り抜き・拡大・透明度)、合成メソッド (multiply・screen・overlay・add など)、`.pna` / `use_self_alpha` (1・true・full) / 左上色の透過、collision / collisionex (region を含む)、`collision-sort` / `animation-sort`、cursor・tooltips ブレス、`point.basepos`、`balloon.offset*` (サーフェスごと・左右別)、`seriko.alignmenttodesktop`・`seriko.zorder`・`seriko.sticky-window`・`balloon.dontmove`・`sakura.defaultx` など既定の位置 |
| SERIKO | sometimes / rarely / random / periodic / always / runonce / talk / yen-e / never / bind / starttalk / endtalk、overlay・overlay-fast・base・replace・interpolate・reduce・asis・move・start・stop・alternativestart など、`-1` / `-2`、`option,exclusive` (ID 指定可) / `background` / `shared-index`、アニメーションの名前 |
| 着せ替え | `bindgroup` (メニューと `\![bind]`) |
| バルーン | 画像バルーン (`balloons*.png` / `balloonk*.png`、descript と画像ごとの `balloons*s.txt`)、内蔵バルーン、左右の自動切り替え (キャラクターに被らない側)、矢印・クリック待ち・オンライン・SSTP のマーカーと送り主・ファイル数、カーソルとアンカーのマーカー (色・枠・下線)、文字の影・縁取り、縦書き (`vertical,1`)、ドラッグで動かす、拡大率 (シェルと別)、`\![execute,dumpballoon]` |
| さくらスクリプト | `\0 \1 \p \s \i \b \n \n[half] \n[150] \w \_w \__w \_q \_s \c \x \t \e \- \+ \_+ \4 \5 \v \a \q (新旧書式) \__q \_a \f (align・valign・影・縁取り・マーカーの色を含む) \_n \_l \_b (切り抜き・拡大・前面・固定) \& \_u \_m \8 \_v \_V \__v \j \__c \__t \* \_?`、`%` 環境変数 (`%ms` などの言葉を含む)、`%property[]`、音声合成での読み上げ (オプション) |
| `\![...]` | raise / notify / embed / raiseother / notifyother / timerraise / timernotify / timerraiseother / timernotifyother、change・call (random・sequential・lastinstalled)、open (inputbox・passwordinput・textareabox・dateinput・timeinput・sliderinput・ipinput・communicatebox・teachbox・dialog・browser・mailer・file・readme・terms・developer・surfacetest・aigraph・rateofusegraph・backlogviewer・errorlog など) / close、set (balloontimeout・choicetimeout・balloonwait・serikotalk・autoscroll・balloonoffset・balloonalign・balloonmarker・balloonnum・scaling・alpha・position・zorder・sticky-window・alignmenttodesktop・windowstate・property・otherghosttalk・othersurfacechange・syncobject・tasktrayicon・trayballoon) / reset、enter・leave (passivemode・inductionmode・onlinemode・nouserbreakmode・collisionmode)、lock・unlock (repaint・balloonrepaint・balloonmove)、bind / bind-noevent、anim (start・stop・pause・resume・offset・add)、sound (play・loop・load・pause・resume・stop・option・wait)、move / moveasync、wait,syncobject、execute (http-*・rss-*・install・extractarchive・compressarchive・createnar・createupdatedata・dumpsurface・resetwindowpos・resetballoonpos)、get,property / set,property、vanishbymyself、update / updatebymyself、reload / load / unload、quicksection |
| イベント | 起動・終了・切り替え・呼び出し (OnInitialize / OnDestroy / OnCloseAll / OnGhostCalling / OnGhostCallComplete / OnOtherGhostBooted / OnOtherGhostClosed / OnVanished / OnOtherGhostVanished)、マウス (Down / Up / クリック / ダブルクリック / 3回以上 / 中ボタン・戻る・進む (…Ex) / 右ドラッグのジェスチャー / 移動 / 静止 / ホイール / ドラッグ / 当たり判定とキャラクターの出入り。重なったキャラクターはピクセル単位で判定)、キー、OnSecondChange / OnMinuteChange / OnHourTimeSignal、OnSurfaceChange / OnSurfaceRestore / OnOtherSurfaceChange、OnOverlap / OnOffscreen / OnOtherOverlap / OnOtherOffscreen、選択肢・アンカー (Select・Ex・Enter・Hover・タイムアウト)、OnBalloonBreak / OnSSTPBreak / OnBalloonClose / OnBalloonTimeout、入力ボックス (OnUserInput / OnTextAreaInput / OnTeach / OnSystemDialog など)、OnTranslate、OnOtherGhostTalk、シェル・バルーン・着せ替えの変更、OnShellScaling / OnBalloonScaling、OnWindowStateMinimize / Restore、OnResetWindowPos、ファイル・フォルダ・URL・文字のドロップとその既定の処理 (OnPictureViewerOpen など)、音 (OnSoundStop / OnSoundError / OnSoundLoop / OnSoundSpectrum)、HTTP (進捗・ストリーミング)・RSS・iCal・予定表・WebSocket、ネットワーク更新、消滅 (OnVanishButtonHold を含む)、利用条件 (OnGhostTermsAccept / Decline)、OnRaiseOtherFailure / OnNotifyOtherFailure、範囲選択 (OnSelectMode…)、ゴーストキャッシュ (OnCacheSuspend / Restore)、x-ukagaka-link (OnXUkagakaLinkOpen)、ネットワーク・暗い表示・バッテリー・画面の大きさ・ゲームパッド・音声認識と音声合成の状態、トレイの通知、OnRecommendsiteChoice、インストール (Begin / Complete / CompleteEx / CompleteAll / Failure / Refuse)、nar・更新データの作成、起動時の NOTIFY (installedsakuraname・uniqueid・capability・OnNotifySelfInfo・OnLanguageChange・OnNotifyHolidayInfo (日本の祝日)・OnNotifyInternationalInfo・OnNotifyFontInfo など) |
| プロパティ | system.* (ブラウザで分かるもの)、baseware.*、ghostlist / activeghostlist / balloonlist / history / rateofuselist、currentghost.* (scope・shelllist・balloon・status・seriko の cursor・tooltip・surfacelist・sticky-window・zorder・mousecursor・sound)、developer.log。[SET有効] のものは書き込める |
| SSTP | SEND / NOTIFY / COMMUNICATE / EXECUTE / GIVE (下記の開発用 API と postMessage で受ける。ポート 9801 では待てない) |
| 道具 | 開発用パレット、スクリプトを送るボックス、サーフェステスト、スクリプトログ、エラーログ、SHIORI リクエスト、使用率グラフ、AI グラフ、着せ替え一覧、画像ビューア、アーカイブビューア、readme / 利用条件、入力ボックスの候補 (inputbox.autocomplete)、最小化、位置のリセット、最近使ったゴースト |

### SHIORI について

ブラウザでは Windows の DLL をそのまま実行できないので、各 SHIORI のソースを WebAssembly にしたものを `index.html` に組み込んでいます。
ゴーストの `descript.txt` の `shiori` と、ゴーストが同梱している DLL の中身から、どれで動かすかを決めます (`shiori.dll` などに名前を変えてあっても分かります)。
版によって動きが変わった SHIORI は、古い版も組み込んであり、同梱の DLL の版 (ファイルバージョンや DLL の中の版の文字列) で選びます。DLL を同梱していなければ最新の版で動かします。

| SHIORI | DLL | ソース |
|---|---|---|
| YAYA | yaya.dll | [YAYA-shiori/yaya-shiori](https://github.com/YAYA-shiori/yaya-shiori) |
| 文 (AYA5) | aya5.dll | [ponapalt/aya5-shiori](https://github.com/ponapalt/aya5-shiori) |
| 里々 2.x (Unicode 版) | satori.dll | [ukatech/satoriya-shiori](https://github.com/ukatech/satoriya-shiori) (Mc206-4) |
| 里々 1.x | satori.dll (ファイルバージョン 1.x) | [ukatech/satoriya-shiori](https://github.com/ukatech/satoriya-shiori) (Mc172-3。整備班より前の 里々 の DLL も 1.x として扱う) |
| 華和梨 9 (8 の辞書もそのまま読める) | shiori.dll (kawarirc.kis) | [ukatech/kawari](https://github.com/ukatech/kawari) (Phase 9.2.0) |
| 華和梨 7 | shiori.dll (kawari.ini)。SHIORI/2.x で話す | [kawari/kawari7](https://github.com/kawari/kawari7) |
| なし栞 | nashi.dll | [yanashi-interface/nashi-shiori-studio](https://github.com/yanashi-interface/nashi-shiori-studio) |
| minato (Rust) | shiori.dll (talks/main.mnt) | [mizuki-yura/minato](https://github.com/mizuki-yura/minato) (0.3.0。0.2.x・0.1.x の DLL のゴーストは、呼び出し元の let が見える 0.2.2 で動かす) |
| pasta (Rust と Lua) | pasta.dll (pasta.toml) | [ekicyou/pasta](https://github.com/ekicyou/pasta) (LuaJIT の代わりに Lua 5.4 で動かす) |
| emo (Rust と Lua 5.3。pasta の前身) | emo.dll | [ekicyou/emo-rs](https://github.com/ekicyou/emo-rs) (0.5.2) |
| kagari (Lua 5.4。kotori を含む) | kagari.dll | [Tatakinov/kagari_shiori](https://github.com/Tatakinov/kagari_shiori) (ゴーストが同梱する C のモジュールのうち、LPeg は組み込み、lua-utf8・luachild・iconv・rand は作り直したものを使う) |
| quickshiori (QuickJS) | quickshiori.dll | [cronfox/quickshiori](https://github.com/cronfox/quickshiori) |

できないこと:

- **下の表に無い SAORI** (DLL や外部のプログラム) は読めません。呼ぶと失敗として返ります。
- **.NET (dnproxy)・PowerShell (powershiori) の SHIORI** は、ブラウザで動く実行環境が無いので動きません。
- **蒼空 (aosora)** は、ソースの使い方が個人利用に限られている (まだライセンスが決まっていない) ので組み込んでいません。
- **ソースが公開されていない SHIORI** (文 ver.1〜4・美坂・偽栞・此栞・忍・似非shiori・ひとみ。・翡翠・結奈・真絵・透理・灯 など、主に 2001〜2005 年ごろのもの) は、WebAssembly にできないので動きません。
- **別の言語の実行環境を呼ぶ SHIORI** (里珠 (Perl)・PIXY (PHP)・Ruby栞・phiori (Python)) は動きません。
- kagari のゴーストが使う LuaSocket・Lua Lanes は読み込めますが、ソケットはつながらず、別のスレッドの処理 (lane) は動きません。
- 実行ファイルの中にゴーストを書いた SHIORI (Go・Zig などで書いて DLL にしたもの、SHIOLINK から別のプログラムを呼ぶもの) は動きません。
- pasta は LuaJIT の代わりに標準の Lua 5.4 で動かすので、LuaJIT にしか無いもの (`jit`・`ffi`・`bit`) を使う台本は動きません。
- minato が内部でパニックした場合、その SHIORI はそこで止まります (Safari 12 で動かすため、Rust の例外処理を使わずに組んでいます)。

上のどれにも当たらない SHIORI のゴーストは、シェルの表示とメニューだけが使え、起動時にその旨をバルーンで知らせます。
SHIORI のセーブデータは、ゴーストを閉じたとき・ページを閉じたり隠したりしたときに保存します。
SHIORI が応答の `ErrorLevel`・`ErrorDescription` で知らせたエラーはエラーログに書き、error 以上ならゴーストごとに1度通知します。
Windows と同じく、SHIORI・SAORI から見たファイル名は大文字・小文字を区別しません。

組み込んでいる SHIORI・SAORI とライブラリのライセンスは、メニューの「ライセンス」で見られます。

### SAORI について

ゴーストが同梱している SAORI の DLL は、DLL の中身 (書き出し表にある DLL じしんの名前) とファイル名で見分け、
ブラウザで作り直したものに差し替えて呼びます。SHIORI が DLL を開くところ (dlopen・LoadLibrary など) を Engawa が受けるので、
上のどの SHIORI からも、Windows と同じ書き方で呼べます。

本体の内蔵モジュールを DLL なしで呼ぶ SAORI over DirectSSTP (SSP 2.9.13 から) にも答えます (いまは華和梨 9 の `callsaori "internal_…"` から)。
Engawa が持つのは `internal_file` の `MediaInfo` (MP3・WAV・Ogg・FLAC のタグと長さ) と、`internal_system` の `ListModules`・`ListFunctions` で、
`--async=識別子` の結果はイベントで届けます。

WebAssembly にしたもの (ソースからビルドして `index.html` に組み込んでいます):

| SAORI | DLL | ソース |
|---|---|---|
| ssu (里々に付いてくるもの) | ssu.dll | [ukatech/satoriya-shiori](https://github.com/ukatech/satoriya-shiori) |
| timebkn (時刻・旧暦) | timebkn.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| XAORIC (XPath) | xaoric.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| sqlori (SQLite) | sqlori.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| MahjongUtil (麻雀) | MahjongUtil.dll・MahjongUtilCustom.dll | [nikolat/MahjongUtil](https://github.com/nikolat/MahjongUtil) |
| mahjong_nodoka (麻雀) | nodoka.dll | [Tatakinov/mahjong_nodoka](https://github.com/Tatakinov/mahjong_nodoka) |
| connect6_mio (六目並べ) | mio.dll | [Tatakinov/connect6_mio](https://github.com/Tatakinov/connect6_mio) |
| TexasHoldemUtil (ポーカー) | TexasHoldemUtil.dll | [Tatakinov/TexasHoldemUtil](https://github.com/Tatakinov/TexasHoldemUtil) |
| saori_budoux (文の区切り) | budoux.dll | [Tatakinov/saori_budoux](https://github.com/Tatakinov/saori_budoux) |
| saori-calcs (四則演算) | calcs.dll | [tukinami/saori-calcs](https://github.com/tukinami/saori-calcs) |
| saori-japanese-gengou (和暦) | japanesegengou.dll | [tukinami/saori-japanese-gengou](https://github.com/tukinami/saori-japanese-gengou) |
| saori-resized-png (画像の縮小) | resizedpng.dll | [tukinami/saori-resized-png](https://github.com/tukinami/saori-resized-png) |
| saori-resized-png-mini (画像の縮小) | resizedpngmini.dll | [tukinami/saori-resized-png-mini](https://github.com/tukinami/saori-resized-png-mini) |
| saori-pie-chart (円グラフ) | piechart.dll | [tukinami/saori-pie-chart](https://github.com/tukinami/saori-pie-chart) |
| saori-qrcode (QR コード) | saori_qrcode.dll | [nikolat/saori-qrcode](https://github.com/nikolat/saori-qrcode) |
| yaya-as-saori (YAYA を SAORI として使う) | yaya.dll | [YAYA-shiori/yaya-as-saori](https://github.com/YAYA-shiori/yaya-as-saori) (中身は上の YAYA) |
| sqlori-sqlite2 (SQLite 2) | sqlori-sqlite2.dll | [ukatech/csaori](https://github.com/ukatech/csaori) |
| kisaragi (MeCab) | kisaragi.dll | [ukatech/csaori](https://github.com/ukatech/csaori) と [taku910/mecab](https://github.com/taku910/mecab)。辞書 (dic/) はゴーストが同梱したものを使う |
| saori_satori・saori_kawari・saori_yaya (ninix-saori) | 同じ名前 | [Tatakinov/ninix-saori](https://github.com/Tatakinov/ninix-saori)。中身は上の里々・華和梨・YAYA |

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
| chttpc | chttpc.dll | URL・`file:` から取る。translate・strip・start / end・save などのオプション。終わってから知らせる使い方 (hwnd・id) はできないので、その場で返す |
| saori_curl (ninix-saori) | saori_curl.dll | URL から UTF-8 の文字を取る。ゴーストに無くても名前で使える |
| ip.dll (saori_ip)・iptools・uds | ip.dll・iptools.dll・uds.dll | ブラウザから分かることだけ答える (この機械の IP アドレスは 127.0.0.1、whois やダイヤルアップは失敗) |
| FileVersion | FileVersion.dll | ゴーストの中の DLL・EXE のバージョン情報を読む |
| AqTalkSaori | AqTalkSaori.dll | AquesTalk の代わりにブラウザの音声合成で読む (WAV は作れない) |
| MakotoUtil | MakotoUtil.dll | SAORI は待てないので、キーは押されていない・入力ボックスは初期値・メッセージボックスは OK と答える |
| nullsaori・SaoriTest・example (ninix-saori) | nullsaori.dll など | 元と同じ答え |
| mciaudio・mciaudior | mciaudio.dll・mciaudior.dll | 1曲を読み込んで鳴らす (load・play (一時停止と再開)・loop・stop)。mciaudior の construction 7 からの版は、鳴り終わり・繰り返しを OnMAAPlayFinish・OnMAAPlayLoop で知らせる (DLL の版で決める)。MIDI は鳴らない |
| httpc | httpc.dll | 里々の httpc と同じ引数 (先頭の euc・jis・sjis・utf8・erase_tag・translate_tag、URL・保存・前と後で挟んだところ、bg と OnHttpcNotify)。CORS を許すところだけ |
| textcopy・houchi・choice・os_detect | それぞれの DLL | クリップボードに写す・操作していない間 1分ごとに OnHouchi・引数から1つ選ぶ・OS の名前 (Windows と答える) |
| gomi・findwin・cpuusage・HandUtil・process (Tatakinov)・hotkey・screencatch | それぞれの DLL | ごみ箱・ほかのアプリの窓・CPU の負荷・窓のハンドル・子プロセス・全体のホットキー・画面の取り込みは、ブラウザに無いので、元の SAORI の「無い・空・無効・失敗」の答えを返す |
| Windows の機能そのもの (SetCursorPos・Osuwari・screenshot・set_wall_paper・steam_api・tsvnexec・cmdrunner・imoutomessenger・gainer・effect_wrapper・proxy_ex・saori_call_translator) | それぞれの DLL | ブラウザでは行えないので、元の SAORI が「できなかった」ときの答えを返す (ゴーストの台本は止まらない) |

SSP が内蔵している SAORI (clipcopy・textcopy・saori_ip・saori_cpuid・mciaudio・cpuusage・httpc・houchi) は、SSP と同じく、ゴーストが DLL を同梱していなくても名前で使えます。

SAORI について、できないこと・違うこと:

- SAORI は SHIORI と同じ Worker の中で、同期で答えます。ブラウザに聞かないと分からないこと (クリップボード・音) は、答えを待たずにページに頼みます。
- SAORI が書いたファイル (sqlori のデータベース、作った画像など) は、すぐに表示に使え、セーブデータと同じく保存されます。
- SAORI どうしはファイルを分け合わないので、ある SAORI が作った画像を、別の SAORI が続けて読むことはできません。
- saori-pie-chart は字体が無いので、円グラフの文字 (ラベル) を描きません。
- saori-resized-png は、AVIF と OpenEXR の画像を読めません (C のライブラリやスレッドを使うため)。
- saori-japanese-gengou の「今日」は、世界時 (UTC) の日付になります。
- 灯 as SAORI (akari.dll) は、灯の本体のソースが公開されていないので使えません。
- 蒼空を SAORI として使う saori_aosora (ninix-saori) は、上の理由で蒼空を組み込んでいないので使えません。
- ネットワークを使う SAORI (chttpc・httpc・saori_curl・ip.dll) は、相手のサーバーが CORS を許していないと失敗します。
- ソースが無く、画面に描く SAORI (easyballoon (bln.dll)・Weirds・scribble・effect・imgctl・hanayu) と string (りゅう) はまだ作り直していません。
  『盤上の隅っこで』の五目並べ・バックギャモンなどの AI (sharo・kay・cocoa・charlotte) もソースが無いので使えません (六目並べの mio は使えます)。
- 実行ファイルの SAORI (SAORI-basic。parallel.exe・mako.exe など) は、ブラウザではプログラムを起動できないので使えません。
- WebAssembly の SHIORI・SAORI を組み込んだので、`index.html` と `engawa-embed.js` はそれぞれ約 14 MB です。

### プラグインについて

インストールしたプラグイン (PLUGIN/2.0) を読み込み、SSP と同じくイベントを送ります。
プラグインの DLL は SHIORI と同じ形 (load / request / unload) なので、上の SHIORI の仕組みで動かします。
いま使われているプラグインの多くは YAYA の辞書で書かれたもの (YAYA as PLUGIN。スタンプ帳・BalloonSelector など) で、そのまま動きます。
kagari で書いたもの (kagari_as_plugin) も動きます。

- 本体から送るもの: version・installedplugin・installedghostname・installedballoonname・ghostpathlist などの NOTIFY、OnSecondChange (`secondchangeinterval`)、
  OnOtherGhostTalk (`otherghosttalk` の before・after)、OnGhostBoot・OnGhostExit・OnGhostInfoUpdate、メニューの「プラグイン」からの OnMenuExec、OnInstallComplete
- ゴーストから: `\![raiseplugin]`・`\![notifyplugin]`・`\![timerraiseplugin]`・`\![timernotifyplugin]` (送れなければ OnRaisePluginFailure・OnNotifyPluginFailure)、
  SHIORI の installedplugin・pluginpathlist、SSTP の `GetPluginNameList`
- プラグインの応答: Event・EventOption (notify)・Reference・Target (`__SYSTEM_ALL_GHOST__` を含む)・Script・ScriptOption (nobreak・notranslate)・Marker。
  プラグインが出したスクリプトの選択肢・アンカーと、`\![raise]`・`\![notify]`・`\![get,property]` のイベントは、そのプラグインに返します

できないこと:

- Windows の DLL のままのプラグイン (C++ や .NET で書いたもの、棒読みちゃん・Discord などのほかのアプリとつなぐもの) は動きません。メニューには「(動かせません)」と出ます。
- PLUGIN/1.0 (何か・Materia のころの形。いま残っているのは FreeMem くらい) の DLL も動きません。
- プラグインの拡張プロパティ (`pluginlist(…).ext.…` の property.get・property.set) は、プロパティを同期で読むので使えません。

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

ブラウザのコンソールから、前面のゴーストにスクリプトを送れます。`engawa.sstp` は SSTP の要求文を受けて応答文を返します。

```js
engawa.send('\\0\\s[5]こんにちは。\\e');
engawa.raise('OnBoot');
await engawa.sstp('SEND SSTP/1.4\r\nSender: テスト\r\nScript: \\0やあ\\e\r\n\r\n');
```

よそのページやフレームからは `postMessage` で SSTP を送れます。ただし既定では受けず (420 Refuse)、オプションの「よそのページからの SSTP を受ける」を入れたときだけ受けます。
SSP がリモートからの SSTP を制限するのと同じく、よそのページから送られたスクリプトでは、開く・実行する (`\j`・`\![open,…]`・`\![execute,…]`)、ほかのゴーストやイベントを動かす (`\![raise,…]`・`\![change,…]` など)、消滅・更新・設定の変更は使えません。EXECUTE も名前・版・状態とクッキーだけを答えます (クッキーは送り元のオリジンごと)。

```js
engawaWindow.postMessage({ type: 'sstp', id: 1, request: 'NOTIFY SSTP/1.1\r\nSender: アプリ\r\nEvent: OnMusicPlay\r\nReference0: 曲名\r\n\r\n' }, '*');
// 応答は { type: 'sstp-response', id: 1, response: 'SSTP/1.4 200 OK…' } で返ってくる
```

### ブラウザではできないこと

Windows の DLL のままのプラグイン (PLUGIN/1.0 のものを含む) とヘッドラインの実行、FMO、ポート 9801 の SSTP、時計合わせ (SNTP)、メールチェック (biff)、ping・nslookup・filewatch・ごみ箱、壁紙、ほかのアプリのウインドウ (OnOverlap などは起動中のゴーストのキャラクターだけ)、メディアプレーヤーの曲 (OnMusicPlay)、スリープ・ロック・スクリーンセーバー・仮想デスクトップ・CPU やメモリの負荷・デバイスの抜き差し、エディタ・エクスプローラなどほかのアプリを開くこと、CD の再生、`\m` (ウインドウメッセージ)。

違うところ: `\![open,dialog,folder]` は取り消しとして扱い、`\![open,dialog,save]` はダウンロードになります。バッテリーは Chrome など Battery Status API のあるブラウザ、音声認識は Web Speech API のあるブラウザ (Chrome など) だけです。フォントの一覧 (OnNotifyFontInfo) は、よくあるフォントのうち入っているものだけを答えます。iCal・WebSocket も相手が CORS (WebSocket は接続) を許しているときだけです。ゴーストキャッシュにあるゴーストのセーブデータは、ページを閉じる・隠すときに書かれます。

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
