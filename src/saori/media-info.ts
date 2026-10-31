/**
 * 音声ファイルのタグと長さを、再生せずにヘッダとタグだけから読む (SAORI over DirectSSTP の internal_file の MediaInfo)。
 * ukadoc の「MediaInfoを実装するベースウェア向けの注記」のとおり、取れなかった値は空文字にし、独自のキーは返さない。
 * 読む形式: MP3 (ID3v2・ID3v1。長さは Xing / VBRI か固定ビットレート)、WAV (RIFF の fmt・data・LIST INFO)、
 * Ogg (Vorbis・Opus)、FLAC。ほかの形式は Result も値もすべて空。
 */

/** MediaInfo のキー (仕様にあるものだけ) */
const KEYS = ['title', 'artist', 'albumartist', 'album', 'genre', 'comment', 'year', 'track', 'duration', 'width', 'height'] as const;
type Key = (typeof KEYS)[number];

export interface MediaInfo {
  /** 種別 (audio。判別できなければ空) */
  result: string;
  /** keys と同じ順の値 */
  values: string[];
}

interface Parsed {
  kind: '' | 'audio';
  tags: Partial<Record<Key, string[]>>;
  /** 長さ (ミリ秒) */
  duration?: number;
}

export function mediaInfo(data: Uint8Array, keys: string[]): MediaInfo {
  let parsed: Parsed = { kind: '', tags: {} };
  try {
    parsed = parse(data);
  } catch {
    // 壊れたファイルは、読めなかったものとして空で返す
  }
  const values = keys.map((raw) => {
    const key = raw.toLowerCase() as Key;
    if (!KEYS.includes(key)) return '';
    if (key === 'duration') return parsed.duration !== undefined && Number.isFinite(parsed.duration) ? String(Math.round(parsed.duration)) : '';
    if (key === 'width' || key === 'height') return '';
    const list = (parsed.tags[key] ?? []).map((v) => v.trim()).filter(Boolean);
    let value = list.join('; ');
    if (key === 'year') value = /\d{4}/.exec(value)?.[0] ?? '';
    if (key === 'track') value = /^\s*(\d+)/.exec(value)?.[1] ?? '';
    // 値の中の改行は 0x01 にし、NUL は除く
    return value.replace(/\r\n|\r|\n/g, '\x01').replace(/\0/g, '');
  });
  return { result: parsed.kind, values };
}

