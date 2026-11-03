#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
test_qq_ekey.py — qq_ekey.py 的离线测试

能在 Linux 上跑的部分 (qq_ekey.py 的 Win32 依赖是惰性的, 所以可 import):
  - musicex footer 解析
  - ekey 请求的协议构造 (信封结构 / GET 语义 / songtype=1 / authst 位置)
  - Cookie 头构造

不在这里测: 进程内存扫描 (需要 Windows + 活的 QQMusic.exe)

跑法:  python test/test_qq_ekey.py
"""

import importlib.util
import json
import os
import struct
import sys
import unittest
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET = os.path.join(ROOT, "qq_ekey.py")

_spec = importlib.util.spec_from_file_location("qq_ekey", TARGET)
qq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qq)

MUSICEX_MAGIC = b"musicex\x00"


def build_musicex(mid, filename, song_id=4660, version=1):
    """构造一个最小 musicex footer (布局同真实文件)。"""
    inner = bytearray(12 + 60 + 100)

    def wstr(off, s):
        for i, ch in enumerate(s):
            inner[off + i * 2] = ord(ch) & 0xFF
            inner[off + i * 2 + 1] = ord(ch) >> 8

    inner[0:4] = struct.pack("<I", song_id)
    wstr(12, mid)
    wstr(12 + 60, filename)

    payload_len = len(inner) + 16
    return bytes(inner) + struct.pack("<I", payload_len) + \
        struct.pack("<I", version) + MUSICEX_MAGIC


class TestMusicexParse(unittest.TestCase):
    def _write(self, data, name="x.mgg"):
        path = os.path.join(HERE, name)
        with open(path, "wb") as fh:
            fh.write(b"\x00" * 512)          # 假音频数据
            fh.write(data)
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        return path

    def test_parses_mid_and_filename(self):
        path = self._write(build_musicex("0039MnYb0FzMPN", "004ZzMIRh1N8WaT.mgg"))
        meta = qq.parse_musicex(path)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["songmid"], "0039MnYb0FzMPN")
        self.assertEqual(meta["filename"], "004ZzMIRh1N8WaT.mgg")

    def test_rejects_non_musicex(self):
        path = self._write(b"\x00" * 200)
        self.assertIsNone(qq.parse_musicex(path))

    def test_rejects_wrong_version(self):
        path = self._write(build_musicex("a", "b.mgg", version=2))
        self.assertIsNone(qq.parse_musicex(path))

    def test_missing_file_returns_none(self):
        self.assertIsNone(qq.parse_musicex(os.path.join(HERE, "nope-not-here.mgg")))

    def test_finds_real_vector(self):
        """站点自带的真实 musicex 向量, 用来对拍真实布局。"""
        vec = os.path.join(ROOT, "test", "xval-vectors", "v3-real-map.mgg")
        if not os.path.exists(vec):
            self.skipTest("没有真实向量")
        meta = qq.parse_musicex(vec)
        self.assertIsNotNone(meta)
        self.assertTrue(meta["filename"].endswith(".mgg"))
        self.assertEqual(len(meta["songmid"]), 14)


class TestCookieHeader(unittest.TestCase):
    def test_contains_required_fields(self):
        s = {"uin": "100012345678", "key": "A" * 60, "guid": "F" * 32,
             "gkey": "G" * 10, "gtime": "1700000000", "login_type": "1"}
        c = qq.cookie_header(s)
        self.assertIn("qm_keyst=" + s["key"], c)
        self.assertIn("qqmusic_key=" + s["key"], c)
        self.assertIn("qqmusic_uin=" + s["uin"], c)
        self.assertIn("qqmusic_guid=" + s["guid"], c)
        self.assertIn("tmeLoginType=1", c)
        self.assertIn("qqmusic_gkey=" + s["gkey"], c)

    def test_drops_non_ascii(self):
        s = {"uin": "100012345678", "key": "A" * 60, "guid": "F" * 32,
             "gkey": "中文垃圾", "gtime": "", "login_type": "1"}
        c = qq.cookie_header(s)
        self.assertNotIn("中文", c)
        c.encode("ascii")      # 必须纯 ASCII

    def test_wechat_login_type(self):
        s = {"uin": "100012345678", "key": "Q_H_L" + "B" * 60, "guid": "F" * 32,
             "gkey": "", "gtime": "", "login_type": "2"}
        self.assertIn("tmeLoginType=2", qq.cookie_header(s))


class _FakeResp:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._payload


class TestEkeyRequest(unittest.TestCase):
    """验证发给 musicu.fcg 的请求构造。"""

    def _capture(self, session, songmid, filename, payload):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["headers"] = dict(req.header_items())
            return _FakeResp(payload)

        orig = urllib.request.urlopen
        urllib.request.urlopen = fake_urlopen
        try:
            res = qq.fetch_ekey(session, songmid, filename)
        finally:
            urllib.request.urlopen = orig
        return captured, res

    def test_request_shape(self):
        session = {"uin": "100012345678", "key": "Q_H_L" + "B" * 60,
                   "guid": "F" * 32, "gkey": "", "gtime": "", "login_type": "2"}
        ok_payload = {"code": 0, "req_1": {"data": {
            "midurlinfo": [{"ekey": "EK", "vkey": "VK",
                            "filename": "004ZzMIRh1N8WaT.mgg",
                            "songmid": "0039MnYb0FzMPN"}],
            "expiration": 80400}}}
        cap, res = self._capture(session, "0039MnYb0FzMPN",
                                 "004ZzMIRh1N8WaT.mgg", ok_payload)

        # GET, JSON 放 query string
        self.assertIn("?g_tk=", cap["url"])
        self.assertIn("&data=", cap["url"])

        qs = urllib.parse.parse_qs(cap["url"].split("?", 1)[1])
        payload = json.loads(qs["data"][0])

        comm = payload["comm"]
        self.assertEqual(comm["authst"], session["key"])
        self.assertEqual(str(comm["uin"]), session["uin"])
        self.assertEqual(comm["tmeLoginType"], "2")
        self.assertEqual(comm["ct"], "19")
        self.assertEqual(comm["cv"], "1859")

        req = payload["req_1"]
        self.assertEqual(req["module"], "music.vkey.GetEVkey")
        self.assertEqual(req["method"], "CgiGetEVkey")
        p = req["param"]
        self.assertEqual(p["songtype"], [1])      # 必须 1, 否则只返回 vkey
        self.assertEqual(p["filename"], ["004ZzMIRh1N8WaT.mgg"])
        self.assertEqual(p["songmid"], ["0039MnYb0FzMPN"])
        self.assertEqual(str(p["uin"]), session["uin"])

        ck = cap["headers"].get("Cookie", "")
        self.assertIn("qm_keyst=", ck)

        self.assertEqual(res["ekey"], "EK")
        self.assertEqual(res["expiration"], 80400)

    def test_raises_when_no_ekey(self):
        session = {"uin": "1", "key": "A" * 60, "guid": "F" * 32,
                   "gkey": "", "gtime": "", "login_type": "1"}
        payload = {"code": 0, "req_1": {"data": {
            "midurlinfo": [{"ekey": "", "result": 101404}],
            "msg": "must request encrypted file"}}}

        orig = urllib.request.urlopen
        urllib.request.urlopen = lambda req, timeout=None: _FakeResp(payload)
        try:
            with self.assertRaises(RuntimeError) as cm:
                qq.fetch_ekey(session, "m", "f.mgg")
            self.assertIn("ekey", str(cm.exception).lower())
        finally:
            urllib.request.urlopen = orig

    def test_raises_on_top_level_error(self):
        session = {"uin": "1", "key": "A" * 60, "guid": "F" * 32,
                   "gkey": "", "gtime": "", "login_type": "1"}
        payload = {"code": 500001, "ts": 1}

        orig = urllib.request.urlopen
        urllib.request.urlopen = lambda req, timeout=None: _FakeResp(payload)
        try:
            with self.assertRaises(RuntimeError) as cm:
                qq.fetch_ekey(session, "m", "f.mgg")
            self.assertIn("500001", str(cm.exception))
        finally:
            urllib.request.urlopen = orig


class TestFindEncryptedFiles(unittest.TestCase):
    def test_finds_by_extension(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            for name in ("a.mgg", "b.mflac", "c.mp3"):
                with open(os.path.join(d, name), "wb") as fh:
                    fh.write(b"x")
            found = qq.find_encrypted_files(d)
            names = sorted(os.path.basename(f) for f in found)
            self.assertEqual(names, ["a.mgg", "b.mflac"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
