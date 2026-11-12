#!/usr/bin/env python3
"""
用 GitHub API 重建仓库历史。

为什么不用 git push:
    这台机器直连 github.com 会被 reset, 只能用 API。
    API 的 git database 端点能完整重建历史 (blob -> tree -> commit -> ref)。

用法:
    python3 push_history.py --repo Berg-E5/music-unlock
    python3 push_history.py --repo OWNER/NAME --message "..."
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def _find(name, pats):
    """按给定 glob 模式找可执行文件。

    注意: 这台机器上 shutil.which() 会返回 WindowsApps 里的路径, 那个目录
    权限受限, CreateProcess 会报 PermissionError(WinError 5)。所以必须
    优先用真实安装目录, which 只当最后的兜底。
    """
    import glob as _g
    import shutil as _s
    for pat in pats:
        hits = sorted(_g.glob(pat))
        if hits:
            return hits[-1]
    found = _s.which(name)
    if found and os.path.isfile(found):
        return found
    return name


def _gh_path():
    return _find("gh", [
        os.path.expandvars(r"%LOCALAPPDATA%\hermes\tools\gh-*\bin\gh.exe"),
        r"C:\Program Files\GitHub CLI\gh.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe"),
    ])


GH_BIN = _gh_path()


def _git_path():
    return _find("git", [
        os.path.expandvars(r"%LOCALAPPDATA%\hermes\tools\git-*\cmd\git.exe"),
        r"C:\Program Files\Git\cmd\git.exe",
        r"C:\Program Files\Git\bin\git.exe",
    ])


GIT = _git_path()


def sh(*args, cwd=None):
    return subprocess.run(
        [GIT] + list(args), cwd=cwd, capture_output=True, text=True, errors="replace"
    ).stdout


class GH:
    def __init__(self, token, repo):
        self.token = token
        self.repo = repo
        self.base = f"https://api.github.com/repos/{repo}"
        self.blob_cache = {}

    def call(self, method, path, body=None):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "push-history")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            raise SystemExit(f"!! {method} {path} -> {e.code}\n{detail}")

    def ensure_blob(self, content_bytes):
        """上传 blob, 同内容复用 (GitHub 按 sha 去重, 不用自己算)。"""
        sha = hashlib_sha1_git(content_bytes)
        if sha in self.blob_cache:
            return sha
        r = self.call(
            "POST",
            "/git/blobs",
            {"content": base64.b64encode(content_bytes).decode(), "encoding": "base64"},
        )
        self.blob_cache[r["sha"]] = True
        return r["sha"]


def hashlib_sha1_git(data):
    import hashlib

    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--message", default=None, help="只推这一个 commit (不推历史)")
    ap.add_argument("--local", default=None, help="本地仓库目录, 默认当前目录")
    args = ap.parse_args()

    local = args.local or os.getcwd()
    token = subprocess.run(
        [GH_BIN, "auth", "token"], capture_output=True, text=True, errors="replace"
    ).stdout.strip()
    if not token:
        raise SystemExit("拿不到 gh token")
    gh = GH(token, args.repo)

    if args.message:
        commits = [sh("rev-parse", "HEAD", cwd=local).strip()]
        msg = args.message
    else:
        # 从旧到新
        commits = [
            c
            for c in sh("rev-list", "--reverse", "HEAD", cwd=local).split()
            if c.strip()
        ]
        msg = None

    parent = None
    for i, c in enumerate(commits, 1):
        lines = sh("ls-tree", "-r", "--full-tree", c, cwd=local).splitlines()
        entries = []
        for line in lines:
            parts = line.split()
            if len(parts) < 4 or parts[1] != "blob":
                continue
            mode, _typ, sha, path = parts[0], parts[1], parts[2], parts[3]
            raw = subprocess.run(
                [GIT, "cat-file", "-p", sha], cwd=local, capture_output=True
            ).stdout
            new_sha = gh.ensure_blob(raw)
            entries.append(
                {"path": path, "mode": mode, "type": "blob", "sha": new_sha}
            )
        tree = gh.call("POST", "/git/trees", {"tree": entries})
        commit_msg = msg or sh("log", "-1", "--format=%B", c, cwd=local).strip()
        author = sh("log", "-1", "--format=%an%n%ae%n%aI", c, cwd=local).split("\n")
        body = {
            "message": commit_msg,
            "tree": tree["sha"],
            "parents": [parent] if parent else [],
        }
        if len(author) >= 3 and author[0]:
            body["author"] = {
                "name": author[0],
                "email": author[1],
                "date": author[2],
            }
            body["committer"] = body["author"]
        cm = gh.call("POST", "/git/commits", body)
        parent = cm["sha"]
        print(f"  [{i}/{len(commits)}] {cm['sha'][:10]}  {commit_msg.splitlines()[0][:56]}")

    gh.call("PATCH", "/git/refs/heads/main", {"sha": parent, "force": True})
    print(f"\n完成: https://github.com/{args.repo}/tree/main")
    print(f"  commit: {parent}")
    print(f"  文件数: {len(entries)}")


if __name__ == "__main__":
    main()
