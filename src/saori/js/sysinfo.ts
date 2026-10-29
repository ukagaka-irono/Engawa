import type { SaoriContext, SaoriEnv } from '../context';
import type { JsSaori } from '../host';

/** userAgent から OS の名前と版 (分からなければ <unknown>) */
function osOf(ua: string): { name: string; version: string } {
  const pick = (re: RegExp) => re.exec(ua)?.[1]?.replace(/_/g, '.');
  if (/Windows NT/.test(ua)) return { name: 'Windows', version: pick(/Windows NT ([\d.]+)/) ?? '<unknown>' };
  if (/iPhone|iPad|iPod/.test(ua)) return { name: 'iOS', version: pick(/OS ([\d_]+)/) ?? '<unknown>' };
  if (/Android/.test(ua)) return { name: 'Android', version: pick(/Android ([\d.]+)/) ?? '<unknown>' };
  if (/Mac OS X/.test(ua)) return { name: 'macOS', version: pick(/Mac OS X ([\d_.]+)/) ?? '<unknown>' };
  if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: '<unknown>' };
  if (/Linux/.test(ua)) return { name: 'Linux', version: '<unknown>' };
  return { name: '<unknown>', version: '<unknown>' };
}

/**
 * ccpuid.dll (CSaori。saori_cpuid.dll の代わり)。Argument ごとの問い合わせに Value で答える。
 * ブラウザから分かるのは論理プロセッサの数・おおよそのメモリ・OS だけなので、ほかは <unknown> などを返す。
 */
export function ccpuid(ctx: SaoriContext): JsSaori {
  const answer = (query: string, env: SaoriEnv): string | undefined => {
    const os = osOf(env.userAgent);
    const memory = env.deviceMemory ? String(env.deviceMemory * 1024) : '<unknown>';
    const q = query.toLowerCase();
    if (q === 'platform') return 'Engawa';
    if (q === 'os.name') return os.name;
    if (q === 'os.version') return os.version;
    if (q === 'os.build') return '<unknown>';
    if (q === 'mem.phyt') return memory;
    if (/^mem\.(os|phya|pagt|paga|virt|vira|viraex)$/.test(q)) return '<unknown>';
    if (q === 'cpu.num' || q === 'cpu.logicalprocessors') return String(env.hardwareConcurrency);
    if (q === 'cpu.vender' || q === 'cpu.vendor' || q === 'cpu.name') return '<unknown>';
    if (/^cpu\.(ptype|family|model|stepping|clock|clockex|usage|usage\.history|features|cache)$/.test(q)) return '<unknown>';
    if (/^cpu\.(mmx|sse|sse2|tdn|mmx\+|tdn\+|htt)$/.test(q)) return 'Not Ready';
    if (q === 'cpu.vmguest') return 'No';
    if (q === 'cpu.vmbrand') return 'Not in VM';
    if (/^dmi\.(bios|system|mb|chassis)\.\w+$/.test(q)) return '<empty>';
    return undefined;
  };
  return {
    execute({ args }) {
      const env = ctx.env();
      const values = args.map((a) => answer(a, env) ?? '!param error');
      if (!values.some((v) => !v.startsWith('!'))) return { status: 400, result: 'param error', values };
      return { result: values[0].replace(/^!/, ''), values };
    },
  };
}

/**
 * advanced_sysinfo.dll (CSaori)。特別なフォルダ・ドライブの S.M.A.R.T.・環境変数は、ブラウザには無い。
 * フォルダは 204、ドライブは 0 台、環境変数はそのまま返す。
 */
export function advancedSysinfo(): JsSaori {
  return {
    execute({ args }) {
      const command = (args[0] ?? '').toLowerCase();
      if (command === 'get_drive_info') return args[1] ? { status: 204 } : { result: '0' };
      if (command === 'expand_variable') return args[1] ? { result: args[1] } : { status: 400 };
      if (command === 'get_special_folder_path') return { status: 204 };
      return { status: 400 };
    },
  };
}
