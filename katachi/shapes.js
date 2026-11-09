'use strict';
// ふたりでカタチ 図形の部品
// どの図形も、中心(0,0)・-50〜50 の箱に収まる形で書く。
//   塗りの図形：SVG のパス（d）
//   線の図形　：折れ線の点のならび（line）。どれだけ伸ばしても線の太さは同じ
// 置いた図形は { k: 種類, c: 色, x, y, r: 回転(ラジアン), sx, sy: 横・縦の大きさ（1 = 100px。マイナスなら裏返し） } で表す。
// 回したり縦横に伸ばしたりすれば同じになる形は、1種類にまとめている
// （正方形・長四角・棒 →「四角」、大小の丸・楕円 →「丸」）。
(function () {
  const star = (n, R, r) => {
    let d = '';
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n, rr = i % 2 ? r : R;
      d += (i ? 'L' : 'M') + (Math.cos(a) * rr).toFixed(1) + ' ' + (Math.sin(a) * rr).toFixed(1);
    }
    return d + 'Z';
  };
  const poly = (n, R, rot = 0) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      const a = rot + (i * 2 * Math.PI) / n;
      d += (i ? 'L' : 'M') + (Math.cos(a) * R).toFixed(1) + ' ' + (Math.sin(a) * R).toFixed(1);
    }
    return d + 'Z';
  };
  // 線の図形の点
  const sample = (n, f) => { const a = []; for (let i = 0; i <= n; i++) a.push(f(i / n)); return a; };
  const cubic = (p0, p1, p2, p3) => (t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
  };

  // name: 読み上げ用（画面には出さない）
  const LIB = {
    // ---- 塗りの図形 ----
    rect: { name: '四角', d: 'M-42-42H42V42H-42Z' },
    circle: { name: '丸', d: 'M-42 0A42 42 0 1 0 42 0A42 42 0 1 0 -42 0Z' },
    tri: { name: '三角', d: 'M0-44L48 40H-48Z' },
    rtri: { name: '直角三角', d: 'M-42-42L42 42H-42Z' },
    half: { name: '半円', d: 'M-46 23A46 46 0 0 1 46 23Z' },
    quarter: { name: '扇形', d: 'M-40 40V-40A80 80 0 0 1 40 40Z' },
    ring: { name: '輪', d: 'M-44 0A44 44 0 1 0 44 0A44 44 0 1 0 -44 0ZM-26 0A26 26 0 1 1 26 0A26 26 0 1 1 -26 0Z', rule: 'evenodd' },
    arch: { name: 'アーチ', d: 'M-44 44V0A44 44 0 0 1 44 0V44H20V0A20 20 0 0 0 -20 0V44Z' },
    hex: { name: '六角', d: poly(6, 46) },
    pent: { name: '五角', d: poly(5, 46, -Math.PI / 2) },
    trap: { name: '台形', d: 'M-26-30H26L46 30H-46Z' },
    para: { name: '平行四辺形', d: 'M-22-30H48L22 30H-48Z' },
    diamond: { name: 'ひし形', d: 'M0-48L32 0L0 48L-32 0Z' },
    star: { name: '星', d: star(5, 48, 20) },
    burst: { name: 'ギザギザ丸', d: star(12, 48, 36) },
    heart: { name: 'ハート', d: 'M0 42C-62 2-42-46 0-18C42-46 62 2 0 42Z' },
    arrow: { name: '矢印', d: 'M-14-46H14V4H34L0 46L-34 4H-14Z' },
    corner: { name: 'カギ', d: 'M-46-46H46L20-20H-20V20L-46 46Z' },
    plus: { name: '十字', d: 'M-14-46H14V-14H46V14H14V46H-14V14H-46V-14H-14Z' },
    moon: { name: '三日月', d: 'M33.9-39.9A46 46 0 1 0 33.9 39.9A40 40 0 1 1 33.9-39.9Z' },
    drop: { name: 'しずく', d: 'M0-48C18-16 36 2 36 16A36 36 0 0 1 -36 16C-36 2-18-16 0-48Z' },
    lens: { name: 'レンズ', d: 'M-48 0Q0-44 48 0Q0 44-48 0Z' },
    bolt: { name: 'いなずま', d: 'M12-48L-26 6H0L-14 48L28-8H2Z' },
    cloud: { name: '雲', d: 'M-34 24A18 18 0 0 1 -32-6A22 22 0 0 1 4-26A22 22 0 0 1 36-6A16 16 0 0 1 34 24Z' },
    bubble: { name: '吹き出し', d: 'M-40-34H40Q48-34 48-26V10Q48 18 40 18H-4L-24 42L-16 18H-40Q-48 18-48 10V-26Q-48-34-40-34Z' },
    // ---- 線の図形 ----
    line: { name: '線', line: [[[-50, 0], [50, 0]]] },
    dash: { name: '点線', line: [[[-50, 0], [50, 0]]], dash: true },
    larrow: { name: '線の矢印', line: [[[-50, 0], [48, 0]], [[30, -17], [49, 0], [30, 17]]] },
    arc: { name: '半円の線', line: [sample(24, (t) => [-46 * Math.cos(Math.PI * t), 23 - 46 * Math.sin(Math.PI * t)])] },
    curve: { name: '曲線', line: [sample(28, cubic([-48, 0], [-18, -64], [18, 64], [48, 0]))] },
    wave: { name: '波線', line: [sample(40, (t) => [-50 + 100 * t, -14 * Math.sin(t * Math.PI * 4)])] },
    zigzag: { name: 'ギザギザ線', line: [[[-50, 12], [-30, -12], [-10, 12], [10, -12], [30, 12], [50, -12]]] },
    spiral: { name: 'うずまき', line: [sample(60, (t) => { const a = t * Math.PI * 5.5, r = 4 + 42 * t; return [Math.cos(a) * r, Math.sin(a) * r]; })] },
  };
  const KINDS = Object.keys(LIB);
  const COLORS = ['#f08030', '#ffc000', '#6aa84f', '#4472c4', '#222222', '#e04858', '#ff9ec4', '#8b5a2b', '#7fd3f0', '#9b6bd6', '#ffffff', '#9a9a9a'];
  const LINE_W = 6; // 線の図形の太さ（画用紙の px）
  const isLine = (k) => !!(LIB[k] && LIB[k].line);

  // 線の色：塗りより少し暗く（白い図形も見えるように）
  function edge(c) {
    const n = parseInt(c.slice(1), 16);
    const k = c === '#ffffff' ? 0.55 : 0.62;
    const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
    return `rgb(${r},${g},${b})`;
  }
  const cache = {};
  const pathOf = (k) => cache[k] || (cache[k] = new Path2D((LIB[k] && LIB[k].d) || LIB.rect.d));
  const ruleOf = (k) => (LIB[k] && LIB[k].rule) || 'nonzero';
  const sxOf = (s) => (s.sx || 1) * (s.f ? -1 : 1); // 古い「左右反転」も、横の大きさがマイナスとして扱う
  const syOf = (s) => s.sy || 1;

  // 図形の中の点 → 画用紙の点
  function toWorld(s) {
    const c = Math.cos(s.r || 0), n = Math.sin(s.r || 0), sx = sxOf(s), sy = syOf(s);
    return ([lx, ly]) => { const x = lx * sx, y = ly * sy; return [s.x + x * c - y * n, s.y + x * n + y * c]; };
  }
  function linesOf(s) {
    const w = toWorld(s);
    return LIB[s.k].line.map((pl) => pl.map(w));
  }

  // ctx に図形を描く（ctx はもう紙の座標になっている前提）
  function draw(ctx, s, opt = {}) {
    ctx.save();
    ctx.globalAlpha = opt.alpha == null ? 1 : opt.alpha;
    if (isLine(s.k)) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (LIB[s.k].dash) ctx.setLineDash([LINE_W * 1.6, LINE_W * 1.5]);
      for (const [col, w] of [[edge(s.c), LINE_W + 2.4], [s.c, LINE_W]]) {
        ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.beginPath();
        for (const pl of linesOf(s)) pl.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
    } else {
      const sx = sxOf(s), sy = syOf(s);
      ctx.translate(s.x, s.y); ctx.rotate(s.r || 0);
      ctx.scale(sx, sy);
      const p = pathOf(s.k);
      ctx.fillStyle = s.c; ctx.fill(p, ruleOf(s.k));
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.6 / Math.max(0.2, Math.min(Math.abs(sx), Math.abs(sy)));
      ctx.strokeStyle = edge(s.c); ctx.stroke(p);
    }
    ctx.restore();
  }
  // 画用紙の点 → 図形の中の点
  function local(s, px, py) {
    const dx = px - s.x, dy = py - s.y, c = Math.cos(-(s.r || 0)), n = Math.sin(-(s.r || 0));
    return [(dx * c - dy * n) / sxOf(s), (dx * n + dy * c) / syOf(s)];
  }
  function segDist(px, py, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L)) : 0;
    return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
  }
  // 紙の上の点 (px,py) が図形にふれているか（pad：これだけ外れていても OK。紙の px）
  const hitCtx = (typeof document !== 'undefined') ? document.createElement('canvas').getContext('2d') : null;
  function hit(s, px, py, pad = 0) {
    if (isLine(s.k)) {
      for (const pl of linesOf(s)) for (let i = 1; i < pl.length; i++) if (segDist(px, py, pl[i - 1], pl[i]) <= LINE_W / 2 + 2 + pad) return true;
      return false;
    }
    if (!hitCtx) return false;
    const inside = (x, y) => { const [lx, ly] = local(s, x, y); return hitCtx.isPointInPath(pathOf(s.k), lx, ly, ruleOf(s.k)); };
    if (inside(px, py)) return true;
    // 細い図形もつかめるように、まわり8方向を見る（画面の上での距離なので、伸ばしても回しても同じ）
    if (pad > 0) for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; if (inside(px + Math.cos(a) * pad, py + Math.sin(a) * pad)) return true; }
    return false;
  }
  // 図形がおおよそ占める範囲 [x0, y0, x1, y1]
  function bbox(s) {
    const pts = isLine(s.k) ? linesOf(s).flat() : (() => { const w = toWorld(s); return [[-50, -50], [50, -50], [50, 50], [-50, 50]].map(w); })();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = isLine(s.k) ? LINE_W : 0;
    return [x0 - m, y0 - m, x1 + m, y1 + m];
  }
  const overlap = (a, b) => { const p = bbox(a), q = bbox(b); return p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]; };
  function randomPick(rand = Math.random) {
    return { k: KINDS[Math.floor(rand() * KINDS.length)], c: COLORS[Math.floor(rand() * COLORS.length)] };
  }
  window.KATA_SHAPES = { LIB, KINDS, COLORS, LINE_W, draw, hit, local, bbox, overlap, edge, randomPick, pathOf, ruleOf, isLine, sxOf, syOf };
})();
