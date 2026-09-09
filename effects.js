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
     拖曳共用工具
     --------------------------------------------------------------------
     位置以「腳底線 footY」記錄而非中心點，切換角色大小時腳底才會維持
     在同一條線上，不會浮起或陷入。
     ====================================================================== */

  /* 命中判定，範圍略為放寬並保證最小觸控尺寸 */
  function hitBox(cx, cy, x, y, stage, sprite, s, pad, extraUp) {
    var hw = Math.max(sprite.w * 0.5 * s * pad, 44 * stage.u);
    var hh = Math.max(sprite.h * 0.5 * s * pad, 44 * stage.u);
    return Math.abs(x - cx) <= hw &&
           y >= cy - hh - (extraUp || 0) &&
           y <= cy + hh;
  }

  /* 將指標座標換算為新的位置，並限制在畫面內 */
  function placeAt(motion, x, y, stage, sprite, scale) {
    var s = stage.u * scale;
    var halfH = sprite.h * 0.5 * s;
    var hw = sprite.w * 0.5 * s * 0.4;
    var hh = halfH * 0.4;

    motion.x = Math.max(hw, Math.min(stage.w - hw, x));
    motion.footY = Math.max(hh, Math.min(stage.h - hh, y)) + halfH;
  }

  /* ======================================================================
     動作零：自由擺放
     --------------------------------------------------------------------
     角色不自行移動，由使用者拖曳到任意位置。draggable 標記讓介面知道
     這個動作需要開啟拖曳，並顯示操作提示。
     ====================================================================== */

  function Static(opt) {
    this.breathe = opt.breathe !== false;   /* 輕微呼吸起伏，避免完全靜止 */
    this.startX = opt.startX;               /* 0..1，佔畫面寬度的比例 */
    this.startY = opt.startY;
    this.time = 0;
    this.x = null;
    this.y = null;
  }

  Static.prototype.draggable = true;

  /* 已經擺放過就保留位置，切換素材或大小時不會跳回原點 */
  Static.prototype.reset = function (stage) {
    this.time = 0;
    /* 舞台尚未取得尺寸時不初始化，留待尺寸確定後的下一次 reset */
    if (!stage.w || !stage.h) return;
    if (this.x === null) {
      this.x = stage.w * (typeof this.startX === 'number' ? this.startX : 0.5);
      this.y = stage.h * (typeof this.startY === 'number' ? this.startY : 0.72);
    }
  };

  Static.prototype.update = function (dt) {
    this.time += dt;
  };

  /* 移動到指定的畫布座標，並限制在畫面內留一小段邊界 */
  Static.prototype.moveTo = function (x, y, stage, sprite, scale) {
    var hw = sprite.w * 0.5 * stage.u * scale * 0.4;
    var hh = sprite.h * 0.5 * stage.u * scale * 0.4;
    this.x = Math.max(hw, Math.min(stage.w - hw, x));
    this.y = Math.max(hh, Math.min(stage.h - hh, y));
  };

  /* 判斷座標是否落在角色上，範圍略為放寬以利觸控 */
  Static.prototype.hitTest = function (x, y, stage, sprite, scale) {
    var s = stage.u * scale;
    var hw = sprite.w * 0.5 * s * 1.25;
    var hh = sprite.h * 0.5 * s * 1.25;
    var minTouch = 44 * stage.u;
    hw = Math.max(hw, minTouch);
    hh = Math.max(hh, minTouch);
    return Math.abs(x - this.x) <= hw && Math.abs(y - this.y) <= hh;
  };

  Static.prototype.draw = function (ctx, stage, sprite, scale) {
    var s = stage.u * scale;
    var sy = this.breathe ? 1 + 0.018 * Math.sin(this.time * 2.2) : 1;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(s, s * sy);
    sprite.draw(ctx, { time: this.time, phase: 0, spread: 0 });
    ctx.restore();
  };

  /* ======================================================================
     動作一：底部來回走動
     ====================================================================== */

  function Walker(opt) {
    this.speed = opt.speed || 150;       /* 每秒移動的畫面單位 */
    this.ground = opt.ground || 60;      /* 預設的距離底部高度 */
    this.cycle = opt.cycle || 1.6;       /* 每秒走幾個循環 */
    this.x = null;
    this.footY = null;                   /* 走動的水平線，可由拖曳調整 */
    this.dir = 1;
    this.time = 0;
    this.phase = 0;
    this.isDragging = false;
  }

  Walker.prototype.draggable = true;

  /* 已擺放過就保留位置，切換素材或大小時不跳回原處 */
  Walker.prototype.reset = function (stage) {
    this.time = 0;
    this.phase = 0;
    if (!stage.w || !stage.h) return;
    if (this.x === null) this.x = stage.w * 0.5;
    if (this.footY === null) this.footY = stage.h - this.ground * stage.u;
  };

  Walker.prototype.update = function (dt, stage, sprite, scale) {
    this.time += dt;
    if (this.isDragging) return;         /* 拖曳期間暫停，才抓得住 */

    this.x += this.speed * stage.u * dt * this.dir;
    this.phase = (this.phase + dt * this.cycle) % 1;

    var pad = sprite.w * 0.5 * stage.u * scale;
    if (this.x > stage.w - pad) { this.x = stage.w - pad; this.dir = -1; }
    if (this.x < pad) { this.x = pad; this.dir = 1; }
  };

  Walker.prototype.hitTest = function (x, y, stage, sprite, scale) {
    var s = stage.u * scale;
    return hitBox(this.x, this.footY - sprite.h * 0.5 * s, x, y, stage, sprite, s, 1.4, 0);
  };

  Walker.prototype.moveTo = function (x, y, stage, sprite, scale) {
    placeAt(this, x, y, stage, sprite, scale);
  };

  Walker.prototype.draw = function (ctx, stage, sprite, scale) {
    var s = stage.u * scale;
    ctx.save();
    ctx.translate(this.x, this.footY - sprite.h * 0.5 * s);
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
    this.ground = opt.ground || 60;       /* 預設的距離底部高度 */
    this.time = 0;
    this.t = 0;
    this.x = null;
    this.footY = null;                    /* 落地的水平線，可由拖曳調整 */
    this.isDragging = false;
  }

  Jumper.prototype.draggable = true;

  Jumper.prototype.reset = function (stage) {
    this.t = 0;
    this.time = 0;
    if (!stage.w || !stage.h) return;
    if (this.x === null) this.x = stage.w * 0.5;
    if (this.footY === null) this.footY = stage.h - this.ground * stage.u;
  };

  Jumper.prototype.update = function (dt) {
    this.time += dt;
    /* 拖曳期間停在落地狀態，位置才好對準 */
    if (this.isDragging) { this.t = 0; return; }
    this.t = (this.t + dt) % (this.jumpDur + this.restDur);
  };

  /* 角色在跳躍中，命中範圍往上延伸涵蓋整段跳躍高度 */
  Jumper.prototype.hitTest = function (x, y, stage, sprite, scale) {
    var s = stage.u * scale;
    var cy = this.footY - sprite.h * 0.5 * s;
    return hitBox(this.x, cy, x, y, stage, sprite, s, 1.4, this.height * stage.u);
  };

  Jumper.prototype.moveTo = function (x, y, stage, sprite, scale) {
    placeAt(this, x, y, stage, sprite, scale);
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
    ctx.translate(this.x, this.footY - lift - sprite.h * 0.5 * s * sy);
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

    /* 避免重疊：把畫面切成與數量相同的直向軌道，每個個體固定佔一條，
       隨機位移與左右飄動都夾在自己的軌道內，因此不會左右相疊。
       軌道寬度為畫面寬除以數量；若素材比軌道還寬則無法完全避免，
       此時個體會盡量停在軌道中央。 */
    this.noOverlap = opt.noOverlap !== false;

    this.time = 0;
    this.items = [];
  }

  /* 計算個體當下的水平位置 */
  Rain.prototype.itemX = function (it, stage, sprite, scale) {
    if (!this.noOverlap) {
      return it.x + Math.sin(it.swayPhase) * this.sway * stage.u;
    }

    var laneW = stage.w / this.count;
    var center = (it.lane + 0.5) * laneW;

    /* 軌道內扣掉素材本身寬度後，剩餘的可活動空間 */
    var halfSprite = sprite.w * 0.5 * stage.u * scale * it.size;
    var free = Math.max(0, laneW * 0.5 - halfSprite);

    var swayAmp = Math.min(this.sway * stage.u, free);
    var jitterAmp = Math.max(0, free - swayAmp);

    return center + it.jitter * jitterAmp + Math.sin(it.swayPhase) * swayAmp;
  };

  Rain.prototype.spawn = function (stage, aloft, lane) {
    return {
      lane: lane,
      jitter: Math.random() * 2 - 1,     /* -1..1，軌道內的偏移比例 */
      x: Math.random() * stage.w,
      y: aloft ? Math.random() * stage.h : -120 * stage.u,
      vy: (this.minSpeed + Math.random() * (this.maxSpeed - this.minSpeed)) * stage.u,
      swayPhase: Math.random() * TAU,
      /* spin 為 0 時連初始角度也一併歸零，維持素材原本的方向落下 */
      rot: this.spin ? Math.random() * TAU : 0,
      vrot: (Math.random() - 0.5) * 2.4 * this.spin,
      size: 0.62 + Math.random() * 0.55
    };
  };

  Rain.prototype.reset = function (stage) {
    this.time = 0;
    this.items = [];
    for (var i = 0; i < this.count; i++) {
      this.items.push(this.spawn(stage, true, i));
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
        this.items[i] = this.spawn(stage, false, it.lane);   /* 沿用原軌道 */
      }
    }
  };

  Rain.prototype.draw = function (ctx, stage, sprite, scale) {
    var st = { time: this.time, phase: 0, spread: 0 };

    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var s = stage.u * scale * it.size;
      ctx.save();
      ctx.translate(this.itemX(it, stage, sprite, scale), it.y);
      ctx.rotate(it.rot);
      ctx.scale(s, s);
      sprite.draw(ctx, st);
      ctx.restore();
    }
  };

  /* ======================================================================
     相框
     --------------------------------------------------------------------
     每種相框都是一支繪製函式，全部以向量繪製，不需要圖檔。
     要新增樣式就在下方寫一支函式並登記到 FRAMES，再到 config.json 的
     frames 陣列加一筆即可。
     ====================================================================== */

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* 底部加深，讓白色文字與角色在明亮背景上仍然清楚 */
  function bottomFade(ctx, stage, strength) {
    var g = ctx.createLinearGradient(0, stage.h * 0.62, 0, stage.h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + strength + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, stage.h * 0.62, stage.w, stage.h * 0.38);
  }

  function drawLabel(ctx, stage, text, y, size, align, x) {
    if (!text) return;
    var u = stage.u;
    ctx.save();
    ctx.font = '600 ' + Math.round(size * u) + 'px "Noto Sans TC", system-ui, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10 * u;
    ctx.fillText(text, x === undefined ? stage.w / 2 : x, y);
    ctx.restore();
  }

  /* 經典：外框加四角強調 */
  function frameClassic(ctx, stage, text) {
    var u = stage.u, w = stage.w, h = stage.h, pad = 26 * u;

    bottomFade(ctx, stage, 0.42);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 3 * u;
    ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);

    var arm = 46 * u, off = pad + 14 * u;
    var corners = [
      [off, off, 1, 1], [w - off, off, -1, 1],
      [off, h - off, 1, -1], [w - off, h - off, -1, -1]
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
    ctx.restore();

    drawLabel(ctx, stage, text, h - pad - 24 * u, 21);
  }

  /* 細邊：極簡單線 */
  function frameThin(ctx, stage, text) {
    var u = stage.u, w = stage.w, h = stage.h, pad = 34 * u;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 1.8 * u;
    ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
    ctx.restore();

    drawLabel(ctx, stage, text, h - pad - 20 * u, 16);
  }

  /* 圓角：厚圓角外框，標籤置於底部藥丸內 */
  function frameRounded(ctx, stage, text) {
    var u = stage.u, w = stage.w, h = stage.h, pad = 22 * u, r = 36 * u;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 4.5 * u;
    roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, r);
    ctx.stroke();
    ctx.restore();

    if (text) {
      ctx.save();
      var size = 18 * u;
      ctx.font = '700 ' + Math.round(size) + 'px "Noto Sans TC", system-ui, sans-serif';
      var tw = ctx.measureText(text).width;
      var pw = tw + 34 * u, ph = 34 * u;
      var px = (w - pw) / 2, py = h - pad - ph - 14 * u;

      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      roundRectPath(ctx, px, py, pw, ph, ph / 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, py + ph / 2);
      ctx.restore();
    }
  }

  /* 雙線：內外兩道線，較正式 */
  function frameDouble(ctx, stage, text) {
    var u = stage.u, w = stage.w, h = stage.h, p1 = 22 * u, p2 = 36 * u;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 3.6 * u;
    ctx.strokeRect(p1, p1, w - p1 * 2, h - p1 * 2);
    ctx.lineWidth = 1.3 * u;
    ctx.strokeRect(p2, p2, w - p2 * 2, h - p2 * 2);
    ctx.restore();

    drawLabel(ctx, stage, text, h - p2 - 22 * u, 18);
  }

  /* 膠捲：上下暗帶加齒孔 */
  function frameFilm(ctx, stage, text) {
    var u = stage.u, w = stage.w, h = stage.h, bar = 74 * u;

    ctx.save();
    ctx.fillStyle = 'rgba(12,12,14,0.94)';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    var hw = 26 * u, hh = 17 * u, gap = 30 * u;
    var y1 = (bar - hh) / 2, y2 = h - bar + (bar - hh) / 2;
    for (var x = gap; x < w - hw; x += hw + gap) {
      roundRectPath(ctx, x, y1, hw, hh, 4 * u); ctx.fill();
      roundRectPath(ctx, x, y2, hw, hh, 4 * u); ctx.fill();
    }
    ctx.restore();

    drawLabel(ctx, stage, text, h - bar - 22 * u, 19);
  }

  /* 底標：無外框，僅底部說明帶 */
  function frameCaption(ctx, stage, text) {
    var u = stage.u, w = stage.w, h = stage.h;

    bottomFade(ctx, stage, 0.7);

    if (!text) return;

    ctx.save();
    ctx.fillStyle = '#F97316';
    ctx.fillRect(40 * u, h - 62 * u, 6 * u, 30 * u);

    ctx.font = '700 ' + Math.round(23 * u) + 'px "Noto Sans TC", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fillText(text, 60 * u, h - 40 * u);
    ctx.restore();
  }

  /* 無框：不繪製任何內容，作為相框清單中的關閉選項 */
  function frameNone() {}

  var FRAMES = {
    none: frameNone,
    classic: frameClassic,
    thin: frameThin,
    rounded: frameRounded,
    double: frameDouble,
    film: frameFilm,
    caption: frameCaption
  };

  function drawFrame(ctx, stage, type, text) {
    var fn = FRAMES[type] || FRAMES.classic;
    fn(ctx, stage, text);
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

  var MOTIONS = { static: Static, walker: Walker, jumper: Jumper, rain: Rain };

  global.PhotoEffects = {

    hasMotion: function (type) {
      return Object.prototype.hasOwnProperty.call(MOTIONS, type);
    },

    hasFrame: function (type) {
      return Object.prototype.hasOwnProperty.call(FRAMES, type);
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
