/** \![sound] の --seektime。「:」が無ければミリ秒、あれば [[時:]分:]秒[.ミリ秒] (ukadoc)。読めなければ undefined */
export function seekTime(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const t = v.trim();
  if (!t.includes(':')) return Number.isFinite(Number(t)) ? Number(t) : undefined;
  const parts = t.split(':').map(Number);
  if (parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  return Math.round(parts.reduce((sum, n) => sum * 60 + n, 0) * 1000);
}
