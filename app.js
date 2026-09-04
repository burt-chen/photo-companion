/* ==========================================================================
   互動拍照模組 — 主程式
   --------------------------------------------------------------------------
   負責：設定載入 / 相機控制 / 算圖迴圈 / 照片合成 / 介面 / 儲存

   設計重點：
   1. 相機畫面與動畫「都畫在同一張 canvas」上，按下快門就是直接輸出這張
      canvas，因此預覽與成品保證完全一致。
   2. 照片全程在瀏覽器內合成，不會上傳任何伺服器。
   3. 所有素材皆為向量（見 effects.js），沒有任何外部圖檔，因此不會發生
      跨來源圖片汙染 canvas 而導致無法匯出照片的問題。

   角色造型與動畫參數請改 effects.js，本檔案通常不需要調整。
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
    frame: {
      enabled: true,
      label: 'ART IN COMMON'
    },
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
    motions: [
      { id: 'walk', name: '來回走動', type: 'walker', enabled: true, order: 1, options: {} },
      { id: 'jump', name: '原地蹦跳', type: 'jumper', enabled: true, order: 2, options: {} },
      { id: 'fall', name: '持續落下', type: 'rain', enabled: true, order: 3, options: {} }
    ]
  };

  var CONFIG_URL = './config.json';
  var CONFIG_TIMEOUT = 2500;
  var MAX_EDGE = 1920;          /* canvas 長邊上限，避免大螢幕產生過大點陣 */

  /* 預覽模式：網址加上 ?preview=1 時不啟動相機，改用模擬背景，
     供版面與動畫檢視使用。正式部署的一般網址不受影響。 */
  var PREVIEW = /[?&]preview=1/.test(window.location.search);

  /* ======================================================================
     狀態
     ====================================================================== */

  var config = DEFAULT_CONFIG;
  var sprites = [];             /* [{ meta, instance }] */
  var motions = [];             /* [{ meta, instance }] */
  var currentSprite = null;
  var currentMotion = null;
  var frameOn = true;

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
      'stage', 'source', 'screenIntro', 'screenCamera', 'screenResult', 'screenError',
      'introTitle', 'barTitle', 'btnStart', 'btnShutter', 'btnFlip', 'btnFrame',
      'spriteChips', 'motionChips', 'pickers', 'btnPickers', 'pickerSummary',
      'countdown', 'flash', 'resultImg', 'resultHint',
      'btnRetake', 'btnSave', 'btnRetry', 'errorTitle', 'errorMsg'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  var ctx = null;

  function showScreen(name) {
    ['screenIntro', 'screenCamera', 'screenResult', 'screenError'].forEach(function (k) {
      el[k].classList.toggle('is-active', k === name);
    });
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
      frame: DEFAULT_CONFIG.frame,
      sprites: DEFAULT_CONFIG.sprites,
      motions: DEFAULT_CONFIG.motions
    };

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

    fillChips(el.spriteChips, sprites, selectSprite);
    fillChips(el.motionChips, motions, selectMotion);

    currentSprite = sprites.length ? sprites[0] : null;
    currentMotion = motions.length ? motions[0] : null;
    updateSummary();
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
    updateSummary();
  }

  function selectMotion(index) {
    currentMotion = motions[index] || null;
    if (currentMotion) currentMotion.instance.reset(stage);
    markSelected(el.motionChips, index);
    updateSummary();
  }

  /* 收合狀態下，按鈕直接顯示目前的組合，不必展開就知道選了什麼 */
  function updateSummary() {
    var a = currentSprite ? (currentSprite.meta.name || currentSprite.meta.id) : '';
    var b = currentMotion ? (currentMotion.meta.name || currentMotion.meta.id) : '';
    el.pickerSummary.textContent = (a && b) ? (a + ' · ' + b) : '更換';
  }

  function openPickers() {
    el.pickers.classList.add('is-open');
    el.btnPickers.setAttribute('aria-expanded', 'true');
  }

  function closePickers() {
    el.pickers.classList.remove('is-open');
    el.btnPickers.setAttribute('aria-expanded', 'false');
  }

  function togglePickers() {
    if (el.pickers.classList.contains('is-open')) closePickers();
    else openPickers();
  }

  /* ======================================================================
     舞台尺寸
     ====================================================================== */

  function resize() {
    var rect = el.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = rect.width * dpr;
    var h = rect.height * dpr;

    /* 限制長邊，避免高解析度裝置產生過大的 canvas */
    var over = Math.max(w, h) / MAX_EDGE;
    if (over > 1) { w /= over; h /= over; }

    el.stage.width = Math.round(w);
    el.stage.height = Math.round(h);

    stage.w = el.stage.width;
    stage.h = el.stage.height;
    stage.u = stage.h / 1000;

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
      var scale = currentSprite.scale;
      currentMotion.instance.update(dt, stage, sprite, scale);
      currentMotion.instance.draw(ctx, stage, sprite, scale);
    }

    if (frameOn && config.frame.enabled) {
      PhotoEffects.drawFrame(ctx, stage, config.frame.label);
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

    var n = config.countdown;

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
      showScreen('screenCamera');
      resize();
      startLoop();
      return;
    }

    if (!cameraSupported() || !window.isSecureContext) { fail(null); return; }

    el.btnStart.disabled = true;
    startCamera().then(function () {
      el.btnStart.disabled = false;
      showScreen('screenCamera');
      resize();
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

  function toggleFrame() {
    frameOn = !frameOn;
    el.btnFrame.setAttribute('aria-pressed', String(frameOn));
  }

  function retake() {
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = ''; }
    photoBlob = null;
    el.resultImg.removeAttribute('src');
    showScreen('screenCamera');
    resize();
    startLoop();
  }

  /* ======================================================================
     啟動
     ====================================================================== */

  function bind() {
    el.btnStart.addEventListener('click', enterCamera);
    el.btnRetry.addEventListener('click', enterCamera);
    el.btnShutter.addEventListener('click', capture);
    el.btnPickers.addEventListener('click', togglePickers);
    el.btnFlip.addEventListener('click', flipCamera);
    el.btnFrame.addEventListener('click', toggleFrame);
    el.btnSave.addEventListener('click', savePhoto);
    el.btnRetake.addEventListener('click', retake);

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () {
      setTimeout(resize, 250);
    });

    /* 切到背景時停止算圖，回到前景再恢復，避免無謂耗電 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopLoop();
      } else if (el.screenCamera.classList.contains('is-active')) {
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

      el.btnFrame.setAttribute('aria-pressed', String(config.frame.enabled));
      frameOn = config.frame.enabled;

      buildPickers();
      resize();
      bind();

      if (PREVIEW) enterPreview();
    });
  }

  /* 預覽模式：直接進入拍攝畫面，並標示相機未啟用 */
  function enterPreview() {
    var badge = document.createElement('div');
    badge.className = 'preview-badge';
    badge.textContent = '預覽模式 · 未啟用相機';
    document.getElementById('app').appendChild(badge);

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
