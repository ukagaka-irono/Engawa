import type { SaoriContext } from '../context';
import type { JsSaoriKind } from '../detect';
import type { JsSaori } from '../host';
import { bignum } from './bignum';
import { clipcopy, textcopy2 } from './clipboard';
import { keywordReg } from './keywordreg';
import { playWavSound } from './sound';
import { advancedSysinfo, ccpuid } from './sysinfo';
import { totpSaori } from './totp';
import { getDesktopInfo, windowInfo } from './windows';

/** JavaScript で作り直した SAORI。DLL が開かれるたびに作る */
export const JS_SAORI: Record<JsSaoriKind, (ctx: SaoriContext) => JsSaori> = {
  textcopy2,
  clipcopy,
  playwavsound: playWavSound,
  ccpuid,
  advanced_sysinfo: advancedSysinfo,
  window_info: windowInfo,
  getdesktopinfo: getDesktopInfo,
  bignum,
  totp: totpSaori,
  keywordreg: keywordReg,
};
