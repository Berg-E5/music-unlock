#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
qq_ekey.py — QQ 音乐 ekey 提取器 (Windows)

用途
----
QQ 音乐的 musicex (.mgg/.mflac) 加密文件不含密钥, 必须凭会话票据向服务器换。
这个工具从**正在运行的 QQ 音乐客户端**进程内存里读出会话票据
(qm_keyst / qqmusic_key / qqmusic_uin / tmeLoginType), 然后用它换 ekey。

为什么读进程内存而不是让你登录
----------------------------
客户端登录后, cookie 明文躺在它的堆里, 一直用着。你并不需要"再登录一次"
—— 这里只是**把你机器上那个已经登录好的客户端的票据读出来**用。
不注入代码、不打补丁, 进程只以 PROCESS_VM_READ 打开。

用法
----
    python qq_ekey.py                      # 提取票据 + 列出可解的 ekey
    python qq_ekey.py --cookie             # 只打印 Cookie 头 (调试用)
    python qq_ekey.py --files "D:\\Music" # 为目录里的加密文件取 ekey
    python qq_ekey.py --server https://ncm.byberg.store   # 把 ekey 送到站点

前提
----
- Windows
- QQ 音乐客户端已启动且已登录 (不用重新登录)

仅用于你自己合法下载、有权使用的音频文件。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as w
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "qqmusic_session.json")

# ---------------------------------------------------------------------------
# Win32 常量
# ---------------------------------------------------------------------------
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
TH32CS_SNAPPROCESS = 0x00000002
# PAGE_READONLY / PAGE_READWRITE / PAGE_EXECUTE_READ / PAGE_EXECUTE_READWRITE / PAGE_WRITECOPY
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}

# 客户端用 qm_keyst 登录; qqmusic_key 是同一值在网页端的叫法。两者都能当锚点。
NEEDLES = (b"qm_keyst=", b"qqmusic_key=")

# ekey 接口
GATEWAY = "https://u.y.qq.com/cgi-bin/musicu.fcg"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

MUSICEX_MAGIC = b"musicex\x00"
ENCRYPTED_EXT = (".mgg", ".mflac", ".mgg0", ".mgg1", ".mggl",
                 ".mflac0", ".mflac2", ".mmp4")


def _p(*a):
    """ASCII-safe print.

    中文 Windows 控制台是 cp936(GBK), 非 ASCII 输出会抛 UnicodeEncodeError。
    这个坑会让整个脚本静默死掉, 所以所有输出都先过滤成 ASCII。
    """
    s = " ".join(str(x) for x in a)
    try:
        print(s, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(s.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


def _eprint(*a):
    _p("[X]", *a)


# ---------------------------------------------------------------------------
# 进程内存读取
# ---------------------------------------------------------------------------
def _win32():
    """返回 (kernel32, ctypes_last_error)。

    只在 Windows 上真的去加载 kernel32。非 Windows 上返回一个只会抛异常的替身,
    这样本模块在 Linux/macOS 上仍可 import —— 协议构造那部分逻辑是可测试的,
    只有进程内存扫描需要 Windows。
    """
    if sys.platform != "win32":
        raise RuntimeError("这个功能只能在 Windows 上跑 (需要读 QQMusic.exe 进程内存)")
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype = w.HANDLE
    k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    k.CloseHandle.argtypes = [w.HANDLE]
    k.CreateToolhelp32Snapshot.restype = w.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    k.Process32FirstW.argtypes = [w.HANDLE, ctypes.c_void_p]
    k.Process32NextW.argtypes = [w.HANDLE, ctypes.c_void_p]
    k.VirtualQueryEx.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t]
    k.ReadProcessMemory.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                   ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    return k, ctypes.get_last_error


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p),
                ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", w.DWORD),
                ("RegionSize", ctypes.c_size_t),
                ("State", w.DWORD),
                ("Protect", w.DWORD),
                ("Type", w.DWORD)]