function parse(d: Uint8Array): Parsed {
  if (ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WAVE') return parseWav(d);
  if (ascii(d, 0, 4) === 'OggS') return parseOgg(d);
  if (ascii(d, 0, 4) === 'fLaC') return parseFlac(d);
  if (ascii(d, 0, 3) === 'ID3' || mpegFrameAt(d, 0)) return parseMp3(d);
  return { kind: '', tags: {} };
}

// ---------------------------------------------------------------- 共通

const ascii = (d: Uint8Array, at: number, n: number) => String.fromCharCode(...d.subarray(at, at + n));
const u32le = (d: Uint8Array, at: number) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
const u32be = (d: Uint8Array, at: number) => ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;
const u16le = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const syncsafe = (d: Uint8Array, at: number) => ((d[at] & 0x7f) << 21) | ((d[at + 1] & 0x7f) << 14) | ((d[at + 2] & 0x7f) << 7) | (d[at + 3] & 0x7f);

function add(tags: Parsed['tags'], key: Key, value: string): void {
  if (value) (tags[key] ??= []).push(value);
}

/** 文字コードの指定の無いタグ (ID3 の ISO-8859-1・ID3v1・WAV の INFO)。日本のファイルは Shift_JIS のことが多いので、読めればそれで */
function legacyText(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  const b = bytes.subarray(0, end);
  if (b.every((c) => c < 0x80)) return String.fromCharCode(...b);
  try {
    return new TextDecoder('shift_jis', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('latin1').decode(b);
  }
}

/** Vorbis comment (Ogg Vorbis・Opus・FLAC の共通のタグ) */
function vorbisComments(d: Uint8Array, at: number, tags: Parsed['tags']): void {
  const vendor = u32le(d, at);
  let p = at + 4 + vendor;
  const n = u32le(d, p);
  p += 4;
  const map: Record<string, Key> = { TITLE: 'title', ARTIST: 'artist', ALBUMARTIST: 'albumartist', 'ALBUM ARTIST': 'albumartist', ALBUM: 'album', GENRE: 'genre', COMMENT: 'comment', DESCRIPTION: 'comment', DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track' };
  for (let i = 0; i < n && p + 4 <= d.length; i++) {
    const len = u32le(d, p);
    const text = new TextDecoder().decode(d.subarray(p + 4, p + 4 + len));
    p += 4 + len;
    const eq = text.indexOf('=');
    const key = map[text.slice(0, eq).toUpperCase()];
    if (eq > 0 && key) add(tags, key, text.slice(eq + 1));
  }
}

// ---------------------------------------------------------------- MP3

function parseMp3(d: Uint8Array): Parsed {
  const tags: Parsed['tags'] = {};
  let start = 0;
  if (ascii(d, 0, 3) === 'ID3') {
    start = 10 + syncsafe(d, 6) + (d[5] & 0x10 ? 10 : 0);
    id3v2(d, tags);
  }
  // ID3v2 が無いか項目が無ければ、末尾の ID3v1
  const v1 = d.length >= 128 && ascii(d, d.length - 128, 3) === 'TAG' ? d.length - 128 : -1;
  if (v1 >= 0 && !Object.keys(tags).length) {
    add(tags, 'title', legacyText(d.subarray(v1 + 3, v1 + 33)));
    add(tags, 'artist', legacyText(d.subarray(v1 + 33, v1 + 63)));
    add(tags, 'album', legacyText(d.subarray(v1 + 63, v1 + 93)));
    add(tags, 'year', legacyText(d.subarray(v1 + 93, v1 + 97)));
    add(tags, 'comment', legacyText(d.subarray(v1 + 97, v1 + 125)));
    if (d[v1 + 125] === 0 && d[v1 + 126]) add(tags, 'track', String(d[v1 + 126]));
  }
  // 最初のフレームを探す (タグの直後とは限らない)
  let at = start;
  while (at + 4 <= d.length && !mpegFrameAt(d, at)) at++;
  const frame = mpegFrameAt(d, at);
  return { kind: frame || Object.keys(tags).length ? 'audio' : '', tags, duration: frame ? mp3Duration(d, at, frame, (v1 >= 0 ? v1 : d.length) - at) : undefined };
}

function id3v2(d: Uint8Array, tags: Parsed['tags']): void {
  const major = d[3];
  const end = Math.min(d.length, 10 + syncsafe(d, 6));
  let p = 10;
  // 拡張ヘッダ
  if (d[5] & 0x40) p += major === 4 ? syncsafe(d, p) : 4 + u32be(d, p);
  const idLen = major === 2 ? 3 : 4;
  const head = major === 2 ? 6 : 10;
  const map: Record<string, Key> = {
    TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumartist', TP2: 'albumartist', TALB: 'album', TAL: 'album',
    TCON: 'genre', TCO: 'genre', COMM: 'comment', COM: 'comment', TYER: 'year', TYE: 'year', TDRC: 'year', TRCK: 'track', TRK: 'track',
  };
  while (p + head <= end) {
    const id = ascii(d, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = major === 2 ? (d[p + 3] << 16) | (d[p + 4] << 8) | d[p + 5] : major === 4 ? syncsafe(d, p + 4) : u32be(d, p + 4);
    const body = d.subarray(p + head, Math.min(end, p + head + size));
    p += head + size;
    const key = map[id];
    if (!key || !body.length) continue;
    // COMM は 言語 (3) と説明 (終端まで) の後ろが本文
    let text = id === 'COMM' || id === 'COM' ? commentText(body) : id3Text(body[0], body.subarray(1));
    // TCON の (13) のような番号は外す
    if (key === 'genre') text = text.replace(/^\(\d+\)/, '');
    for (const v of text.split('\0')) add(tags, key, v);
  }
}

function commentText(body: Uint8Array): string {
  const enc = body[0];
  const rest = body.subarray(4);
  const wide = enc === 1 || enc === 2;
  // 説明の終わり (NUL) を探す
  let i = 0;
  if (wide) {
    while (i + 1 < rest.length && (rest[i] || rest[i + 1])) i += 2;
    i += 2;
  } else {
    while (i < rest.length && rest[i]) i++;
    i += 1;
  }
  return id3Text(enc, rest.subarray(i));
}

function id3Text(enc: number, b: Uint8Array): string {
  // 1 は BOM 付きの UTF-16、2 は BOM 無しの UTF-16BE、3 は UTF-8、0 は ISO-8859-1 (日本のファイルは Shift_JIS のことが多い)
  const text =
    enc === 1
      ? new TextDecoder(b[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(b)
      : enc === 2
        ? new TextDecoder('utf-16be').decode(b)
        : enc === 3
          ? new TextDecoder().decode(b)
          : legacyText(b.indexOf(0) < 0 ? b : b.subarray(0, lastNonNul(b)));
  return text.replace(/^﻿/, '').replace(/\0+$/, '');
}

const lastNonNul = (b: Uint8Array) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return n;
};

interface MpegFrame {
  version: 1 | 2 | 25;
  layer: 1 | 2 | 3;
  bitrate: number;
  rate: number;
  samples: number;
  mono: boolean;
}

const BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function mpegFrameAt(d: Uint8Array, at: number): MpegFrame | undefined {
  if (at + 4 > d.length || d[at] !== 0xff || (d[at + 1] & 0xe0) !== 0xe0) return undefined;
  const v = (d[at + 1] >> 3) & 3;
  const l = (d[at + 1] >> 1) & 3;
  const b = d[at + 2] >> 4;
  const r = (d[at + 2] >> 2) & 3;
  if (v === 1 || l === 0 || b === 0 || b === 15 || r === 3) return undefined;
  const version = v === 3 ? 1 : v === 2 ? 2 : 25;
  const layer = (4 - l) as 1 | 2 | 3;
  const table = version === 1 ? BITRATES[`1-${layer}`] : BITRATES[layer === 1 ? '2-1' : '2-2'];
  const rate = [44100, 48000, 32000][r] / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  return { version, layer, bitrate: table[b] * 1000, rate, samples, mono: (d[at + 3] >> 6) === 3 };
}

/** Xing / Info・VBRI があればフレーム数から、無ければ固定ビットレートとして長さを出す */
function mp3Duration(d: Uint8Array, at: number, f: MpegFrame, bytes: number): number {
  const side = f.version === 1 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17;
  const xing = at + 4 + side;
  const tag = ascii(d, xing, 4);
  if ((tag === 'Xing' || tag === 'Info') && d[xing + 7] & 1) return (u32be(d, xing + 8) * f.samples * 1000) / f.rate;
  if (ascii(d, at + 36, 4) === 'VBRI') return (u32be(d, at + 36 + 14) * f.samples * 1000) / f.rate;
  return (bytes * 8 * 1000) / f.bitrate;
}

// ---------------------------------------------------------------- WAV

function parseWav(d: Uint8Array): Parsed {
  const tags: Parsed['tags'] = {};
  let byteRate = 0;
  let dataSize = 0;
  const info: Record<string, Key> = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre', ICMT: 'comment', ICRD: 'year', ITRK: 'track', IPRT: 'track' };
  for (let p = 12; p + 8 <= d.length; ) {
    const id = ascii(d, p, 4);
    const size = u32le(d, p + 4);
    const body = p + 8;
    if (id === 'fmt ') byteRate = u32le(d, body + 8);
    else if (id === 'data') dataSize = Math.min(size, d.length - body);
    else if (id === 'LIST' && ascii(d, body, 4) === 'INFO') {
      // 大きさはファイルに書かれた値なので、ファイルの終わりを越えて読み続けないようにする
      const end = Math.min(body + size, d.length);
      for (let q = body + 4; q + 8 <= end; ) {
        const sub = ascii(d, q, 4);
        const len = u32le(d, q + 4);
        if (info[sub]) add(tags, info[sub], legacyText(d.subarray(q + 8, Math.min(q + 8 + len, end))));
        q += 8 + len + (len & 1);
      }
    }
    p = body + size + (size & 1);
  }
  return { kind: 'audio', tags, duration: byteRate ? (dataSize * 1000) / byteRate : undefined };
}

// ---------------------------------------------------------------- Ogg (Vorbis・Opus)

/** Ogg のパケット1つの上限 (タグはこれより先を読まない) */
const MAX_PACKET = 4 * 1024 * 1024;

function parseOgg(d: Uint8Array): Parsed {
  const tags: Parsed['tags'] = {};
  // 先頭の数ページのパケットをつなぐ (コメントのパケットは複数のページにまたがることがある)
  const packets: Uint8Array[] = [];
  // 終わらないパケット (区切りが 255 ばかり) で、ファイル全体を写さないように、1つのパケットは MAX_PACKET までにする
  let current: Uint8Array[] = [];
  let currentLength = 0;
  let lastGranule = 0;
  for (let p = 0; p + 27 <= d.length && ascii(d, p, 4) === 'OggS'; ) {
    const granuleLo = u32le(d, p + 6);
    const granuleHi = u32le(d, p + 10);
    if (granuleLo !== 0xffffffff || granuleHi !== 0xffffffff) lastGranule = granuleHi * 2 ** 32 + granuleLo;
    const segs = d[p + 26];
    let body = p + 27 + segs;
    for (let s = 0; s < segs; s++) {
      const len = d[p + 27 + s] ?? 0;
      if (packets.length < 3 && currentLength < MAX_PACKET) {
        const chunk = d.subarray(body, Math.min(body + len, d.length));
        current.push(chunk);
        currentLength += chunk.length;
      }
      body += len;
      if (len < 255 && packets.length < 3) {
        const packet = new Uint8Array(currentLength);
        let at = 0;
        for (const c of current) {
          packet.set(c, at);
          at += c.length;
        }
        packets.push(packet);
        current = [];
        currentLength = 0;
      }
    }
    p = body;
  }
  const head = packets[0];
  if (!head) return { kind: '', tags };
  if (head[0] === 1 && ascii(head, 1, 6) === 'vorbis') {
    const rate = u32le(head, 12);
    const c = packets[1];
    if (c && c[0] === 3 && ascii(c, 1, 6) === 'vorbis') vorbisComments(c, 7, tags);
    return { kind: 'audio', tags, duration: rate ? (lastGranule * 1000) / rate : undefined };
  }
  if (ascii(head, 0, 8) === 'OpusHead') {
    const preSkip = u16le(head, 10);
    const c = packets[1];
    if (c && ascii(c, 0, 8) === 'OpusTags') vorbisComments(c, 8, tags);
    return { kind: 'audio', tags, duration: (Math.max(0, lastGranule - preSkip) * 1000) / 48000 };
  }
  return { kind: '', tags };
}

// ---------------------------------------------------------------- FLAC

function parseFlac(d: Uint8Array): Parsed {
  const tags: Parsed['tags'] = {};
  let duration: number | undefined;
  for (let p = 4; p + 4 <= d.length; ) {
    const last = d[p] & 0x80;
    const type = d[p] & 0x7f;
    const len = (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
    const b = p + 4;
    if (type === 0) {
      const rate = (d[b + 10] << 12) | (d[b + 11] << 4) | (d[b + 12] >> 4);
      const total = (d[b + 13] & 0x0f) * 2 ** 32 + u32be(d, b + 14);
      if (rate) duration = (total * 1000) / rate;
    } else if (type === 4) vorbisComments(d, b, tags);
    if (last) break;
    p = b + len;
  }
  return { kind: 'audio', tags, duration };
}
