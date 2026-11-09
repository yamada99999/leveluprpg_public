'use strict';
// ふたりでカタチ 図形の部品
// どの図形も、中心(0,0)・-50〜50 の箱に収まる形で書く（SVG のパス）。
// 置いた図形は { k: 種類, c: 色, x, y, r: 回転(ラジアン), sx, sy: 横・縦の大きさ（1 = 100px）, f: 左右反転 } で表す。
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
  // name: 画面には出さない（データと説明用）
  const LIB = {
    square: { name: '四角', d: 'M-42-42H42V42H-42Z' },
    bar: { name: '長四角', d: 'M-50-16H50V16H-50Z' },
    stick: { name: '棒', d: 'M-50-5H50V5H-50Z' },
    tri: { name: '三角', d: 'M0-44L48 40H-48Z' },
    rtri: { name: '直角三角', d: 'M-42-42L42 42H-42Z' },
    circle: { name: '丸', d: 'M-42 0A42 42 0 1 0 42 0A42 42 0 1 0 -42 0Z' },
    dot: { name: '小さい丸', d: 'M-16 0A16 16 0 1 0 16 0A16 16 0 1 0 -16 0Z' },
    half: { name: '半円', d: 'M-46 18A46 46 0 0 1 46 18Z' },
    ring: { name: '輪', d: 'M-44 0A44 44 0 1 0 44 0A44 44 0 1 0 -44 0ZM-26 0A26 26 0 1 1 26 0A26 26 0 1 1 -26 0Z', rule: 'evenodd' },
    hex: { name: '六角', d: poly(6, 46) },
    pent: { name: '五角', d: poly(5, 46, -Math.PI / 2) },
    star: { name: '星', d: star(5, 48, 20) },
    heart: { name: 'ハート', d: 'M0 42C-62 2-42-46 0-18C42-46 62 2 0 42Z' },
    arrow: { name: '矢印', d: 'M-14-46H14V4H34L0 46L-34 4H-14Z' },
    corner: { name: 'カギ', d: 'M-46-46H46L20-20H-20V20L-46 46Z' },
    plus: { name: '十字', d: 'M-14-46H14V-14H46V14H14V46H-14V14H-46V-14H-14Z' },
    moon: { name: '三日月', d: 'M14-46A46 46 0 1 0 14 46A36 36 0 1 1 14-46Z' },
    trap: { name: '台形', d: 'M-26-30H26L46 30H-46Z' },
    diamond: { name: 'ひし形', d: 'M0-48L32 0L0 48L-32 0Z' },
    drop: { name: 'しずく', d: 'M0-48C18-16 36 2 36 16A36 36 0 0 1 -36 16C-36 2-18-16 0-48Z' },
    lens: { name: 'レンズ', d: 'M-48 0Q0-44 48 0Q0 44-48 0Z' },
    bolt: { name: 'いなずま', d: 'M12-48L-26 6H0L-14 48L28-8H2Z' },
    cloud: { name: '雲', d: 'M-34 24A18 18 0 0 1 -32-6A22 22 0 0 1 4-26A22 22 0 0 1 36-6A16 16 0 0 1 34 24Z' },
    wave: { name: '波', d: 'M-50 6Q-37-20-25 6T0 6T25 6T50 6V18Q37-8 25 18T0 18T-25 18T-50 18Z' },
  };
  const KINDS = Object.keys(LIB);
  const COLORS = ['#f08030', '#ffc000', '#6aa84f', '#4472c4', '#222222', '#e04858', '#ff9ec4', '#8b5a2b', '#7fd3f0', '#9b6bd6', '#ffffff', '#9a9a9a'];

  // 線の色：塗りより少し暗く（白い図形も見えるように）
  function edge(c) {
    const n = parseInt(c.slice(1), 16);
    const k = c === '#ffffff' ? 0.55 : 0.62;
    const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
    return `rgb(${r},${g},${b})`;
  }
  const cache = {};
  const pathOf = (k) => cache[k] || (cache[k] = new Path2D((LIB[k] || LIB.square).d));
  const ruleOf = (k) => (LIB[k] && LIB[k].rule) || 'nonzero';

  // ctx に図形を描く（ctx はもう紙の座標になっている前提）
  function draw(ctx, s, opt = {}) {
    ctx.save();
    ctx.translate(s.x, s.y); ctx.rotate(s.r || 0);
    ctx.scale((s.f ? -1 : 1) * (s.sx || 1), s.sy || 1);
    const p = pathOf(s.k);
    ctx.globalAlpha = opt.alpha == null ? 1 : opt.alpha;
    ctx.fillStyle = s.c; ctx.fill(p, ruleOf(s.k));
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6 / Math.max(0.2, Math.min(s.sx || 1, s.sy || 1));
    ctx.strokeStyle = edge(s.c); ctx.stroke(p);
    ctx.restore();
  }
  // 紙の上の点 (px,py) が図形の中か
  const hitCtx = (typeof document !== 'undefined') ? document.createElement('canvas').getContext('2d') : null;
  function local(s, px, py) {
    const dx = px - s.x, dy = py - s.y, c = Math.cos(-(s.r || 0)), n = Math.sin(-(s.r || 0));
    let lx = (dx * c - dy * n) / (s.sx || 1), ly = (dx * n + dy * c) / (s.sy || 1);
    if (s.f) lx = -lx;
    return [lx, ly];
  }
  function hit(s, px, py, pad = 0) {
    const [lx, ly] = local(s, px, py);
    if (hitCtx && hitCtx.isPointInPath(pathOf(s.k), lx, ly, ruleOf(s.k))) return true;
    // 細い図形もつかめるように、少し外側まで（pad は紙の px）
    if (pad > 0) {
      const ex = pad / (s.sx || 1), ey = pad / (s.sy || 1);
      for (const [ox, oy] of [[ex, 0], [-ex, 0], [0, ey], [0, -ey]]) if (hitCtx && hitCtx.isPointInPath(pathOf(s.k), lx + ox, ly + oy, ruleOf(s.k))) return true;
    }
    return false;
  }
  function randomPick(rand = Math.random) {
    return { k: KINDS[Math.floor(rand() * KINDS.length)], c: COLORS[Math.floor(rand() * COLORS.length)] };
  }
  window.KATA_SHAPES = { LIB, KINDS, COLORS, draw, hit, local, edge, randomPick, pathOf, ruleOf };
})();
