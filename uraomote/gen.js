'use strict';
// ウラオモテ迷宮 ステージ自動生成（ステージ6〜）
//
// しくみ
//  ・それぞれの面を、横いっぱいの仕切り板で「部屋」に分ける。
//  ・ワープは部屋の左右の壁に置く（入口の真裏＝相手の面の反対側の壁が出口になる）。
//  ・縦持ちで束をゆっくり回すと、玉は部屋の壁にそって一周する。
//    「右回り／左回り」に進んで最初に当たるもの（ワープの入口・危険地帯・ゴール）で行き先が決まる。
//  ・この「どっちに回すと、どこへ行けるか」を全部たどって、ゴールに着けるか（何回のワープで着けるか）を計算する。
//  ・解けない形・途中で詰む形（どう動いてもゴールへ戻れない場所がある形）は捨てて作り直す。
// 同じ（ステージ番号, seed）からは必ず同じステージができるので、2台で seed だけ送れば同じ形になる。
(function (root) {
  const W = 360, H = 640, WALL = 12, R = 13, T = 24;
  const XL = WALL + R, XR = W - WALL - R; // 玉の中心が通る左右の線
  const STEP = 2;                          // 壁ぞいを調べるときの刻み
  const WARP_GAP = 125;                    // 同じ面のワープ同士の最小距離
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const mirrorRect = (r) => [W - r[0] - r[2], r[1], r[2], r[3]];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rectDist = (x, y, r) => Math.hypot(x - clamp(x, r[0], r[0] + r[2]), y - clamp(y, r[1], r[1] + r[3]));

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- 部屋と、壁ぞいの一周 ----------
  function rooms(divs) {
    const out = []; let top = WALL;
    for (const d of divs) { out.push({ top, bottom: d }); top = d + T; }
    out.push({ top, bottom: H - WALL });
    return out;
  }
  function roomAt(rs, y) { return rs.findIndex((c) => y >= c.top + R - 4 && y <= c.bottom - R + 4); }
  // 一周の長さと位置。s=0 が左下の角。s が増える向き＝画面で見て反時計回り（床→右の壁→天井→左の壁）
  function loop(c) { const yT = c.top + R, yB = c.bottom - R, Lx = XR - XL, Ly = yB - yT; return { yT, yB, Lx, Ly, P: 2 * (Lx + Ly) }; }
  function sToXY(c, s) {
    const p = loop(c); s = ((s % p.P) + p.P) % p.P;
    if (s < p.Lx) return [XL + s, p.yB]; s -= p.Lx;
    if (s < p.Ly) return [XR, p.yB - s]; s -= p.Ly;
    if (s < p.Lx) return [XR - s, p.yT]; s -= p.Lx;
    return [XL, p.yT + s];
  }
  function xyToS(c, x, y) {
    const p = loop(c);
    const cx = clamp(x, XL, XR), cy = clamp(y, p.yT, p.yB);
    const cand = [
      [Math.abs(y - p.yB), cx - XL],
      [Math.abs(x - XR), p.Lx + (p.yB - cy)],
      [Math.abs(y - p.yT), p.Lx + p.Ly + (XR - cx)],
      [Math.abs(x - XL), 2 * p.Lx + p.Ly + (cy - p.yT)],
    ];
    cand.sort((a, b) => a[0] - b[0]);
    return cand[0][1];
  }

  // ---------- モデル ----------
  // M = { divs: {A, B}, warps: [{ face, side:'L'|'R', y }], dangers: [{ seen, rect }], start: { face, x, y }, goal: { face, x, y, r } }
  const warpIn = (w) => ({ x: w.side === 'R' ? W - 35 : 35, y: w.y });          // 入口（w.face の面）
  const warpOut = (w) => ({ x: w.side === 'R' ? 35 : W - 35, y: w.y });         // 出口（反対の面）
  function dangersOn(M, face) {
    const out = [];
    for (const d of M.dangers) out.push(d.seen === face ? d.rect : mirrorRect(d.rect));
    return out;
  }

  // 位置 (face, x, y) から dir（+1:反時計回り / -1:時計回り）に回したとき、最初に起きること。
  // limit を渡すと、その距離まで（＝壁の端まで）しか進まない
  function walk(M, face, x, y, dir, limit) {
    const rs = rooms(M.divs[face]);
    const ci = roomAt(rs, y);
    if (ci < 0) return { type: 'none' };
    const c = rs[ci], p = loop(c);
    const s0 = xyToS(c, x, y);
    const dz = dangersOn(M, face);
    const ins = M.warps.map((w, i) => ({ i, w })).filter((o) => o.w.face === face);
    const end = limit === undefined ? p.P : limit;
    for (let d = STEP; d < end + STEP; d += STEP) {
      const [px, py] = sToXY(c, s0 + dir * Math.min(d, end));
      for (const r of dz) if (rectDist(px, py, r) < R * 0.55) return { type: 'dead', at: [px, py] };
      if (M.goal.face === face && Math.hypot(px - M.goal.x, py - M.goal.y) < M.goal.r * 0.8) return { type: 'goal' };
      for (const o of ins) { const q = warpIn(o.w); if (Math.hypot(px - q.x, py - q.y) < 22 * 0.6) return { type: 'warp', i: o.i, dir }; }
      if (limit !== undefined && d >= end) return { type: 'corner', x: px, y: py };
    }
    return { type: 'none' };
  }

  // 壁ぞいの位置 (x, y) から dir に進んで、今いる辺の端（角）までの距離
  function toCorner(M, face, x, y, dir) {
    const rs = rooms(M.divs[face]);
    const c = rs[roomAt(rs, y)], p = loop(c);
    const s = xyToS(c, x, y);
    const bounds = [0, p.Lx, p.Lx + p.Ly, 2 * p.Lx + p.Ly, p.P];
    if (dir > 0) { const b = bounds.find((v) => v > s + 0.5); return b - s; }
    const b = [...bounds].reverse().find((v) => v < s - 0.5);
    return s - (b === undefined ? 0 : b);
  }

  // ワープ i に dir の向きで入ったあと、何が起きるか。
  // 出口では、入る前の勢いのまま「出口の壁」を同じ向きに滑り、壁の端（角）まで行く（その間は止められない）。
  // 束を回し続ける向きが同じなので、相手の面では向きが逆になる（オモテの反時計回り＝ウラの時計回り）。
  function arrive(M, i, dir, depth = 0) {
    if (depth > 8) return { type: 'dead' };
    const w = M.warps[i], face = other(w.face), o = warpOut(w), d = -dir;
    const r = walk(M, face, o.x, o.y, d, toCorner(M, face, o.x, o.y, d));
    if (r.type === 'warp') return arrive(M, r.i, r.dir, depth + 1);
    if (r.type === 'corner') return { type: 'node', key: `W${i}:${dir}`, face, x: r.x, y: r.y };
    return r; // dead / goal
  }

  // スタートからたどれる全部の場所と、ゴールまでの最短ワープ回数・手順
  function solve(M) {
    const startN = { key: 'S', face: M.start.face, x: M.start.x, y: M.start.y };
    const nodes = new Map([['S', startN]]);
    const edges = new Map();
    const queue = [startN];
    const dist = new Map([['S', 0]]), prev = new Map();
    let goalFrom = null;
    while (queue.length) {
      const n = queue.shift(), k = n.key;
      const out = [];
      for (const dir of [1, -1]) {
        let r = walk(M, n.face, n.x, n.y, dir);
        if (r.type === 'warp') r = arrive(M, r.i, r.dir);
        if (r.type === 'goal') { out.push({ goal: true, dir }); if (!goalFrom) goalFrom = { k, dir }; }
        if (r.type === 'node') {
          out.push({ to: r.key, dir });
          if (!nodes.has(r.key)) { nodes.set(r.key, r); dist.set(r.key, dist.get(k) + 1); prev.set(r.key, { k, dir, face: n.face }); queue.push(r); }
        }
      }
      edges.set(k, out);
    }
    if (!goalFrom) return { ok: false };
    // どこからでもゴールへ行けるか（詰む場所がないか）
    const canGoal = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [k, out] of edges) {
        if (canGoal.has(k)) continue;
        if (out.some((e) => e.goal || (e.to && canGoal.has(e.to)))) { canGoal.add(k); changed = true; }
      }
    }
    const deadEnds = [...edges.keys()].filter((k) => !canGoal.has(k));
    // 最短でゴールに着く道（BFS の順なので、ゴールに届いた最初の場所が最短）
    let best = null;
    for (const [k, out] of edges) for (const e of out) if (e.goal && (best === null || dist.get(k) < dist.get(best.k))) best = { k, dir: e.dir };
    const plan = [];
    const at = (key) => { const n = nodes.get(key); return { x: n.x, y: n.y }; };
    plan.unshift({ face: nodes.get(best.k).face, dir: best.dir, ...at(best.k) });
    let k = best.k;
    while (prev.has(k)) { const pv = prev.get(k); plan.unshift({ face: pv.face, dir: pv.dir, ...at(pv.k) }); k = pv.k; }
    return { ok: deadEnds.length === 0, warps: dist.get(best.k), plan, deadEnds: deadEnds.length, reachable: edges.size };
  }

  // 位置から dir に進んで、最初に何かに当たるまでの距離（何もなければ一周）
  function freeRun(M, face, x, y, dir) {
    const rs = rooms(M.divs[face]);
    const c = rs[roomAt(rs, y)], p = loop(c);
    let lo = 0, hi = p.P;
    // walk を少しずつ延ばして、最初のできごとまでの距離を調べる
    for (let d = 20; d < p.P; d += 10) {
      const r = walk(M, face, x, y, dir, d);
      if (r.type !== 'corner') { hi = d; break; }
      lo = d;
    }
    return { c, p, s0: xyToS(c, x, y), safe: lo };
  }

  // ハート：正解の道から「わざと逆に回して少し寄り道すると取れる」場所に置く（取ったら戻ってくる）
  function placeHeart(M, sol, rand) {
    const cands = [];
    for (const st of sol.plan) {
      const fr = freeRun(M, st.face, st.x, st.y, -st.dir);
      if (fr.safe < 140) continue; // 寄り道できる長さが足りない
      cands.push({ st, fr });
    }
    for (let tries = 0; tries < 10 && cands.length; tries++) {
      const { st, fr } = cands[Math.floor(rand() * cands.length)];
      const d = 60 + Math.floor(rand() * (fr.safe - 120));
      const [x, y] = sToXY(fr.c, fr.s0 - st.dir * d);
      const near = (q) => Math.hypot(q.x - x, q.y - y) < 60;
      const warpPts = [];
      for (const w of M.warps) { if (w.face === st.face) warpPts.push(warpIn(w)); if (other(w.face) === st.face) warpPts.push(warpOut(w)); }
      if (warpPts.some(near)) continue;
      if (M.goal.face === st.face && near(M.goal)) continue;
      if (M.start.face === st.face && near(M.start)) continue;
      return { side: st.face, x: Math.round(x), y: Math.round(y) };
    }
    return null;
  }

  // ---------- 生成 ----------
  function difficulty(n) {
    const t = Math.max(0, n - 6);
    return {
      chain: Math.min(2 + Math.floor(t / 2), 6),            // 本筋のワープの数
      divMax: Math.min(1 + Math.floor((t + 1) / 3), 3),     // 1面あたりの仕切りの最大数
      dangerP: Math.min(0.45 + t * 0.07, 0.95),            // 部屋ごとに「逆回り側」に危険地帯を置く確率
      decoys: t >= 3 ? Math.min(1 + Math.floor((t - 3) / 3), 3) : 0, // 寄り道ワープの数
      hiddenP: Math.min(0.5 + t * 0.05, 0.9),              // 危険地帯を「玉がない側の人」にだけ見せる確率
    };
  }

  function tryBuild(n, rand) {
    const D = difficulty(n);
    const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const pick = (a) => a[Math.floor(rand() * a.length)];

    // 仕切り
    const divs = {};
    for (const f of ['A', 'B']) {
      const cnt = ri(1, D.divMax);
      let ys;
      for (let tries = 0; tries < 50; tries++) {
        ys = Array.from({ length: cnt }, () => ri(120, 500)).sort((a, b) => a - b);
        const tops = [WALL, ...ys.map((y) => y + T)], bots = [...ys, H - WALL];
        if (tops.every((t, i) => bots[i] - t >= 130)) break;
        ys = null;
      }
      if (!ys) return null;
      divs[f] = ys;
    }
    const M = { divs, warps: [], dangers: [], start: null, goal: null };
    const rs = { A: rooms(divs.A), B: rooms(divs.B) };

    // スタート：どこかの部屋の床
    const sf = pick(['A', 'B']);
    const sc = rs[sf][ri(0, rs[sf].length - 1)];
    M.start = { face: sf, x: ri(90, 270), y: sc.bottom - R };
    M.goal = { face: 'X', x: -999, y: -999, r: 24 }; // ゴールは最後に置く

    const warpPoints = (face) => {
      const pts = [];
      for (const w of M.warps) { if (w.face === face) pts.push(warpIn(w)); if (other(w.face) === face) pts.push(warpOut(w)); }
      return pts;
    };
    const farFromWarps = (face, q) => warpPoints(face).every((p) => Math.hypot(p.x - q.x, p.y - q.y) >= WARP_GAP);
    const insideRoom = (face, y, margin) => { const c = rs[face][roomAt(rs[face], y)]; return c && y - c.top >= margin && c.bottom - y >= margin; };

    // 本筋：ワープを順番につなぐ
    let cur = { face: sf, x: M.start.x, y: M.start.y };
    const steps = [];
    for (let i = 0; i < D.chain; i++) {
      const ci = roomAt(rs[cur.face], cur.y);
      const c = rs[cur.face][ci];
      let placed = null;
      for (let tries = 0; tries < 40 && !placed; tries++) {
        const w = { face: cur.face, side: pick(['L', 'R']), y: ri(c.top + 40, c.bottom - 40) };
        if (w.y <= c.top + 40 || w.y >= c.bottom - 40) continue;
        const q = warpIn(w), o = warpOut(w);
        if (!farFromWarps(w.face, q) || !farFromWarps(other(w.face), o)) continue;
        if (Math.hypot(q.x - cur.x, q.y - cur.y) < 80) continue;
        if (!insideRoom(other(w.face), o.y, 45)) continue;
        if (Math.abs(o.y - M.start.y) < 60 && other(w.face) === M.start.face && Math.abs(o.x - M.start.x) < 120) continue;
        M.warps.push(w);
        const dirs = rand() < 0.5 ? [1, -1] : [-1, 1];
        const dir = dirs.find((d) => { const r = walk(M, cur.face, cur.x, cur.y, d); return r.type === 'warp' && r.i === M.warps.length - 1; });
        if (dir === undefined) { M.warps.pop(); continue; }
        // 出口の壁を端まで滑ったあとの位置（ここから次へ）
        const a = arrive(M, M.warps.length - 1, dir);
        if (a.type !== 'node') { M.warps.pop(); continue; }
        placed = { w, dir, from: { ...cur }, to: { face: a.face, x: a.x, y: a.y } };
      }
      if (!placed) return null;
      steps.push(placed);
      cur = placed.to;
    }

    // ゴール：最後の部屋の床か天井
    {
      const c = rs[cur.face][roomAt(rs[cur.face], cur.y)];
      let ok = false;
      for (let tries = 0; tries < 30 && !ok; tries++) {
        const onFloor = rand() < 0.5;
        M.goal = { face: cur.face, x: ri(80, 280), y: onFloor ? c.bottom - 16 : c.top + 17, r: 24 };
        if (warpPoints(cur.face).some((p) => Math.hypot(p.x - M.goal.x, p.y - M.goal.y) < 90)) continue;
        if (Math.hypot(cur.x - M.goal.x, cur.y - M.goal.y) < 80) continue;
        ok = [1, -1].some((d) => walk(M, cur.face, cur.x, cur.y, d).type === 'goal');
      }
      if (!ok) return null;
    }

    // 危険地帯：本筋の「逆回り側」に置いて、回す向きを間違えたときだけ当たるようにする
    const allSteps = [...steps, { goal: true, from: cur }];
    for (const st of allSteps) {
      if (rand() > D.dangerP) continue;
      const f = st.from.face;
      const r0 = walk(M, f, st.from.x, st.from.y, 1), r1 = walk(M, f, st.from.x, st.from.y, -1);
      const good = (r) => (st.goal ? r.type === 'goal' : r.type === 'warp' && r.i === M.warps.indexOf(st.w));
      const wrong = good(r0) ? -1 : good(r1) ? 1 : 0;
      if (!wrong) continue;
      const c = rs[f][roomAt(rs[f], st.from.y)], p = loop(c), s0 = xyToS(c, st.from.x, st.from.y);
      // 逆回りに 70〜(一周の半分) 進んだあたりの、まっすぐな辺の上
      for (let tries = 0; tries < 12; tries++) {
        const d = ri(70, Math.max(80, Math.floor(p.P / 2) - 40));
        const [px, py] = sToXY(c, s0 + wrong * d);
        const len = ri(50, 80);
        let rect;
        if (Math.abs(py - p.yB) < 1 && px - len / 2 > WALL + 30 && px + len / 2 < W - WALL - 30) rect = [Math.round(px - len / 2), c.bottom - 40, len, 40];
        else if (Math.abs(py - p.yT) < 1 && px - len / 2 > WALL + 30 && px + len / 2 < W - WALL - 30) rect = [Math.round(px - len / 2), c.top, len, 40];
        else if (Math.abs(px - XR) < 1 && py - len / 2 > c.top + 25 && py + len / 2 < c.bottom - 25) rect = [W - WALL - 46, Math.round(py - len / 2), 46, len];
        else if (Math.abs(px - XL) < 1 && py - len / 2 > c.top + 25 && py + len / 2 < c.bottom - 25) rect = [WALL, Math.round(py - len / 2), 46, len];
        if (!rect) continue;
        const seen = rand() < D.hiddenP ? other(f) : f; // 玉がない側の人にだけ見せる（声をかけ合う）
        const rectSeen = seen === f ? rect : mirrorRect(rect);
        M.dangers.push({ seen, rect: rectSeen });
        if (!clearOfThings(M) || !solve(M).ok) { M.dangers.pop(); continue; }
        break;
      }
    }

    // 寄り道ワープ（ハズレ。ただし行った先からも必ずゴールへ戻れる）
    for (let i = 0; i < D.decoys; i++) {
      for (let tries = 0; tries < 30; tries++) {
        const f = pick(['A', 'B']);
        const c = rs[f][ri(0, rs[f].length - 1)];
        const w = { face: f, side: pick(['L', 'R']), y: ri(c.top + 40, c.bottom - 40) };
        if (w.y <= c.top + 40 || w.y >= c.bottom - 40) continue;
        const q = warpIn(w), o = warpOut(w);
        if (!farFromWarps(f, q) || !farFromWarps(other(f), o) || !insideRoom(other(f), o.y, 45)) continue;
        if (Math.hypot(q.x - M.goal.x, q.y - M.goal.y) < 90 && f === M.goal.face) continue;
        M.warps.push(w);
        if (!clearOfThings(M) || !solve(M).ok) { M.warps.pop(); continue; }
        break;
      }
    }

    if (!clearOfThings(M)) return null;
    const sol = solve(M);
    if (!sol.ok || sol.warps < Math.max(1, D.chain - 1)) return null;
    return { M, sol };
  }

  // 危険地帯がスタート・ゴール・ワープにかぶっていないか
  function clearOfThings(M) {
    for (const face of ['A', 'B']) {
      const dz = dangersOn(M, face);
      const things = [];
      if (M.start.face === face) things.push({ ...M.start, r: 60 });
      if (M.goal.face === face) things.push({ x: M.goal.x, y: M.goal.y, r: M.goal.r * 0.6 + R + 10 });
      for (const w of M.warps) {
        if (w.face === face) things.push({ ...warpIn(w), r: 22 * 0.6 + R + 10 });
        if (other(w.face) === face) things.push({ ...warpOut(w), r: 22 * 0.6 + R + 30 });
      }
      for (const t of things) for (const r of dz) if (rectDist(t.x, t.y, r) < t.r) return false;
    }
    return true;
  }

  // levels.js と同じ形のパターンにする
  function toPattern(M) {
    const face = (f) => ({
      walls: M.divs[f].map((y) => [WALL, y, W - WALL * 2, T]),
      danger: M.dangers.filter((d) => d.seen === f).map((d) => d.rect),
    });
    return {
      start: { side: M.start.face, x: M.start.x, y: M.start.y },
      goal: { side: M.goal.face, x: M.goal.x, y: M.goal.y, r: M.goal.r },
      // tunnels は A 側の座標で書く。入口が A の右の壁 → x=325 / A の左 → x=35。入口が B の右の壁 → A から見ると左（x=35）
      tunnels: M.warps.map((w) => ({ x: w.face === 'A' ? warpIn(w).x : W - warpIn(w).x, y: w.y, from: w.face })),
      A: face('A'),
      B: face('B'),
    };
  }

  // ---------- 物理で確かめる（45°刻み・床を描く手も使う） ----------
  const STEP45 = Math.PI / 4;
  function verify(P, draws, budget, maxStates = 900) {
    const PH = root.URA_PHYS;
    const res = PH.search(P, { maxStates, maxDepth: 30, robust: true, step: STEP45, draws });
    if (budget) budget.used += res.explored || 0;
    return res;
  }
  // 床を描かなくても解けるか（描くのが必須かどうかを調べる）
  function needsDraw(P, budget) {
    const PH = root.URA_PHYS;
    const res = PH.search(P, { maxStates: 1200, maxDepth: 30, step: STEP45 });
    if (budget) budget.used += res.explored || 0;
    if (res.ok) return false;          // 描かなくても行ける（＝「描かなきゃ」という先入観のワナ）
    return res.reason === 'none' ? true : null; // 調べきれなかったときは null
  }

  // ---------- 穴と足場の部屋（床を描くギミック） ----------
  // ゴールのある部屋の床を「左右の足場＋あいだの穴（底は危険地帯）」に作りかえ、ゴールを奥の足場に置く。
  //  must … 天井も危険地帯にして、ひっくり返して回り込む道をふさぐ（相棒に橋を描いてもらうしかない）
  //  それ以外 … 天井は空けておく（描いてもいいが、束をひっくり返せば足場から足場へ行ける）
  function addBridge(M, sol, pattern, rand, must) {
    const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const face = M.goal.face;
    const rs = rooms(M.divs[face]);
    const c = rs[roomAt(rs, M.goal.y)];
    if (!c) return null;
    const h = ri(70, 115);
    if (c.bottom - c.top < h + 170) return null;
    const ph = c.bottom - h;
    // 入ってくる側（最後に自由に動かし始める場所）
    const last = sol.plan[sol.plan.length - 1];
    let side;
    if (Math.abs(last.x - XL) < 3) side = 'L';
    else if (Math.abs(last.x - XR) < 3) side = 'R';
    else side = M.goal.x > last.x ? 'L' : 'R';
    // この部屋にあるワープ（入口・出口）は、足場より上でないといけない
    const pts = [];
    for (const w of M.warps) { if (w.face === face) pts.push(warpIn(w)); if (other(w.face) === face) pts.push(warpOut(w)); }
    if (pts.some((p) => p.y > c.top && p.y < c.bottom && p.y > ph - 40)) return null;
    if (must && pts.some((p) => p.y > c.top && p.y < c.bottom && p.y < c.top + 80)) return null;
    // 足場の場所にもとからある危険地帯（両面ぶん）があったら作り直す
    const zone = [WALL, ph - 45, W - 2 * WALL, c.bottom - ph + 45];
    const overlap = (r, q) => r[0] < q[0] + q[2] && q[0] < r[0] + r[2] && r[1] < q[1] + q[3] && q[1] < r[1] + r[3];
    if (dangersOn(M, face).some((r) => overlap(r, zone))) return null;
    const wp = ri(70, 118);
    let pL, pR, gx;
    if (side === 'L') { pL = ri(100, 270 - wp); pR = pL + wp; gx = ri(pR + 32, 316); }
    else { pR = ri(90 + wp, 260); pL = pR - wp; gx = ri(44, pL - 32); }
    const P = JSON.parse(JSON.stringify(pattern));
    P[face].walls.push([WALL, ph, pL - WALL, c.bottom - ph], [pR, ph, W - WALL - pR, c.bottom - ph]);
    const addDanger = (rect) => {
      const seen = rand() < 0.5 ? face : other(face); // 穴の底は、どちらの人に見えるかランダム
      P[seen].danger.push(seen === face ? rect : mirrorRect(rect));
    };
    addDanger([pL, c.bottom - 40, wp, 40]);
    if (must) addDanger([WALL, c.top, W - 2 * WALL, 40]);
    P.goal = { side: face, x: gx, y: ph - 16, r: 24 };
    // スタートがこの部屋の床だったら、入ってくる側の足場の上へ
    if (P.start.side === face && P.start.y > c.top && P.start.y < c.bottom) P.start = { side: face, x: side === 'L' ? ri(40, pL - 30) : ri(pR + 30, 320), y: ph - R };
    const draws = [{ face, seg: [pL - 14, ph - 1, pR + 14, ph - 1] }];
    return { pattern: P, draws };
  }

  // ---------- 玉を増やす・敵を置く ----------
  // 何を足すかは難しさレベルで決める（机上のルール）
  function extrasFor(lv, rand) {
    let enemies = 0, balls = 1;
    if (lv >= 9 && rand() < 0.6) enemies++;
    if (lv >= 15 && rand() < 0.5) enemies++;
    if (lv >= 11 && rand() < 0.55) balls++;
    if (lv >= 16 && balls === 2 && rand() < 0.4) balls++;
    return { balls: Math.min(balls, 3), enemies: Math.min(enemies, 2) };
  }

  // 足した玉・敵の置き場所をいくつか試し、実際の物理で「全部の玉をゴールに入れられるか」を調べる。
  // 入れられる置き方が見つかったら採用（見つからなければ、その形はあきらめる）
  function placeExtras(M, pattern, want, rand, budget, draws) {
    const rs = { A: rooms(M.divs.A), B: rooms(M.divs.B) };
    const roomKey = (face, y) => face + roomAt(rs[face], y);
    const startRoom = roomKey(pattern.start.side, pattern.start.y);
    const goalRoom = roomKey(pattern.goal.side, pattern.goal.y);
    const spots = [];
    for (const f of ['A', 'B']) rs[f].forEach((c) => { for (const x of [50, 130, 230, 310]) spots.push({ side: f, x, y: c.bottom - R }); });
    const warpPts = (face) => M.warps.flatMap((w) => [w.face === face ? warpIn(w) : null, other(w.face) === face ? warpOut(w) : null]).filter(Boolean);
    const allDanger = (face) => [...pattern[face].danger, ...pattern[other(face)].danger.map(mirrorRect)];
    const okSpot = (s) => {
      if (pattern[s.side].walls.some((w) => rectDist(s.x, s.y, w) < R)) return false; // 足場の中など
      if (warpPts(s.side).some((p) => Math.hypot(p.x - s.x, p.y - s.y) < 60)) return false;
      if (allDanger(s.side).some((r) => rectDist(s.x, s.y, r) < 50)) return false;
      if (pattern.goal.side === s.side && Math.hypot(pattern.goal.x - s.x, pattern.goal.y - s.y) < 70) return false;
      return true;
    };
    const ballSpots = spots.filter((s) => okSpot(s) && roomKey(s.side, s.y) !== goalRoom);
    for (let tries = 0; tries < 12; tries++) {
      if (budget && budget.used > budget.max) return null;
      const balls = [{ ...pattern.start }];
      const used = new Set([startRoom]);
      // 足す玉は、なるべく反対の面に（2人ともそれぞれ自分の玉を見るように）
      for (let i = 1; i < want.balls; i++) {
        const free = (s) => balls.every((b) => b.side !== s.side || Math.hypot(b.x - s.x, b.y - s.y) > 60);
        const prefer = ballSpots.filter((s) => s.side !== pattern.start.side && !used.has(roomKey(s.side, s.y)) && free(s));
        let pool = prefer.length && rand() < 0.8 ? prefer : ballSpots.filter((s) => !used.has(roomKey(s.side, s.y)) && free(s));
        if (!pool.length) pool = ballSpots.filter(free); // 部屋が足りなければ、同じ部屋の別の場所でもよい
        if (!pool.length) break;
        const s = pool[Math.floor(rand() * pool.length)];
        balls.push({ side: s.side, x: s.x, y: s.y });
        used.add(roomKey(s.side, s.y));
      }
      if (balls.length < want.balls) return null;
      // 敵は、玉と同じ部屋には置かない（スタートしたとたんにぶつかるので）
      const enemies = [];
      const ePool = spots.filter((s) => okSpot(s) && !used.has(roomKey(s.side, s.y)) && roomKey(s.side, s.y) !== goalRoom);
      for (let i = 0; i < want.enemies && ePool.length; i++) {
        const s = ePool.splice(Math.floor(rand() * ePool.length), 1)[0];
        enemies.push({ side: s.side, x: s.x, y: s.y });
      }
      if (enemies.length < want.enemies) return null;
      const P = { ...pattern, balls, enemies };
      const res = verify(P, draws, budget, 700);
      if (res.ok) return { pattern: P, actions: res.actions, step: res.step };
    }
    return null;
  }

  // 床を描くギミックを入れる割合（机上のルール）。入れたうち、およそ6割は「描くのが必須」、4割は「実は描かなくていい」（必須の形は作りやすいので、狙いは少し控えめに）
  const bridgeP = (lv) => (lv >= 7 ? 0.7 : 0);

  function make(n, seed) {
    const rand = rng((Math.imul(seed >>> 0, 2654435761) ^ (n * 40503)) >>> 0);
    // うまく作れないときは、少しずつ易しくして必ず作る
    // 玉・敵の数・床のギミックは最初に決める。どうしても置けないときだけ、少しずつ減らす
    const want = extrasFor(Math.min(n, 20), rand);
    let wantBridge = rand() < bridgeP(Math.min(n, 20));
    const mustDraw = rand() < 0.45;
    let exFails = 0, brFails = 0;
    // 物理の探索は重いので、使ってよい量を決めておく。使い切ったら玉・敵を1つ減らす
    const budget = { used: 0, max: 7000 };
    const t0 = Date.now();
    let downgraded = 0;
    for (let attempt = 0; attempt < 2400; attempt++) {
      const level = Math.max(6, Math.min(n, 20) - Math.floor(attempt / 150)); // 20 以降の難しさは頭打ち
      // 時間がかかりすぎたら、玉・敵を減らす（1.5秒ごとに1つ、3秒を超えたら足さない。4秒を超えたら床のギミックもやめる）
      const spent = Date.now() - t0;
      while (downgraded < Math.floor(spent / 1500) && (want.enemies > 0 || want.balls > 1)) {
        if (want.enemies > 0) want.enemies--; else want.balls--;
        downgraded++;
      }
      if (spent > 3000) { want.enemies = 0; want.balls = 1; }
      if (spent > 4000) wantBridge = false;
      const r = tryBuild(level, rand);
      if (!r) continue;
      let pattern = toPattern(r.M);
      let actions = null, step = null, draws = [], needDraw = false;
      if (wantBridge) {
        const br = addBridge(r.M, r.sol, pattern, rand, mustDraw);
        if (!br) { if (++brFails > 60) wantBridge = false; continue; }
        pattern = br.pattern; draws = br.draws;
      }
      if (want.balls > 1 || want.enemies > 0) {
        const ex = placeExtras(r.M, pattern, want, rand, budget, draws);
        if (!ex) { // この形では無理だった：別の形で作り直す
          if (++exFails % 12 === 0 || budget.used > budget.max) {
            if (want.enemies > 0) want.enemies--; else if (want.balls > 1) want.balls--;
            budget.used = 0;
          }
          continue;
        }
        pattern = ex.pattern; actions = ex.actions; step = ex.step;
      } else if (wantBridge) {
        const res = verify(pattern, draws, budget);
        if (!res.ok) { if (++brFails > 60) wantBridge = false; continue; }
        actions = res.actions; step = res.step;
      }
      if (wantBridge) {
        const nd = needsDraw(pattern, budget);
        if (nd === null) continue; // 必須かどうか判断できない形は使わない
        needDraw = nd;
      }
      // ハートは半分くらいのステージに1つ（足場や穴の中には置かない）
      let heart = rand() < 0.5 ? placeHeart(r.M, r.sol, rand) : null;
      if (heart && (pattern[heart.side].walls.some((w) => rectDist(heart.x, heart.y, w) < 18) ||
        [...pattern[heart.side].danger, ...pattern[other(heart.side)].danger.map(mirrorRect)].some((d) => rectDist(heart.x, heart.y, d) < 40))) heart = null;
      pattern.hearts = heart ? [{ id: 'h1', ...heart }] : [];
      const nb = (pattern.balls || [1]).length, ne = (pattern.enemies || []).length;
      return {
        pattern,
        name: '自動生成',
        // 床が必要かどうかは書かない（「描かなきゃ」という先入観もゲームのうち）
        hint: `その場で作った迷路。${nb > 1 ? `玉${nb}つ（全部ゴールへ）・` : ''}${ne ? `敵${ne}体・` : ''}最短でワープ${r.sol.warps}回くらい。危険地帯${pattern.A.danger.length + pattern.B.danger.length}か所${r.M.warps.length > r.sol.warps ? '・ハズレのワープあり' : ''}${draws.length ? '・穴あり' : ''}。`,
        plan: actions ? null : r.sol.plan,
        actions, step, draws,
        bridge: draws.length > 0,
        needDraw,
        heart,
        warps: r.sol.warps,
        balls: nb,
        enemies: ne,
        level,
        model: r.M,
      };
    }
    return null;
  }

  const api = { make, solve, difficulty, extrasFor, _walk: walk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.URA_GEN = api;
})(typeof window !== 'undefined' ? window : globalThis);
