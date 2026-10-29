#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""造 derived-key 路径的测试向量 + oracle 基准明文。

背景
----
`modules/qmc.js` 的 ekey 路径 (QmcDecryptKey -> makeCipherFromKey) 是
「密钥在文件内, 浏览器直接可解」那条宣传的实现。它有四个独立缺陷
(base64Decode 环境判定 / TEA 轮数 / Map cipher / RC4 cipher), 全部由
本目录的 Python oracle (qmc_ref.py, Rust um_crypto 对拍移植) 定死期望值。

本脚本造 4 个真实文件格式的向量, 每个都带 oracle 解出的明文基准:

  dv-v1embedded   PC v1 Legacy  (Rust: PcV1Legacy)  尾 4B = payload_len LE
  dv-qtag         Android QTag   (Rust: QTag)        尾 4B = payload_len BE
  dv-map120       Map cipher, master 120B (非 128 倍数 -> 旧 JS 公式会分叉)
  dv-rc4          RC4 cipher, master 512B

用法: python3 test/xval-vectors/make_derived.py [输出目录]
"""
import base64
import importlib.util
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('qmc_ref', os.path.join(HERE, 'qmc_ref.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

EXPECTED_DIRNAME = 'expected'


def make_v1_ekey_for(cipher_key: bytes, header8: bytes) -> str:
    """构造 EKey V1, 使 ekey_decrypt(ekey) == cipher_key。

    Rust _ekey_decrypt_v1: decoded = b64decode(ekey); header = decoded[:8];
    cipher = decoded[8:]; tea_key = interleave(simple_key, header);
    plain = tea_cbc_decrypt(cipher, tea_key); 返回 header + plain。
    """
    assert len(cipher_key) > 8 and cipher_key[:8] == header8, 'header8 必须是 cipher_key 前 8 字节'
    tea_key = bytearray()
    for sk, hk in zip(q.EKEY_SIMPLE_KEY, header8):
        tea_key.append(sk)
        tea_key.append(hk)
    salt = header8[:8]
    enc = q.tea_cbc_encrypt(cipher_key[8:], bytes(tea_key), salt)
    return base64.b64encode(header8 + enc).decode()


def make_v2_ekey_for(v1_ekey: str) -> str:
    """构造 EKey V2 (双层 TEA KEY1->KEY2), 解出后应等价于 v1_ekey。"""
    payload = v1_ekey.encode('latin-1')
    payload = q.tea_cbc_encrypt(payload, bytes(q.EKEY_V2_KEY2), bytes(range(0x30, 0x3A)))
    payload = q.tea_cbc_encrypt(payload, bytes(q.EKEY_V2_KEY1), bytes(range(0x20, 0x2A)))
    return q.EKEY_V2_PREFIX.decode() + base64.b64encode(payload).decode()


def audio_payload(n=0x9000):
    """一段跨 0x7FFF 边界、跨 RC4 首段(0x80)与后续段(0x1400)的音频正文。"""
    a = bytearray()
    a += b'OggS\x00\x02' + b'\x00' * 100
    a += b'qmc derived-key vector'
    a += bytes((i * 13 + 5) & 0xFF for i in range(n))
    return bytes(a)


def master_key(n, seed=0x37):
    """确定性的 master key, 前 8 字节当 header。"""
    return bytes(((i * 37 + 11 + seed) & 0xFF) for i in range(n))


def write(outdir, name, blob, plain, ekey=None):
    with open(os.path.join(outdir, name + '.bin'), 'wb') as f:
        f.write(blob)
    exp_dir = os.path.join(outdir, EXPECTED_DIRNAME)
    os.makedirs(exp_dir, exist_ok=True)
    with open(os.path.join(exp_dir, name + '.plain'), 'wb') as f:
        f.write(plain)
    if ekey is not None:
        with open(os.path.join(outdir, name + '.ekey.txt'), 'w') as f:
            f.write(ekey)
    print('  %-14s file=%-7d plain=%-7d ekey=%s' % (
        name, len(blob), len(plain), (ekey[:24] + '...') if ekey else '-'))


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else HERE
    os.makedirs(outdir, exist_ok=True)
    print('造向量 ->', outdir)

    plain = audio_payload()
    print('音频正文 %d 字节 (跨 0x7FFF / 0x1400 边界)' % len(plain))

    # ---------- 1) PC v1 Legacy: [密文][ekey 文本][payload_len u32 LE] ----------
    mk = master_key(128, seed=0x00)
    header8 = mk[:8]
    ekey = make_v1_ekey_for(mk, header8)
    cipher = q.make_qmc2_cipher(mk)
    enc = cipher.decrypt(plain, 0)
    ekey_bytes = ekey.encode('latin-1')
    blob = enc + ekey_bytes + struct.pack('<I', len(ekey_bytes))
    assert q.ekey_decrypt(ekey) == mk, 'V1 ekey 自校验失败'
    write(outdir, 'dv-v1embedded', blob, plain, ekey)

    # ---------- 2) Android QTag: [密文][csv][payload_len u32 BE][b'QTag'] ----------
    mk = master_key(128, seed=0x11)
    header8 = mk[:8]
    ekey = make_v1_ekey_for(mk, header8)
    cipher = q.make_qmc2_cipher(mk)
    enc = cipher.decrypt(plain, 0)
    csv = ('%s,1234567,2' % ekey).encode('utf-8')
    blob = enc + csv + struct.pack('>I', len(csv)) + b'QTag'
    write(outdir, 'dv-qtag', blob, plain, ekey)

    # ---------- 3) Map cipher, master 120B (不是 128 的倍数) ----------
    mk = master_key(120, seed=0x22)
    header8 = mk[:8]
    ekey = make_v1_ekey_for(mk, header8)
    cipher = q.make_qmc2_cipher(mk)
    assert isinstance(cipher, q.QMC2Map), '应走 Map 分支'
    enc = cipher.decrypt(plain, 0)
    ekey_bytes = ekey.encode('latin-1')
    blob = enc + ekey_bytes + struct.pack('<I', len(ekey_bytes))
    write(outdir, 'dv-map120', blob, plain, ekey)

    # ---------- 4) RC4 cipher, master 512B ----------
    mk = master_key(512, seed=0x33)
    header8 = mk[:8]
    ekey = make_v1_ekey_for(mk, header8)
    cipher = q.make_qmc2_cipher(mk)
    assert isinstance(cipher, q.QMC2RC4), '应走 RC4 分支'
    enc = cipher.decrypt(plain, 0)
    ekey_bytes = ekey.encode('latin-1')
    blob = enc + ekey_bytes + struct.pack('<I', len(ekey_bytes))
    write(outdir, 'dv-rc4', blob, plain, ekey)

    # ---------- 5) V2 EKey 包装 (双层 TEA), 解出应与 V1 等价 ----------
    mk = master_key(128, seed=0x44)
    v1 = make_v1_ekey_for(mk, mk[:8])
    v2 = make_v2_ekey_for(v1)
    assert q.ekey_decrypt(v2) == q.ekey_decrypt(v1), 'V2 ekey 应解出同一个 master key'
    cipher = q.make_qmc2_cipher(mk)
    enc = cipher.decrypt(plain, 0)
    ekey_bytes = v2.encode('latin-1')
    blob = enc + ekey_bytes + struct.pack('<I', len(ekey_bytes))
    write(outdir, 'dv-ekeyv2', blob, plain, v2)

    print('全部向量造完, oracle 自校验已过')


if __name__ == '__main__':
    main()
