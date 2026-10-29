// ゆかりとちゅん — Engawa のサンプルゴースト用 SHIORI (JavaScript)
//
// Engawa は ghost/master/descript.txt の `shiori,shiori.js` を見て、このファイルを
// Web Worker 内の ES モジュールとして読み込みます。export するのは次の3つです。
//   load(dir)       起動時
//   request(text)   SHIORI/3.0 の要求文字列を受け取り、応答文字列を返す (Promise 可)
//   unload()        終了時
// ファイルの読み書きは globalThis.engawa (readText / writeText など) で行えます。

const CRLF = '\r\n';
const raw = String.raw;

const save = {
  userName: '',
  talkInterval: 90,
  nade: 0,
  talks: 0,
};

let secondsSinceTalk = 0;

function parse(text) {
  const lines = text.split(CRLF);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(': ');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 2);
  }
  return {
    method: lines[0].split(' ')[0],
    id: headers.ID ?? '',
    ref: (n) => headers[`Reference${n}`] ?? '',
  };
}

function respond(value) {
  if (!value) return ['SHIORI/3.0 204 No Content', 'Charset: UTF-8', 'Sender: yukari', '', ''].join(CRLF);
  return ['SHIORI/3.0 200 OK', 'Charset: UTF-8', 'Sender: yukari', `Value: ${value}`, '', ''].join(CRLF);
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const you = () => save.userName || 'あなた';

function persist() {
  globalThis.engawa.writeText('save.json', JSON.stringify(save));
}

export function load() {
  const text = globalThis.engawa.readText('save.json');
  if (text) {
    try {
      Object.assign(save, JSON.parse(text));
    } catch {
      // 壊れていたら初期値のまま
    }
  }
}

export function unload() {
  persist();
}

// ---------------------------------------------------------------- 会話

const randomTalks = [
  () => raw`\0\s[0]縁側って、日なたと日かげの境目にあるんだよ。\w9\n\s[6]どっちにも行けるの、いいでしょ。\1\s[10]ちゅんは日なた派。\e`,
  () => raw`\0\s[5]ねえ${you()}、\w4お茶いれてきてもいい？\w9\1\s[12]ゆかりは猫舌でしょ。\w6\0\s[3]……冷ましてから飲むもん。\e`,
  () => raw`\1\s[10]ねえゆかり、\w4ここってブラウザの中なんだって。\w9\0\s[2]えっ。\w6\s[3]じゃあ、外には出られないの？\w9\1\s[11]タブを閉じなければ平気だよ。\e`,
  () => raw`\0\s[6]ぽかぽか……\w9\w9\s[0]あ、\w4寝てないよ。\e`,
  () => raw`\0\s[0]右クリックするとメニューが出るよ。\w9\n着せ替えもできるんだって。\1\s[11]麦わら帽子が似合うよ。\e`,
  () => raw`\1\s[10]ゆかりの好きなものってなに？\w9\0\s[5]かつおぶし！\w6\n\s[1]……と、${you()}。\1\s[11]ちゅん。\e`,
  () => raw`\0\s[0]ゴーストの .nar ファイルを画面に落とすと、\w4お友だちが増えるよ。\w9\1\s[10]SHIORI が JavaScript なら、ちゃんとおしゃべりできるんだ。\e`,
  () => raw`\0\s[3]最近、\w4すずめが増えた気がする……\w9\1\s[12]ちゅん？\w6\0\s[0]ちゅんのことじゃないよ。\e`,
  () => raw`\1\s[10]今は%hour時%minute分だよ。\w9\0\s[0]時間、ちゃんと見てるんだね。\e`,
  () => raw`\0\s[0]頭をなでてくれると、\w4\s[1]ちょっとうれしいかも。\e`,
];

function menu() {
  return (
    raw`\0\s[0]なあに？\n\n[half]` +
    raw`\q[なにか話して,talk]\n` +
    raw`\q[名前を教える,name]\n` +
    raw`\q[しゃべる頻度,OnFreqMenu]\n` +
    raw`\q[Engawa について,about]\n\n[half]` +
    raw`\q[なんでもない,cancel]\e`
  );
}

function freqMenu() {
  const opt = (label, sec) => raw`\q[${sec === save.talkInterval ? '● ' : '　'}${label},OnFreqSet,${sec}]\n`;
  return (
    raw`\0\s[0]どのくらいおしゃべりする？\n\n[half]` +
    opt('よく話す (30秒)', 30) +
    opt('ふつう (90秒)', 90) +
    opt('たまに (3分)', 180) +
    opt('静かにしてる', 0) +
    raw`\e`
  );
}

function communicate(text) {
  const t = text.trim();
  if (/おはよう/.test(t)) return raw`\0\s[5]おはよう、${you()}！\e`;
  if (/こんにちは|こんにちわ/.test(t)) return raw`\0\s[0]こんにちは。\w4いい天気だね。\e`;
  if (/こんばんは/.test(t)) return raw`\0\s[6]こんばんは。\w4夜の縁側も好き。\e`;
  if (/かわいい|可愛い/.test(t)) return raw`\0\s[1]えへへ……\w6\1\s[11]照れてる照れてる。\e`;
  if (/好き|すき/.test(t)) return raw`\0\s[1]ゆかりも、\w4${you()}のこと好きだよ。\e`;
  if (/ありがとう/.test(t)) return raw`\0\s[5]どういたしまして！\e`;
  if (/ちゅん/.test(t)) return raw`\1\s[12]呼んだ？\e`;
  if (/ばいばい|さようなら|またね/.test(t)) return raw`\0\s[4]もう行っちゃうの？\e`;
  return pick([
    raw`\0\s[0]「${t.replace(/[\\[\]]/g, '')}」？\w6\s[3]うーん、\w4むずかしいなあ。\e`,
    raw`\0\s[0]ふむふむ。\w6\1\s[10]ゆかり、わかってないでしょ。\w6\0\s[7]わかってるもん！\e`,
  ]);
}

const events = {
  // リソース
  version: () => 'Engawa sample 1.0',
  username: () => save.userName,
  'sakura.recommendsites': () => ['Engawa (GitHub)', 'https://github.com/ukagaka-irono/Engawa'].join('\x01'),

  OnFirstBoot: () =>
    raw`\0\s[2]……あれ？\w9\s[0]ここ、\w4新しいおうち？\w9\n\1\s[10]ブラウザの中みたいだよ。\w9\0\s[5]` +
    raw`はじめまして、\w4ゆかりです。\w6\n\1\s[11]ちゅんです。\w9\0\s[0]\n\nダブルクリックでお話しできるよ。\e`,
  OnBoot: () =>
    pick([
      raw`\0\s[5]おかえり、${you()}。\1\s[10]ちゅん。\e`,
      raw`\0\s[0]今日も縁側日和だね。\w6\1\s[11]ちゅんちゅん。\e`,
      raw`\0\s[6]ふわぁ……\w9\s[0]あ、\w4${you()}。\w4いらっしゃい。\e`,
    ]),
  OnClose: () => raw`\0\s[6]それじゃあ、\w4またね。\w9\1\s[11]ちゅん！\w9\-`,
  OnGhostChanging: (r) => raw`\0\s[0]${r(0)}さんによろしくね。\w9\-`,
  OnGhostChanged: (r) => raw`\0\s[0]${r(0)}さんと交代したよ。\w6\1\s[10]ちゅん。\e`,
  OnGhostCalled: () => raw`\0\s[2]呼んだ？\w6\s[0]\1\s[10]おじゃまします。\e`,
  OnOtherGhostBooted: (r) => raw`\0\s[2]あ、\w4${r(0)}さんだ。\w6\s[5]こんにちは！\e`,
  OnShellChanged: (r) => raw`\0\s[0]どう？\w4「${r(0)}」になってみたよ。\e`,
  OnDressupChanged: (r) =>
    r(0) === '0' ? (r(2) === '1' ? raw`\0\s[5]${r(1)}、\w4似合う？\e` : raw`\0\s[0]${r(1)}、\w4外したよ。\e`) : '',
  OnBalloonChange: (r) => raw`\0\s[0]バルーンを「${r(0)}」にしたよ。\e`,
  OnInstallComplete: (r) => raw`\0\s[5]「${r(1)}」が届いたよ。\e`,

  OnMouseDoubleClick: (r) => {
    if (r(3) === '1') return pick([raw`\1\s[12]ちゅっ！？\w6\s[10]つつかないでよ。\e`, raw`\1\s[11]ちゅんちゅん♪\e`]);
    if (r(4) === 'Belly') return raw`\0\s[7]おなかはだめ！\e`;
    if (r(4) === 'Tail') return raw`\0\s[2]しっぽ！\w6\s[3]しっぽはデリケートなの……\e`;
    return menu();
  },
  OnMouseMove: (r) => {
    if (r(3) !== '0' || r(4) !== 'Head') return '';
    save.nade++;
    if (save.nade < 24) return '';
    save.nade = 0;
    return pick([raw`\0\s[1]ん……\w6\s[6]ごろごろ……\e`, raw`\0\s[5]なでなでされちゃった。\e`]);
  },
  OnMouseWheel: (r) => (r(3) === '0' && r(4) === 'Tail' ? raw`\0\s[2]しっぽで遊ばないで！\e` : ''),

  OnChoiceSelect: (r) => {
    switch (r(0)) {
      case 'talk':
        return pick(randomTalks)();
      case 'name':
        return raw`\0\s[0]${you()}のこと、\w4なんて呼べばいい？\![open,inputbox,OnNameInput,-1]\e`;
      case 'about':
        return (
          raw`\0\s[0]Engawa は、\w4ブラウザで動く伺かのベースウェアだよ。\w9\n` +
          raw`\1\s[10]SSP みたいに、\w4シェルやバルーンを読んで動くんだ。\w9\0\n\n[half]\_a[https://github.com/ukagaka-irono/Engawa]ソースコード\_a\e`
        );
      default:
        return raw`\0\s[0]うん、\w4またね。\e`;
    }
  },
  OnFreqMenu: () => freqMenu(),
  OnFreqSet: (r) => {
    save.talkInterval = Number(r(0)) || 0;
    persist();
    return save.talkInterval ? raw`\0\s[5]わかった、\w4そのくらい話すね。\e` : raw`\0\s[6]しばらく静かにしてるね。\e`;
  },
  OnChoiceTimeout: () => raw`\0\s[3]……決まらないみたいだね。\e`,

  // \![open,inputbox,OnNameInput,…] の ID が On で始まるので、そのイベントが Reference0 = 入力文字列で来る
  OnNameInput: (r) => {
    const name = r(0).trim().replace(/[\\[\]%]/g, '');
    if (!name) return raw`\0\s[3]うーん、\w4空っぽだよ。\e`;
    save.userName = name;
    persist();
    return raw`\0\s[5]${name}だね。\w4おぼえたよ！\e`;
  },
  OnUserInputCancel: (r) => (r(1) === 'timeout' ? raw`\0\s[3]……時間切れ。\w4また今度教えてね。\e` : raw`\0\s[0]また今度教えてね。\e`),
  OnGhostCallComplete: (r) => raw`\0\s[5]${r(0)}さん、\w4来てくれたね。\e`,
  OnOtherGhostClosed: (r) => raw`\0\s[0]${r(0)}さん、\w4またね。\e`,
  OnCommunicate: (r) => communicate(r(1)),

  OnKeyPress: (r) => {
    if (r(0) === 't') return pick(randomTalks)();
    if (r(0) === 'f1') return raw`\0\s[0]ダブルクリックでメニュー、\w4右クリックでベースウェアのメニューだよ。\e`;
    return '';
  },

  OnSecondChange: (r) => {
    secondsSinceTalk++;
    if (r(3) !== '1') return '';
    if (!save.talkInterval || secondsSinceTalk < save.talkInterval) return '';
    secondsSinceTalk = 0;
    save.talks++;
    if (save.talks % 10 === 0) persist();
    return pick(randomTalks)();
  },
  OnMinuteChange: () => {
    const now = new Date();
    if (now.getMinutes() !== 0) return '';
    secondsSinceTalk = 0;
    return raw`\0\s[5]${now.getHours()}時になったよ。\1\s[11]ちゅん、\w4ちゅん。\e`;
  },
  OnSurfaceRestore: () => raw`\0\s[0]\1\s[10]\e`,
};

export function request(text) {
  const req = parse(text);
  const handler = events[req.id];
  if (!handler) return respond('');
  try {
    return respond(handler(req.ref));
  } catch (e) {
    globalThis.engawa.log(`${req.id}: ${e}`);
    return respond('');
  }
}
