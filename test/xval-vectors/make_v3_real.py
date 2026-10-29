#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""造**真音频**的 MusicEx (V3) 测试向量。

为什么需要这个
------------
`make_v3.py` 造的向量正文是伪造的随机字节, 只在「解密算法正确」这一层有效。
但浏览器的 AudioContext 要真的能解码才能转码 —— 随机字节不是合法 Ogg 流,
所以端到端测试 (v3-e2e-harness.js) 会报 "Unable to decode audio data"。

这个脚本用 ffmpeg 生成真 Ogg, 再用 oracle 加密 + 加 musicex footer,
造出「能真解真放」的文件, 供端到端测试用。

前提: ffmpeg 可用 (本机 /usr/bin/ffmpeg)

用法: python3 test/xval-vectors/make_v3_real.py
产出: test/xval-vectors/v3-real-map.mgg / v3-real-rc4.mgg + 对应 ekey + expected
"""
import base64
import importlib.util
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('qmc_ref', os.path.join(HERE, 'qmc_ref.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

EXPECTED_DIRNAME = 'expected'


def make_real_ogg(path):
    """用 ffmpeg 造一段真 Ogg (440Hz 正弦, 2 秒)。"""
    subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
         '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
         '-c:a', 'libvorbis', '-q:a', '3', path],
        check=True,
    )
    with open(path, 'rb') as f:
        return f.read()


def w16(s):
    return s.encode('utf-16-le') + b'\x00\x00'


def make_musicex_footer(song_id, mid, media_filename):
    """按 Rust oracle 的 PcV2MusicEx 布局造 192 字节 footer。

    尾部 16 字节: [payload_len u32 LE][version u32 LE][b'musicex\\0']
    payload_len = 192 (整个 footer 长度)
    inner (176B)  = song_id(4) + quality1(4) + quality2(4)
                     + mid[60] UTF-16LE + filename[100] UTF-16LE
    """
    inner = bytearray(176)
    struct.pack_into('<I', inner, 0, song_id)
    struct.pack_into('<I', inner, 4, 0)   # quality1
    struct.pack_into('<I', inner, 8, 0)   # quality2
    mid_b = w16(mid)
    fn_b = w16(media_filename)
    inner[12:12 + len(mid_b)] = mid_b[:60]
    inner[72:72 + len(fn_b)] = fn_b[:100]

    footer = bytearray(inner)
    footer += struct.pack('<I', 192)   # payload_len
    footer += struct.pack('<I', 1)     # version
    footer += b'musicex\x00'
    assert len(footer) == 192, len(footer)
    return bytes(footer)


def main():
    if not any(os.access(os.path.join(p, 'ffmpeg'), os.X_OK)
               for p in os.environ.get('PATH', '').split(os.pathsep) if p):
        print('需要 ffmpeg, 未找到', file=sys.stderr)
        return 1

    real = os.path.join(HERE, '_real_audio.ogg')
    print('造真 Ogg (ffmpeg) ...', end=' ', flush=True)
    audio = make_real_ogg(real)
    print('%d 字节' % len(audio))

    mid = '0039MnYb0FzMPN'
    filename = '004ZzMIRh1N8WaT.mgg'

    # 用 oracle 造 ekey (让 ekey_decrypt(ekey) == master key)
    def make_v1_ekey_for(cipher_key, header8):
        tea_key = bytearray()
        for sk, hk in zip(q.EKEY_SIMPLE_KEY, header8):
            tea_key.append(sk)
            tea_key.append(hk)
        enc = q.tea_cbc_encrypt(cipher_key[8:], bytes(tea_key), header8[:8])
        return base64.b64encode(header8 + enc).decode()

    for name, n, seed in (('map', 128, 0x61), ('rc4', 512, 0x62)):
        master = bytes(((i * 37 + 11 + seed) & 0xFF) for i in range(n))
        ekey = make_v1_ekey_for(master, master[:8])
        assert q.ekey_decrypt(ekey) == master

        cipher = q.make_qmc2_cipher(master)
        encrypted = cipher.decrypt(audio, 0)

        blob = encrypted + make_musicex_footer(0x1234, mid, filename)

        out = os.path.join(HERE, 'v3-real-%s.mgg' % name)
        with open(out, 'wb') as f:
            f.write(blob)
        with open(os.path.join(HERE, 'ekey-v3-real-%s.txt' % name), 'w') as f:
            f.write(ekey)

        # oracle 基准明文
        plain, ext, log = q.decrypt_qmc_file(blob, ekey_override=ekey, ext_hint='mgg')
        exp_dir = os.path.join(HERE, EXPECTED_DIRNAME)
        os.makedirs(exp_dir, exist_ok=True)
        with open(os.path.join(exp_dir, 'v3-real-%s.plain' % name), 'wb') as f:
            f.write(plain)

        print('  %-8s file=%dB plain=%dB ext=%s head=%s'
              % (name, len(blob), len(plain), ext, plain[:4].hex(' ')))
        for l in log:
            print('      ', l)

    os.remove(real)
    print('完成 —— 端到端测试用 v3-real-{map,rc4}.mgg')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
