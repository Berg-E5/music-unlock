#!/usr/bin/env python3
"""构造 V2 EKey 测试向量 (双层 TEA KEY1→KEY2 包装)。

背景: cross-ref-harness.js 之前只覆盖 V1 ekey, 而 QQ 服务器下发的
基本是 V2 (前缀 'UVFNdXNpYyBFbmNWMixLZXk6' = base64("QQMusic EncV2,Key:"))。
V2 解密路径 = b64decode → TEA(KEY1) → TEA(KEY2) → 去首个 0 → 走 V1。
这条路径从未被向量验证过。

做法: 复用已验证的 V1 ekey 字符串 s (它解开就是目标 cipher key),
      再用两次 tea_cbc_encrypt 包一层 → V2 ekey。
"""
import sys, os, base64, importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('qmc_ref', os.path.join(_HERE, 'qmc_ref.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

V2_PREFIX = 'UVFNdXNpYyBFbmNWMixLZXk6'


def wrap_v1_to_v2(v1_ekey: str, salt1=bytes(range(0x20, 0x2A)),
                  salt2=bytes(range(0x30, 0x3A))) -> str:
    """把 V1 ekey 字符串包成 V2 ekey。解密 V2 应得到与解密 V1 完全相同的 cipher key。"""
    # V2 解密 = TEA_CBC_DECRYPT(KEY1) 然后 TEA_CBC_DECRYPT(KEY2)
    # 所以加密顺序反过来: 先 KEY2 再 KEY1
    payload = v1_ekey.encode('latin-1')
    payload = q.tea_cbc_encrypt(payload, bytes(q.EKEY_V2_KEY2), salt2)
    payload = q.tea_cbc_encrypt(payload, bytes(q.EKEY_V2_KEY1), salt1)
    return V2_PREFIX + base64.b64encode(payload).decode()


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else _HERE
    for kind in ['map', 'rc4']:
        v1 = open(os.path.join(outdir, f'ekey-{kind}.txt')).read().strip()
        v2 = wrap_v1_to_v2(v1)
        with open(os.path.join(outdir, f'ekey-{kind}-v2.txt'), 'w') as f:
            f.write(v2)

        # 参考实现自校验: V2 解出的 cipher key 必须与 V1 完全一致
        k1 = q.ekey_decrypt(v1)
        k2 = q.ekey_decrypt(v2)
        assert bytes(k1) == bytes(k2), (kind, len(k1), len(k2))
        print(f'{kind}: V1 ekey {len(v1)}B / V2 ekey {len(v2)}B '
              f'→ cipher key {len(k2)}B 一致 ✓')
        print(f'   V2 前缀: {v2[:40]}...')

        # 端到端: 用 V2 ekey 解同一个 mgg, 必须与 V1 结果逐字节相同
        data = open(os.path.join(outdir, f'v3-{kind}.mgg'), 'rb').read()
        o1, _, _ = q.decrypt_qmc_file(data, ekey_override=v1, ext_hint='mgg')
        o2, _, _ = q.decrypt_qmc_file(data, ekey_override=v2, ext_hint='mgg')
        assert bytes(o1) == bytes(o2), kind
        assert o2.startswith(b'OggS'), (kind, o2[:8])
        print(f'   端到端 V1==V2 ✓ 头={o2[:8].hex(" ")}')


if __name__ == '__main__':
    main()