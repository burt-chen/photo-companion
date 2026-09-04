/* ==========================================================================
   互動拍照模組 — 素材與動作
   --------------------------------------------------------------------------
   本檔案把「畫什麼」與「怎麼動」拆成兩個獨立概念，可自由組合：

     素材 Sprite ── 角色的外觀，來自 assets 資料夾的圖片檔。
     動作 Motion ── 角色的運動方式（來回走動、原地蹦跳、持續落下）。

   任何素材都能套用任何動作，設定於 config.json。

   對外介面：
     PhotoEffects.createSprite(def)            -> { w, h, draw(ctx, st) }
     PhotoEffects.createMotion(type, options)  -> { reset, update, draw(ctx, stage, sprite, scale) }
     PhotoEffects.hasMotion(type)
     PhotoEffects.drawFrame(ctx, stage, label)
     PhotoEffects.drawBackdrop(ctx, stage)

   座標約定
     素材一律「以自身中心為原點」繪製，高度正規化為 100 單位，
     寬度依原圖比例換算。動作只負責決定位置、旋轉與縮放，
     因此換圖不需要調整動作，換動作也不需要調整圖。

   圖片來源
     圖片必須與網頁放在同一個網域。跨網域的圖片會使 canvas 被標記為
     受汙染，導致無法輸出合成照片。

   stage 物件：{ w, h, u }，u 為縮放單位（h / 1000）。
   st 物件：{ time, phase, spread }，動作提供給素材的運動狀態。
   ========================================================================== */