def find_pids(name="QQMusic.exe"):
    """所有镜像名匹配的活进程 PID。"""
    pids = []

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD),
                    ("th32ProcessID", w.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
                    ("th32ModuleID", w.DWORD), ("cntThreads", w.DWORD),
                    ("th32ParentProcessID", w.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", w.DWORD), ("szExeFile", w.WCHAR * 260)]

    kernel32, _ = _win32()
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == w.HANDLE(-1).value:
        return pids
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == name.lower():
                pids.append(entry.th32ProcessID)
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return pids


def iter_readable(h):
    """可读且已提交的内存区段。"""
    kernel32, _ = _win32()
    regions, addr, mbi = [], 0, MBI()
    while addr < 0x7FFFFFFF:
        if not kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                       ctypes.sizeof(mbi)):
            break
        base = mbi.BaseAddress or 0
        size = mbi.RegionSize
        if (mbi.State == MEM_COMMIT and size
                and (mbi.Protect & 0xFF) in READABLE
                and not (mbi.Protect & 0x100)):   # 跳过 PAGE_GUARD
            regions.append((base, size))
        addr = base + size
    return regions


def scan(pid):
    """扫进程堆, 抽出 cookie 字段。"""
    kernel32, last_error = _win32()
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        raise RuntimeError(
            "OpenProcess(%d) failed (err=%d). 请用启动 QQ 音乐的那个用户身份运行。"
            % (pid, last_error()))
    fields = {}
    blobs = []
    scanned = 0
    CHUNK = 1 << 20
    OVERLAP = 8192
    rb = ctypes.c_size_t()
    try:
        for base, size in iter_readable(h):
            off = 0
            tail = b""
            while off < size:
                n = min(CHUNK, size - off)
                buf = ctypes.create_string_buffer(n)
                if not kernel32.ReadProcessMemory(h, ctypes.c_void_p(base + off),
                                                 buf, n, ctypes.byref(rb)):
                    break
                data = tail + buf.raw[:rb.value]
                scanned += rb.value
                spans = [i for i in (data.find(nd) for nd in NEEDLES) if i >= 0]
                if spans:
                    lo = max(0, min(spans) - 4096)
                    blobs.append(data[lo:max(spans) + 4096])
                tail = data[-OVERLAP:]
                off += n
    finally:
        kernel32.CloseHandle(h)

    if not blobs:
        raise RuntimeError(
            "PID %d 里没找到会话 cookie。请确认 QQ 音乐已启动并已登录。" % pid)

    joined = b"\x00".join(blobs)
    for m in re.finditer(rb"([A-Za-z_][A-Za-z0-9_]{2,31})=([^\x00;\"'\s<>]{6,2048})", joined):
        k = m.group(1).decode("ascii", "ignore")
        v = m.group(2).decode("utf-8", "replace")
        # 堆里常有截断副本, 取最长的那个
        if len(v) > len(fields.get(k, "")):
            fields[k] = v
    return _normalise(fields, scanned)


def _normalise(raw, scanned):
    """挑出真正有用的字段并校验形状。"""

    def pick(*names, pattern=None, minimum=1):
        best = ""
        for n in names:
            v = raw.get(n, "")
            if pattern and v and not re.fullmatch(pattern, v):
                continue
            if len(v) > len(best):
                best = v
        return best

    uin = pick("qqmusic_uin", "uin", "wxuin", pattern=r"\d{5,12}")
    key = pick("qm_keyst", "qqmusic_key", minimum=40)
    guid = pick("qqmusic_guid", "guid", pattern=r"[0-9A-Fa-f]{32}")
    gkey = pick("qqmusic_gkey", "gkey")
    gtime = pick("qqmusic_gtime", "gtime", pattern=r"\d{9,11}")

    if not uin:
        raise RuntimeError("抽到的 cookie 里没有 uin —— 客户端没登录?")
    if len(key) < 40:
        raise RuntimeError("抽到的 key 像是被截断了 (%d 字符)" % len(key))

    return {
        "uin": uin,
        "guid": guid or _fallback_guid(uin),
        "key": key,
        "gkey": gkey,
        "gtime": gtime,
        "login_type": pick("tmeLoginType", pattern=r"\d{1,2}") or
                      ("2" if key.startswith("Q_H_L") else "1"),
        "harvested_at": int(time.time()),
        "scanned_bytes": scanned,
    }


def _fallback_guid(uin):
    import hashlib
    return hashlib.md5(("qqmusic-ekey:" + uin).encode()).hexdigest().upper()


def cookie_header(session):
    """构造客户端自己发给 u6.y.qq.com 的 Cookie 头。"""
    k, uin = session["key"], session["uin"]
    parts = [
        "qm_keyst=" + k,
        "qqmusic_key=" + k,
        "qqmusic_uin=" + uin,
        "qqmusic_type=1",
        "qqmusic_version=21",
        "qqmusic_miniversion=2",
        "tmeLoginType=" + str(session.get("login_type", "1")),
        "qm_hideuin=" + uin,
        "qm_method=1",
        "qqmusic_guid=" + session["guid"],
    ]
    if session.get("gkey"):
        parts.insert(2, "qqmusic_gkey=" + session["gkey"])
    if session.get("gtime"):
        parts.insert(3, "qqmusic_gtime=" + session["gtime"])
    # HTTP 头是 latin-1, 丢掉堆里带出来的非 ASCII 垃圾
    clean = []
    for item in parts:
        name, _, value = item.partition("=")
        if value and all(ch.isascii() and ch.isprintable() for ch in value):
            clean.append(name + "=" + value)
    return "; ".join(clean)


def harvest(pid=None, save=True):
    """提取会话票据。"""
    pids = [pid] if pid else find_pids()
    if not pids:
        raise RuntimeError("QQMusic.exe 没在运行。先启动并登录 QQ 音乐。")
    last = None
    for p in pids:
        try:
            session = scan(p)
        except Exception as exc:
            last = exc
            continue
        session["pid"] = p
        if save:
            save_session(session)
        return session
    raise last or RuntimeError("没有 QQMusic.exe 进程能读出会话")


def save_session(session, path=CONFIG):
    payload = dict(session)
    payload.pop("scanned_bytes", None)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def load_session(path=CONFIG):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if data.get("uin") and data.get("key") else None


def get_session(force=False, verbose=True):
    if not force:
        cached = load_session()
        if cached:
            return cached
    if verbose:
        _p("[*] 从 QQMusic.exe 读取会话票据 ...")
    session = harvest()
    if verbose:
        _p("[*] uin=%s guid=%s key=%d chars"
            % (session["uin"], session["guid"], len(session["key"])))
    return session


# ---------------------------------------------------------------------------
# musicex 文件解析
# ---------------------------------------------------------------------------
def parse_musicex(path):
    """从 musicex 文件尾部解析出取 ekey 需要的 songmid 与 filename。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 4096))
            tail = fh.read()
    except OSError:
        return None
    if len(tail) < 32:
        return None
    if not tail.endswith(MUSICEX_MAGIC):
        return None
    # 尾部 16 字节: [payload_len u32 LE][version u32 LE]['musicex\0']
    n = len(tail)
    payload_len = int.from_bytes(tail[n - 16:n - 12], "little")
    version = int.from_bytes(tail[n - 12:n - 8], "little")
    if version != 1 or payload_len < 16 or payload_len > n:
        return None
    inner = tail[n - payload_len: n - 16]

    def cstr(buf, off, ln):
        raw = buf[off:off + ln]
        s = raw.decode("utf-16le", errors="ignore")
        return s.split("\x00")[0]

    mid = cstr(inner, 12, 60)
    filename = cstr(inner, 12 + 60, 100)
    if not mid or not filename:
        return None
    return {"songmid": mid, "filename": filename}


def find_encrypted_files(root):
    out = []
    if os.path.isfile(root):
        if root.lower().endswith(ENCRYPTED_EXT):
            out.append(root)
        return out
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith(ENCRYPTED_EXT):
                out.append(os.path.join(dirpath, fn))
    return out


# ---------------------------------------------------------------------------
# 换 ekey
# ---------------------------------------------------------------------------
def fetch_ekey(session, songmid, filename, timeout=20):
    """调 CgiGetEVkey 换 ekey。

    协议逆向自 QQ 音乐 PC 客户端 (QQMusic_Protocol.dll):
      module = music.vkey.GetEVkey, method = CgiGetEVkey
      响应 midurlinfo[].ekey
    comm.authst 就是 qqmusic_key。
    """
    comm = {
        "ct": "19",
        "cv": "1859",
        "uin": str(session["uin"]),
        "authst": session["key"],
        "tmeLoginType": str(session.get("login_type", "1")),
        "format": "json",
        "inCharset": "utf-8",
        "outCharset": "utf-8",
        "notice": 0,
        "platform": "yqq.json",
    }
    param = {
        "filename": [filename],
        "guid": session.get("guid", "10000"),
        "songmid": [songmid],
        "songtype": [1],      # 必须 1, 否则只返回 vkey
        "uin": str(session["uin"]),
        "loginflag": 1,
        "platform": "20",
        "ctx": 1,
    }
    payload = {"comm": comm, "req_1": {
        "module": "music.vkey.GetEVkey", "method": "CgiGetEVkey", "param": param}}

    query = urllib.parse.urlencode({
        "g_tk": "5381",
        "loginUin": str(session["uin"]),
        "hostUin": "0",
        "format": "json",
        "inCharset": "utf8",
        "outCharset": "utf-8",
        "notice": "0",
        "platform": "yqq.json",
        "needNewCode": "0",
        "data": json.dumps(payload, separators=(",", ":")),
    })
    req = urllib.request.Request(
        GATEWAY + "?" + query,
        headers={"User-Agent": UA,
                 "Referer": "https://y.qq.com/",
                 "Cookie": cookie_header(session)})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())

    if body.get("code"):
        raise RuntimeError("musicu.fcg code=%s" % body["code"])
    data = (body.get("req_1") or {}).get("data") or {}
    info = (data.get("midurlinfo") or [{}])[0]
    ekey = info.get("ekey") or ""
    if not ekey:
        raise RuntimeError(
            "没拿到 ekey (result=%s, msg=%s)。常见原因: 票据过期 / 该音质非加密资源 / 无权限"
            % (info.get("result"), str(data.get("msg", ""))[:80]))
    return {"ekey": ekey, "vkey": info.get("vkey", ""),
            "filename": info.get("filename", filename),
            "songmid": info.get("songmid", songmid),
            "purl": info.get("purl", ""),
            "expiration": data.get("expiration", 0)}


def push_to_server(server, session, songmid, filename, timeout=30):
    """把 ekey 通过站点代理取回来 (服务器 IP 拿不到资源, 必须走用户网络)。"""
    url = server.rstrip("/") + "/qq/ekey"
    payload = json.dumps({
        "mid": songmid,
        "filename": filename,
        "uin": session["uin"],
        "authst": session["key"],
        "cookie": cookie_header(session),
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())
    if not body.get("ok"):
        raise RuntimeError(body.get("error", "server error"))
    return body


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="QQ Music ekey extractor")
    ap.add_argument("--pid", type=int, help="指定 QQMusic.exe 的 PID")
    ap.add_argument("--force", action="store_true", help="忽略缓存重新扫")
    ap.add_argument("--cookie", action="store_true", help="只打印 Cookie 头")
    ap.add_argument("--files", help="为指定文件/目录里的加密音乐取 ekey")
    ap.add_argument("--server", help="通过该站点代理取 ekey (如 https://ncm.byberg.store)")
    ap.add_argument("--timeout", type=int, default=20)
    a = ap.parse_args()

    if sys.platform != "win32":
        _eprint("这个工具只能在 Windows 上跑 (要读 QQMusic.exe 进程内存)")
        return 2

    try:
        session = get_session(force=a.force, verbose=not a.cookie)
    except Exception as exc:
        _eprint(exc)
        return 1

    if a.cookie:
        _p(cookie_header(session))
        return 0

    _p("[*] uin=%s  guid=%s  key=%d chars  loginType=%s"
        % (session["uin"], session["guid"], len(session["key"]),
           session.get("login_type")))
    _p("[*] 会话已缓存到 %s" % CONFIG)

    if not a.files:
        _p("[*] 加 --files <路径> 可以为具体的加密音乐取 ekey")
        return 0

    targets = find_encrypted_files(a.files)
    if not targets:
        _eprint("没找到加密音乐文件 (%s)" % ", ".join(ENCRYPTED_EXT))
        return 1

    ok = fail = 0
    for path in targets:
        meta = parse_musicex(path)
        if not meta:
            _p("[ ] 跳过 (不是 musicex 格式): %s" % os.path.basename(path))
            fail += 1
            continue
        try:
            if a.server:
                res = push_to_server(a.server, session, meta["songmid"],
                                     meta["filename"], timeout=a.timeout)
            else:
                res = fetch_ekey(session, meta["songmid"], meta["filename"],
                                 timeout=a.timeout)
            ok += 1
            _p("[+] %s" % os.path.basename(path))
            _p("    ekey: %s" % res["ekey"][:64])
            if a.server:
                _p("    (已通过站点代理取回)")
        except Exception as exc:
            fail += 1
            _p("[X] %s -- %s" % (os.path.basename(path), exc))

    _p("")
    _p("成功 %d, 失败 %d" % (ok, fail))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
