#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
decrypt_frida.py - QQ Music .mgg / .mflac decryptor via client (v1.5)

USAGE:
    python decrypt_frida.py "D:\\Music\\song.mgg"      one file
    python decrypt_frida.py "D:\\Music"               whole folder (recursive)
    python decrypt_frida.py --watch "D:\\Music"       watch mode: auto on new file
    python decrypt_frida.py --watch "D:\\Music" --out "D:\\Plain"

FORMAT OPTIONS:
    (default)        convert to MP3 320k
    --keep           keep the original container (ogg/flac/...)
    --bitrate N      MP3 bitrate, default 320k  (e.g. --bitrate 192k)
    --flac           convert to FLAC (best when the source is lossless)

Conversion needs ffmpeg on PATH. Without it the output stays Ogg.
Get it: https://www.gyan.dev/ffmpeg/builds/  (pick "full" build, then add
its bin folder to PATH)

All console output is pure ASCII on purpose: a Chinese Windows console runs
codepage 936 (GBK), and non-ASCII output raises UnicodeEncodeError which would
kill the watch loop silently. (hit this 09:52)
"""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ENCRYPTED_EXT = ('.mgg', '.mflac', '.mgg0', '.mgg1', '.mflac0', '.mflac2')
SELF_EXTS = ('.decrypted.ogg', '.decrypted.flac', '.decrypted.mp3',
             '.decrypted.m4a', '.decrypted.wav', '.decrypted.bin')
SETTLE_SECONDS = 6.0      # file size must be unchanged this long = download done
MAX_RETRIES = 3           # cap retries so a bad file cannot spam forever
MIN_SIZE = 64 * 1024
QQ_TEMP_PREFIXES = ('.~', '.!qmc', 'grsfile', 'qqmusic', '._', '~$', '~')
DEFAULT_BITRATE = '320k'


def _p(*a):
    """ASCII-safe print. Never raises UnicodeEncodeError."""
    s = ' '.join(str(x) for x in a)
    try:
        print(s, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, 'encoding', None) or 'ascii'
        print(s.encode(enc, 'replace').decode(enc, 'replace'), flush=True)


def _ts():
    return time.strftime('%H:%M:%S')


def _find_ffmpeg():
    """Locate ffmpeg. Returns None if not installed."""
    exe = 'ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg'
    # 1) on PATH
    from shutil import which
    p = which(exe) or which('ffmpeg')
    if p:
        return p
    # 2) common Windows install spots (user may not have set PATH yet)
    cands = [
        r'C:\ffmpeg\bin', r'C:\Program Files\ffmpeg\bin',
        os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Packages'),
        os.path.expandvars(r'%USERPROFILE%\Downloads\ffmpeg'),
    ]
    for d in cands:
        if not d or not os.path.isdir(d):
            continue
        # shallow walk for ffmpeg.exe (covers extracted build dirs)
        for dp, dn, fns in os.walk(d):
            dn[:] = [x for x in dn if x not in ('node_modules', '.git')]
            if exe in fns:
                return os.path.join(dp, exe)
            if dp.count(os.sep) - d.count(os.sep) > 3:
                dn[:] = []
    return None


def _probe_audio(path):
    """Return (codec, sample_rate, channels, duration) or None."""
    from shutil import which
    fp = which('ffprobe') or which('ffprobe.exe')
    if not fp:
        # try next to the ffmpeg we found
        ff = _find_ffmpeg()
        cand = os.path.join(os.path.dirname(ff), 'ffprobe.exe') if ff else None
        fp = cand if cand and os.path.exists(cand) else None
    if not fp:
        return None
    try:
        import subprocess
        import json
        out = subprocess.run(
            [fp, '-v', 'quiet', '-print_format', 'json', '-show_streams',
             '-show_format', path],
            capture_output=True, timeout=60).stdout
        data = json.loads(out.decode('utf-8', 'ignore'))
        st = next((s for s in data.get('streams', [])
                   if s.get('codec_type') == 'audio'), None)
        if not st:
            return None
        return (st.get('codec_name'), int(st.get('sample_rate', 0) or 0),
                int(st.get('channels', 0) or 0),
                float(data.get('format', {}).get('duration', 0) or 0))
    except Exception:
        return None


def _convert(src, dst, fmt='mp3', bitrate=DEFAULT_BITRATE):
    """Convert audio. Returns (ok, message)."""
    ff = _find_ffmpeg()
    if not ff:
        return False, 'ffmpeg not found (install it, or use --keep)'
    import subprocess
    # Note: let ffmpeg pick the decoder from the container. For AAC-in-Ogg it
    # must NOT be told "vorbis" - that would either fail or double-loss it.
    if fmt == 'mp3':
        cmd = [ff, '-y', '-hide_banner', '-loglevel', 'error',
               '-i', src, '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, dst]
    elif fmt == 'flac':
        cmd = [ff, '-y', '-hide_banner', '-loglevel', 'error',
               '-i', src, '-vn', '-c:a', 'flac', dst]
    else:
        return False, 'unsupported format: %s' % fmt
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=1800)
        if r.returncode != 0:
            err = r.stderr.decode('utf-8', 'ignore').strip().splitlines()
            return False, 'ffmpeg failed: %s' % (err[-1] if err else 'code %d' % r.returncode)
        return True, ''
    except Exception as e:
        return False, 'ffmpeg error: %s' % e


def _audio_ext(data):
    if data[:4] == b'OggS':
        return 'ogg'
    if data[:4] == b'fLaC':
        return 'flac'
    if data[:3] == b'ID3':
        return 'mp3'
    if data[4:8] == b'ftyp':
        return 'm4a'
    if data[:4] == b'RIFF' and data[8:12] == b'WAVE':
        return 'wav'
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return 'mp3'
    return 'bin'


def _is_ascii(s):
    return all(ord(c) < 128 for c in s)


def _ascii_dir():
    """Injected layer only accepts ASCII paths (08:57: Chinese path broke it)."""
    for cand in (tempfile.gettempdir(), r'C:\Windows\Temp', r'C:\Temp'):
        try:
            if cand and _is_ascii(cand):
                os.makedirs(cand, exist_ok=True)
                return cand
        except Exception:
            continue
    return None


class Decryptor(object):
    """Reuse one frida attach - attaching is slow, do it once."""

    def __init__(self, fmt='mp3', bitrate=DEFAULT_BITRATE):
        import frida_mode
        self.fm = frida_mode
        self.adir = _ascii_dir()
        self.fmt = fmt
        self.bitrate = bitrate
        self._n = 0
        self._ff_cache = None
        if not self.adir:
            raise RuntimeError('no ASCII temp dir found. Set TMP to an ASCII path.')

    def _stage(self):
        self._n += 1
        t = str(self._n)
        return (os.path.join(self.adir, 'qmc_s%s.mgg' % t),
                os.path.join(self.adir, 'qmc_o%s.bin' % t))

    def decrypt(self, src, out_dir=None):
        if not self.fm.available():
            raise RuntimeError('frida not installed. Run: pip install frida')
        if sys.platform != 'win32':
            raise RuntimeError('Windows only (needs to inject QQMusic.exe)')
        if not self.fm.client_running():
            raise RuntimeError('QQMusic.exe not found. Start QQ Music and log in.')

        abs_src = os.path.abspath(src)
        stage_src, stage_out = self._stage()
        for p in (stage_src, stage_out, stage_out + '.frida_tmp'):
            try:
                os.path.exists(p) and os.remove(p)
            except OSError:
                pass

        if _is_ascii(abs_src):
            real_src = abs_src
        else:
            shutil.copy2(abs_src, stage_src)
            real_src = stage_src

        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        dst_dir = out_dir or os.path.dirname(abs_src)
        stem = os.path.splitext(os.path.basename(abs_src))[0]
        dst = os.path.join(dst_dir, stem + '.decrypted.bin')

        try:
            self.fm.decrypt_file(real_src, stage_out)
            shutil.copy2(stage_out, dst)
        finally:
            for p in (stage_src, stage_out, stage_out + '.frida_tmp'):
                try:
                    os.path.exists(p) and os.remove(p)
                except OSError:
                    pass

        with open(dst, 'rb') as f:
            data = f.read()
        ext = _audio_ext(data)
        if ext != 'bin':
            final = os.path.splitext(dst)[0] + '.' + ext
            os.replace(dst, final)
            dst = final

        # ---- convert if requested ----
        info = None
        if self.fmt == 'mp3' or self.fmt == 'flac':
            # already in the target format? do nothing
            if ext == self.fmt:
                return dst, ext, len(data), None
            info = _probe_audio(dst)
            target = os.path.splitext(dst)[0] + '.' + self.fmt
            ok, msg = _convert(dst, target, self.fmt, self.bitrate)
            if ok and os.path.exists(target):
                try:
                    os.remove(dst)          # drop the intermediate ogg
                except OSError:
                    pass
                dst = target
                ext = self.fmt
                try:
                    n2 = os.path.getsize(dst)
                except OSError:
                    n2 = 0
                return dst, ext, n2, info
            # conversion failed -> keep the ogg, report why
            if info is None:
                info = _probe_audio(dst)
            return dst, ext, len(data), {'convert_error': msg}

        return dst, ext, len(data), info

    def close(self):
        try:
            self.fm.close()
        except Exception:
            pass


def _explain(msg):
    """Map an error to something the user can act on.

    Note: matching checks ASCII fragments only. The frida-side messages may be
    Chinese (QQ Music is a Chinese client), and this file must stay ASCII-safe
    for GBK consoles - so we match on the ASCII substrings they contain.
    """
    if 'Non-ASCII' in msg:
        return ['Path still not ASCII.',
                'Fix:  set TMP=D:\\tmp   then open a new console and retry.']
    if ('符号' in msg or 'Symbol' in msg or 'find all' in msg
            or 'NotFound' in msg or '未能找到' in msg or '方法' in msg):
        return ['Symbol not matched - QQ Music updated, EncAndDesMediaFile changed.',
                'Not your fault. Send me the full error and I will adapt it.']
    if ('Open' in msg and ('fail' in msg.lower() or 'false' in msg.lower()
                           or '失败' in msg or '不认' in msg)):
        return ['Client does not recognise this file.',
                'Likely: still downloading / not downloaded by this client /',
                'or not in its cache. Try: play the song in QQ Music first,',
                'or wait until the download fully finishes.']
    if 'Not injected' in msg or 'process not found' in msg.lower():
        return ['QQMusic.exe not found - client not running, or 32/64 bit mismatch.']
    if 'Encode' in msg or 'encode' in msg or 'gbk' in msg.lower() or 'codec' in msg.lower():
        return ['Console encoding problem.',
                'The message text is non-ASCII and this console is GBK.',
                'Try:  chcp 65001   then rerun.',
                'Or:  set PYTHONIOENCODING=utf-8']
    return ['Troubleshooting:',
            '  1) pip install frida==16.2.2',
            '  2) python -c "import sys;print(sys.maxsize)"  ->  9223372036854775807',
            '  3) Right-click the .bat -> Run as administrator',
            '  4) Send me the full error above']


def _show_audio(info):
    """Print codec info + conversion warnings. info may be None."""
    if not info:
        return
    if 'convert_error' in info:
        _p('[!] Convert to target format failed: %s' % info['convert_error'])
        _p('    The decrypted Ogg was kept. Install ffmpeg, or use --keep.')
        return
    codec, sr, ch, dur = info
    if codec:
        _p('Source codec: %s  %d Hz  %d ch  %.1fs'
           % (codec, sr, ch, dur))


# ---------------- one file ----------------
def cmd_single(src, fmt, bitrate):
    if not os.path.exists(src):
        _p('[X] File not found: %s' % src)
        return 1
    d = None
    try:
        import frida_mode  # noqa: F401
        d = Decryptor(fmt, bitrate)
        if not _is_ascii(os.path.abspath(src)):
            _p('Non-ASCII filename -> staging via ASCII temp path')
        _p('Source: %s (%d bytes)' % (src, os.path.getsize(src)))
        _p('Injecting QQMusic.exe ...')
        t0 = time.time()
        out, ext, n, info = d.decrypt(src)
        _p('')
        _p('[OK] Done (%d bytes, %.1fs)' % (n, time.time() - t0))
        _p('Output: %s' % out)
        _p('Format: %s' % ext)
        _show_audio(info)
        return 0
    except Exception as e:
        msg = str(e)
        _p('')
        _p('[X] Failed: %s' % msg)
        _p('')
        for line in _explain(msg):
            _p('  ' + line)
        return 1
    finally:
        d and d.close()


# ---------------- folder ----------------
def _walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [x for x in dirnames if not x.startswith('.')]
        for fn in filenames:
            low = fn.lower()
            if not low.endswith(ENCRYPTED_EXT):
                continue
            if any(low.endswith(s) for s in SELF_EXTS):
                continue
            yield os.path.join(dirpath, fn)


def cmd_batch(root, out_dir=None, fmt='mp3', bitrate=DEFAULT_BITRATE):
    if not os.path.isdir(root):
        _p('[X] Not a folder: %s' % root)
        return 1
    files = list(_walk(root))
    if not files:
        _p('No .mgg / .mflac files found in that folder.')
        return 1
    _p('Found %d file(s) to decrypt.' % len(files))
    _p('Target format: %s' % (fmt if fmt != 'keep' else 'keep original'))
    _p('')
    d = None
    ok = fail = 0
    warn = 0
    fails = []
    try:
        d = Decryptor(fmt, bitrate)
        for i, f in enumerate(files, 1):
            _p('[%d/%d] %s' % (i, len(files), os.path.basename(f)))
            try:
                out, ext, n, info = d.decrypt(f, out_dir)
                _p('       [OK] %s (%d bytes)' % (ext, n))
                if info and 'convert_error' in info:
                    _p('       [!] %s' % info['convert_error'])
                    warn += 1
                ok += 1
            except Exception as e:
                _p('       [X] %s' % str(e)[:120])
                fails.append((os.path.basename(f), str(e)[:200]))
                fail += 1
    except Exception as e:
        _p('')
        _p('[X] Fatal: %s' % e)
        for line in _explain(str(e)):
            _p('  ' + line)
        return 1
    finally:
        d and d.close()

    _p('')
    _p('=' * 46)
    _p('Finished: %d ok, %d failed' % (ok, fail))
    if warn:
        _p('%d file(s) stayed Ogg because conversion failed.' % warn)
    if fails:
        _p('')
        _p('Failures:')
        for name, msg in fails:
            _p('  - %s' % name)
            _p('      %s' % msg)
    return 0 if fail == 0 else 2


# ---------------- watch ----------------
def cmd_watch(root, out_dir=None, interval=2.0, fmt='mp3',
              bitrate=DEFAULT_BITRATE):
    if not os.path.isdir(root):
        _p('[X] Not a folder: %s' % root)
        return 1
    _p('=' * 46)
    _p(' WATCH MODE RUNNING')
    _p(' dir   : %s' % root)
    _p(' output: %s' % (out_dir or 'same folder as source'))
    _p(' format: %s' % (fmt if fmt != 'keep' else 'keep original'))
    _p(' ext   : %s' % ', '.join(ENCRYPTED_EXT))
    _p('=' * 46)
    _p(' Leave this window open. New downloads decrypt automatically.')
    _p(' A file must stay unchanged for %d sec before it is processed' % SETTLE_SECONDS)
    _p(' Press Ctrl+C to stop.')
    _p('')

    done = set()
    pending = {}
    retries = {}
    seen = set()
    d = None
    ok = fail = 0
    last_beat = 0.0

    def attach():
        nonlocal d
        if d is None:
            d = Decryptor(fmt, bitrate)
        return d

    try:
        while True:
            now = time.time()

            # heartbeat every 10s - proves the loop is alive
            if now - last_beat >= 10.0:
                last_beat = now
                present = set()
                for dp, dn, fns in os.walk(root):
                    dn[:] = [x for x in dn if not x.startswith('.')]
                    for fn in fns:
                        present.add(os.path.join(dp, fn))
                fresh = present - seen
                if not present:
                    _p('[%s] waiting... folder is empty' % _ts())
                elif fresh:
                    _p('[%s] NEW FILE(S): %d' % (_ts(), len(fresh)))
                    for n in sorted(fresh)[:5]:
                        try:
                            sz = os.path.getsize(n)
                        except OSError:
                            sz = -1
                        base = os.path.basename(n)
                        _p('      * %s  (%d bytes)' % (base, sz))
                        if not base.lower().endswith(ENCRYPTED_EXT):
                            _p('        ^ NOT a .mgg/.mflac name - will be ignored.')
                            _p('          (QQ Music may use a temp name; it renames later)')
                    if len(fresh) > 5:
                        _p('      * ... and %d more' % (len(fresh) - 5))
                    seen.update(present)

            for f in list(_walk(root)):
                af = os.path.abspath(f)
                if af in done:
                    continue
                try:
                    size = os.path.getsize(f)
                except OSError:
                    continue
                if size < MIN_SIZE:
                    continue
                prev_size, since = pending.get(af, (None, now))
                if prev_size != size:
                    pending[af] = (size, now)
                    continue
                if now - since < SETTLE_SECONDS:
                    continue

                _p('')
                _p('> %s (%d bytes, idle %.0fs)'
                   % (os.path.basename(f), size, now - since))
                try:
                    out, ext, n, info = attach().decrypt(f, out_dir)
                    _p('  [OK] %s (%d bytes)' % (ext, n))
                    if info and 'convert_error' in info:
                        _p('     [!] %s (kept Ogg)' % info['convert_error'])
                    _p('      %s' % out)
                    done.add(af)
                    ok += 1
                except Exception as e:
                    msg = str(e)
                    _p('  [X] %s' % msg[:160])
                    for line in _explain(msg)[:2]:
                        _p('     ' + line)
                    fail += 1
                    retry = retries.get(af, 0) + 1
                    if 'Open' in msg and retry <= MAX_RETRIES:
                        retries[af] = retry
                        pending[af] = (size, now)
                        _p('     retry %d/%d in a moment' % (retry, MAX_RETRIES))
                    else:
                        if retry > MAX_RETRIES:
                            _p('     gave up after %d retries' % MAX_RETRIES)
                        done.add(af)
            time.sleep(interval)
    except KeyboardInterrupt:
        _p('')
        _p('Stopped. %d ok, %d failed.' % (ok, fail))
        return 0
    finally:
        d and d.close()


def main():
    args = sys.argv[1:]
    watch = False
    out_dir = None
    fmt = 'mp3'                 # default: convert to mp3
    bitrate = DEFAULT_BITRATE
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('--watch', '-w'):
            watch = True
        elif a in ('--out', '-o'):
            i += 1
            out_dir = args[i] if i < len(args) else None
        elif a == '--keep':
            fmt = 'keep'
        elif a == '--flac':
            fmt = 'flac'
        elif a == '--mp3':
            fmt = 'mp3'
        elif a in ('--bitrate', '-b'):
            i += 1
            bitrate = args[i] if i < len(args) else DEFAULT_BITRATE
        elif a in ('-h', '--help', '/?'):
            _p(__doc__)
            return 0
        else:
            rest.append(a)
        i += 1

    if not rest:
        _p(__doc__)
        return 1

    target = rest[0]
    if watch:
        return cmd_watch(target, out_dir, fmt=fmt, bitrate=bitrate)
    if os.path.isdir(target):
        return cmd_batch(target, out_dir, fmt=fmt, bitrate=bitrate)
    return cmd_single(target, fmt, bitrate)


if __name__ == '__main__':
    sys.exit(main())