(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var UNIT = 100;          /* 素材正規化高度 */

  /* 角色會疊在任意相機畫面上，加一層柔和陰影，深色與淺色背景都能看清楚 */
  function withShadow(ctx, fn) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    fn();
    ctx.restore();
  }

  /* ======================================================================
     素材：圖片
     --------------------------------------------------------------------
     支援單張圖，或多格連續動作圖：
       單張圖              省略 cols / rows / frames
       橫向一排 N 格        frames: N
       網格 C 欄 R 列       cols: C, rows: R（frames 可省略，預設 C×R）
     取格順序為先左至右、再上至下。

     圖片載入失敗時不繪製任何內容，畫面上就不會出現該角色。
     ====================================================================== */

  function ImageSprite(def) {
    var cols = parseInt(def.cols, 10) || 0;
    var rows = parseInt(def.rows, 10) || 0;
    var frames = parseInt(def.frames, 10) || 0;

    if (!cols && !rows) { cols = frames || 1; rows = 1; }
    else { cols = cols || 1; rows = rows || 1; }

    this.cols = cols;
    this.rows = rows;
    this.frames = Math.max(1, Math.min(frames || cols * rows, cols * rows));

    this.fps = def.fps || 12;
    /* 淺色線稿疊在明亮的相機畫面上會看不清楚，預設加一層柔和陰影。
       深色或本身已有輪廓的素材可在設定中加上 "shadow": false 關閉。 */
    this.shadow = def.shadow !== false;

    this.ready = false;
    this.failed = false;
    this.w = UNIT;
    this.h = UNIT;

    var self = this;
    var img = new Image();

    img.onload = function () {
      var fw = img.naturalWidth / self.cols;
      var fh = img.naturalHeight / self.rows;
      if (!fw || !fh) { self.failed = true; return; }

      self.img = img;
      self.fw = fw;
      self.fh = fh;
      self.h = UNIT;
      self.w = UNIT * (fw / fh);
      self.ready = true;
    };

    img.onerror = function () {
      self.failed = true;
      if (global.console) {
        console.warn('[素材] 圖片載入失敗，此角色不會顯示：' + def.src);
      }
    };

    img.src = def.src;
  }

  ImageSprite.prototype.draw = function (ctx, st) {
    /* 尚未載入或載入失敗：不繪製任何內容 */
    if (!this.ready) return;

    var f = 0;
    if (this.frames > 1) {
      f = Math.floor((st.time || 0) * this.fps) % this.frames;
    }

    var cx = f % this.cols;
    var cy = Math.floor(f / this.cols);
    var self = this;

    var blit = function () {
      ctx.drawImage(
        self.img,
        cx * self.fw, cy * self.fh, self.fw, self.fh,
        -self.w / 2, -self.h / 2, self.w, self.h
      );
    };

    if (this.shadow) withShadow(ctx, blit);
    else blit();
  };

  /* ======================================================================
     動作一：底部來回走動
     ====================================================================== */

  function Walker(opt) {
    this.speed = opt.speed || 150;       /* 每秒移動的畫面單位 */
    this.ground = opt.ground || 60;      /* 距離底部的高度 */
    this.cycle = opt.cycle || 1.6;       /* 每秒走幾個循環 */
    this.x = 0;
    this.dir = 1;
    this.time = 0;
    this.phase = 0;
  }

  Walker.prototype.reset = function (stage) {
    this.x = stage.w * 0.5;
    this.dir = 1;
    this.time = 0;
    this.phase = 0;
  };

  Walker.prototype.update = function (dt, stage, sprite, scale) {
    this.time += dt;
    this.x += this.speed * stage.u * dt * this.dir;
    this.phase = (this.phase + dt * this.cycle) % 1;

    var pad = sprite.w * 0.5 * stage.u * scale;
    if (this.x > stage.w - pad) { this.x = stage.w - pad; this.dir = -1; }
    if (this.x < pad) { this.x = pad; this.dir = 1; }
  };

  Walker.prototype.draw = function (ctx, stage, sprite, scale) {
    var s = stage.u * scale;
    ctx.save();
    ctx.translate(this.x, stage.h - this.ground * stage.u - sprite.h * 0.5 * s);
    ctx.scale(this.dir * s, s);
    sprite.draw(ctx, { time: this.time, phase: this.phase, spread: 0 });
    ctx.restore();
  };

  /* ======================================================================
     動作二：底部原地蹦跳
     ====================================================================== */

  function Jumper(opt) {
    this.jumpDur = opt.jumpDur || 0.72;   /* 一次跳躍的秒數 */
    this.restDur = opt.restDur || 0.45;   /* 落地後停頓的秒數 */
    this.height = opt.height || 210;      /* 跳躍高度（畫面單位） */
    this.ground = opt.ground || 60;
    this.time = 0;
    this.t = 0;
    this.x = 0;
  }

  Jumper.prototype.reset = function (stage) {
    this.x = stage.w * 0.5;
    this.t = 0;
    this.time = 0;
  };

  Jumper.prototype.update = function (dt) {
    this.time += dt;
    this.t = (this.t + dt) % (this.jumpDur + this.restDur);
  };

  Jumper.prototype.draw = function (ctx, stage, sprite, scale) {
    var s = stage.u * scale;
    var lift = 0;
    var sy = 1;
    var spread = 0;
    var phase = 0;

    if (this.t < this.jumpDur) {
      var u = this.t / this.jumpDur;
      phase = u;
      lift = Math.sin(u * Math.PI) * this.height * stage.u;
      /* 起跳拉長、落地壓扁，並反向縮放橫軸維持體積感 */
      sy = 1 + 0.13 * Math.cos(u * Math.PI);
      spread = Math.sin(u * Math.PI);
    } else {
      /* 停頓期的呼吸起伏 */
      var r = (this.t - this.jumpDur) / this.restDur;
      sy = 1 - 0.05 * Math.sin(r * Math.PI);
    }

    ctx.save();
    ctx.translate(this.x, stage.h - this.ground * stage.u - lift - sprite.h * 0.5 * s * sy);
    ctx.scale(s / sy, s * sy);
    sprite.draw(ctx, { time: this.time, phase: phase, spread: spread });
    ctx.restore();
  };

  /* ======================================================================
     動作三：由上方持續落下
     ====================================================================== */

  function Rain(opt) {
    this.count = opt.count || 9;
    this.minSpeed = opt.minSpeed || 170;
    this.maxSpeed = opt.maxSpeed || 300;
    this.spin = opt.spin === undefined ? 1 : opt.spin;   /* 0 可關閉旋轉 */
    this.sway = opt.sway === undefined ? 22 : opt.sway;
    this.time = 0;
    this.items = [];
  }

  Rain.prototype.spawn = function (stage, aloft) {
    return {
      x: Math.random() * stage.w,
      y: aloft ? Math.random() * stage.h : -120 * stage.u,
      vy: (this.minSpeed + Math.random() * (this.maxSpeed - this.minSpeed)) * stage.u,
      swayPhase: Math.random() * TAU,
      rot: Math.random() * TAU,
      vrot: (Math.random() - 0.5) * 2.4 * this.spin,
      size: 0.62 + Math.random() * 0.55
    };
  };

  Rain.prototype.reset = function (stage) {
    this.time = 0;
    this.items = [];
    for (var i = 0; i < this.count; i++) {
      this.items.push(this.spawn(stage, true));
    }
  };

  Rain.prototype.update = function (dt, stage) {
    if (!this.items.length) this.reset(stage);
    this.time += dt;

    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      it.y += it.vy * dt;
      it.rot += it.vrot * dt;
      it.swayPhase += dt * 1.7;
      if (it.y > stage.h + 120 * stage.u) {
        this.items[i] = this.spawn(stage, false);
      }
    }
  };

  Rain.prototype.draw = function (ctx, stage, sprite, scale) {
    var st = { time: this.time, phase: 0, spread: 0 };

    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var s = stage.u * scale * it.size;
      ctx.save();
      ctx.translate(it.x + Math.sin(it.swayPhase) * this.sway * stage.u, it.y);
      ctx.rotate(it.rot);
      ctx.scale(s, s);
      sprite.draw(ctx, st);
      ctx.restore();
    }
  };

  /* ======================================================================
     相框：以向量繪製的預設外框
     正式美術素材到位後，可在此改為 drawImage
     ====================================================================== */

  function drawFrame(ctx, stage, label) {
    var u = stage.u;
    var w = stage.w;
    var h = stage.h;
    var pad = 26 * u;

    ctx.save();

    var vign = ctx.createLinearGradient(0, h * 0.62, 0, h);
    vign.addColorStop(0, 'rgba(0,0,0,0)');
    vign.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vign;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);

    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 3 * u;
    ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);

    var arm = 46 * u;
    var off = pad + 14 * u;
    var corners = [
      [off, off, 1, 1],
      [w - off, off, -1, 1],
      [off, h - off, 1, -1],
      [w - off, h - off, -1, -1]
    ];
    ctx.lineWidth = 6 * u;
    ctx.lineCap = 'round';
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      ctx.beginPath();
      ctx.moveTo(c[0] + arm * c[2], c[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] + arm * c[3]);
      ctx.stroke();
    }

    if (label) {
      ctx.font = '600 ' + Math.round(21 * u) + 'px "Noto Sans TC", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 10 * u;
      ctx.fillText(label, w / 2, h - pad - 24 * u);
    }

    ctx.restore();
  }

  /* ======================================================================
     預覽用模擬背景
     --------------------------------------------------------------------
     僅在預覽模式（網址加上 ?preview=1）取代相機畫面使用，
     讓角色與相框可以在接近實際拍攝的明暗條件下檢視。
     ====================================================================== */

  function drawBackdrop(ctx, stage) {
    var w = stage.w;
    var h = stage.h;

    var sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#6E9CBF');
    sky.addColorStop(0.52, '#BBD3DD');
    sky.addColorStop(0.53, '#C6B99F');
    sky.addColorStop(1, '#7E7059');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    var glow = ctx.createRadialGradient(w * 0.74, h * 0.16, 0, w * 0.74, h * 0.16, h * 0.42);
    glow.addColorStop(0, 'rgba(255, 246, 220, 0.55)');
    glow.addColorStop(1, 'rgba(255, 246, 220, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.fillStyle = 'rgba(70, 92, 78, 0.42)';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.53);
    ctx.lineTo(w * 0.26, h * 0.38);
    ctx.lineTo(w * 0.48, h * 0.53);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.42, h * 0.53);
    ctx.lineTo(w * 0.68, h * 0.34);
    ctx.lineTo(w * 0.95, h * 0.53);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    var ground = ctx.createLinearGradient(0, h * 0.53, 0, h);
    ground.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
    ground.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
    ctx.fillStyle = ground;
    ctx.fillRect(0, h * 0.53, w, h * 0.47);
  }

  /* ======================================================================
     對外介面
     ====================================================================== */

  var MOTIONS = { walker: Walker, jumper: Jumper, rain: Rain };

  global.PhotoEffects = {

    hasMotion: function (type) {
      return Object.prototype.hasOwnProperty.call(MOTIONS, type);
    },

    /* def 為 { src, cols, rows, frames, fps, shadow } */
    createSprite: function (def) {
      if (!def || !def.src) return null;
      return new ImageSprite(def);
    },

    createMotion: function (type, options) {
      var Ctor = MOTIONS[type];
      if (!Ctor) return null;
      return new Ctor(options || {});
    },

    drawFrame: drawFrame,
    drawBackdrop: drawBackdrop
  };

})(window);
