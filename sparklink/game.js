'use strict';
// スパークリンク ゲームロジック（ホスト端末の host.js と、AI用の ai-worker.js で実行）
//
// 盤面は (2n+1)×(2n+1) の格子座標で表す。
//   赤の点: x が奇数・y が偶数   （y=0 と y=2n が赤のゴールライン）
//   青の点: x が偶数・y が奇数   （x=0 と x=2n が青のゴールライン）
// 線を引ける「スロット」は隣り合う2点の中点。赤の線と青の線は同じ中点で交差するので、
// 1つのスロットはどちらか1色しか使えない（＝線は交差しない）。

// ページ上の app.js と名前がぶつからないよう、全体を関数で包む
(function () {
const R = 'R';
const B = 'B';
const other = (c) => (c === R ? B : R);
const key = (mx, my) => `${mx},${my}`;

function isSlot(n, mx, my) {
  const m = 2 * n;
  if (mx % 2 === 1 && my % 2 === 1) return mx >= 1 && mx <= m - 1 && my >= 1 && my <= m - 1;
  if (mx % 2 === 0 && my % 2 === 0) return mx >= 2 && mx <= m - 2 && my >= 2 && my <= m - 2;
  return false;
}

function allSlots(n) {
  const list = [];
  for (let my = 1; my < 2 * n; my++) for (let mx = 1; mx < 2 * n; mx++) if (isSlot(n, mx, my)) list.push([mx, my]);
  return list;
}

// スロットをその色で使ったときの両端の点
function endpoints(color, mx, my) {
  const vertical = color === R ? mx % 2 === 1 : mx % 2 === 0;
  return vertical ? [[mx, my - 1], [mx, my + 1]] : [[mx - 1, my], [mx + 1, my]];
}

const isStart = (n, color, x, y) => (color === R ? y === 0 : x === 0);
const isGoal = (n, color, x, y) => (color === R ? y === 2 * n : x === 2 * n);

function colorDots(n, color) {
  const dots = [];
  if (color === R) { for (let y = 0; y <= 2 * n; y += 2) for (let x = 1; x < 2 * n; x += 2) dots.push([x, y]); } else { for (let y = 1; y < 2 * n; y += 2) for (let x = 0; x <= 2 * n; x += 2) dots.push([x, y]); }
  return dots;
}

// 始点ラインから、自分の線でつながっている範囲をたどる。ゴールに届いたら経路を返す
function trace(n, owner, color) {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const parent = new Map();
  const queue = [];
  for (const [x, y] of colorDots(n, color)) {
    if (isStart(n, color, x, y)) { parent.set(key(x, y), null); queue.push([x, y]); }
  }
  const powered = [];
  let goal = null;
  while (queue.length) {
    const [x, y] = queue.shift();
    if (!goal && isGoal(n, color, x, y)) goal = [x, y];
    for (const [dx, dy] of DIRS) {
      const mx = x + dx; const my = y + dy;
      if (owner[key(mx, my)] !== color) continue;
      const nx = x + 2 * dx; const ny = y + 2 * dy;
      const k = key(nx, ny);
      if (parent.has(k)) continue;
      parent.set(k, { from: [x, y], slot: key(mx, my) });
      powered.push(key(mx, my));
      queue.push([nx, ny]);
    }
  }
  let path = null;
  if (goal) {
    path = [];
    let k = key(goal[0], goal[1]);
    while (parent.get(k)) { const p = parent.get(k); path.unshift(p.slot); k = key(p.from[0], p.from[1]); }
  }
  return { powered, path };
}

function createGame(n, handicap, handicapColor) {
  const h = Math.max(0, Number(handicap) || 0);
  const hColor = h > 0 ? handicapColor : null;
  return {
    n,
    owner: {},
    moves: [],
    turn: hColor || R, // ハンデがあれば、その色から自由に打てる
    handicap: h,
    handicapColor: hColor,
    handicapRemaining: h,
    phase: 'play', // play | finished
    winner: null,
    winPath: null,
    resigned: null,
    log: [],
  };
}

function addLog(g, text) {
  g.log.push(text);
  if (g.log.length > 80) g.log.shift();
}

function play(g, color, mx, my) {
  mx = Number(mx); my = Number(my);
  if (g.phase !== 'play') return { ok: false, error: 'ゲームは終了しています' };
  if (g.turn !== color) return { ok: false, error: 'あなたの手番ではありません' };
  if (!Number.isInteger(mx) || !Number.isInteger(my) || !isSlot(g.n, mx, my)) return { ok: false, error: 'そこには線を引けません' };
  const k = key(mx, my);
  if (g.owner[k]) return { ok: false, error: 'すでに線が交差しています' };
  g.owner[k] = color;
  g.moves.push({ mx, my, color });
  const { path } = trace(g.n, g.owner, color);
  if (path) {
    g.phase = 'finished';
    g.winner = color;
    g.winPath = path;
    return { ok: true };
  }
  if (g.handicapRemaining > 0) {
    g.handicapRemaining--;
    if (g.handicapRemaining === 0) g.turn = other(g.handicapColor);
  } else {
    g.turn = other(color);
  }
  return { ok: true };
}

function resign(g, color) {
  if (g.phase !== 'play') return { ok: false, error: 'ゲームは終了しています' };
  g.phase = 'finished';
  g.winner = other(color);
  g.resigned = color;
  return { ok: true };
}

// ---------------- AI：電気抵抗による評価 ----------------
// 自分の線 = 導線（高い導電率）、空きスロット = 抵抗1、相手の線 = 断線。
// スタートライン→ゴールライン間の合成抵抗が小さいほど「つながりやすい」。
function resistance(n, owner, color) {
  const idx = new Map();
  let m = 0;
  for (const [x, y] of colorDots(n, color)) {
    if (isStart(n, color, x, y)) idx.set(key(x, y), -1);
    else if (isGoal(n, color, x, y)) idx.set(key(x, y), -2);
    else idx.set(key(x, y), m++);
  }
  const A = Array.from({ length: m }, () => new Float64Array(m + 1));
  const edgesFromStart = [];
  for (const [mx, my] of allSlots(n)) {
    const o = owner[key(mx, my)];
    if (o && o !== color) continue;
    const c = o === color ? 200 : 1;
    const [[x1, y1], [x2, y2]] = endpoints(color, mx, my);
    const a = idx.get(key(x1, y1)); const b = idx.get(key(x2, y2));
    if (a === undefined || b === undefined) continue;
    // 電位: スタート=1, ゴール=0
    const add = (p, q) => {
      if (p < 0) return;
      A[p][p] += c;
      if (q >= 0) A[p][q] -= c; else if (q === -1) A[p][m] += c;
    };
    add(a, b); add(b, a);
    if (a === -1 && b !== -1) edgesFromStart.push([b, c]);
    if (b === -1 && a !== -1) edgesFromStart.push([a, c]);
  }
  // ガウスの消去法
  for (let i = 0; i < m; i++) {
    let piv = i;
    for (let r = i + 1; r < m; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-12) { A[i].fill(0); A[i][i] = 1; continue; }
    [A[i], A[piv]] = [A[piv], A[i]];
    const d = A[i][i];
    for (let c2 = i; c2 <= m; c2++) A[i][c2] /= d;
    for (let r = 0; r < m; r++) {
      if (r === i || A[r][i] === 0) continue;
      const f = A[r][i];
      for (let c2 = i; c2 <= m; c2++) A[r][c2] -= f * A[i][c2];
    }
  }
  let current = 0;
  for (const [p, c] of edgesFromStart) current += c * (1 - (p === -2 ? 0 : A[p][m]));
  return current > 1e-9 ? 1 / current : 1e9;
}

function evaluate(n, owner, color) {
  return Math.log(resistance(n, owner, other(color))) - Math.log(resistance(n, owner, color));
}

// ---------------- 必勝判定（Lehman の定理） ----------------
// このゲームは「シャノンのスイッチングゲーム」。自分の色の点をグラフの頂点、
// 空きスロットを辺、自分の線を「縮約（点を1つにまとめる）」、相手の線を「削除」とみなす。
// 始点ライン全体を s、ゴールライン全体を t にまとめたとき、
//   「相手の手番で、s と t を含む頂点集合の上に、辺を共有しない全域木が2本ある」
// ⇔ 自分は何をされても必ず勝てる（Lehman 1964）。
// 相手に辺を1本消されたら、もう片方の木からつなぎ直す辺を選べばよいので、これは読み抜けのない完全な判定。

class UF {
  constructor(n) { this.p = Int32Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a === b) return false; this.p[a] = b; return true; }
}

const templateCache = new Map();
function slotTemplate(n, color) {
  const ck = `${n}:${color}`;
  if (templateCache.has(ck)) return templateCache.get(ck);
  const id = new Map();
  let V = 2;
  for (const [x, y] of colorDots(n, color)) {
    if (isStart(n, color, x, y)) id.set(key(x, y), 0);
    else if (isGoal(n, color, x, y)) id.set(key(x, y), 1);
    else id.set(key(x, y), V++);
  }
  const slots = allSlots(n).map(([mx, my]) => {
    const [[x1, y1], [x2, y2]] = endpoints(color, mx, my);
    return { k: key(mx, my), a: id.get(key(x1, y1)), b: id.get(key(x2, y2)) };
  });
  const t = { V, slots };
  templateCache.set(ck, t);
  return t;
}

// 色 color から見たグラフ（自分の線は縮約、相手の線は削除）。won=true なら既につながっている
function buildGraph(n, owner, color) {
  const { V, slots } = slotTemplate(n, color);
  const uf = new UF(V);
  const free = [];
  for (const s of slots) {
    const o = owner[s.k];
    if (!o) free.push(s);
    else if (o === color) uf.union(s.a, s.b);
  }
  return contract(V, uf, free.map((s) => [s.a, s.b]), 0, 1);
}

function contract(V, uf, edges, s, t) {
  const map = new Int32Array(V).fill(-1);
  const rs = uf.find(s); const rt = uf.find(t);
  if (rs === rt) return { won: true };
  map[rs] = 0; map[rt] = 1;
  let nv = 2;
  const out = [];
  for (const [a, b] of edges) {
    let ra = uf.find(a); let rb = uf.find(b);
    if (ra === rb) continue;
    if (map[ra] < 0) map[ra] = nv++;
    if (map[rb] < 0) map[rb] = nv++;
    out.push([map[ra], map[rb]]);
  }
  return { won: false, V: nv, edges: out };
}

// 森 label===li の辺で、各頂点の親・深さ・連結成分を作る
function rootForest(V, edges, label, li) {
  const adj = Array.from({ length: V }, () => []);
  edges.forEach(([a, b], i) => { if (label[i] === li) { adj[a].push(i); adj[b].push(i); } });
  const comp = new Int32Array(V).fill(-1);
  const par = new Int32Array(V);
  const pe = new Int32Array(V);
  const dep = new Int32Array(V);
  const stack = [];
  for (let r = 0; r < V; r++) {
    if (comp[r] >= 0) continue;
    comp[r] = r; par[r] = -1; pe[r] = -1; dep[r] = 0; stack.push(r);
    while (stack.length) {
      const u = stack.pop();
      for (const ei of adj[u]) {
        const w = edges[ei][0] === u ? edges[ei][1] : edges[ei][0];
        if (comp[w] >= 0) continue;
        comp[w] = r; par[w] = u; pe[w] = ei; dep[w] = dep[u] + 1; stack.push(w);
      }
    }
  }
  return { comp, par, pe, dep };
}

function forestPath(f, u, v, visit) {
  while (u !== v) {
    if (f.dep[u] >= f.dep[v]) { visit(f.pe[u], u); u = f.par[u]; } else { visit(f.pe[v], v); v = f.par[v]; }
  }
}

// 辺を共有しない森2本の和を最大化（マトロイド分割・最短増加路）
function maxTwoForests(V, edges) {
  const E = edges.length;
  const label = new Int8Array(E);
  const prev = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    const F = [null, rootForest(V, edges, label, 1), rootForest(V, edges, label, 2)];
    prev.fill(-2);
    prev[e] = -1;
    const queue = [e];
    let done = false;
    for (let qi = 0; qi < queue.length && !done; qi++) {
      const g = queue[qi];
      const [u, v] = edges[g];
      for (let li = 1; li <= 2 && !done; li++) {
        if (label[g] === li) continue;
        const f = F[li];
        if (f.comp[u] !== f.comp[v]) {
          let cur = g; let nl = li;
          while (cur !== -1) { const old = label[cur]; label[cur] = nl; nl = old; cur = prev[cur]; }
          done = true;
        } else {
          forestPath(f, u, v, (h) => { if (prev[h] === -2) { prev[h] = g; queue.push(h); } });
        }
      }
    }
  }
  return label;
}

