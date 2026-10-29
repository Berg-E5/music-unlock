#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""造 TEA-CBC 对拍向量 (JS teaDecryptCBC vs Python oracle)。

背景
----
`modules/crypto-utils.js` 的 `teaDecryptCBC` 之前用 32 轮 TEA, 而 Rust/Oracle
用的是 16 轮 (Tencent tc_tea 变体), 改对之后又暴露出 zero-check 语义偏差。

直接用「人造的 16 字节全零密文」当测试输入是不行的 —— 那不是合法的 TEA-CBC
密文, zero 校验当然过不了。本脚本用 oracle 的 `tea_cbc_encrypt` 造**合法**密文
(header[1] + salt[2] + body + zero pad[7]), 再交给 JS 解, 看能否还原 body。

用法: python3 test/xval-vectors/make_tea_vectors.py
输出: test/xval-vectors/tea-vectors.json
"""
import base64
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('qmc_ref', os.path.join(HERE, 'qmc_ref.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

OUT = os.path.join(HERE, 'tea-vectors.json')


def b64(b):
    return base64.b64encode(bytes(b)).decode()


def main():
    vectors = []

    def add(name, plain, key, salt):
        cipher = q.tea_cbc_encrypt(plain, key, salt)
        vectors.append({
            'name': name,
            'cipher': b64(cipher),
            'key': b64(key),
            'plain': b64(plain),
            'note': 'oracle 造的合法 TEA-CBC 密文',
        })

    # 1) 空 body (最短合法输入)
    add('empty-body', b'', bytes(range(0x10, 0x20)), bytes(range(0x30, 0x3A)))

    # 2) 短 body
    add('short-body', b'hello tea', bytes(range(0x10, 0x20)), bytes(range(0x30, 0x3A)))

    # 3) body 长度跨 8 字节对齐的各个余数 (覆盖 pad_len 0..7)
    for n in range(0, 16):
        body = bytes(((i * 7 + 3) & 0xFF) for i in range(n))
        add('body-len-%d' % n, body,
            bytes(range(0x10, 0x20)), bytes(range(0x30, 0x3A)))

    # 4) 32 字节 body (跨 4 个块)
    add('body-32', bytes(range(32)), bytes(range(0x10, 0x20)), bytes(range(0x30, 0x3A)))

    # 5) 非默认 key (全 0x5A —— 和旧 harness 里那个一样, 但用合法密文)
    add('key-5a', b'zero-check test payload', bytes([0x5A] * 16),
        bytes(range(0x30, 0x3A)))

    with open(OUT, 'w') as f:
        json.dump(vectors, f, indent=1)
    print('造 %d 个 TEA 向量 -> %s' % (len(vectors), OUT))
    for v in vectors[:3]:
        print('  %-14s cipher=%dB plain=%dB' % (
            v['name'],
            len(base64.b64decode(v['cipher'])),
            len(base64.b64decode(v['plain']))))


if __name__ == '__main__':
    main()
