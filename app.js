/* ==========================================================================
   互動拍照模組 — 主程式
   --------------------------------------------------------------------------
   負責：設定載入 / 相機控制 / 算圖迴圈 / 照片合成 / 介面 / 儲存

   設計重點：
   1. 相機畫面與動畫「都畫在同一張 canvas」上，按下快門就是直接輸出這張
      canvas，因此預覽與成品保證完全一致。
   2. 照片全程在瀏覽器內合成，不會上傳任何伺服器。
   3. 版面分為標題列、照片區、控制列三段。控制項一律在照片區之外，
      不會遮擋構圖，畫面所見即為輸出結果。
   4. 素材圖片必須與網頁同來源，否則 canvas 受汙染將無法輸出照片。

   素材與動畫參數請改 config.json，繪製邏輯在 effects.js，
   本檔案通常不需要調整。
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     預設設定
     --------------------------------------------------------------------
     若同目錄存在 config.json，會以其內容覆蓋；讀取失敗時沿用以下預設值，
     確保沒有後端也能完整運作。
     ====================================================================== */

  var DEFAULT_CONFIG = {
    title: '公共藝術互動拍照',
    countdown: 3,
    /* 輸出解析度固定，不隨螢幕大小改變，所有裝置拍出的照片一致 */
    output: { width: 1080, height: 1440 },
    frame: {
      label: 'ART IN COMMON'
    },
    frames: [
      { id: 'classic', name: '經典', type: 'classic', enabled: true, order: 1 },
      { id: 'none', name: '無框', type: 'none', enabled: true, order: 9 },
      { id: 'thin', name: '細邊', type: 'thin', enabled: true, order: 2 },
      { id: 'rounded', name: '圓角', type: 'rounded', enabled: true, order: 3 },
      { id: 'double', name: '雙線', type: 'double', enabled: true, order: 4 },
      { id: 'film', name: '膠捲', type: 'film', enabled: true, order: 5 },
      { id: 'caption', name: '底標', type: 'caption', enabled: true, order: 6 }
    ],
    /* 圖片與動作各自獨立，使用者可任意組合。
       此處為 config.json 讀取失敗時的備援，內容應與 config.json 保持一致。 */
    sprites: [
      {
        id: 'cat-walk', name: '貓咪', src: './assets/cat-walk.png',
        cols: 2, rows: 2, frames: 4, fps: 8, scale: 1.5, enabled: true, order: 1
      },
      { id: 'shiba', name: '柴犬', src: './assets/shiba-line.png', scale: 1.2, enabled: true, order: 2 },
      { id: 'cat-sit', name: '坐姿貓', src: './assets/cat-line.png', scale: 1.2, enabled: true, order: 3 },
      { id: 'orange', name: '橘子', src: './assets/orange.png', scale: 1.35, shadow: false, enabled: true, order: 4 }
    ],
    sizes: [
      { id: 'sm', name: '小', factor: 0.7, enabled: true, order: 1 },
      { id: 'md', name: '中', factor: 1, enabled: true, order: 2, "default": true },
      { id: 'lg', name: '大', factor: 1.4, enabled: true, order: 3 },
      { id: 'xl', name: '特大', factor: 1.9, enabled: true, order: 4 }
    ],
    motions: [
      { id: 'free', name: '自由擺放', type: 'static', enabled: true, order: 1, options: {} },
      { id: 'walk', name: '來回走動', type: 'walker', enabled: true, order: 2, options: {} },
      { id: 'jump', name: '原地蹦跳', type: 'jumper', enabled: true, order: 2, options: {} },
      { id: 'fall', name: '持續落下', type: 'rain', enabled: true, order: 3, options: {} }
    ]
  };

  var CONFIG_URL = './config.json';
  var CONFIG_TIMEOUT = 2500;

  /* 預覽模式：網址加上 ?preview=1 時不啟動相機，改用模擬背景，
     供版面與動畫檢視使用。正式部署的一般網址不受影響。 */
  var PREVIEW = /[?&]preview=1/.test(window.location.search);

  /* ======================================================================
     狀態
     ====================================================================== */

  var config = DEFAULT_CONFIG;
  var sprites = [];             /* [{ meta, instance }] */
  var motions = [];             /* [{ meta, instance }] */
  var frames = [];              /* [meta]，相框只是繪製樣式，不需實例 */
  var sizes = [];               /* [meta]，角色大小倍率 */
  var currentSprite = null;
  var currentMotion = null;
  var currentFrame = null;
  var currentSize = null;
  var timerOn = true;        /* true 為倒數後拍攝，false 為按下即拍 */

  var stream = null;
  var facing = 'user';
  var rafId = 0;
  var lastTime = 0;
  var running = false;
  var busy = false;

  var stage = { w: 0, h: 0, u: 1 };
  var photoBlob = null;
  var photoUrl = '';

  /* ======================================================================
     DOM
     ====================================================================== */

  var el = {};

  function cacheDom() {
    [
      'stage', 'stageWrap', 'source', 'screenIntro', 'screenResult', 'screenError',
      'introTitle', 'barTitle', 'btnStart', 'btnShutter', 'btnFlip', 'btnFrame',
      'spriteChips', 'motionChips', 'frameChips', 'sizeChips', 'btnPickers', 'dragHint',
      'pickersEffect', 'pickersFrame',
      'btnTimer', 'timerLabel', 'countdown', 'flash', 'resultImg', 'resultHint',
      'btnRetake', 'btnSave', 'btnRetry', 'errorTitle', 'errorMsg'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  var ctx = null;

  /* 拍攝畫面是底層版面，傳入 'camera' 即關閉所有覆蓋層 */
  function showScreen(name) {
    ['screenIntro', 'screenResult', 'screenError'].forEach(function (k) {
      el[k].classList.toggle('is-active', k === name);
    });
  }

  function isCameraActive() {
    return !el.screenIntro.classList.contains('is-active')
        && !el.screenResult.classList.contains('is-active')
        && !el.screenError.classList.contains('is-active');
  }

  /* ======================================================================
     設定載入
     ====================================================================== */

  function loadConfig() {
    if (typeof fetch !== 'function') return Promise.resolve(DEFAULT_CONFIG);

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CONFIG_TIMEOUT) : 0;

    return fetch(CONFIG_URL, { cache: 'no-cache', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        return merge(data);
      });
  }

  /* 只接受認得的欄位，缺項一律回退預設值 */
  function merge(data) {
    if (!data || typeof data !== 'object') return DEFAULT_CONFIG;

    var out = {
      title: typeof data.title === 'string' && data.title ? data.title : DEFAULT_CONFIG.title,
      countdown: typeof data.countdown === 'number' ? Math.max(0, data.countdown | 0) : DEFAULT_CONFIG.countdown,
      output: DEFAULT_CONFIG.output,
      frame: DEFAULT_CONFIG.frame,
      frames: DEFAULT_CONFIG.frames,
      sprites: DEFAULT_CONFIG.sprites,
      sizes: DEFAULT_CONFIG.sizes,
      motions: DEFAULT_CONFIG.motions
    };

    if (data.output && typeof data.output === 'object') {
      var ow = parseInt(data.output.width, 10);
      var oh = parseInt(data.output.height, 10);
      if (ow > 0 && oh > 0 && ow <= 4096 && oh <= 4096) {
        out.output = { width: ow, height: oh };
      }
    }

    if (data.frame && typeof data.frame === 'object') {
      out.frame = {
        enabled: data.frame.enabled !== false,
        label: typeof data.frame.label === 'string' ? data.frame.label : DEFAULT_CONFIG.frame.label
      };
    }

    /* 素材：必須指定圖片路徑 */
    if (Array.isArray(data.sprites)) {
      var validSprites = data.sprites.filter(function (s) {
        return s && s.enabled !== false && s.src;
      });
      if (validSprites.length) out.sprites = validSprites;
    }

    /* 大小：倍率須為正數 */
    if (Array.isArray(data.sizes)) {
      var validSizes = data.sizes.filter(function (z) {
        return z && z.enabled !== false && typeof z.factor === 'number' && z.factor > 0;
      });
      if (validSizes.length) out.sizes = validSizes;
    }

    /* 相框：只接受程式支援的樣式 */
    if (Array.isArray(data.frames)) {
      var validFrames = data.frames.filter(function (f) {
        return f && f.enabled !== false && PhotoEffects.hasFrame(f.type);
      });
      if (validFrames.length) out.frames = validFrames;
    }

    /* 動作：只接受程式支援的種類，避免設定錯字造成整頁失效 */
    if (Array.isArray(data.motions)) {
      var validMotions = data.motions.filter(function (m) {
        return m && m.enabled !== false && PhotoEffects.hasMotion(m.type);
      });
      if (validMotions.length) out.motions = validMotions;
    }

    return out;
  }

  /* ======================================================================
     選擇器：圖片與動作各一排，自由組合
     ====================================================================== */

  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0);
  }

  function buildPickers() {
    sprites = config.sprites.slice().sort(byOrder).map(function (meta) {
      return {
        meta: meta,
        instance: PhotoEffects.createSprite(meta),
        scale: typeof meta.scale === 'number' ? meta.scale : 1
      };
    }).filter(function (s) { return !!s.instance; });

    motions = config.motions.slice().sort(byOrder).map(function (meta) {
      return { meta: meta, instance: PhotoEffects.createMotion(meta.type, meta.options || {}) };
    }).filter(function (m) { return !!m.instance; });

    frames = config.frames.slice().sort(byOrder);
    sizes = config.sizes.slice().sort(byOrder);

    /* 預設大小取標記 default 的項目，未標記則取第一項 */
    var sizeIndex = 0;
    for (var i = 0; i < sizes.length; i++) {
      if (sizes[i]['default']) { sizeIndex = i; break; }
    }

    fillChips(el.spriteChips, sprites, selectSprite);
    fillChips(el.motionChips, motions, selectMotion);
    fillChips(el.frameChips, frames.map(function (f) { return { meta: f }; }), selectFrame);
    fillChips(el.sizeChips, sizes.map(function (z) { return { meta: z }; }), selectSize);

    currentSprite = sprites.length ? sprites[0] : null;
    currentMotion = motions.length ? motions[0] : null;
    currentFrame = frames.length ? frames[0] : null;
    currentSize = sizes[sizeIndex] || null;
    markSelected(el.sizeChips, sizeIndex);
    updateDragState();
  }

  function fillChips(host, list, onPick) {
    host.innerHTML = '';
    list.forEach(function (item, i) {
      var btn = document.createElement('button');
      btn.className = 'chip';
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.textContent = item.meta.name || item.meta.id;
      btn.setAttribute('aria-selected', String(i === 0));
      btn.addEventListener('click', function () { onPick(i); });
      host.appendChild(btn);
    });
  }

  function markSelected(host, index) {
    Array.prototype.forEach.call(host.children, function (c, i) {
      c.setAttribute('aria-selected', String(i === index));
    });
  }

  /* 選擇後不自動收合，讓使用者可連續調整圖片與動作，
     由「更換」按鈕控制展開與收合。 */
  function selectSprite(index) {
    currentSprite = sprites[index] || null;
    if (currentMotion) currentMotion.instance.reset(stage);
    markSelected(el.spriteChips, index);
  }

  function selectMotion(index) {
    currentMotion = motions[index] || null;
    if (currentMotion) currentMotion.instance.reset(stage);
    markSelected(el.motionChips, index);
    updateDragState();
  }

  /* ======================================================================
     自由擺放：拖曳角色
     --------------------------------------------------------------------
     只有標記 draggable 的動作會啟用。畫布為固定解析度並以 CSS 縮放，
     因此指標座標需依實際顯示尺寸換算回畫布座標。
     ====================================================================== */

  var dragging = false;

  function isDraggable() {
    return !!(currentMotion && currentMotion.instance.draggable && currentSprite);
  }

  function updateDragState() {
    var on = isDraggable();
    el.dragHint.hidden = !on;
    el.stage.classList.toggle('is-draggable', on);
    if (!on) {
      dragging = false;
      el.stage.classList.remove('is-dragging');
    }
  }

  function toCanvas(e) {
    var r = el.stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: (e.clientX - r.left) / r.width * stage.w,
      y: (e.clientY - r.top) / r.height * stage.h
    };
  }

  function currentScale() {
    return currentSprite.scale * (currentSize ? currentSize.factor : 1);
  }

  function onDragStart(e) {
    if (!isDraggable() || busy) return;
    var p = toCanvas(e);
    if (!p) return;

    var m = currentMotion.instance;
    if (!m.hitTest(p.x, p.y, stage, currentSprite.instance, currentScale())) return;

    dragging = true;
    el.stage.classList.add('is-dragging');
    closePickers();
    if (el.stage.setPointerCapture && e.pointerId !== undefined) {
      el.stage.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!dragging) return;
    var p = toCanvas(e);
    if (!p) return;
    currentMotion.instance.moveTo(p.x, p.y, stage, currentSprite.instance, currentScale());
    e.preventDefault();
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    el.stage.classList.remove('is-dragging');
  }

  function selectFrame(index) {
    currentFrame = frames[index] || null;
    markSelected(el.frameChips, index);
  }

  function selectSize(index) {
    /* 大小改變後角色可能超出邊界，稍後由 moveTo 夾住 */
    currentSize = sizes[index] || null;
    if (currentMotion) currentMotion.instance.reset(stage);
    markSelected(el.sizeChips, index);
  }

  function panels() {
    return [
      [el.pickersEffect, el.btnPickers],
      [el.pickersFrame, el.btnFrame]
    ];
  }

  function closePickers() {
    panels().forEach(function (p) {
      p[0].classList.remove('is-open');
      p[1].setAttribute('aria-expanded', 'false');
    });
  }

  /* 開啟其中一個面板時關閉另一個，避免控制列過高擠壓照片區 */
  function togglePanel(panel, btn) {
    var wasOpen = panel.classList.contains('is-open');
    closePickers();
    if (!wasOpen) {
      panel.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  /* ======================================================================
     舞台尺寸
     ====================================================================== */

  /* 輸出解析度固定於設定值，與螢幕大小無關，因此只需在啟動時設定一次。
     畫面上的顯示尺寸由 CSS 等比縮放，超出的部分以留白呈現。
     這確保每台裝置拍出的照片尺寸、構圖與相框比例完全一致。 */
  function setStageSize() {
    var w = config.output.width;
    var h = config.output.height;

    el.stage.width = w;
    el.stage.height = h;

    stage.w = w;
    stage.h = h;
    stage.u = h / 1000;

    motions.forEach(function (m) { m.instance.reset(stage); });
  }

  /* ======================================================================
     相機
     ====================================================================== */

  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  function startCamera() {
    stopCamera();

    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: facing,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    }).then(function (s) {
      stream = s;
      el.source.srcObject = s;
      return el.source.play();
    });
  }

  function describeError(err) {
    if (!window.isSecureContext) {
      return '瀏覽器僅允許在 HTTPS 或 localhost 環境下使用相機，請確認網址為 https 開頭。';
    }
    if (!cameraSupported()) {
      return '此瀏覽器不支援相機功能，請改用較新版本的 Chrome、Safari 或 Edge。';
    }
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '相機權限遭拒。請在瀏覽器網址列的權限設定中允許相機，再重新嘗試。';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return '找不到可用的相機裝置。';
      case 'NotReadableError':
        return '相機正被其他程式使用，請關閉其他應用程式後重試。';
      default:
        return '相機啟動失敗' + (err && err.name ? '（' + err.name + '）' : '') + '，請重新嘗試。';
    }
  }

  function fail(err) {
    stopLoop();
    stopCamera();
    el.errorTitle.textContent = '無法啟動相機';
    el.errorMsg.textContent = describeError(err);
    showScreen('screenError');
  }

  /* 合成失敗：多半是素材圖片來自其他網域且未提供 CORS 標頭，
     導致 canvas 被標記為受汙染而禁止輸出。 */
  function failCapture(err) {
    stopLoop();
    el.errorTitle.textContent = '無法輸出照片';

    if (err && (err.name === 'SecurityError' || err.name === 'InvalidStateError')) {
      el.errorMsg.textContent =
        '素材圖片與網頁不同來源，瀏覽器基於安全限制禁止輸出合成結果。' +
        '請將 assets 圖片放到與網頁相同的網域下。';
    } else {
      el.errorMsg.textContent = '照片合成失敗，請重新嘗試。';
    }

    showScreen('screenError');
  }

  /* ======================================================================
     算圖迴圈
     ====================================================================== */

  function drawVideo() {
    if (PREVIEW) {
      PhotoEffects.drawBackdrop(ctx, stage);
      return;
    }

    var v = el.source;
    var vw = v.videoWidth;
    var vh = v.videoHeight;
    if (!vw || !vh) return;

    /* 以 cover 方式填滿畫面並置中裁切 */
    var scale = Math.max(stage.w / vw, stage.h / vh);
    var dw = vw * scale;
    var dh = vh * scale;
    var dx = (stage.w - dw) / 2;
    var dy = (stage.h - dh) / 2;

    ctx.save();
    /* 前鏡頭做水平鏡像，符合使用者照鏡子的直覺；動畫不受影響 */
    if (facing === 'user') {
      ctx.translate(stage.w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, dx, dy, dw, dh);
    ctx.restore();
  }

  function renderOnce(dt) {
    ctx.clearRect(0, 0, stage.w, stage.h);
    drawVideo();

    /* 動作只負責運動，素材只負責外觀，兩者在此組合 */
    if (currentMotion && currentSprite) {
      var sprite = currentSprite.instance;
      var scale = currentSprite.scale * (currentSize ? currentSize.factor : 1);
      currentMotion.instance.update(dt, stage, sprite, scale);
      currentMotion.instance.draw(ctx, stage, sprite, scale);
    }

    if (currentFrame) {
      PhotoEffects.drawFrame(ctx, stage, currentFrame.type,
        currentFrame.label !== undefined ? currentFrame.label : config.frame.label);
    }
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
    lastTime = now;
    renderOnce(dt);
  }

  function startLoop() {
    if (running) return;
    running = true;
    lastTime = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ======================================================================
     拍攝
     ====================================================================== */

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function tick(text) {
    el.countdown.textContent = text;
    el.countdown.classList.remove('is-tick');
    void el.countdown.offsetWidth;   /* 重置動畫 */
    el.countdown.classList.add('is-tick');
  }

  function capture() {
    if (busy) return;
    busy = true;
    closePickers();
    el.btnShutter.disabled = true;

    var n = timerOn ? config.countdown : 0;

    (function step() {
      if (n > 0) {
        tick(String(n));
        n--;
        wait(1000).then(step);
        return;
      }

      el.flash.classList.remove('is-firing');
      void el.flash.offsetWidth;
      el.flash.classList.add('is-firing');

      /* 於下一幀輸出，確保取到的是最新畫面 */
      requestAnimationFrame(function () {
        try {
          el.stage.toBlob(function (blob) {
            busy = false;
            el.btnShutter.disabled = false;
            if (!blob) { failCapture(null); return; }
            showResult(blob);
          }, 'image/png');
        } catch (err) {
          busy = false;
          el.btnShutter.disabled = false;
          failCapture(err);
        }
      });
    })();
  }

  function showResult(blob) {
    stopLoop();
    if (photoUrl) URL.revokeObjectURL(photoUrl);

    photoBlob = blob;
    photoUrl = URL.createObjectURL(blob);
    el.resultImg.src = photoUrl;
    el.resultHint.textContent = '';
    showScreen('screenResult');
  }

  /* ======================================================================
     儲存
     --------------------------------------------------------------------
     優先使用系統分享（iOS 可直接存入「照片」App），不支援時退回一般下載。
     ====================================================================== */

  function filename() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return 'photo-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.png';
  }

  function savePhoto() {
    if (!photoBlob) return;

    var name = filename();
    var file = null;

    try {
      file = new File([photoBlob], name, { type: 'image/png' });
    } catch (e) {
      file = null;   /* 舊版瀏覽器不支援 File 建構式 */
    }

    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] })
        .then(function () {
          el.resultHint.textContent = '已開啟分享選單，可選擇「儲存影像」。';
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;   /* 使用者取消 */
          download(name);
        });
      return;
    }

    download(name);
  }

  function download(name) {
    var a = document.createElement('a');
    a.href = photoUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    el.resultHint.textContent = '照片已下載，請至裝置的下載或檔案位置查看。';
  }

  /* ======================================================================
     流程控制
     ====================================================================== */

  function enterCamera() {
    if (PREVIEW) {
      showScreen('camera');
      
      startLoop();
      return;
    }

    if (!cameraSupported() || !window.isSecureContext) { fail(null); return; }

    el.btnStart.disabled = true;
    startCamera().then(function () {
      el.btnStart.disabled = false;
      showScreen('camera');
      
      startLoop();
    }).catch(function (err) {
      el.btnStart.disabled = false;
      fail(err);
    });
  }

  function flipCamera() {
    if (PREVIEW) return;
    facing = (facing === 'user') ? 'environment' : 'user';
    startCamera().catch(fail);
  }

  /* 倒數秒數：在設定的秒數與「按下即拍」之間切換 */
  function toggleTimer() {
    timerOn = !timerOn;
    el.btnTimer.setAttribute('aria-pressed', String(timerOn));
    el.timerLabel.textContent = timerOn ? (config.countdown + ' 秒') : '即拍';
  }


  function retake() {
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = ''; }
    photoBlob = null;
    el.resultImg.removeAttribute('src');
    showScreen('camera');
    
    startLoop();
  }

  /* ======================================================================
     啟動
     ====================================================================== */

  function bind() {
    el.btnStart.addEventListener('click', enterCamera);
    el.btnRetry.addEventListener('click', enterCamera);
    el.btnShutter.addEventListener('click', capture);
    el.btnPickers.addEventListener('click', function () {
      togglePanel(el.pickersEffect, el.btnPickers);
    });
    el.btnFrame.addEventListener('click', function () {
      togglePanel(el.pickersFrame, el.btnFrame);
    });
    el.btnTimer.addEventListener('click', toggleTimer);
    el.stage.addEventListener('pointerdown', onDragStart);
    el.stage.addEventListener('pointermove', onDragMove);
    el.stage.addEventListener('pointerup', onDragEnd);
    el.stage.addEventListener('pointercancel', onDragEnd);

    el.btnFlip.addEventListener('click', flipCamera);
    el.btnSave.addEventListener('click', savePhoto);
    el.btnRetake.addEventListener('click', retake);


    /* 切到背景時停止算圖，回到前景再恢復，避免無謂耗電 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopLoop();
      } else if (isCameraActive()) {
        startLoop();
      }
    });
  }

  function init() {
    cacheDom();
    ctx = el.stage.getContext('2d');

    loadConfig().then(function (cfg) {
      config = cfg;
      el.introTitle.textContent = config.title;
      el.barTitle.textContent = config.title;
      document.title = config.title;

      /* 設定為 0 秒時沒有可切換的對象，直接隱藏按鈕 */
      timerOn = config.countdown > 0;
      el.btnTimer.hidden = config.countdown <= 0;
      el.btnTimer.setAttribute('aria-pressed', String(timerOn));
      el.timerLabel.textContent = timerOn ? (config.countdown + ' 秒') : '即拍';

      buildPickers();
      setStageSize();
      bind();

      if (PREVIEW) enterPreview();
    });
  }

  /* 預覽模式：直接進入拍攝畫面，並標示相機未啟用 */
  function enterPreview() {
    var badge = document.createElement('div');
    badge.className = 'preview-badge';
    badge.textContent = '預覽模式 · 未啟用相機';
    el.stageWrap.appendChild(badge);

    el.btnFlip.disabled = true;
    el.btnFlip.setAttribute('aria-pressed', 'false');

    enterCamera();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
