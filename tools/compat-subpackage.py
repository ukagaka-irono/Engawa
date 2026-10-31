# compat-check.mjs から使う。リポジトリの zip の中で、install.txt が type,ghost のいちばん浅いフォルダを
# 取り出して別の zip にする (ゴーストが一番上に無いソースのリポジトリ用)。
#   python -I tools/compat-subpackage.py 元.zip 先.zip   → 取り出したフォルダを出力 (無ければ何も出さない)
import re
import sys
import zipfile

src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    names = z.namelist()
    found = []
    for n in names:
        if n.lower().endswith('/install.txt') or n.lower() == 'install.txt':
            text = z.read(n).decode('utf-8', 'replace') if z.getinfo(n).file_size < 65536 else ''
            if re.search(r'^\s*type\s*,\s*ghost\s*$', text, re.I | re.M):
                found.append(n[: -len('install.txt')])
    if not found:
        sys.exit(0)
    base = min(found, key=lambda p: (p.count('/'), p))
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as out:
        for n in names:
            if n.startswith(base) and not n.endswith('/') and n != base:
                out.writestr(n[len(base):], z.read(n))
    print(base)