// 相手の手番のとき、自分（s-t をつなぐ側）が必ず勝てるか
function secondPlayerWins(graph) {
  let { V, edges } = graph;
  for (;;) {
    const label = maxTwoForests(V, edges);
    const F = [null, rootForest(V, edges, label, 1), rootForest(V, edges, label, 2)];
    const spare = [];
    for (let i = 0; i < edges.length; i++) if (!label[i]) spare.push(i);
    if (!spare.length) {
      // 余りの辺がない：s,t を含み、両方の森で木になる最小の頂点集合が作れるか
      const inS = new Uint8Array(V);
      inS[0] = 1; inS[1] = 1;
      const members = [0, 1];
      const add = (x) => { if (!inS[x]) { inS[x] = 1; members.push(x); } };
      for (let size = -1; size !== members.length;) {
        size = members.length;
        for (let li = 1; li <= 2; li++) {
          const f = F[li];
          for (const m of members) if (f.comp[m] !== f.comp[0]) return false;
          for (const m of [...members]) forestPath(f, 0, m, (h) => { add(edges[h][0]); add(edges[h][1]); });
        }
      }
      return true;
    }
    // 余りの辺から交換でたどれる辺の集合は、全域木2本を持つ塊（clump）。それを1点に縮約して繰り返す
    const uf = new UF(V);
    const seen = new Uint8Array(edges.length);
    for (const e of spare) {
      if (seen[e]) continue;
      seen[e] = 1;
      const queue = [e];
      for (let qi = 0; qi < queue.length; qi++) {
        const g = queue[qi];
        const [u, v] = edges[g];
        uf.union(u, v);
        for (let li = 1; li <= 2; li++) {
          if (label[g] === li) continue;
          forestPath(F[li], u, v, (h) => { uf.union(edges[h][0], edges[h][1]); if (!seen[h]) { seen[h] = 1; queue.push(h); } });
        }
      }
    }
    const c = contract(V, uf, edges, 0, 1);
    if (c.won) return true;
    V = c.V; edges = c.edges;
  }
}

