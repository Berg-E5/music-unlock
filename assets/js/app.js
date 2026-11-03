/* ============================================
 * app.js — 主线程 UI · 科技感深色霓虹
 * 只管界面和 Worker 通信
 * ============================================ */

(function () {
  'use strict';

  // ---------- 站点根路径归一化 ----------
  // 页面可能通过 /index.html 打开, 此时相对链接会丢一段路径。
  // 把 zip 下载链接钉到站点根目录 (目录结构是固定的, 只有前缀会变)。
  (function fixAssetBase() {
    // 页面可能通过 /index.html 打开, 此时相对链接会丢一段路径。
    // 把 zip 下载链接钉到站点根目录 (目录结构是固定的, 只有前缀会变)。
    const root = new URL('./', location.href).pathname;
    for (const a of document.querySelectorAll('a[data-zip]')) {
      const name = a.getAttribute('data-zip');
      if (name) a.setAttribute('href', root + name);
    }
  })();

  // ---------- State ----------
  const state = {
    items: [],
    nextId: 1,
    worker: null
  };

  // ---------- Web Audio (主线程解码, 供 worker 转码) ----------
  let _audioCtx = null;
  function getAudioCtx() {
    if (!_audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('浏览器不支持 Web Audio API');
      _audioCtx = new Ctx();
    }
    return _audioCtx;
  }
  async function handleAudioDecode(msg) {
    const { seq, audioBuffer } = msg;
    try {
      const ctx = getAudioCtx();
      // decodeAudioData 需要一个 ArrayBuffer (不是 SharedArrayBuffer)
      const ab = audioBuffer instanceof ArrayBuffer ? audioBuffer : new Uint8Array(audioBuffer).buffer;
      const decoded = await ctx.decodeAudioData(ab);
      const channels = decoded.numberOfChannels;
      const sampleRate = decoded.sampleRate;
      const ch0 = decoded.getChannelData(0);
      const ch1 = channels > 1 ? decoded.getChannelData(1) : null;
      // Float32Array transferable
      const reply = {
        type: 'audio-decoded',
        seq,
        sampleRate,
        channels,
        ch0: ch0.slice()  // 复制, transfer 原 buffer
      };
      const transfer = [reply.ch0.buffer];
      if (ch1) { reply.ch1 = ch1.slice(); transfer.push(reply.ch1.buffer); }
      state.worker.postMessage(reply, transfer);
    } catch (e) {
      state.worker.postMessage({ type: 'audio-decode-error', seq, error: e.message || String(e) });
    }
  }

  // ---------- Worker ----------
  function getWorker() {
    if (state.worker) return state.worker;
    state.worker = new Worker('assets/js/worker.js?v=105');
    state.worker.addEventListener('message', onWorkerMessage);
    state.worker.addEventListener('error', (e) => {
      toast('Worker 错误: ' + e.message, 'error', 6000);
    });
    return state.worker;
  }

  function onWorkerMessage(e) {
    const { id, type } = e.data || {};
    const item = state.items.find(i => i.id === id);
    if (!item) return;

    if (type === 'audio-decode') {
      // Worker 请主线程用 AudioContext 解码 (OGG/FLAC/WAV/MP3)
      handleAudioDecode(e.data).catch(() => {});
      return;
    }
    if (type === 'progress') {
      item.progress = e.data.ratio;
      render();
    } else if (type === 'done') {
      item.status = 'done';
      item.result = e.data.payload;
      item.progress = 1;
      render();
    } else if (type === 'error') {
      item.status = 'error';
      item.error = e.data.message;
      item.dbDiag = e.data.dbDiag || null;
      if (item.dbDiag) {
        console.log('[DB Diag]', JSON.stringify(item.dbDiag, null, 2));
        // 加上可读的提示
        const tip = explainDbDiag(item.dbDiag);
        if (tip) item.error += '\n\n' + tip;
      }
      render();
      toast('✗ ' + item.file.name + ': ' + item.error, 'error', 6000);
    }
  }

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const queueSection = $('queue');
  const list = $('list');
  const count = $('count');
  const doneSection = $('done');
  const doneList = $('done-list');
  const doneCount = $('done-count');
  const clearBtn = $('clear-btn');
  const downloadAllBtn = $('download-all');

  // ---------- Toast ----------
  const toastEl = $('toast');
  function toast(msg, kind = 'info', ms = 3000) {
    toastEl.textContent = msg;
    toastEl.classList.remove('success', 'error');
    if (kind && kind !== 'info') toastEl.classList.add(kind);
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toastEl.classList.remove('show', 'success', 'error');
    }, ms);
  }

  // ---------- Add files ----------
  function detectFormat(name) {
    if (/\.ncm$/i.test(name)) return 'ncm';
    // QMC 系列: v2 (qmc0/qmc2/qmc3/qmcflac/qmcogg/mgg/mggl/mgg2/mqms/mqms2) + v1 (bkcmp3/bkcm4a/bkcflac/bkcogg/tkm)
    // 支持双后缀: .mgg2.flac / .mgg.flac 等
    if (/\.(qmc0|qmc1|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|mgg|mgg0|mgg1|mggl|mgg2|mgg3|mflac|mflac0|mflac2|mmp4|mqmc|mqcf|mqms|mqms2|bkcmp3|bkcm4a|bkcflac|bkcogg|666c6163|6d7033|6f6767|6d3461|776176)(\.[^.]+)?$/i.test(name)) return 'qmc';
    if (/\.(kgm|kgma|vpr)$/i.test(name)) return 'kgm';
    return null;
  }

  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 明文音频后缀 (不走 decrypt, 走纯转码)
  const PLAIN_AUDIO_RE = /\.(flac|mp3|ogg|wav|m4a|aac|opus|ape|webm)$/i;

  function addFiles(fileList) {
    let added = 0;
    let skipped = 0;
    const skippedNames = [];
    for (const file of fileList) {
      let fmt = detectFormat(file.name);
      // 明文音频接受为「转码任务」 (fmt=plain)
      if (!fmt && PLAIN_AUDIO_RE.test(file.name)) fmt = 'plain';
      if (!fmt) {
        skipped++;
        skippedNames.push(file.name);
        continue;
      }
      if (state.items.some(i => i.file.name === file.name && i.file.size === file.size)) continue;
      const item = {
        id: state.nextId++,
        file,
        format: fmt,
        status: 'pending',
        progress: 0,
        result: null,
        error: null
      };
      state.items.push(item);
      added++;
    }
    if (added === 0 && skipped > 0) {
      // 给出更精准的提示 (不只看后缀, 还要区分未识别 vs 已解密)
      const sample = skippedNames[0] || '';
      const lower = sample.toLowerCase();
      // 未识别的: 明显不是加密后缀, 也不在常见纯音频后缀里
      const knownAudio = ['.ogg','.mp3','.flac','.m4a','.wav','.ape','.wma','.aac','.opus','.mkv','.mp4','.m4v','.mov','.webm','.aiff','.au'];
      const endsKnown = knownAudio.some(ext => lower.endsWith(ext));
      if (endsKnown) {
        // V=52+ 这种情况已会走「纯转码」, 不应再出现这个 toast. 保留以防极端
        toast(`《${sample}》是已解密文件 · 本工具只处理加密格式 (NCM/QMC/KGM/VPR)`, 'error', 5000);
      } else {
        toast(`未识别格式：《${sample}》· 支持 NCM / QMC / KGM / VPR 加密文件 + 纯音频 (flac/mp3/ogg/wav) 转码`, 'error', 5000);
      }
      return;
    }
    if (added === 0) return;
    queueSection.hidden = false;
    render();
    for (const item of state.items) {
      if (item.status === 'pending') {
        item.status = 'processing';
        const msg = { id: item.id, type: 'decrypt', file: item.file };
        // 默认转码为 MP3 (UI 上有码率下拉)
        msg.outputFormat = 'mp3';
        const br = parseInt((document.getElementById('mp3-bitrate') || {}).value, 10);
        if (br) msg.mp3Bitrate = br;
        // QMC MusicEx (V3) 的 ekey (base64 文本) —— 只有填了才传, 空则让 worker 报缺 ekey
        const ekeyInput = document.getElementById('qmc-ekey');
        if (ekeyInput && ekeyInput.value) {
          const ekey = ekeyInput.value.trim();
          if (ekey) msg.ekey = ekey;
        }
        getWorker().postMessage(msg);
      }
    }
  }

  // ---------- Render ----------
  function render() {
    const pending = state.items.filter(i => i.status !== 'done');
    const done = state.items.filter(i => i.status === 'done');
    count.textContent = state.items.length;
    doneCount.textContent = done.length;
    queueSection.hidden = state.items.length === 0;
    doneSection.hidden = done.length === 0;
    downloadAllBtn.disabled = done.length === 0;
    renderList(list, pending);
    renderList(doneList, done);
  }

  function makeBadge(status) {
    const b = document.createElement('span');
    b.className = 'status-badge ' + status;
    const labels = {
      pending: '等待',
      processing: '解密中',
      done: '完成',
      error: '失败'
    };
    b.textContent = labels[status] || status;
    return b;
  }

  function buildRow(item) {
    const li = document.createElement('li');
    li.className = 'file-item ' + item.status;

    // 格式图标
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = { ncm: 'NCM', qmc: 'QMC', kgm: 'KGM' }[item.format] || '?';
    li.appendChild(icon);

    // 文件元信息
    const meta = document.createElement('div');
    meta.className = 'file-meta';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.result ? item.result.filename : item.file.name;

    const sub = document.createElement('div');
    sub.className = 'file-sub';
    if (item.status === 'error') {
      sub.classList.add('error');
      sub.textContent = item.error || '未知错误';
    } else if (item.status === 'done' && item.result && item.result.meta) {
      const m = item.result.meta;
      const artist = Array.isArray(m.artist) ? m.artist.map(a => a[0]).join(', ') : (m.artist || '');
      const album = m.album || '';
      const parts = [
        artist && ('♪ ' + artist),
        album && ('· ' + album),
        fmtSize(item.file.size)
      ].filter(Boolean);
      sub.textContent = parts.join('  ');
    } else {
      sub.textContent = fmtSize(item.file.size);
    }

    meta.appendChild(name);
    meta.appendChild(sub);

    // 进度条 (处理中)
    if (item.status === 'processing' && item.progress > 0 && item.progress < 1) {
      const pg = document.createElement('div');
      pg.className = 'file-progress';
      const bar = document.createElement('div');
      bar.className = 'file-progress-bar';
      bar.style.width = (item.progress * 100).toFixed(1) + '%';
      pg.appendChild(bar);
      meta.appendChild(pg);
    }

    li.appendChild(meta);

    // 状态徽章
    li.appendChild(makeBadge(item.status));

    // 操作按钮
    if (item.status === 'done' && item.result) {
      const actions = document.createElement('div');
      actions.className = 'file-actions';

      // 试听按钮
      if (item.result.blob && item.result.blob.type.startsWith('audio/')) {
        const preview = document.createElement('button');
        preview.className = 'btn-icon';
        preview.textContent = '▶ 试听';
        preview.title = '在浏览器中试听';
        preview.addEventListener('click', () => previewAudio(item));
        actions.appendChild(preview);
      }

      // 下载按钮
      const dl = document.createElement('a');
      dl.className = 'btn-icon';
      const url = URL.createObjectURL(item.result.blob);
      dl.href = url;
      dl.download = item.result.filename;
      dl.textContent = '⬇ 下载';
      dl.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 2000));
      actions.appendChild(dl);

      li.appendChild(actions);
    }

    return li;
  }

  function renderList(ul, items) {
    ul.innerHTML = '';
    for (const item of items) {
      ul.appendChild(buildRow(item));
    }
  }

  // ---------- 试听 (底部固定播放器, 绕过 autoplay policy) ----------
  const playerBar   = $('player-bar');
  const playerAudio = $('player-audio');
  const playerName  = $('player-name');
  const playerMeta  = $('player-meta');
  const playerClose = $('player-close');
  let currentPreviewItem = null;
  let _playerUrl = null;

  // 调试: 记录所有 audio 事件
  if (playerAudio) {
    ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
     'play', 'playing', 'pause', 'ended', 'error', 'stalled', 'suspend', 'abort', 'emptied'].forEach(ev => {
      playerAudio.addEventListener(ev, () => {
        const err = playerAudio.error;
        const code = err ? err.code : 0;
        const codeName = ['NONE','ABORTED','NETWORK','DECODE','SRC_NOT_SUPPORTED'][code] || code;
        console.log(`[audio ${ev}] src=${(playerAudio.src||'').slice(0,60)} readyState=${playerAudio.readyState} networkState=${playerAudio.networkState} err=${codeName}`);
      });
    });
  }

  function previewAudio(item) {
    if (!item.result || !item.result.blob) {
      toast('该项目未生成可试听文件', 'error');
      return;
    }
    // 释放上一次的 URL
    if (_playerUrl) { URL.revokeObjectURL(_playerUrl); _playerUrl = null; }
    _playerUrl = URL.createObjectURL(item.result.blob);
    playerName.textContent = item.result.filename || item.file.name;
    const m = (item.result.meta) || {};
    const artist = (Array.isArray(m.artist) ? m.artist.map(a => a[0]).join(', ') : m.artist) || '';
    const album  = m.album || '';
    playerMeta.textContent = [artist, album].filter(Boolean).join(' · ');
    playerBar.hidden = false;
    // 浏览器必须先读到 supported MIME 才会启动. 某些状况下同一份 blob URL 会坏, 加个 canplay 监听保险
    const onCanPlay = () => {
      playerAudio.removeEventListener('canplay', onCanPlay);
      const p = playerAudio.play();
      if (p && p.catch) {
        p.catch(err => {
          console.warn('[audio play blocked]', err);
          toast('♪ 已加载, 浏览器拦截自动播放, 点播放器中间按钮开始', 'info', 4000);
        });
      }
    };
    playerAudio.addEventListener('canplay', onCanPlay);
    // 设 src (不 .load(), 不脱离手势上下文)
    playerAudio.src = _playerUrl;
    currentPreviewItem = item;
    // 滚动到可视
    playerBar.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  if (playerClose) {
    playerClose.addEventListener('click', () => {
      playerAudio.pause();
      playerAudio.removeAttribute('src');
      playerAudio.load();
      playerBar.hidden = true;
      if (_playerUrl) { URL.revokeObjectURL(_playerUrl); _playerUrl = null; }
      currentPreviewItem = null;
    });
  }

  // ---------- Download all as ZIP ----------
  async function downloadAllAsZip() {
    const done = state.items.filter(i => i.status === 'done' && i.result);
    if (done.length === 0) return;
    toast('正在打包…', 'info', 2000);
    const zip = new JSZip();
    const used = new Set();
    for (const item of done) {
      let name = item.result.filename;
      let n = 1;
      while (used.has(name)) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        name = base + ' (' + n + ')' + ext;
        n++;
      }
      used.add(name);
      zip.file(name, item.result.blob);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'music-unlock-' + Date.now() + '.zip';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('✓ 已下载 ' + done.length + ' 个文件', 'success');
  }

  function clearAll() {
    if (playerAudio) { playerAudio.pause(); playerAudio.removeAttribute('src'); }
    if (playerBar) playerBar.hidden = true;
    if (_playerUrl) { URL.revokeObjectURL(_playerUrl); _playerUrl = null; }
    currentPreviewItem = null;
    state.items = [];
    render();
  }

  // 转码选项 (在 dropzone 内部, 防止 click 冒泡触发 file-input)
  const optRow = document.getElementById('opt-row');
  if (optRow) {
    optRow.addEventListener('click', (e) => e.stopPropagation());
    optRow.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  // 扩展状态行 (也在 dropzone 内, 防止 click 冒泡)

  // ---------- Events ----------
  dropzone.addEventListener('click', (e) => {
    // 只在点击 dropzone 本身/提示文字时打开文件选择器, 避免被子区点击 (码率下拉/预览) 误触发
    if (e.target.closest('button, a, select, input, .opt-row, .row, .item, .done, .player-bar')) return;
    fileInput.click();
  });
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', e => {
    addFiles(e.target.files);
    fileInput.value = '';
  });
  clearBtn.addEventListener('click', clearAll);
  downloadAllBtn.addEventListener('click', downloadAllAsZip);


  ['dragover', 'drop'].forEach(ev => {
    window.addEventListener(ev, e => {
      if (!dropzone.contains(e.target)) e.preventDefault();
    });
  });

})();
