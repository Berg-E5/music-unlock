"""
frida_mode — QQ音乐借壳解密引擎

思路来源（署名保留）:
  - 原始版: yllhwa/decrypt-mflac-frida  https://github.com/yllhwa/decrypt-mflac-frida
  - 简化版: ericjuice/music-decryptor     https://github.com/ericjuice/music-decryptor
  - 本文件: 从 mzj3920/qqmusic-decrypt 的 frida_mode 独立重写版取用

原理: **不获取密钥**, 而是用 Frida 注入 QQMusic.exe 进程,
      调用其内置解密引擎 (QQMusicCommon.dll 的 EncAndDesMediaFile 类),
      让客户端自己完成「取钥 + 解密」, 把明文音频写盘。

为什么这是目前最靠谱的路:
  我们已经把密钥库翻遍了 (暴力试解全库, 07:00 实测确认库里没有目标 key),
  网页端 ekey 接口实测无效, 算法侧已与两个独立参考实现交叉验证过。
  剩下唯一能拿到明文的办法, 就是让**持有密钥的客户端自己解密**。

仅用于解密你自己合法下载、有权使用的音频文件。
"""

import os
import subprocess
import sys
import threading

_lock = threading.Lock()
_state = None  # (session, script) —— attach 一次，多文件复用


def available():
    """frida 是否已安装。"""
    try:
        import frida  # noqa: F401
        return True
    except ImportError:
        return False


def client_running():
    """QQMusic.exe 是否在运行。仅 Windows 有效；探测失败时放行，让 attach 报真实错误。

    ⚠️ 中文 Windows 上 tasklist 输出是 GBK(cp936), 不能用 text=True(默认 UTF-8),
       否则 'Chinese' 里的字节会抛 UnicodeDecodeError (08:57 实测)。
    """
    try:
        out = subprocess.run(
            ['tasklist'], capture_output=True, timeout=10,
            encoding='gbk', errors='ignore')
        return 'QQMusic.exe' in (out.stdout or '')
    except Exception:
        return True


def _hook_path():
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, 'hook_qq_music.js')
    if os.path.exists(p):
        return p
    meipass = getattr(sys, '_MEIPASS', '')
    p = os.path.join(meipass, 'frida_mode', 'hook_qq_music.js')
    if os.path.exists(p):
        return p
    raise RuntimeError('找不到 hook_qq_music.js（目录不完整）')


def _get_engine():
    global _state
    with _lock:
        if _state is None:
            import frida
            session = frida.attach('QQMusic.exe')
            script = session.create_script(open(_hook_path(), encoding='utf-8').read())
            script.load()
            _state = (session, script)
        return _state


def decrypt_file(src, dst):
    """借壳解密单个文件: src (.mflac/.mgg) -> dst (明文)。

    ⚠️ 必须用**纯 ASCII 路径** (08:57 实测):
       hook 脚本里 new File(path) 遇到非 ASCII 路径会抛
       "Illegal byte sequence" —— Frida 的 JS 字符串→原生路径转换
       按 UTF-8 处理, 而 Windows 文件路径可能是 GBK/UTF-16。
       所以路径搬运交给 Python (原生支持 Unicode), 注入层只碰 ASCII。
    """
    _, script = _get_engine()
    tmp = dst + '.frida_tmp'
    try:
        # 路径必须转绝对路径: 进程内 CWD 不可靠
        script.exports_sync.decrypt(os.path.abspath(src), os.path.abspath(tmp))
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def close():
    """释放注入会话。"""
    global _state
    with _lock:
        if _state is not None:
            session, _ = _state
            try:
                session.detach()
            except Exception:
                pass
            _state = None