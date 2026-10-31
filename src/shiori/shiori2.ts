/**
 * SHIORI/2.x しか話さない SHIORI (華和梨 7 など) のための読み替え。
 * Engawa は SHIORI/3.0 で要求を作るので、SSP と同じく 2.x の要求にして送り、応答を 3.0 に戻す。
 * 仕様は SHIORI/2.x (http://usada.sakura.vg/contents/shiori.html、ukadoc から参照されているもの)。
 *   イベント (On…)          → GET Sentence SHIORI/2.2 (Event と Reference0〜7)。応答の Sentence が Value
 *   OnCommunicate           → GET Sentence SHIORI/2.3 (Sender・Sentence・Age、Reference2 以降を Reference0 以降へ)
 *   OnTeach                 → TEACH SHIORI/2.4 (Word、Reference1 以降を Reference0 以降へ)
 *   OnTranslate             → TRANSLATE Sentence SHIORI/2.6
 *   version・name・craftman → GET Version SHIORI/2.0 (応答の Version・ID・Craftman)
 *   ownerghostname          → NOTIFY OwnerGhostName SHIORI/2.0 (Ghost)
 *   otherghostname          → NOTIFY OtherGhostName SHIORI/2.3 (GhostEx をゴーストの数だけ)
 *   それ以外の文字列リソース → GET String SHIORI/2.5 (ID)。応答の String が Value
 * 2.x に当たるものが無い NOTIFY は送らない。
 */

/** 応答のどのヘッダを Value にするか */
type ValueHeader = 'Sentence' | 'String' | 'Version' | 'ID' | 'Craftman' | undefined;

export interface Shiori2Request {
  text: string;
  value: ValueHeader;
}

interface Parsed {
  method: string;
  headers: [string, string][];
  get(name: string): string | undefined;
  refs: string[];
}

function parse(text: string): Parsed {
  const lines = text.split('\r\n');
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    const i = line.indexOf(': ');
    if (i > 0) headers.push([line.slice(0, i), line.slice(i + 2)]);
  }
  const refs: string[] = [];
  for (const [k, v] of headers) {
    const m = /^Reference(\d+)$/.exec(k);
    if (m) refs[Number(m[1])] = v;
  }
  return {
    method: (lines[0] ?? '').split(' ')[0],
    headers,
    get: (name) => headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1],
    refs,
  };
}

/** 3.0 の要求を 2.x の要求にする。送らなくてよいものは undefined */
export function toShiori2(text: string): Shiori2Request | undefined {
  const req = parse(text);
  const id = req.get('ID') ?? '';
  const common = ['Sender', 'Charset', 'SecurityLevel']
    .map((k): readonly [string, string | undefined] => [k, req.get(k)])
    .filter((h): h is readonly [string, string] => h[1] !== undefined);
  /** headers に同じ名前があれば、共通のヘッダ (Sender など) よりそちらを使う */
  const build = (first: string, headers: (readonly [string, string | undefined])[], refs: (string | undefined)[] = []): string => {
    const own = new Set(headers.map(([k]) => k));
    const lines = [first, ...[...common.filter(([k]) => !own.has(k)), ...headers].filter((h) => h[1] !== undefined).map(([k, v]) => `${k}: ${v}`)];
    refs.slice(0, 8).forEach((r, i) => r !== undefined && lines.push(`Reference${i}: ${r}`));
    return lines.join('\r\n') + '\r\n\r\n';
  };

  if (req.method === 'NOTIFY') {
    if (id === 'ownerghostname') return { text: build('NOTIFY OwnerGhostName SHIORI/2.0', [['Ghost', req.refs[0] ?? '']]), value: undefined };
    if (id === 'otherghostname') {
      return { text: build('NOTIFY OtherGhostName SHIORI/2.3', req.refs.filter((r) => r !== undefined).map((r) => ['GhostEx', r] as const)), value: undefined };
    }
    return undefined;
  }
  if (id === 'version') return { text: build('GET Version SHIORI/2.0', []), value: 'Version' };
  if (id === 'name') return { text: build('GET Version SHIORI/2.0', []), value: 'ID' };
  if (id === 'craftman' || id === 'craftmanw') return { text: build('GET Version SHIORI/2.0', []), value: 'Craftman' };
  if (id === 'OnCommunicate') {
    // 3.0 の Reference0 は話しかけた相手 (ユーザーは user)、Reference1 が文、Reference2 以降が追加情報
    const sender = req.refs[0] === 'user' || req.refs[0] === undefined ? 'User' : req.refs[0];
    return { text: build('GET Sentence SHIORI/2.3', [['Sender', sender], ['Sentence', req.refs[1] ?? ''], ['Age', req.get('Age')]], req.refs.slice(2)), value: 'Sentence' };
  }
  if (id === 'OnTeach') return { text: build('TEACH SHIORI/2.4', [['Word', req.refs[0] ?? '']], req.refs.slice(1)), value: 'Sentence' };
  if (id === 'OnTranslate') return { text: build('TRANSLATE Sentence SHIORI/2.6', [['Sentence', req.refs[0] ?? '']]), value: 'Sentence' };
  if (id.startsWith('On')) return { text: build('GET Sentence SHIORI/2.2', [['Event', id]], req.refs), value: 'Sentence' };
  return { text: build('GET String SHIORI/2.5', [['ID', id]]), value: 'String' };
}

/** 2.x の応答を 3.0 の応答にする */
export function fromShiori2(text: string, request: Shiori2Request): string {
  const lines = text.split(/\r\n|\n/);
  const status = /^SHIORI\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(lines[0]?.trim() ?? '');
  const res = parse(text);
  const value = request.value ? res.get(request.value) : undefined;
  const code = status ? Number(status[1]) : 500;
  const out = [`SHIORI/3.0 ${code === 200 && !value && request.value ? 204 : code} ${code === 200 && !value && request.value ? 'No Content' : (status?.[2] ?? 'Internal Server Error')}`];
  // 値の入ったヘッダ以外 (Charset・Sender・To・Age・Reference など) はそのまま渡す
  const valueHeaders = new Set(['sentence', 'string', 'version', 'id', 'craftman', 'word', 'status']);
  for (const [k, v] of res.headers) if (!valueHeaders.has(k.toLowerCase())) out.push(`${k}: ${v}`);
  if (value) out.push(`Value: ${value}`);
  return out.join('\r\n') + '\r\n\r\n';
}
