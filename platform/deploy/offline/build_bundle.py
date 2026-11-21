"""在可联网的机器上构建 KAIP 离线安装包。

用法：python deploy/offline/build_bundle.py [--no-kse] [--platform-image dist/images/kaip-platform-image-1.0.0.tar.gz]
产物：dist/kaip-offline-<版本>-<日期>.tar.gz

内容：
  server/ client/ deploy/ tests/ docs/ README.md   平台与终端程序
  wheels/py3.10 py3.11 py3.12                        Linux x86_64 依赖（manylinux），离线安装免 pip
  runtime/node-win-x64.zip node-linux-x64.tar.gz     供无 Node 终端下载的私有运行时
  python/cpython-3.12-*-install_only_stripped.tar.gz 便携 Python（系统 Python < 3.10 时平台使用，如 Ubuntu 20.04 / CentOS 7）
  kse/                                               KSE 2.2 安装包（可选，许可证另行提供）
  images/kaip-platform-image-*.tar.gz                 平台 Docker 镜像（可选，docker load 后 docker compose up，无需联网构建）
  Dockerfile .dockerignore                           平台镜像构建文件（deploy/docker-compose.yml 使用）
  install-offline.sh  SHA256SUMS  README-OFFLINE.md
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # platform/
REPO = ROOT.parent                                   # 仓库根（含 lite/ 与统一文档）
PROJECT = REPO.parent                                # 存放 KSE 安装包的项目目录
VERSION = "1.0.0"
PYVERS = ["3.10", "3.11", "3.12"]
DEPS = ["fastapi", "uvicorn", "httpx", "python-multipart"]   # uvicorn 不带 [standard]：全部纯 Python 或 manylinux 轮子
# pip download 指定 --python-version 时不会按目标版本求值环境标记（如 anyio 的 exceptiongroup; python_version<"3.11"），需显式补齐
EXTRA = {"3.10": ["exceptiongroup", "tomli", "typing-extensions"]}
NODE_MIRROR = "https://registry.npmmirror.com/-/binary/node"
PBS_API = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
EXCLUDE = {"__pycache__", ".testdata", "node_modules", ".rules-testdata"}


def copytree(src: Path, dst: Path):
    shutil.copytree(src, dst, ignore=lambda d, names: [n for n in names if n in EXCLUDE or n.endswith((".pyc", ".log", "testdata"))])


def fetch(url: str, out: Path):
    print("  下载", url)
    with urllib.request.urlopen(url, timeout=300) as r, open(out, "wb") as f:
        shutil.copyfileobj(r, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-kse", action="store_true", help="不打包 KSE 安装包")
    ap.add_argument("--platform-image", help="平台镜像包（在 Docker 主机上 docker save kaip-platform:<版本> | gzip 生成）")
    ap.add_argument("--no-lite", action="store_true", help="不打包 Lite 网关形态（仅平台形态）")
    ap.add_argument("--reuse-assets", help="复用已有离线包中的 wheels/runtime/python/images/kse 产物（离线重建时使用）")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d")
    name = f"kaip-offline-{VERSION}-{stamp}"
    work = ROOT / "dist" / name
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    print("1/5 复制程序")
    for d in ["server", "client", "deploy", "tests", "mcp-server"]:
        copytree(ROOT / d, work / d)

    # Lite 网关形态（零依赖，仅标准库）：作为离线包的可选部署方式一并提供
    if not args.no_lite:
        copytree(REPO / "lite", work / "lite")
        print("  已包含 lite 网关形态")

    (work / "docs").mkdir()
    for f in (ROOT / "docs").glob("*.docx"):
        shutil.copy2(f, work / "docs" / f.name)
    # 统一文档（验证指南 / 真实环境记录 / API 参考）
    if (REPO / "docs").is_dir():
        copytree(REPO / "docs", work / "docs" / "unified")
    shutil.copy2(ROOT / "README.md", work / "README-PLATFORM.md")
    if (REPO / "README.md").is_file():
        shutil.copy2(REPO / "README.md", work / "README.md")   # 统一入口 README
    shutil.copy2(ROOT / "Dockerfile", work / "Dockerfile")            # docker compose 部署（deploy/docker-compose.yml）
    shutil.copy2(ROOT / ".dockerignore", work / ".dockerignore")
    shutil.copy2(ROOT / "deploy" / "offline" / "install-offline.sh", work / "install-offline.sh")
    shutil.copy2(ROOT / "deploy" / "offline" / "README-OFFLINE.md", work / "README-OFFLINE.md")

    reuse = Path(args.reuse_assets) if args.reuse_assets else None
    if reuse:
        reuse = reuse if reuse.is_absolute() else (Path.cwd() / reuse)
    reuse_ok = bool(reuse and (reuse / "wheels").is_dir())

    print("2/5 下载 Python 依赖（Linux x86_64）")
    for pv in PYVERS:
        d = work / "wheels" / f"py{pv}"
        d.mkdir(parents=True)
        if reuse_ok and (reuse / "wheels" / f"py{pv}").is_dir():
            for w in (reuse / "wheels" / f"py{pv}").glob("*.whl"):
                shutil.copy2(w, d / w.name)
            print(f"  py{pv}: 复用 {len(list(d.glob('*.whl')))} 个 wheel")
            continue
        subprocess.run([sys.executable, "-m", "pip", "download", "-q", "-d", str(d), "--only-binary=:all:",
                        "--platform", "manylinux2014_x86_64", "--platform", "manylinux_2_17_x86_64", "--platform", "any",
                        "--python-version", pv, "--implementation", "cp", *DEPS, *EXTRA.get(pv, [])], check=True)
        print(f"  py{pv}: {len(list(d.glob('*.whl')))} 个 wheel")

    print("3/5 下载 Node.js 运行时")
    rt = work / "runtime"
    rt.mkdir()
    if reuse_ok and (reuse / "runtime" / "node-win-x64.zip").is_file():
        for f in (reuse / "runtime").iterdir():
            if f.is_file():
                shutil.copy2(f, rt / f.name)
        nv = (rt / "NODE_VERSION").read_text(encoding="utf-8").strip()
        print(f"  复用 Node 运行时 {nv}")
    else:
        idx = json.load(urllib.request.urlopen(f"{NODE_MIRROR}/index.json", timeout=60))
        nv = next(x["version"] for x in idx if x["version"].startswith("v22.") and x.get("lts"))
        fetch(f"{NODE_MIRROR}/{nv}/node-{nv}-win-x64.zip", rt / "node-win-x64.zip")
        fetch(f"{NODE_MIRROR}/{nv}/node-{nv}-linux-x64.tar.gz", rt / "node-linux-x64.tar.gz")   # gzip：最小系统也自带（xz 不一定有）
        (rt / "NODE_VERSION").write_text(nv, newline="\n")

    print("3b/5 下载便携 Python 3.12（python-build-standalone）")
    (work / "python").mkdir()
    if reuse_ok and (reuse / "python").is_dir() and any((reuse / "python").iterdir()):
        for f in (reuse / "python").iterdir():
            if f.is_file():
                shutil.copy2(f, work / "python" / f.name)
        print("  复用便携 Python")
    else:
        rel = json.load(urllib.request.urlopen(PBS_API, timeout=60))
        asset = next(a for a in rel["assets"] if a["name"].startswith("cpython-3.12.")
                     and a["name"].endswith("-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"))
        fetch(asset["browser_download_url"], work / "python" / asset["name"])

    if not args.no_kse:
        print("4/5 复制 KSE 安装包")
        kse = sorted(PROJECT.glob("Kaspersky_ScanEngine-Linux-x86_64-*.tar.gz"))
        if kse:
            (work / "kse").mkdir()
            shutil.copy2(kse[-1], work / "kse" / kse[-1].name)
        elif reuse_ok and (reuse / "kse").is_dir():
            (work / "kse").mkdir()
            for f in (reuse / "kse").iterdir():
                if f.is_file():
                    shutil.copy2(f, work / "kse" / f.name)
            print("  复用 KSE 安装包")
        else:
            print("  未找到 KSE 安装包，跳过")

    if args.platform_image:
        img = Path(args.platform_image)
        (work / "images").mkdir()
        shutil.copy2(img, work / "images" / img.name)
        print(f"  平台镜像：{img.name}（{img.stat().st_size / 1048576:.1f} MB）")
    elif reuse_ok and (reuse / "images").is_dir():
        (work / "images").mkdir()
        for f in (reuse / "images").iterdir():
            if f.is_file():
                shutil.copy2(f, work / "images" / f.name)
        print("  复用平台镜像")

    print("5/5 生成校验文件并打包")
    sums = []
    for p in sorted(work.rglob("*")):
        if p.is_file() and p.name != "SHA256SUMS":
            sums.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(work).as_posix()}")
    (work / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8", newline="\n")   # 在 Linux 上校验，必须 LF（Windows 默认会写成 CRLF）
    out = ROOT / "dist" / f"{name}.tar.gz"

    def norm(ti: tarfile.TarInfo):
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = "root"
        if ti.isfile():
            ti.mode = 0o755 if ti.name.endswith((".sh", ".js")) else 0o644
        return ti
    with tarfile.open(out, "w:gz") as t:
        t.add(work, arcname=name, filter=norm)
    print(f"\n完成：{out}（{out.stat().st_size / 1048576:.1f} MB，{len(sums)} 个文件，Node {nv}）")


if __name__ == "__main__":
    main()