// その手を打った後、相手が何をしても自分が勝てるか
function isWinningMove(g, color, k) {
  const graph = buildGraph(g.n, { ...g.owner, [k]: color }, color);
  return graph.won || secondPlayerWins(graph);
}

// 読み切りAI：必勝手があれば必ずそれを打つ（以後は絶対に負けない）。
// 必勝手がない（相手が完璧なら負ける局面）ときは、相手の「正解の手」が最も少なくなる手を選び、ミスを誘う。
function perfectMove(g, free, trap) {
  const color = g.turn;
  const opp = other(color);
  const started = Date.now();
  const scored = free.map(([mx, my]) => {
    const k = key(mx, my);
    const s = evaluate(g.n, { ...g.owner, [k]: color }, color) + evaluate(g.n, { ...g.owner, [k]: opp }, opp);
    return { mx, my, k, s };
  }).sort((a, b) => b.s - a.s);

  for (const c of scored) if (isWinningMove(g, color, c.k)) return [c.mx, c.my];
  if (!trap) return [scored[0].mx, scored[0].my];

  let best = scored[0]; let bestCount = Infinity;
  for (const c of scored.slice(0, 12)) {
    if (Date.now() - started > 1500) break;
    const g2 = { n: g.n, owner: { ...g.owner, [c.k]: color } };
    let count = 0;
    for (const r of scored) {
      if (r.k === c.k || !isWinningMove(g2, opp, r.k)) continue;
      if (++count >= bestCount) break;
    }
    if (count < bestCount) { bestCount = count; best = c; }
  }
  return [best.mx, best.my];
}

