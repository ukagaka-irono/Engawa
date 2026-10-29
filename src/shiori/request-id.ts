export function parseRequestId(text: string): string | undefined {
  const m = /^ID: ?(.*)$/m.exec(text);
  return m ? m[1].trim() : undefined;
}
