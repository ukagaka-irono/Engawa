/**
 * Worker の中で import() が使えないブラウザ (Safari 14 以前など) のために、ES モジュールの JS SHIORI を
 * 普通の (async) 関数として動かす。書き換えるのは行頭の export だけ:
 *   export function / async function / function* / class / const / let / var (1つ目の名前) / default / { a, b as c }
 * import 文と export ... from には対応しない (別のファイルは engawa.importModule で読んでもらう)。
 */

const IDENT = '[A-Za-z_$][\\w$]*';

/** モジュールの本文を、export したものを返す関数の本文に書き換える */
export function moduleToFunctionBody(source: string, path: string): string {
  if (new RegExp(`^[ \\t]*import[ \\t]*(?:[\\w*{$]|['"])`, 'm').test(source) || /^[ \t]*export[ \t]*(?:\*|\{[^}]*\}[ \t]*from)/m.test(source)) {
    throw new Error(`${path}: このブラウザでは import 文と export ... from を使えません (engawa.importModule を使ってください)`);
  }
  const exported: [string, string][] = [];
  let body = source;

  // export default function name / class Name → 宣言のまま残し、名前を default にする
  body = body.replace(new RegExp(`^([ \\t]*)export[ \\t]+default[ \\t]+((?:async[ \\t]+)?function\\*?|class)[ \\t]*(${IDENT})?`, 'gm'), (_m, indent: string, kind: string, name?: string) => {
    if (name) {
      exported.push(['default', name]);
      return `${indent}${kind} ${name}`;
    }
    exported.push(['default', '__default']);
    return `${indent}var __default = ${kind} `;
  });
  // export default <式>
  body = body.replace(/^([ \t]*)export[ \t]+default[ \t]+/gm, (_m, indent: string) => {
    exported.push(['default', '__default']);
    return `${indent}var __default = `;
  });
  // export function f / class C / const x
  body = body.replace(
    new RegExp(`^([ \\t]*)export[ \\t]+((?:async[ \\t]+)?function\\*?|class|const|let|var)[ \\t]+(${IDENT})`, 'gm'),
    (_m, indent: string, kind: string, name: string) => {
      exported.push([name, name]);
      return `${indent}${kind} ${name}`;
    },
  );
  // export { a, b as c };
  body = body.replace(/^([ \t]*)export[ \t]*\{([^}]*)\}[ \t]*;?/gm, (_m, indent: string, list: string) => {
    for (const part of list.split(',')) {
      const m = new RegExp(`^\\s*(${IDENT})(?:\\s+as\\s+(${IDENT}))?\\s*$`).exec(part);
      if (m) exported.push([m[2] ?? m[1], m[1]]);
    }
    return indent;
  });

  const result = exported.map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ');
  return `"use strict";\n${body}\n;return { ${result} };`;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => () => Promise<unknown>;

/** 書き換えたモジュールを実行し、export したものを返す (トップレベルの await も使える) */
export function runModuleScript(source: string, path: string): Promise<Record<string, unknown>> {
  try {
    return new AsyncFunction(moduleToFunctionBody(source, path))() as Promise<Record<string, unknown>>;
  } catch (e) {
    return Promise.reject(e);
  }
}