function aiMove(g, level) {
  const color = g.turn;
  const opp = other(color);
  const free = allSlots(g.n).filter(([mx, my]) => !g.owner[key(mx, my)]);
  const withMove = (mx, my, c) => ({ ...g.owner, [key(mx, my)]: c });

  // 1手で勝てるなら勝つ／相手の1手勝ちは止める
  for (const [mx, my] of free) if (trace(g.n, withMove(mx, my, color), color).path) return [mx, my];
  const threats = free.filter(([mx, my]) => trace(g.n, withMove(mx, my, opp), opp).path);
  if (threats.length === 1) return threats[0];

  if (level === 'hard' || (level === 'normal' && Math.random() < 0.5)) return perfectMove(g, free, level === 'hard');

  if (level === 'easy' && Math.random() < 0.35) return free[Math.floor(Math.random() * free.length)];

  // 各マスを2通りで評価：自分が取ったら得か（攻め）／ 相手が取ったら得か（守るべきか）
  const myScore = new Map();
  const oppScore = new Map();
  for (const [mx, my] of free) {
    const k = key(mx, my);
    myScore.set(k, evaluate(g.n, withMove(mx, my, color), color));
    oppScore.set(k, evaluate(g.n, withMove(mx, my, opp), opp));
  }
  const scored = free.map(([mx, my]) => ({ mx, my, s: myScore.get(key(mx, my)) })).sort((a, b) => b.s - a.s);

  if (level === 'easy') {
    const pool = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.4)));
    const p = pool[Math.floor(Math.random() * pool.length)];
    return [p.mx, p.my];
  }
  if (level === 'normal') {
    const pool = scored.slice(0, 2);
    const p = Math.random() < 0.8 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
    return [p.mx, p.my];
  }
  // hard: 上位候補について相手の最善応手まで読む（2手読み）
  // 候補は「自分が伸びる手」と「相手を妨害する手（守り）」の両方から広めに集める。
  // 守りの手は自分単独の評価では低く出やすく、攻めの評価だけで絞ると見落としてしまうため。
  const poolSize = g.n >= 7 ? 8 : 12;
  const byMine = [...free].sort((a, b) => myScore.get(key(b[0], b[1])) - myScore.get(key(a[0], a[1])));
  const byOpp = [...free].sort((a, b) => oppScore.get(key(b[0], b[1])) - oppScore.get(key(a[0], a[1])));
  const candMap = new Map();
  for (const c of byMine.slice(0, poolSize)) candMap.set(key(c[0], c[1]), c);
  for (const c of byOpp.slice(0, poolSize)) candMap.set(key(c[0], c[1]), c);
  const cand = [...candMap.values()];

  let best = cand[0]; let bestVal = -Infinity;
  for (const [cx, cy] of cand) {
    const o1 = withMove(cx, cy, color);
    let worst = Infinity;
    for (const [mx, my] of free) {
      if (mx === cx && my === cy) continue;
      const o2 = { ...o1, [key(mx, my)]: opp };
      if (trace(g.n, o2, opp).path) { worst = -Infinity; break; }
      const v = evaluate(g.n, o2, color);
      if (v < worst) worst = v;
    }
    if (worst > bestVal) { bestVal = worst; best = [cx, cy]; }
  }
  return best;
}

