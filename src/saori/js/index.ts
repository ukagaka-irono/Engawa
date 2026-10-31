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
import { aqTalk, callTranslator, fileVersion, makotoUtil, ninixExample, nullSaori, saoriTest, unavailable } from './misc';
import { chttpc, httpc, ipTools, saoriCurl, saoriIp, uds } from './net';
import { childProcess, choice, cpuusage, findwin, gomi, handUtil, houchi, osDetect, textcopy } from './classic';
import { mciAudio } from './mciaudio';

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
  curl: saoriCurl,
  chttpc,
  saori_ip: saoriIp,
  iptools: ipTools,
  uds,
  nullsaori: nullSaori,
  saoritest: saoriTest,
  example: ninixExample,
  call_translator: callTranslator,
  fileversion: fileVersion,
  makotoutil: makotoUtil,
  aqtalk: aqTalk,
  setcursorpos: unavailable('SetCursorPos', { status: 204 }),
  osuwari: unavailable('Osuwari', { result: '0' }),
  screenshot: unavailable('screenshot', { status: 500 }),
  set_wall_paper: unavailable('set_wall_paper', { status: 500 }),
  steam_api: unavailable('steam_api', { result: '0' }),
  tsvnexec: unavailable('tsvnexec', { status: 500 }),
  cmdrunner: unavailable('cmdrunner', { status: 500 }),
  imoutomessenger: unavailable('imoutomessenger', { status: 204 }),
  gainer: unavailable('gainer', { status: 500 }),
  effect_wrapper: unavailable('effect_wrapper', { status: 204 }),
  proxy_ex: unavailable('proxy_ex', { result: '' }),
  mciaudio: (ctx) => mciAudio(ctx, false),
  mciaudior: (ctx) => mciAudio(ctx, true),
  httpc,
  gomi,
  findwin,
  cpuusage,
  choice,
  os_detect: osDetect,
  process: childProcess,
  textcopy,
  houchi,
  // Ctrl+Shift+文字を、ほかのアプリを使っている間も受ける。ブラウザでは受けられない
  hotkey: unavailable('hotkey', { status: 204 }),
  screencatch: unavailable('screencatch', { status: 204 }),
  handutil: handUtil,
};
