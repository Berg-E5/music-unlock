#!/usr/bin/env python3
"""用 Python 参考实现造 V3 MusicEx 测试文件, 供 JS 实现交叉验证。"""
import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location(
    'qmc_ref', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qmc_ref.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def build_musicex_footer(mid: str, media_filename: str) -> bytes:
    """构造 0xC0 payload + version(4 LE) + b'musicex\\0'。"""
    inner = bytearray(0xB0)  # payload_len - 0x10 = 0xB0
    def w16(off, s, n):
        b = (s.encode('utf-16-le')[:n-2] + b'\x00\x00').ljust(n, b'\x00')
        inner[off:off+n] = b
    w16(12, mid, 60)
    w16(72, media_filename, 100)
    payload_len = 0xC0
    # data = inner + payloadLen(4 LE)
    data = bytes(inner) + struct.pack('<I', payload_len)
    version = struct.pack('<I', 1)
    return data + version + b'musicex\x00'


def make_v1_ekey_for(cipher_key: bytes, header8: bytes = bytes(range(0x10, 0x18))) -> str:
    """构造 EKey V1, 使 ekey_decrypt(ekey) 恰好等于 cipher_key。

    参考实现 _ekey_decrypt_v1 返回 header + plain, 整段就是 master key。
    所以 header8 必须等于 cipher_key 的前 8 字节, TEA 明文是 cipher_key[8:]。
    """
    assert len(cipher_key) > 8 and cipher_key[:8] == header8, 'header8 必须等于 cipher_key 前 8 字节'
    tea_key = bytearray()
    for sk, hk in zip(q.EKEY_SIMPLE_KEY, header8):
        tea_key.append(sk); tea_key.append(hk)
    salt = header8[:8]
    enc = q.tea_cbc_encrypt(cipher_key[8:], bytes(tea_key), salt)
    import base64
    return base64.b64encode(header8 + enc).decode()


def encrypt_audio(plain: bytes, master_key: bytes) -> bytes:
    cipher = q.make_qmc2_cipher(master_key)
    # QMC2Map/RC4 都是对称 XOR 流: encrypt == decrypt
    return cipher.decrypt(plain, 0)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)
    mid = '0039MnYb0FzMPN'
    fname = '004ZzMIRh1N8WaT.mgg'

    for name, mkey in [
        ('map', bytes([(i * 37 + 11) & 0xFF for i in range(120)])),   # <=300 -> QMC2Map
        ('rc4', bytes([(i * 91 + 7) & 0xFF for i in range(512)])),     # >300 -> QMC2RC4
    ]:
        # 音频正文: 跨 0x7FFF 边界, 跨 RC4 首段(0x80)与其他段
        audio = bytearray()
        audio += b'OggS\x00\x02' + b'\x00' * 100
        audio += b'hello qmc v3 world!!'
        audio += bytes((i * 13 + 5) & 0xFF for i in range(0x8000))   # 覆盖 0x7FFF 边界
        audio += bytes((i * 29 + 3) & 0xFF for i in range(0x3000))
        plain = bytes(audio)
        # cipher key = 8 字节 header + 真实 master key
        header8 = bytes(range(0x10, 0x18))
        cipher_key = header8 + mkey
        enc = encrypt_audio(plain, cipher_key)
        footer = build_musicex_footer(mid, fname)
        ekey = make_v1_ekey_for(cipher_key, header8)
        # PcV1Legacy footer 内嵌 ekey, 但 MusicEx 无内嵌 ekey → 走 ekey_override/DB
        path = os.path.join(outdir, f'v3-{name}.mgg')
        with open(path, 'wb') as f:
            f.write(enc + footer)
        with open(os.path.join(outdir, f'ekey-{name}.txt'), 'w') as f:
            f.write(ekey)
        print(f'{name}: file={path} size={len(enc)+len(footer)} master={len(mkey)}B ekey={ekey[:36]}...')

    # 自解校验: 参考实现自己应该能解回来
    for name in ['map', 'rc4']:
        data = open(os.path.join(outdir, f'v3-{name}.mgg'), 'rb').read()
        out, ext, log = q.decrypt_qmc_file(
            data, ekey_override=open(os.path.join(outdir, f'ekey-{name}.txt')).read().strip(),
            ext_hint='mgg')
        assert out.startswith(b'OggS'), (name, out[:16])
        print(f'  ref self-decrypt {name}: OK ext={ext} head={out[:8].hex(" ")}')


if __name__ == '__main__':
    main()
