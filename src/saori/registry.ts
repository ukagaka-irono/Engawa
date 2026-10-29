import type { EmscriptenFS } from '../shiori/native-engines';
import type { SaoriContext, SaoriEffect, SaoriEnv } from './context';
import { detectSaori } from './detect';
import { fromJs, type SaoriModule, type SaoriResolver } from './host';
import { JS_SAORI } from './js';

/** Worker の中で SAORI を作るのに要るもの */
export interface SaoriServices {
  fs: EmscriptenFS;
  env(): SaoriEnv;
  post(effect: SaoriEffect): void;
  log(message: string): void;
  /** 読み込みのときに用意しておいた WebAssembly の SAORI (DLL のパスごと) */
  prepared?: Map<string, SaoriModule>;
}

/** DLL のパスと中身から、作り直した SAORI を探す */
export function saoriResolver(services: SaoriServices): SaoriResolver {
  return (path, data) => {
    const prepared = services.prepared?.get(path);
    if (prepared) return prepared;
    const kind = detectSaori(path, data);
    const make = kind && (JS_SAORI as Record<string, ((ctx: SaoriContext) => Parameters<typeof fromJs>[0]) | undefined>)[kind];
    if (!make) return undefined;
    const ctx: SaoriContext = {
      fs: services.fs,
      path,
      dir: path.slice(0, path.lastIndexOf('/') + 1),
      env: services.env,
      post: services.post,
      log: services.log,
    };
    return fromJs(make(ctx));
  };
}
