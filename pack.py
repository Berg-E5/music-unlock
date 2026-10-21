#!/usr/bin/env python3
"""
打包发布 music-unlock。

用法:
    python3 pack.py [输出路径]

产出单层 music-unlock/ 前缀的 zip, 并保留 shell 脚本的可执行位。
"""
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "music-unlock-deploy.zip"

# 不进包的东西
SKIP_DIRS = {"__pycache__", "test", ".git", "node_modules", ".pytest_cache"}
SKIP_FILES = {".DS_Store", "pack.py", "*.pyc"}

# 站点部署真正需要的
DEPLOY_ITEMS = [
    "index.html",
    "README.md",
    "install.sh",
    "uninstall.sh",
    "assets",
    "modules",
    "qqmusic-frida.zip",
]
# 附带分发的借壳工具源码 (用户可选, 不参与服务端运行)
EXTRA_ITEMS = ["decrypt_frida.py", "frida_mode"]


def collect() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for item in DEPLOY_ITEMS + EXTRA_ITEMS:
        p = ROOT / item
        if not p.exists():
            print(f"  ! 缺少 {item}, 跳过")
            continue
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and not any(part in SKIP_DIRS for part in f.parts) and f.suffix != ".pyc":
                    files.append(f)
        else:
            files.append(p)
    return files


def main() -> int:
    files = collect()
    total = sum(p.stat().st_size for p in files)

    print(f"打包 {len(files)} 个文件, {total:,} 字节")
    for p in files:
        print(f"  {p.relative_to(ROOT)}  ({p.stat().st_size:,} B)")

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            # 关键: zip 内只留一层 music-unlock/ 前缀
            arcname = f"music-unlock/{p.relative_to(ROOT)}"
            # 保留可执行位, 否则解压后 install.sh 跑不了
            zi = zipfile.ZipInfo(arcname)
            zi.external_attr = (p.stat().st_mode & 0o777) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, p.read_bytes())

    print(f"\n✓ {OUT}  ({OUT.stat().st_size:,} 字节)")

    # 自检: 前缀必须是单层
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
    # 合法: music-unlock/<文件> 或 music-unlock/<目录>/<文件>
    # 异常: music-unlock/music-unlock/... 这类重复前缀
    bad = [n for n in names if n.startswith("music-unlock/music-unlock/")]
    if bad:
        print(f"✗ 前缀异常: {bad[:3]}")
        return 1
    for sh in ("music-unlock/install.sh", "music-unlock/uninstall.sh"):
        if sh not in names:
            print(f"✗ 缺少 {sh}")
            return 1
    print("✓ 结构自检通过 (单层前缀 + 脚本齐全)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())