// ---------------- 一手戻る・解析用 ----------------
// 最初の idx 手だけを打った局面を作り直す（ハンデの残り手数・手番も正しく再現される）
function stateAt(g, idx) {
  const s = createGame(g.n, g.handicap, g.handicapColor);
  for (const m of g.moves.slice(0, Math.max(0, idx))) play(s, m.color, m.mx, m.my);
  return s;
}

// 対局中の盤面を count 手ぶん戻す
function undo(g, count) {
  const s = stateAt(g, g.moves.length - count);
  Object.assign(g, {
    owner: s.owner, moves: s.moves, turn: s.turn, handicapRemaining: s.handicapRemaining,
    phase: 'play', winner: null, winPath: null, resigned: null,
  });
}

// color の手番が回ってくる直前の局面まで戻すには何手戻せばよいか（戻せなければ 0）
function undoCount(g, color) {
  for (let c = 1; c <= g.moves.length; c++) if (stateAt(g, g.moves.length - c).turn === color) return c;
  return 0;
}

// 局面の解析：次の最善手・お互い最善を尽くしたときの勝者
function analyze(g) {
  if (g.phase !== 'play') return { over: true, turn: null, best: null, theory: g.winner };
  const color = g.turn;
  const opp = other(color);
  const free = allSlots(g.n).filter(([mx, my]) => !g.owner[key(mx, my)]);
  let best = perfectMove(g, free, true);
  let theory = null;
  if (isWinningMove(g, color, key(best[0], best[1]))) {
    theory = color;
  } else {
    // 必勝手がない＝相手が最善なら負け（ハンデで連続して打つ途中は交互手番ではないので判定しない）
    if (g.handicapRemaining <= 1) theory = opp;
    const threats = free.filter(([mx, my]) => trace(g.n, { ...g.owner, [key(mx, my)]: opp }, opp).path);
    if (threats.length === 1) best = threats[0];
  }
  return { over: false, turn: color, best, theory };
}

const API = {
  R, B, other, key, isSlot, allSlots, createGame, play, resign, aiMove, addLog,
  trace, buildGraph, secondPlayerWins, isWinningMove, stateAt, undo, undoCount, analyze,
};
// Node.js（動作確認用）では require、ブラウザ・Worker では self.G で使う
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else self.G = API;
})();
