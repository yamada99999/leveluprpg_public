'use strict';
// 小さな QR コード作成器（相棒に URL を読ませるため）
// バイトモード（UTF-8）・誤り訂正レベル M・バージョン 1〜10（最大 213 バイト）だけに対応。
// 使い方：MiniQR.draw(canvas, 'https://...', 220)  → canvas に QR を描く
(function () {
  // [ブロックごとの誤り訂正の数, [ブロック数, データ数], ...]（レベル M）
  const VER = [null,
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // ガロア体 GF(256)
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsRem(data, n) {
    const g = rsGen(n), r = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ r[0];
      r.shift(); r.push(0);
      for (let j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f);
    }
    return r;
  }
  const dataCount = (v) => VER[v].slice(1).reduce((a, [n, k]) => a + n * k, 0);
  const MASK = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];

  // 文字列 → 黒(true)/白(false) の2次元配列
  function make(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let v = 1;
    while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCount(v) * 8) v++;
    if (v > 10) throw new Error('QR: 長すぎます');
    // データのビット列
    const bb = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
    const cap = dataCount(v) * 8;
    put(0, Math.min(4, cap - bb.length));
    while (bb.length % 8) bb.push(0);
    for (let p = 0xec; bb.length < cap; p ^= 0xec ^ 0x11) put(p, 8);
    const data = [];
    for (let i = 0; i < bb.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bb[i + j]; data.push(b); }
    // ブロックに分けて誤り訂正をつけ、交互に並べる
    const ec = VER[v][0], blocks = [];
    let o = 0;
    for (const [n, k] of VER[v].slice(1)) for (let i = 0; i < n; i++) { const d = data.slice(o, o + k); o += k; blocks.push({ d, e: rsRem(d, ec) }); }
    const words = [];
    const maxK = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxK; i++) for (const b of blocks) if (i < b.d.length) words.push(b.d[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) words.push(b.e[i]);

    // 模様
    const size = v * 4 + 17;
    const M = [], F = [];
    for (let i = 0; i < size; i++) { M.push(new Array(size).fill(false)); F.push(new Array(size).fill(false)); }
    const setF = (x, y, d) => { M[y][x] = d; F[y][x] = true; };
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setF(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[v], na = al.length;
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const format = (mask) => {
      const dat = (0 << 3) | mask; // レベル M = 0
      let rem = dat;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((dat << 10) | rem) ^ 0x5412;
      const b = (i) => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) setF(8, i, b(i));
      setF(8, 7, b(6)); setF(8, 8, b(7)); setF(7, 8, b(8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, b(i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, b(i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, b(i));
      setF(8, size - 8, true);
    };
    format(0);
    if (v >= 7) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (v << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bt = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        setF(a, c, bt); setF(c, a, bt);
      }
    }
    // データを右下からジグザグに置く
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!F[y][x] && bi < words.length * 8) { M[y][x] = ((words[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
      }
    }
    // マスク：いちばん読みやすいものを選ぶ
    const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && MASK[m](x, y)) M[y][x] = !M[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      const lines = [];
      for (let y = 0; y < size; y++) lines.push(M[y].map((b) => (b ? 1 : 0)).join(''));
      for (let x = 0; x < size; x++) lines.push(M.map((r) => (r[x] ? 1 : 0)).join(''));
      for (const s of lines) {
        for (const r of s.match(/0+|1+/g)) if (r.length >= 5) p += r.length - 2;
        const t = '0000' + s + '0000';
        for (const pat of ['00001011101', '10111010000']) { let k = -1; while ((k = t.indexOf(pat, k + 1)) >= 0) p += 40; }
      }
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (M[y][x]) dark++;
        if (x < size - 1 && y < size - 1) { const c = M[y][x]; if (M[y][x + 1] === c && M[y + 1][x] === c && M[y + 1][x + 1] === c) p += 3; }
      }
      const total = size * size;
      p += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); format(m);
      const p = penalty();
      if (p < bestP) { bestP = p; best = m; }
      applyMask(m);
    }
    applyMask(best); format(best);
    return M;
  }

  // canvas に描く（まわりに白い余白 4 マス）。px は表示の大きさ（CSS の px）
  function draw(canvas, text, px = 220) {
    const M = make(text), n = M.length, tot = n + 8;
    const dpr = window.devicePixelRatio || 1;
    const cell = Math.max(2, Math.floor((px * dpr) / tot));
    canvas.width = canvas.height = cell * tot;
    canvas.style.width = canvas.style.height = (cell * tot) / dpr + 'px';
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#111';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) g.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell);
    return M;
  }
  window.MiniQR = { make, draw, _rsRem: rsRem, _exp: EXP };
})();
