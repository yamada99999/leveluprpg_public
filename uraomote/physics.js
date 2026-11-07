'use strict';
// ウラオモテ迷宮 物理（ゲーム本体と、自動生成の「解けるか確認」で共通）
//
// 世界 = オモテ(A)とウラ(B)の2つの面 ＋ その上を転がるもの（玉・敵）。
//  ・玉（ball）  … 全部ゴールに入れたらクリア。危険地帯・敵に触れたらアウト。
//  ・敵（enemy） … 玉と同じように転がる。玉と同じ面で触れたらアウト。危険地帯は平気。
//                   ワープも通る（裏へ送り出せる）。違う面どうしなら重なっても平気。
// 重力は grav(面) で外から渡す（束の傾き）。
(function (root) {
  const W = 360, H = 640, WALL = 12, R = 13, ER = 14;
  const G_ACC = 1150, DAMP = 0.5, MAXV = 950, REST = 0.3, LINE_R = 3;
  const CP_CONFIRM = 1.2, WARP_T = 0.35, RESPAWN_HOLD = 1.2;
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mirrorRect = (r) => [W - r[0] - r[2], r[1], r[2], r[3]];
  const rectDist = (px, py, r) => Math.hypot(px - clamp(px, r[0], r[0] + r[2]), py - clamp(py, r[1], r[1] + r[3]));

  // ---------- 面の組み立て ----------
  function buildFace(P, side) {
    const F = P[side] || {};
    const walls = [[0, 0, W, WALL], [0, H - WALL, W, WALL], [0, 0, WALL, H], [W - WALL, 0, WALL, H], ...(F.walls || [])];
    const seen = (F.danger || []).map((r) => r.slice()); // この面の人にだけ見える危険地帯
    // ワープは一方通行：from の面が入口、反対の面は出口
    const tunnels = (P.tunnels || []).map((t, i) => ({ id: i + 1, r: t.r || 22, x: side === 'A' ? t.x : W - t.x, y: t.y, enter: (t.from || 'A') === side }));
    return { walls, seen, danger: [], stars: [], tunnels };
  }
  function buildFaces(P) {
    const faces = { A: buildFace(P, 'A'), B: buildFace(P, 'B') };
    // 危険地帯は束を貫く場所：自分に見えるものも、相棒に見えるもの（真裏）も、両方触れたらアウト
    for (const s of ['A', 'B']) faces[s].danger = [...faces[s].seen, ...faces[other(s)].seen.map(mirrorRect)];
    return faces;
  }

  // パターン → 世界。balls が無ければ start の玉1つ
  function makeWorld(P, opt = {}) {
    const starts = P.balls && P.balls.length ? P.balls : [P.start];
    const balls = starts.map((s, i) => ({
      id: 'b' + i, kind: 'ball', r: R, side: s.side, x: s.x, y: s.y, vx: 0, vy: 0,
      ign: null, warpT: 0, warpTo: null, goaled: false, dead: false,
      cp: { side: s.side, x: s.x, y: s.y, ign: null }, pend: null, cpT: 0,
    }));
    const enemies = (P.enemies || []).map((e, i) => ({
      id: 'e' + i, kind: 'enemy', r: ER, side: e.side, x: e.x, y: e.y, vx: 0, vy: 0,
      ign: null, warpT: 0, warpTo: null, home: { side: e.side, x: e.x, y: e.y },
    }));
    const taken = opt.takenHearts || [];
    return {
      faces: buildFaces(P),
      goal: { ...P.goal, r: P.goal.r || 24 },
      hearts: (opt.hearts === false ? [] : (P.hearts || [])).filter((h) => !taken.includes(h.id)).map((h) => ({ ...h, got: false })),
      lines: { A: null, B: null },
      objs: [...balls, ...enemies],
      hold: 0,
      clear: false,
    };
  }

  // 探索用に、動くものだけをコピー
  function cloneWorld(w) {
    return { ...w, hearts: w.hearts.map((h) => ({ ...h })), lines: { ...w.lines }, objs: w.objs.map((o) => ({ ...o, cp: o.cp && { ...o.cp }, pend: o.pend && { ...o.pend } })) };
  }

  // ---------- 当たり判定 ----------
  function collideRect(o, w, ev) {
    const [x, y, ww, hh] = w, r = o.r;
    const cx = clamp(o.x, x, x + ww), cy = clamp(o.y, y, y + hh);
    const dx = o.x - cx, dy = o.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    let nx, ny, pen;
    if (d2 < 1e-9) { // 中心が壁の中：一番近い辺から押し出す
      const l = o.x - x, rr = x + ww - o.x, t = o.y - y, bo = y + hh - o.y;
      const m = Math.min(l, rr, t, bo);
      if (m === l) { nx = -1; ny = 0; } else if (m === rr) { nx = 1; ny = 0; } else if (m === t) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
      pen = r + m;
    } else { const dd = Math.sqrt(d2); nx = dx / dd; ny = dy / dd; pen = r - dd; }
    o.x += nx * pen; o.y += ny * pen;
    bounce(o, nx, ny, ev);
  }
  function collideSeg(o, s, ev) {
    const [x1, y1, x2, y2] = s;
    const vx = x2 - x1, vy = y2 - y1, L2 = vx * vx + vy * vy || 1;
    const t = clamp(((o.x - x1) * vx + (o.y - y1) * vy) / L2, 0, 1);
    const dx = o.x - (x1 + vx * t), dy = o.y - (y1 + vy * t);
    const d = Math.hypot(dx, dy), need = o.r + LINE_R;
    if (d >= need) return;
    let nx, ny;
    if (d < 1e-6) { nx = -vy; ny = vx; const n = Math.hypot(nx, ny) || 1; nx /= n; ny /= n; } else { nx = dx / d; ny = dy / d; }
    o.x += nx * (need - d); o.y += ny * (need - d);
    bounce(o, nx, ny, ev);
  }
  function bounce(o, nx, ny, ev) {
    const vn = o.vx * nx + o.vy * ny;
    if (vn >= 0) return;
    const e = -vn > 60 ? REST : 0; // ゆっくり当たったときは跳ねさせない（床でのガタつき防止）
    o.vx -= (1 + e) * vn * nx; o.vy -= (1 + e) * vn * ny;
    if (ev && -vn > 220) ev.push({ type: 'bump', o });
  }

  const active = (o) => !o.goaled && !o.dead && o.warpT <= 0;

  // ---------- 1コマ進める ----------
  // ev には起きたことが入る：warpIn / warp / cp / goal / clear / heart / fail / bump
  function step(world, grav, dt, ev) {
    if (world.hold > 0) { world.hold -= dt; return; } // 復活直後は少し待つ（束をまっすぐに戻す時間）
    for (const o of world.objs) {
      if (o.goaled || o.dead) continue;
      if (o.warpT > 0) { o.warpT -= dt; if (o.warpT <= 0) arrive(world, o, ev); continue; }
      move(world, o, grav(o.side), dt, ev);
      if (o.dead || o.goaled) continue;
      if (o.kind === 'ball' && o.pend && o.warpT <= 0) {
        o.cpT -= dt;
        if (o.cpT <= 0) { o.cp = o.pend; o.pend = null; ev.push({ type: 'cp', o }); } // ワープを抜けて無事ならチェックポイント
      }
    }
    for (const o of world.objs) o.hidden = !!(o.goaled || o.dead || o.warpT > 0);
    // 転がるものどうし（同じ面だけ）
    const list = world.objs.filter(active);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.side !== b.side || a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), need = a.r + b.r;
      if (d >= need) continue;
      if (a.kind !== b.kind) { // 玉と敵がぶつかった
        const ball = a.kind === 'ball' ? a : b;
        fail(world, ball, 'enemy', ev);
        continue;
      }
      const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0, pen = (need - d) / 2;
      a.x -= nx * pen; a.y -= ny * pen; b.x += nx * pen; b.y += ny * pen;
      const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rv < 0) { const imp = -(1 + 0.2) * rv / 2; a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny; }
    }
  }

  function move(world, o, g, dt, ev) {
    const F = world.faces[o.side];
    o.vx += g[0] * G_ACC * dt; o.vy += g[1] * G_ACC * dt;
    const d = Math.max(0, 1 - DAMP * dt);
    o.vx *= d; o.vy *= d;
    let sp = Math.hypot(o.vx, o.vy);
    if (sp > MAXV) { o.vx *= MAXV / sp; o.vy *= MAXV / sp; sp = MAXV; }
    const n = Math.max(1, Math.ceil((sp * dt) / (R * 0.35)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      o.x += o.vx * h; o.y += o.vy * h;
      for (const w of F.walls) collideRect(o, w, ev);
      const ln = world.lines[o.side];
      if (ln) collideSeg(o, ln, ev);
      o.x = clamp(o.x, WALL + o.r, W - WALL - o.r);
      o.y = clamp(o.y, WALL + o.r, H - WALL - o.r);
      if (touch(world, o, F, ev)) return;
    }
  }

  function touch(world, o, F, ev) {
    if (o.kind === 'ball') {
      // ゴール（危険地帯と近くても、ゴールに入ったらゴールを優先）
      const gl = world.goal;
      if (gl.side === o.side && Math.hypot(o.x - gl.x, o.y - gl.y) < gl.r * 0.8) {
        o.goaled = true; o.vx = 0; o.vy = 0;
        ev.push({ type: 'goal', o });
        if (world.objs.every((b) => b.kind !== 'ball' || b.goaled)) { world.clear = true; ev.push({ type: 'clear' }); }
        return true;
      }
      for (const hh of world.hearts) {
        if (!hh.got && hh.side === o.side && Math.hypot(o.x - hh.x, o.y - hh.y) < 15 + R) { hh.got = true; ev.push({ type: 'heart', h: hh, o }); }
      }
      for (const r of F.danger) if (rectDist(o.x, o.y, r) < R * 0.55) { fail(world, o, 'trap', ev, r); return true; }
    }
    for (const t of F.tunnels) {
      if (!t.enter) continue; // 出口からは入れない
      const dd = Math.hypot(o.x - t.x, o.y - t.y);
      if (o.ign === t.id) { if (dd > t.r + o.r + 2) o.ign = null; continue; }
      if (dd < t.r * 0.6) {
        o.warpT = WARP_T; o.warpTo = t.id; o.wvx = o.vx; o.wvy = o.vy;
        ev.push({ type: 'warpIn', o, x: t.x, y: t.y, side: o.side });
        return true;
      }
    }
    return false;
  }

  // ワープの出口に出る（真裏なので左右の向きが反転。勢いは半分）
  function arrive(world, o, ev) {
    const to = other(o.side);
    const ex = world.faces[to].tunnels.find((t) => t.id === o.warpTo);
    o.side = to; o.x = ex.x; o.y = ex.y; o.vx = -(o.wvx || 0) * 0.5; o.vy = (o.wvy || 0) * 0.5; o.ign = ex.id; o.warpT = 0;
    if (o.kind === 'ball') { o.pend = { side: to, x: ex.x, y: ex.y, ign: ex.id }; o.cpT = CP_CONFIRM; }
    ev.push({ type: 'warp', o });
  }

  function fail(world, o, reason, ev, rect) {
    if (o.dead) return;
    o.dead = true; o.vx = 0; o.vy = 0;
    ev.push({ type: 'fail', o, reason, rect });
  }

  // アウトになった玉をチェックポイントへ戻す。敵も最初の場所へ戻す（ふさがれて動けなくならないように）
  function respawn(world, o) {
    const cp = o.cp;
    o.pend = null; o.dead = false; o.warpT = 0;
    o.side = cp.side; o.x = cp.x; o.y = cp.y; o.vx = 0; o.vy = 0; o.ign = cp.ign;
    for (const e of world.objs) {
      if (e.kind !== 'enemy') continue;
      e.side = e.home.side; e.x = e.home.x; e.y = e.home.y; e.vx = 0; e.vy = 0; e.warpT = 0; e.ign = null;
    }
    world.hold = RESPAWN_HOLD;
  }

  // ---------- 実際の物理で「解けるか」を探す ----------
  // 束を少しずつ（ゆっくり・玉が落ち着くのを待ちながら）回す手順と、「床を描く」手順を総当たりして、
  // 全部の玉をゴールに入れられるか調べる。アウトになる手順は使わない。
  //   step  … 1回に回す角度（π/2 = 90°、π/4 = 45°。45°だと「斜めで止めて角に玉を預ける」ような手も使える）
  //   draws … 描いてよい床の候補 [{ face, seg }]（その面に床が出る。描くのは相棒＝反対の面の人）
  // 手順は、数（+1/-1 = その角度だけ回す。オモテから見た向き）か、{ d: 候補番号 }（床を描く）の列。
  const gravAt = (th) => (side) => (side === 'A' ? [Math.sin(th), Math.cos(th)] : [-Math.sin(th), Math.cos(th)]);
  function settle(world, th, ev) {
    const g = gravAt(th);
    let still = 0;
    for (let f = 0; f < 60 * 5; f++) {
      step(world, g, 1 / 60, ev);
      if (ev.some((e) => e.type === 'fail' || e.type === 'clear')) return;
      const moving = world.objs.some((o) => !o.goaled && !o.dead && (o.warpT > 0 || Math.hypot(o.vx, o.vy) > 8));
      if (!moving && world.hold <= 0) { if (++still > 12) return; } else still = 0;
    }
  }
  function turn(world, th0, dir, speed = 2, stepAng = Math.PI / 2) {
    const ev = [];
    const SP = speed / 60, target = th0 + dir * stepAng;
    let th = th0;
    for (let f = 0; f < 60 * 12 && dir * (target - th) > 1e-9; f++) {
      // 見えている玉・敵が速く動いている間は回すのを待つ（ワープ中で見えないものは待たない＝人と同じ）
      const fast = world.objs.some((o) => !o.goaled && !o.dead && o.warpT <= 0 && Math.hypot(o.vx, o.vy) > 70);
      if (!fast && world.hold <= 0) th = dir > 0 ? Math.min(target, th + SP) : Math.max(target, th - SP);
      step(world, gravAt(th), 1 / 60, ev);
      if (ev.some((e) => e.type === 'fail' || e.type === 'clear')) return { ev, th };
    }
    settle(world, target, ev);
    return { ev, th: target };
  }
  // 床を描く（その場で止まったまま。描いた床に玉が押し出されることもあるので、少し落ち着かせる）
  // ペンは2人で1本：新しく描くと、どちらの面に出ていた床も消える
  function drawLine(world, cand, th) {
    world.lines.A = null; world.lines.B = null;
    world.lines[cand.face] = cand.seg.slice();
    const ev = [];
    settle(world, th, ev);
    return { ev };
  }
  function keyOf(world, k, n, lineKey) {
    return ((k % n) + n) % n + '|' + lineKey + '|' + world.objs.map((o) => (o.goaled ? 'G' : o.side + Math.round(o.x / 10) + ',' + Math.round(o.y / 10))).join('|');
  }
  function startWorld(P) {
    const w = makeWorld(P, { hearts: false });
    const ev0 = [];
    for (let i = 0; i < 200; i++) step(w, gravAt(0), 1 / 60, ev0); // スタート直後に落ち着かせる
    return { w, bad: ev0.some((e) => e.type === 'fail') };
  }
  // 見つけた手順を、回す速さを変えて最初からやり直しても成功するか（人の操作は毎回少しずつ違うので）
  function replay(P, actions, speed, opt = {}) {
    const stepAng = opt.step || Math.PI / 2, draws = opt.draws || [];
    const { w, bad } = startWorld(P);
    if (bad) return false;
    let k = 0;
    for (const a of actions) {
      let r;
      if (typeof a === 'object') r = drawLine(w, draws[a.d], k * stepAng);
      else { r = turn(w, k * stepAng, a, speed, stepAng); k += a; }
      if (r.ev.some((e) => e.type === 'fail')) return false;
      if (w.clear) return true;
    }
    return w.clear;
  }
  function robust(P, actions, opt) {
    return [1.3, 2.8].every((sp) => replay(P, actions, sp, opt));
  }

  function search(P, opt = {}) {
    const maxStates = opt.maxStates || 800, maxDepth = opt.maxDepth || 24;
    const stepAng = opt.step || Math.PI / 2, n = Math.round((2 * Math.PI) / stepAng);
    const draws = opt.draws || [];
    const { w: w0, bad } = startWorld(P);
    if (bad) return { ok: false, reason: 'start-fail' };
    if (w0.clear) return { ok: true, actions: [], explored: 1, step: stepAng };
    const seen = new Set([keyOf(w0, 0, n, '-')]);
    let frontier = [{ w: w0, k: 0, acts: [], L: -1 }]; // L = いま出ている床の候補番号（-1 = なし。床は全体で1本だけ）
    let explored = 0;
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const nd of frontier) {
        const moves = [1, -1];
        draws.forEach((c, i) => { if (nd.L !== i) moves.push({ d: i }); });
        for (const mv of moves) {
          const w = cloneWorld(nd.w);
          let r, k = nd.k, L = nd.L;
          if (typeof mv === 'object') { r = drawLine(w, draws[mv.d], k * stepAng); L = mv.d; }
          else { r = turn(w, k * stepAng, mv, 2, stepAng); k += mv; }
          explored++;
          if (r.ev.some((e) => e.type === 'fail')) continue;
          const acts = [...nd.acts, mv];
          if (w.clear) {
            if (!opt.robust || robust(P, acts, { step: stepAng, draws })) return { ok: true, actions: acts, explored, step: stepAng };
            continue; // ぎりぎりの手順は採用しない（別の手順を探し続ける）
          }
          const key = keyOf(w, k, n, String(L));
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ w, k, acts, L });
          if (explored > maxStates) return { ok: false, reason: 'limit', explored };
        }
      }
      frontier = next;
    }
    return { ok: false, reason: 'none', explored };
  }

  const api = {
    W, H, WALL, R, ER, LINE_R, RESPAWN_HOLD,
    buildFaces, makeWorld, cloneWorld, step, respawn, search, replay, robust, gravAt, mirrorRect, rectDist, other,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.URA_PHYS = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
