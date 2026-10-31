import type { JsSaori } from '../host';

/** SHA-1 (SAORI は同期で答えるので、非同期の WebCrypto は使えない) */
export function sha1(data: Uint8Array): Uint8Array {
  const words = new Uint32Array((((data.length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < data.length; i++) words[i >> 2] |= data[i] << (24 - (i % 4) * 8);
  words[data.length >> 2] |= 0x80 << (24 - (data.length % 4) * 8);
  words[words.length - 1] = data.length * 8;
  words[words.length - 2] = Math.floor((data.length * 8) / 2 ** 32);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[block + t] : rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      const [f, k] =
        t < 20 ? [(b & c) | (~b & d), 0x5a827999] : t < 40 ? [b ^ c ^ d, 0x6ed9eba1] : t < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rotl(a, 5) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
  }
  const out = new Uint8Array(20);
  h.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v >>> 0));
  return out;
}

export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha1(key) : key);
  const pad = (x: number) => {
    const p = new Uint8Array(64 + message.length);
    for (let i = 0; i < 64; i++) p[i] = block[i] ^ x;
    return p;
  };
  const inner = pad(0x36);
  inner.set(message, 64);
  const outer = new Uint8Array(64 + 20);
  outer.set(pad(0x5c).subarray(0, 64));
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error(`base32: ${c}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** RFC 6238 の TOTP (HMAC-SHA1) */
export function totp(key: Uint8Array, unixTime: number, digits: number, period: number): string {
  const counter = new Uint8Array(8);
  const view = new DataView(counter.buffer);
  const steps = Math.floor(unixTime / period);
  view.setUint32(0, Math.floor(steps / 2 ** 32));
  view.setUint32(4, steps >>> 0);
  const mac = hmacSha1(key, counter);
  const offset = mac[19] & 0xf;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

/**
 * totp_saori.dll。
 *   keygen [長さ=30]                              base32 の鍵を作る
 *   totp 鍵 [UNIX 時刻=今] [桁=6] [周期=30]        ワンタイムパスワード
 */
export function totpSaori(): JsSaori {
  return {
    execute({ args }) {
      const command = (args[0] ?? '').toLowerCase();
      if (command === 'keygen') {
        const length = Math.max(1, Math.min(1024, Number(args[1]) || 30));
        const random = crypto.getRandomValues(new Uint8Array(length));
        return { result: Array.from(random, (r) => BASE32[r & 31]).join('') };
      }
      if (command === 'totp') {
        if (!args[1]) return { status: 400 };
        try {
          const now = args[2] ? Number(args[2]) : Date.now() / 1000;
          const digits = Math.max(1, Math.min(9, Number(args[3]) || 6));
          const period = Math.max(1, Number(args[4]) || 30);
          return { result: totp(base32Decode(args[1]), now, digits, period) };
        } catch {
          return { status: 400 };
        }
      }
      return { status: 400 };
    },
  };
}
