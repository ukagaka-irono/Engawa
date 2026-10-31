import { describe, expect, it } from 'vitest';
import { buildPluginRequest, parsePluginResponse } from '../src/plugin/protocol';

describe('PLUGIN/2.0', () => {
  it('要求は SHIORI/3.0 にならい、ゴーストから呼んだときだけ Sender を付ける', () => {
    expect(buildPluginRequest({ method: 'GET', id: 'OnMenuExec', references: ['0\x010', 'テスト'] })).toBe(
      'GET PLUGIN/2.0\r\nID: OnMenuExec\r\nCharset: UTF-8\r\nReference0: 0\x010\r\nReference1: テスト\r\n\r\n',
    );
    expect(buildPluginRequest({ method: 'NOTIFY', id: 'OnStamp', references: ['a\r\nb'], sender: '晶子' })).toBe(
      'NOTIFY PLUGIN/2.0\r\nID: OnStamp\r\nCharset: UTF-8\r\nSender: 晶子\r\nReference0: a\x01b\r\n\r\n',
    );
  });

  it('応答の Event・Reference・Target・Script とオプションを読む', () => {
    const res = parsePluginResponse(
      [
        'PLUGIN/2.0 200 OK',
        'Charset: Shift_JIS',
        'Target: __SYSTEM_ALL_GHOST__',
        'Event: OnResourceLow',
        'EventOption: notify',
        'Reference0: 19',
        'Reference2: 65',
        'Script: \\0すくりぷと\\e',
        'ScriptOption: nobreak, notranslate',
        '',
        '',
      ].join('\r\n'),
    );
    expect(res).toMatchObject({
      status: 200,
      event: 'OnResourceLow',
      eventOption: ['notify'],
      references: ['19', '', '65'],
      target: '__SYSTEM_ALL_GHOST__',
      script: '\\0すくりぷと\\e',
      scriptOption: ['nobreak', 'notranslate'],
    });
    expect(res.headers.get('charset')).toBe('Shift_JIS');
  });

  it('version の Value と、空のヘッダ・壊れた応答', () => {
    expect(parsePluginResponse('PLUGIN/2.0 200 OK\r\nValue: 1.2.3\r\n\r\n').value).toBe('1.2.3');
    const empty = parsePluginResponse('PLUGIN/2.0 204 No Content\r\nScript: \r\n\r\n');
    expect(empty).toMatchObject({ status: 204, script: undefined, event: undefined });
    expect(parsePluginResponse('garbage').status).toBe(500);
  });
});

describe('PLUGIN/2.0 の応答の上限', () => {
  it('途方もない Reference の番号は読まない (ページを止めない)', () => {
    const t0 = performance.now();
    const res = parsePluginResponse('PLUGIN/2.0 200 OK\r\nReference0: a\r\nReference4294967294: x\r\n\r\n');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.references).toEqual(['a']);
  });
});
