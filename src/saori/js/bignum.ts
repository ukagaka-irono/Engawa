import Decimal from 'decimal.js';
import type { JsSaori } from '../host';

type Fn = (x: Decimal, D: typeof Decimal) => Decimal;

/** 精度 (誤差) を受け取る関数。逆数の三角関数は Windows 版と同じく、もとの関数から作る */
const FUNCTIONS: Record<string, Fn> = {
  sin: (x) => x.sin(),
  cos: (x) => x.cos(),
  tan: (x) => x.tan(),
  arcsin: (x) => x.asin(),
  arccos: (x) => x.acos(),
  arctan: (x) => x.atan(),
  cot: (x, D) => new D(1).div(x.tan()),
  sec: (x, D) => new D(1).div(x.cos()),
  csc: (x, D) => new D(1).div(x.sin()),
  arccot: (x, D) => new D(1).div(x).atan(),
  arcsec: (x, D) => new D(1).div(x).acos(),
  arccsc: (x, D) => new D(1).div(x).asin(),
  sqrt: (x) => x.sqrt(),
};

/** 誤差 eps に見合う小数の桁数 (多すぎる桁は計算が終わらないので 1000 桁まで) */
function placesFor(eps: Decimal): number {
  if (eps.isZero()) return 1000;
  return Math.min(1000, Math.max(0, Math.ceil(-eps.abs().log(10).toNumber())));
}

/** 指数表記にせず、末尾の 0 を除いて書く */
function show(x: Decimal): string {
  if (!x.isFinite()) return '';
  const text = x.toFixed();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * bignum.dll (CSaori)。任意の桁の計算。Argument0 = 演算、Argument1 = a、Argument2 = b。
 *   + - * /                       a と b の四則演算
 *   pi                            誤差 |a| の円周率 (b は使わないが、空ではいけない)
 *   sin cos … sqrt                誤差 |b| での f(a)
 * 誤差が負なら空、読めない数や知らない演算は空の Result を返す。
 */
export function bignum(): JsSaori {
  return {
    execute({ args }) {
      if (args.length < 3 || !args[2]) return { status: 400 };
      const op = args[0].trim().toLowerCase();
      try {
        const a = new Decimal(args[1].trim());
        const b = new Decimal(args[2].trim());
        const digits = (x: Decimal) => x.precision(true) + Math.max(0, x.decimalPlaces());
        if (['+', '-', '*', '/'].includes(op)) {
          const D = Decimal.clone({ precision: Math.max(64, digits(a) + digits(b) + 16) });
          const [x, y] = [new D(a), new D(b)];
          const r = op === '+' ? x.plus(y) : op === '-' ? x.minus(y) : op === '*' ? x.times(y) : x.div(y);
          return { result: show(r) };
        }
        const eps = op === 'pi' ? a : b;
        if (eps.isNegative()) return { result: '' };
        const places = placesFor(eps);
        const D = Decimal.clone({ precision: places + 20 });
        if (op === 'pi') return { result: show(new D(-1).acos().toDecimalPlaces(places)) };
        const fn = FUNCTIONS[op];
        if (!fn) return { result: '' };
        return { result: show(fn(new D(a), D).toDecimalPlaces(places)) };
      } catch {
        return { result: '' };
      }
    },
  };
}
