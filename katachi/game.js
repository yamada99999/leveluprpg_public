'use strict';
// ふたりでカタチ 本体
//
// ・お題（誰が・何をした など）を、部品ごとに A か B のどちらか一方にだけ見せる。
// ・1枚の画用紙に、1手ずつ交代で図形を「置く」「動かす」「選択肢を入れかえる」。
// ・手数を使い切るか、2人とも「完成！」に賛成したら、相棒の部品を4択で当てる → 答え合わせ。
// 通信：先に「2台で遊ぶ」を押した端末（A）がゲームの状態を持ち、B へ配る。B は操作を A に送る。
// 1台モード：1台を2人で交代。お題は長押しの間だけ見える。
(function () {
  const $ = (id) => document.getElementById(id);
  const C = window.KATA_CARDS, SH = window.KATA_SHAPES, CFG = window.KATA_CONFIG;
  const PW = 360, PH = 480;            // 画用紙の大きさ（中の座標）
  const params = new URLSearchParams(location.search);
  const now = () => performance.now();
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const NAME = { A: 'A', B: 'B' };

  // ---------- 音 ----------
  const Snd = {
    ctx: null, out: null, muted: false,
    init() {
      if (!this.ctx) {
        try {
          const c = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          this.out = c.createGain(); this.out.gain.value = 1; this.out.connect(c.destination);
        } catch (e) { this.ctx = null; }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(f, d, type = 'sine', v = 0.2, delay = 0, f2 = null) {
      const c = this.ctx; if (!c || this.muted) return;
      const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(this.out); o.start(t); o.stop(t + d + 0.03);
    },
    play(n) {
      switch (n) {
        case 'tap': this.tone(760, 0.06, 'triangle', 0.15); break;
        case 'pick': this.tone(520, 0.08, 'triangle', 0.18, 0, 780); break;
        case 'place': this.tone(330, 0.14, 'sine', 0.35, 0, 160); this.tone(990, 0.08, 'triangle', 0.12, 0.02); break; // ポン
        case 'move': this.tone(600, 0.12, 'sine', 0.2, 0, 900); break;
        case 'reload': [700, 900, 1100, 1300].forEach((f, i) => this.tone(f, 0.06, 'triangle', 0.13, i * 0.04)); break;
        case 'turn': this.tone(880, 0.12, 'sine', 0.22); this.tone(1320, 0.18, 'sine', 0.18, 0.09); break;
        case 'ask': [660, 880, 660].forEach((f, i) => this.tone(f, 0.12, 'square', 0.08, i * 0.12)); break;
        case 'ok': this.tone(1046, 0.25, 'sine', 0.22); this.tone(1568, 0.3, 'sine', 0.16, 0.08); break;
        case 'ng': this.tone(220, 0.35, 'sawtooth', 0.12, 0, 150); break;
        case 'fan': [523, 659, 784, 1046, 1319].forEach((f, i) => this.tone(f, 0.32, 'triangle', 0.2, i * 0.1)); break;
        case 'join': this.tone(660, 0.12, 'sine', 0.18); this.tone(990, 0.2, 'sine', 0.18, 0.1); break;
      }
    },
  };
  try { Snd.muted = localStorage.getItem('katachi_mute') === '1'; } catch (e) { /* noop */ }
  if (params.get('mute') === '1') Snd.muted = true;

  const vib = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* noop */ } };

  // ---------- 状態 ----------
  const App = {
    mode: null,        // 'net'（2台） | 'local'（1台で交代）
    role: null,        // 2台のとき：'A'（先に押した端末・状態を持つ） | 'B'
    level: 1,
    peek: null,        // 1台モードで、いまお題を見ている人
    guessing: null,    // 1台モードの当てっこで、いま答えている人
  };
  let S = null;        // ゲームの状態（A／1台モードが持つ。B は届いたものを表示する）
  let E = null;        // 自分が操作中の図形 { mode:'place'|'move', pi, id, s, z, sent }
  let Live = null;     // 相棒が操作中の図形（2台のとき、相棒の画面から届く）
  let lastV = -1;

  const auth = () => App.mode === 'local' || App.role === 'A';
  // 「自分」：2台なら自分の役。1台なら、いま手番の人
  const me = () => (App.mode === 'net' ? App.role : (S ? S.turn : 'A'));
  const myTurn = () => S && S.phase === 'play' && !S.fin && (App.mode === 'local' || S.turn === App.role);
  const send = (m) => { if (App.mode === 'net') Link.send(m); };

  // ---------- お題を配る ----------
  function pickDistinct(deck, n, except = []) {
    const pool = shuffle(deck.filter((x) => !except.includes(x)));
    return pool.slice(0, n);
  }
  function freshPalette() {
    const kinds = shuffle(SH.KINDS.slice()).slice(0, 5);
    return kinds.map((k) => ({ k, c: SH.COLORS[Math.floor(Math.random() * SH.COLORS.length)] }));
  }
  function replaceOne(pal, i) {
    const used = pal.filter((p, j) => p && j !== i).map((p) => p.k);
    const k = shuffle(SH.KINDS.filter((x) => !used.includes(x)))[0];
    pal[i] = { k, c: SH.COLORS[Math.floor(Math.random() * SH.COLORS.length)] };
  }
  function newRound(level, round) {
    const L = C.LEVELS[level - 1];
    const parts = [];
    let whoText = null;
    for (const slot of L.slots) {
      const deck = C.SLOTS[slot].deck;
      const text = pickDistinct(deck, 1, slot === 'with' && whoText ? [whoText] : [])[0];
      if (slot === 'who') whoText = text;
      parts.push({ slot, text, owner: null });
    }
    if (whoText) { const w = parts.find((p) => p.slot === 'with'); if (w && w.text === whoText) w.text = pickDistinct(C.SLOTS.with.deck, 1, [whoText])[0]; }
    // 部品を A・B にほぼ半分ずつ配る（どちらも1つ以上）
    const owners = shuffle(parts.map((_, i) => (i % 2 ? 'B' : 'A')));
    parts.forEach((p, i) => { p.owner = owners[i]; });
    const first = round % 2 ? 'A' : 'B';
    return {
      v: 0, phase: 'play', level, round,
      parts, shapes: [], nextId: 1, palette: freshPalette(),
      turn: first, first, left: L.turns, total: L.turns, fin: null,
      quiz: null, guesses: { A: null, B: null }, last: null,
    };
  }

  // ---------- A（状態を持つ側）の処理 ----------
  function commitState() {
    S.v++;
    send({ t: 'state', S });
    onState();
  }
  function endTurn() {
    S.left--;
    S.turn = other(S.turn);
    if (S.left <= 0) startGuess();
  }
  function startGuess() {
    S.phase = 'guess'; S.fin = null;
    // A は B の部品を、B は A の部品を当てる
    const quiz = { A: [], B: [] };
    for (const p of S.parts) {
      const deck = C.SLOTS[p.slot].deck;
      const wrong = pickDistinct(deck, 3, [p.text]);
      const opts = shuffle([p.text, ...wrong]);
      quiz[other(p.owner)].push({ slot: p.slot, opts, ans: opts.indexOf(p.text) });
    }
    S.quiz = quiz; S.guesses = { A: null, B: null };
  }
  // by：操作した人、a：操作
  function applyAct(by, a) {
    if (!S || !a) return;
    switch (a.kind) {
      case 'place': {
        if (S.phase !== 'play' || S.fin || S.turn !== by) return;
        const p = S.palette[a.pi];
        if (!p || p.k !== a.s.k) return;
        const sh = { id: S.nextId++, k: p.k, c: p.c, ...tf(a.s) };
        if (a.z === -1) S.shapes.unshift(sh); else S.shapes.push(sh);
        replaceOne(S.palette, a.pi);
        S.last = { by, kind: 'place', id: sh.id };
        endTurn();
        break;
      }
      case 'move': {
        if (S.phase !== 'play' || S.fin || S.turn !== by) return;
        const i = S.shapes.findIndex((x) => x.id === a.id);
        if (i < 0) return;
        const sh = { ...S.shapes[i], ...tf(a.s) };
        S.shapes.splice(i, 1);
        if (a.z === 1) S.shapes.push(sh); else if (a.z === -1) S.shapes.unshift(sh); else S.shapes.splice(i, 0, sh);
        S.last = { by, kind: 'move', id: sh.id };
        endTurn();
        break;
      }
      case 'reload':
        if (S.phase !== 'play' || S.fin || S.turn !== by) return;
        S.palette = freshPalette();
        S.last = { by, kind: 'reload' };
        endTurn();
        break;
      case 'finish':
        if (S.phase !== 'play' || S.fin || S.turn !== by) return;
        if (App.mode === 'local') { startGuess(); break; } // 1台：その場で2人で決める
        S.fin = by;
        break;
      case 'finAns':
        if (S.phase !== 'play' || !S.fin || S.fin === by) return;
        if (a.ok) startGuess(); else { S.fin = null; S.last = { by, kind: 'notyet' }; }
        break;
      case 'guess':
        if (S.phase !== 'guess' || !Array.isArray(a.ans)) return;
        S.guesses[by] = a.ans.map((x) => x | 0);
        if (S.guesses.A && S.guesses.B) finishRound();
        break;
      default: return;
    }
    commitState();
  }
  function tf(s) {
    return {
      x: clamp(+s.x || 0, -20, PW + 20), y: clamp(+s.y || 0, -20, PH + 20), r: +s.r || 0,
      sx: clamp(+s.sx || 1, 0.08, 4), sy: clamp(+s.sy || 1, 0.08, 4), f: !!s.f,
    };
  }
  function finishRound() {
    S.phase = 'reveal';
    let ok = 0, all = 0;
    for (const side of ['A', 'B']) S.quiz[side].forEach((q, i) => { all++; if (S.guesses[side][i] === q.ans) ok++; });
    S.score = { ok, all, used: S.total - S.left };
    // 記録（A／1台の端末に保存）
    saveRec(S.level, ok === all);
  }
  function loadRec() { try { return JSON.parse(localStorage.getItem('katachi_rec') || '{}'); } catch (e) { return {}; } }
  function saveRec(lv, perfect) {
    const r = loadRec(); const k = 'lv' + lv;
    r[k] = r[k] || { plays: 0, perfect: 0 };
    r[k].plays++; if (perfect) r[k].perfect++;
    try { localStorage.setItem('katachi_rec', JSON.stringify(r)); } catch (e) { /* noop */ }
  }

  // 自分の操作 → A なら直接、B なら A へ送る
  function act(a) {
    if (auth()) applyAct(me(), a);
    else send({ t: 'act', a });
  }

  // ---------- 画面 ----------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (id === 'scr-play') { requestAnimationFrame(fit); setTimeout(fit, 80); }
  }
  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    const el = $('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // 状態が変わったとき（自分で変えた／届いた）
  function onState() {
    if (!S) return;
    const prev = lastV; lastV = S.v;
    if (E && (E.sent || !myTurn())) E = null;
    if (Live && (S.phase !== 'play' || (App.mode === 'net' && S.turn === App.role))) Live = null;
    if (!$('scr-play').classList.contains('active')) showScreen('scr-play');
    // 何が起きたかを知らせる
    const L = S.last;
    if (L && S.v !== prev && prev >= 0) {
      const mine = App.mode === 'net' && L.by === App.role;
      if (L.kind === 'place') Snd.play('place');
      else if (L.kind === 'move') Snd.play('move');
      else if (L.kind === 'reload') { Snd.play('reload'); if (!mine) toast(App.mode === 'net' ? '相棒が選択肢を入れかえた' : '選択肢を入れかえた'); }
      else if (L.kind === 'notyet' && App.mode === 'net') toast(L.by === App.role ? 'もう少し描こう' : '相棒は「まだ描く」そうです');
      if (App.mode === 'net' && S.phase === 'play' && S.turn === App.role && L.by !== App.role && L.kind !== 'notyet') { Snd.play('turn'); vib(30); }
    }
    if (S.v === 1 && prev !== 1 && S.phase === 'play') {
      ['guess', 'reveal', 'finreq', 'menu', 'handoff'].forEach((id) => $(id).classList.add('hidden'));
      toast(App.mode === 'net' ? (S.turn === App.role ? 'あなたから！ 自分のお題をよく見て' : '相棒から！ 自分のお題をよく見て') : `${S.turn} さんから。お題は長押しでこっそり見てね`, 3000);
    }
    renderUI();
  }

  function renderUI() {
    if (!S) return;
    // お題
    const od = $('pl-odai');
    const oKey = [S.round, S.phase, App.peek, App.mode, App.role, JSON.stringify(S.parts)].join('|');
    if (od.dataset.k !== oKey) { od.dataset.k = oKey; renderOdai(od); }
    renderRest();
  }
  function renderOdai(od) {
    od.innerHTML = '';
    od.style.gridTemplateColumns = `repeat(${S.parts.length === 4 ? 2 : S.parts.length}, minmax(0, 1fr))`;
    for (const p of S.parts) {
      const vis = App.mode === 'net' ? p.owner === App.role : App.peek === p.owner;
      const d = document.createElement('div');
      d.className = 'od' + (vis ? ' mine' : ' hid');
      d.innerHTML = `<div class="l"></div><div class="t"></div>`;
      d.querySelector('.l').textContent = C.SLOTS[p.slot].label + (App.mode === 'local' && vis ? `（${p.owner}）` : '');
      d.querySelector('.t').textContent = vis ? C.SLOTS[p.slot].show(p.text) : '？？？？';
      od.appendChild(d);
    }
    if (App.mode === 'local' && S.phase === 'play') {
      const pk = document.createElement('div');
      pk.className = 'peek';
      for (const s of ['A', 'B']) {
        const b = document.createElement('button');
        b.className = s.toLowerCase() + (App.peek === s ? ' on' : '');
        b.textContent = `${s} のお題（長押し）`;
        const on = (e) => { e.preventDefault(); App.peek = s; renderUI(); };
        const off = () => { if (App.peek === s) { App.peek = null; renderUI(); } };
        b.addEventListener('pointerdown', on);
        b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        pk.appendChild(b);
      }
      od.appendChild(pk);
    }
  }
  function renderRest() {
    // 手番
    const tn = $('pl-turn');
    const mineTurn = myTurn();
    if (S.phase !== 'play') tn.innerHTML = '答え合わせ';
    else if (App.mode === 'local') tn.innerHTML = `<span style="color:var(--${S.turn === 'A' ? 'a' : 'b'}-deep)">${S.turn} さんの番</span><small>残り ${S.left} 手（2人で）</small>`;
    else if (mineTurn) tn.innerHTML = `あなたの番<small>残り ${S.left} 手（2人で）</small>`;
    else tn.innerHTML = `相棒の番<small>残り ${S.left} 手・声で相談しよう</small>`;
    tn.className = 'turn' + (mineTurn ? ' me' + (me() === 'B' ? ' b' : '') : '');
    $('pl-finish').disabled = !mineTurn || !!E || !S.shapes.length;
    // 下の選択肢 or 操作中のボタン
    $('pl-palette').classList.toggle('hidden', !!E);
    $('pl-edit').classList.toggle('hidden', !E);
    if (E) {
      $('ed-front').classList.toggle('on', E.z === 1);
      $('ed-back').classList.toggle('on', E.z === -1);
    }
    renderPalette();
    // 見守り中の表示
    const w = $('pl-watch');
    if (App.mode === 'net' && S.phase === 'play' && !mineTurn) {
      w.classList.remove('hidden');
      w.textContent = S.fin === App.role ? '相棒の返事を待っています…' : Live ? '相棒が図形を動かしています…' : '相棒の番です';
    } else w.classList.add('hidden');
    // 重ねる画面
    renderFinReq();
    renderGuess();
    renderReveal();
  }

  // ---------- 下の選択肢 ----------
  let palKey = '';
  function renderPalette() {
    const box = $('pl-palette');
    const can = myTurn() && !E;
    const usedPi = E && E.mode === 'place' ? E.pi : (Live && Live.mode === 'place' ? Live.pi : -1);
    const key = JSON.stringify(S.palette) + '|' + can + '|' + usedPi;
    if (key === palKey && box.children.length) return;
    palKey = key;
    box.innerHTML = '';
    S.palette.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'pal' + (i === usedPi ? ' used' : '');
      b.disabled = !can;
      b.setAttribute('aria-label', SH.LIB[p.k].name);
      const cv = document.createElement('canvas');
      b.appendChild(cv);
      box.appendChild(b);
      requestAnimationFrame(() => drawPalItem(cv, p));
      b.addEventListener('pointerdown', (e) => palDown(e, i));
    });
    const r = document.createElement('button');
    r.className = 'reload';
    r.disabled = !can;
    r.innerHTML = '🔄<small>入れかえ</small>';
    r.addEventListener('click', () => {
      if (!myTurn() || E) return;
      if (!confirm('選択肢を5つとも入れかえます。これで1手使います。いいですか？')) return;
      act({ kind: 'reload' });
    });
    box.appendChild(r);
  }
  function drawPalItem(cv, p) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 56, h = cv.clientHeight || 56;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = Math.min(w, h) / 112;
    ctx.translate(w / 2, h / 2); ctx.scale(k, k);
    SH.draw(ctx, { k: p.k, c: p.c, x: 0, y: 0, r: 0, sx: 1, sy: 1 });
  }

  // ---------- 画用紙 ----------
  const cv = $('paper');
  const ctx = cv.getContext('2d');
  let K = 1; // 画面の px / 画用紙の px
  function fit() {
    const wrap = $('pl-paper-wrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    const w = Math.floor(Math.min(W, H * PW / PH)), h = Math.floor(w * PH / PW);
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    K = w / PW;
    palKey = '';
    if (S) renderPalette();
  }
  window.addEventListener('resize', () => { if ($('scr-play').classList.contains('active')) fit(); });

  function drawPaper(c, scale, list, opt = {}) {
    c.save();
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.fillStyle = '#fff'; c.fillRect(0, 0, PW, PH);
    for (const s of list) SH.draw(c, s);
    c.restore();
  }
  // 操作中の図形の、取っ手の位置
  function handles(s) {
    const c = Math.cos(s.r), n = Math.sin(s.r);
    const w = (x, y) => [s.x + x * c - y * n, s.y + x * n + y * c];
    const hx = 50 * s.sx, hy = 50 * s.sy;
    let rot = w(0, -hy - 30), top = w(0, -hy);
    if (rot[1] < 14 || rot[0] < 6 || rot[0] > PW - 6) { rot = w(0, hy + 30); top = w(0, hy); } // 画用紙の外に出るときは反対側に
    const corners = [w(-hx, -hy), w(hx, -hy), w(hx, hy), w(-hx, hy)];
    // 大きさの取っ手：ふだんは右下。画用紙の外に出るときは、内側にある別の角を使う
    const inside = (p) => p[0] > 10 && p[0] < PW - 10 && p[1] > 10 && p[1] < PH - 10;
    const scale = [corners[2], corners[1], corners[3], corners[0]].find(inside) || corners[2];
    return { corners, rot, top, scale };
  }
  function render() {
    if (!S || !$('scr-play').classList.contains('active')) return;
    const dpr = window.devicePixelRatio || 1, sc = K * dpr;
    const hideId = (E && E.mode === 'move' ? E.id : null) || (Live && Live.mode === 'move' ? Live.id : null);
    drawPaper(ctx, sc, S.shapes.filter((s) => s.id !== hideId));
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    // 相棒が動かしている途中の図形
    if (Live && Live.s) {
      const base = Live.mode === 'move' ? S.shapes.find((x) => x.id === Live.id) : S.palette[Live.pi];
      if (base) {
        const s = { ...base, ...Live.s, k: base.k, c: base.c };
        SH.draw(ctx, s, { alpha: 0.9 });
        outline(ctx, s, App.role === 'A' ? '#4472c4' : '#f08030', false);
      }
    }
    // 自分が操作中の図形と取っ手
    if (E) {
      SH.draw(ctx, E.s, { alpha: E.drag === 'paldrag' && !E.inside ? 0.45 : 1 });
      if (E.drag !== 'paldrag') outline(ctx, E.s, '#e04858', true);
    }
    // 直前の1手（相棒が置いた／動かした図形）を少しだけ光らせる
    ctx.restore();
  }
  function outline(c, s, color, withHandles) {
    const h = handles(s);
    c.save();
    c.strokeStyle = color; c.lineWidth = 1.6; c.setLineDash([5, 4]);
    c.beginPath(); h.corners.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath(); c.stroke();
    c.setLineDash([]);
    if (withHandles) {
      c.beginPath(); c.moveTo(h.top[0], h.top[1]); c.lineTo(h.rot[0], h.rot[1]); c.stroke();
      // 回す
      c.fillStyle = '#fff'; c.beginPath(); c.arc(h.rot[0], h.rot[1], 13, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = color; c.font = 'bold 16px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('↻', h.rot[0], h.rot[1] + 1);
      // 大きさ
      c.fillStyle = '#fff'; c.fillRect(h.scale[0] - 10, h.scale[1] - 10, 20, 20); c.strokeRect(h.scale[0] - 10, h.scale[1] - 10, 20, 20);
      c.fillStyle = color; c.fillRect(h.scale[0] - 4, h.scale[1] - 4, 8, 8);
    }
    c.restore();
  }

  // ---------- 指の操作 ----------
  const ptrs = new Map();
  let pinch = null;
  function toPaper(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * PW, y: (e.clientY - r.top) / r.height * PH, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
  }
  const near = (p, q, d) => Math.hypot(p.x - q[0], p.y - q[1]) < d;

  // 下の選択肢から図形をつまむ（そのまま画用紙へドラッグ。タップなら真ん中に置く）
  function palDown(e, i) {
    if (!myTurn() || E) return;
    e.preventDefault();
    Snd.init();
    const p = S.palette[i];
    const pt = toPaper(e);
    E = { mode: 'place', pi: i, z: 1, s: { k: p.k, c: p.c, x: pt.x, y: pt.y, r: 0, sx: 0.8, sy: 0.8, f: false }, drag: 'paldrag', sx0: e.clientX, sy0: e.clientY, pid: e.pointerId, inside: false };
    Snd.play('pick');
    renderUI(); sendLive();
  }
  window.addEventListener('pointermove', (e) => {
    if (E && E.drag === 'paldrag' && e.pointerId === E.pid) {
      const pt = toPaper(e);
      E.s.x = pt.x; E.s.y = pt.y; E.inside = pt.inside;
      sendLive();
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (!(E && E.drag === 'paldrag' && e.pointerId === E.pid)) return;
    const moved = Math.hypot(e.clientX - E.sx0, e.clientY - E.sy0);
    const pt = toPaper(e);
    if (moved < 10) { E.s.x = PW / 2; E.s.y = PH / 2; E.drag = null; } // タップ：真ん中へ
    else if (pt.inside) { E.drag = null; }
    else { E = null; sendLive(); renderUI(); return; } // 画用紙の外で放した：やめる
    renderUI(); sendLive();
  });
  window.addEventListener('pointercancel', (e) => { if (E && E.drag === 'paldrag' && e.pointerId === E.pid) { E = null; sendLive(); renderUI(); } });

  cv.addEventListener('pointerdown', (e) => {
    Snd.init();
    const pt = toPaper(e);
    if (!myTurn()) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    ptrs.set(e.pointerId, pt);
    if (ptrs.size === 2 && E) { startPinch(); return; }
    if (ptrs.size > 1) return;
    if (E) {
      const h = handles(E.s);
      if (near(pt, h.rot, 22)) { E.drag = 'rot'; return; }
      if (near(pt, h.scale, 22)) { E.drag = 'scale'; return; }
      if (SH.hit(E.s, pt.x, pt.y, 10)) { E.drag = 'move'; E.ox = pt.x - E.s.x; E.oy = pt.y - E.s.y; return; }
      return;
    }
    // 置いてある図形をつかむ（いちばん上のもの）
    for (let i = S.shapes.length - 1; i >= 0; i--) {
      const s = S.shapes[i];
      if (SH.hit(s, pt.x, pt.y, 6)) {
        E = { mode: 'move', id: s.id, z: 0, s: { ...s }, drag: 'move', ox: pt.x - s.x, oy: pt.y - s.y };
        Snd.play('pick');
        renderUI(); sendLive();
        return;
      }
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const pt = toPaper(e);
    ptrs.set(e.pointerId, pt);
    if (!E) return;
    if (pinch && ptrs.size >= 2) { doPinch(); sendLive(); return; }
    const s = E.s;
    if (E.drag === 'move') { s.x = clamp(pt.x - E.ox, 0, PW); s.y = clamp(pt.y - E.oy, 0, PH); }
    else if (E.drag === 'rot') {
      let a = Math.atan2(pt.y - s.y, pt.x - s.x) + Math.PI / 2;
      const step = Math.PI / 4, snap = Math.round(a / step) * step;
      if (Math.abs(a - snap) < 0.09) a = snap; // 45°ごとに少し吸いつく
      s.r = a;
    } else if (E.drag === 'scale') {
      const c = Math.cos(-s.r), n = Math.sin(-s.r), dx = pt.x - s.x, dy = pt.y - s.y;
      s.sx = clamp(Math.abs(dx * c - dy * n) / 50, 0.1, 4);
      s.sy = clamp(Math.abs(dx * n + dy * c) / 50, 0.1, 4);
    } else return;
    sendLive();
  });
  const ptrEnd = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (E && ptrs.size === 0 && E.drag !== 'paldrag') E.drag = null;
  };
  cv.addEventListener('pointerup', ptrEnd);
  cv.addEventListener('pointercancel', ptrEnd);
  function startPinch() {
    const [p, q] = [...ptrs.values()];
    pinch = { d: Math.hypot(q.x - p.x, q.y - p.y) || 1, a: Math.atan2(q.y - p.y, q.x - p.x), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2, s: { ...E.s } };
    E.drag = 'pinch';
  }
  function doPinch() {
    const [p, q] = [...ptrs.values()];
    const d = Math.hypot(q.x - p.x, q.y - p.y) || 1, a = Math.atan2(q.y - p.y, q.x - p.x);
    const k = d / pinch.d;
    E.s.sx = clamp(pinch.s.sx * k, 0.1, 4); E.s.sy = clamp(pinch.s.sy * k, 0.1, 4);
    E.s.r = pinch.s.r + (a - pinch.a);
    E.s.x = clamp(pinch.s.x + (p.x + q.x) / 2 - pinch.mx, 0, PW);
    E.s.y = clamp(pinch.s.y + (p.y + q.y) / 2 - pinch.my, 0, PH);
  }

  // 操作中のボタン
  $('ed-flip').addEventListener('click', () => { if (E) { E.s.f = !E.s.f; Snd.play('tap'); sendLive(); } });
  $('ed-front').addEventListener('click', () => { if (E) { E.z = E.z === 1 ? 0 : 1; Snd.play('tap'); toast(E.z === 1 ? 'いちばん前に置きます' : '重なり順はそのまま'); renderUI(); } });
  $('ed-back').addEventListener('click', () => { if (E) { E.z = E.z === -1 ? (E.mode === 'place' ? 1 : 0) : -1; Snd.play('tap'); toast(E.z === -1 ? 'いちばん後ろに置きます' : (E.mode === 'place' ? 'いちばん前に置きます' : '重なり順はそのまま')); renderUI(); } });
  $('ed-cancel').addEventListener('click', () => { E = null; Snd.play('tap'); sendLive(); renderUI(); });
  $('ed-ok').addEventListener('click', () => {
    if (!E || !myTurn()) return;
    const a = E.mode === 'place' ? { kind: 'place', pi: E.pi, z: E.z, s: { ...E.s } } : { kind: 'move', id: E.id, z: E.z, s: { ...E.s } };
    E.sent = true; E.drag = null;
    send({ t: 'live', e: null });
    act(a);
  });
  $('pl-finish').addEventListener('click', () => {
    if (!myTurn() || E) return;
    if (App.mode === 'local') {
      if (!confirm('2人とも「完成」でいいですか？ 答え合わせ（相棒のお題の当てっこ）に進みます。')) return;
    }
    Snd.play('ask');
    act({ kind: 'finish' });
  });

  // 相棒へ、操作中の図形を送る（なめらかに見えるよう 1秒に20回まで）
  let liveT = 0, liveTimer = 0;
  function sendLive() {
    if (App.mode !== 'net') return;
    const t = now();
    const go = () => { liveT = now(); send({ t: 'live', e: E ? { mode: E.mode, pi: E.pi, id: E.id, s: E.drag === 'paldrag' && !E.inside ? null : { ...E.s } } : null }); };
    clearTimeout(liveTimer);
    if (t - liveT > 50) go(); else liveTimer = setTimeout(go, 50);
  }

  // ---------- 完成の相談 ----------
  function renderFinReq() {
    const show = App.mode === 'net' && S.phase === 'play' && !!S.fin;
    const ov = $('finreq');
    const was = !ov.classList.contains('hidden');
    ov.classList.toggle('hidden', !show);
    if (!show) return;
    const asker = S.fin === App.role;
    $('fr-text').textContent = asker ? '「完成！」と伝えました。相棒が賛成したら、答え合わせに進みます。' : '相棒が「もう完成」と言っています。答え合わせに進みますか？';
    $('fr-yes').classList.toggle('hidden', asker);
    $('fr-no').classList.toggle('hidden', asker);
    $('fr-wait').classList.toggle('hidden', !asker);
    if (!was && !asker) { Snd.play('ask'); vib([40, 40, 40]); }
  }
  $('fr-yes').addEventListener('click', () => act({ kind: 'finAns', ok: true }));
  $('fr-no').addEventListener('click', () => act({ kind: 'finAns', ok: false }));

  // ---------- 当てっこ ----------
  let pick = [];
  let guessKey = '';
  function renderGuess() {
    const ov = $('guess');
    if (S.phase !== 'guess') { ov.classList.add('hidden'); $('handoff').classList.add('hidden'); guessKey = ''; return; }
    // 答える人：2台なら自分。1台なら、まだ答えていない人（A → B の順）
    const who = App.mode === 'net' ? App.role : (!S.guesses.A ? 'A' : 'B');
    const done = !!S.guesses[who];
    if (App.mode === 'local' && App.guessing !== who) {
      // 交代の画面（相手に見えないように）
      ov.classList.add('hidden');
      $('handoff').classList.remove('hidden');
      $('ho-title').textContent = `${who} さんが答える番`;
      $('ho-text').textContent = `${other(who)} さんのお題を当てます。${other(who)} さんは画面を見ないでね。`;
      $('ho-ok').onclick = () => { App.guessing = who; $('handoff').classList.add('hidden'); renderUI(); };
      return;
    }
    ov.classList.remove('hidden');
    const key = S.v + who;
    if (key === guessKey) return;
    guessKey = key;
    const qs = S.quiz[who];
    if (!done) pick = qs.map(() => -1);
    $('gs-title').textContent = App.mode === 'local' ? `${who} さん：${other(who)} さんのお題を当てよう` : '相棒のお題を当てよう';
    const box = $('gs-qs');
    box.innerHTML = '';
    qs.forEach((q, qi) => {
      const d = document.createElement('div');
      d.className = 'q';
      d.innerHTML = `<div class="ql">${App.mode === 'local' ? other(who) + ' さん' : '相棒'}の「${C.SLOTS[q.slot].label.replace('？', '')}」は？</div><div class="opts"></div>`;
      const ops = d.querySelector('.opts');
      q.opts.forEach((t, oi) => {
        const b = document.createElement('button');
        b.className = 'opt' + (pick[qi] === oi || (done && S.guesses[who][qi] === oi) ? ' sel' : '');
        b.textContent = C.SLOTS[q.slot].show(t);
        b.disabled = done;
        b.addEventListener('click', () => {
          pick[qi] = oi; Snd.play('tap');
          ops.querySelectorAll('.opt').forEach((x, j) => x.classList.toggle('sel', j === oi));
          $('gs-ok').disabled = pick.some((x) => x < 0);
        });
        ops.appendChild(b);
      });
      box.appendChild(d);
    });
    $('gs-ok').disabled = done || pick.some((x) => x < 0);
    $('gs-ok').classList.toggle('hidden', done);
    $('gs-wait').classList.toggle('hidden', !done);
    drawMini($('gs-paper'));
  }
  $('gs-ok').addEventListener('click', () => {
    if (pick.some((x) => x < 0)) return;
    Snd.play('tap');
    const ans = pick.slice();
    if (App.mode === 'local') { const who = !S.guesses.A ? 'A' : 'B'; App.guessing = null; applyAct(who, { kind: 'guess', ans }); }
    else act({ kind: 'guess', ans });
  });
  function drawMini(c) {
    const w = c.clientWidth || 240, dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(w * PH / PW * dpr);
    c.style.height = (w * PH / PW) + 'px';
    drawPaper(c.getContext('2d'), w * dpr / PW, S.shapes);
  }

  // ---------- 答え合わせ ----------
  let revealKey = '';
  function renderReveal() {
    const ov = $('reveal');
    if (S.phase !== 'reveal') { ov.classList.add('hidden'); revealKey = ''; return; }
    ov.classList.remove('hidden');
    if (revealKey === String(S.v)) return;
    revealKey = String(S.v);
    const sc = S.score || { ok: 0, all: 1, used: 0 };
    const perfect = sc.ok === sc.all;
    const left = S.total - sc.used;
    let rank;
    if (perfect && left >= 4) rank = '以心伝心！ 🎉✨';
    else if (perfect) rank = '以心伝心！ 🎉';
    else if (sc.ok * 2 >= sc.all) rank = 'おしい！ 🤏';
    else rank = 'ぜんぜん伝わってない！？ 😂';
    $('rv-rank').textContent = rank;
    $('rv-sentence').textContent = C.sentence(S.parts);
    const list = $('rv-list');
    list.innerHTML = '';
    for (const p of S.parts) {
      const g = other(p.owner);
      const qi = S.quiz[g].findIndex((q) => q.slot === p.slot);
      const q = S.quiz[g][qi];
      const ansIdx = S.guesses[g] ? S.guesses[g][qi] : -1;
      const ok = ansIdx === q.ans;
      const d = document.createElement('div');
      d.className = 'res';
      const whoName = (s) => (App.mode === 'net' ? (s === App.role ? 'あなた' : '相棒') : `${s} さん`);
      d.innerHTML = `<span class="mk ${ok ? 'ok' : 'ng'}">${ok ? '◎' : '×'}</span><span></span>`;
      d.lastChild.innerHTML = `<b></b><br><small></small>`;
      d.querySelector('b').textContent = `${C.SLOTS[p.slot].label.replace('？', '')}：${C.SLOTS[p.slot].show(p.text)}`;
      d.querySelector('small').textContent = `${whoName(p.owner)}のお題 → ${whoName(g)}の答え「${ansIdx >= 0 ? C.SLOTS[p.slot].show(q.opts[ansIdx]) : '—'}」`;
      list.appendChild(d);
    }
    const rec = loadRec()['lv' + S.level];
    $('rv-detail').textContent = `当たり ${sc.ok}/${sc.all}・${sc.used} 手で完成（${left} 手残し）` + (auth() && rec ? `　レベル${S.level} の全問正解 ${rec.perfect}/${rec.plays} 回` : '');
    $('rv-host').classList.toggle('hidden', !auth());
    $('rv-wait').classList.toggle('hidden', auth());
    requestAnimationFrame(() => drawMini($('rv-paper')));
    Snd.play(perfect ? 'fan' : sc.ok ? 'ok' : 'ng');
    vib(perfect ? [60, 40, 120] : 80);
  }
  $('rv-next').addEventListener('click', () => { Snd.play('tap'); startRound(S.level, (S.round || 1) + 1); });
  $('rv-lobby').addEventListener('click', () => { Snd.play('tap'); toLobby(true); });
  $('rv-save').addEventListener('click', saveImage);
  // 絵とお題を1枚の画像にして保存
  function saveImage() {
    const sc = 2, W = PW * sc, Hh = PH * sc + 150;
    const c = document.createElement('canvas'); c.width = W; c.height = Hh;
    const g = c.getContext('2d');
    g.fillStyle = '#f3e6cf'; g.fillRect(0, 0, W, Hh);
    drawPaper(g, sc, S.shapes);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#3b2f25'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const text = C.sentence(S.parts);
    let fs = 34; g.font = `bold ${fs}px sans-serif`;
    while (g.measureText(text).width > W - 40 && fs > 16) { fs -= 2; g.font = `bold ${fs}px sans-serif`; }
    g.fillText(text, W / 2, PH * sc + 62);
    g.font = '22px sans-serif'; g.fillStyle = '#8a7562';
    g.fillText(`ふたりでカタチ・レベル${S.level}・当たり ${S.score ? S.score.ok + '/' + S.score.all : ''}`, W / 2, PH * sc + 112);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `katachi-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('絵を保存しました');
    }, 'image/png');
  }

  // ---------- 進行 ----------
  function startRound(level, round) {
    App.level = level; App.peek = null; App.guessing = null; E = null; Live = null; lastV = -1;
    S = newRound(level, round || 1);
    showScreen('scr-play');
    commitState();
  }
  function toLobby(notify) {
    S = null; E = null; Live = null;
    if (notify) send({ t: 'lobby' });
    ['guess', 'reveal', 'finreq', 'menu', 'handoff'].forEach((id) => $(id).classList.add('hidden'));
    showScreen('scr-lobby');
    renderLobby();
  }
  function toTitle() {
    Link.stop();
    App.mode = null; App.role = null; S = null; E = null; Live = null;
    ['guess', 'reveal', 'finreq', 'menu', 'handoff', 'netwait'].forEach((id) => $(id).classList.add('hidden'));
    showScreen('scr-title');
  }

  // ---------- ロビー ----------
  function renderLobby() {
    const st = $('lb-status');
    const net = App.mode === 'net';
    $('lb-net').classList.toggle('hidden', !net);
    $('lb-title').textContent = net ? '2台で遊ぶ' : '1台で交代して遊ぶ';
    if (net) {
      const map = { searching: '相棒を探しています…', waiting: '相棒を待っています…（もう1台でも「2台で遊ぶ」を押してね）', connected: '', reconnecting: 'つなぎ直しています…', idle: '' };
      st.innerHTML = Link.open ? `<span class="ok">つながりました！</span> あなたは <b>${App.role}</b>` : (map[Link.state] || '');
    } else st.innerHTML = '1台を2人で交代して使います。<br>お題は「長押し」している間だけ見えます。';
    const leader = !net || App.role === 'A';
    $('lb-host-area').classList.toggle('hidden', !leader);
    $('lb-wait').textContent = net && !leader ? (Link.open ? 'A の人がレベルを選んで始めるのを待っています…' : '') : '';
    const box = $('lb-levels');
    box.innerHTML = '';
    const rec = loadRec();
    for (const L of C.LEVELS) {
      const b = document.createElement('button');
      b.className = 'lv' + (App.level === L.n ? ' sel' : '');
      const r = rec['lv' + L.n];
      b.innerHTML = `<b>${L.name}</b><span>${L.desc}（${L.turns} 手）${r ? `<span class="rec">全問正解 ${r.perfect}/${r.plays} 回</span>` : ''}</span>`;
      b.addEventListener('click', () => { App.level = L.n; Snd.play('tap'); renderLobby(); });
      box.appendChild(b);
    }
    $('lb-start').disabled = net && !Link.open;
  }
  $('lb-start').addEventListener('click', () => { Snd.init(); Snd.play('tap'); startRound(App.level, 1); });
  $('lb-leave').addEventListener('click', toTitle);
  $('lb-share').addEventListener('click', async () => {
    const url = CFG.publicUrl;
    try { if (navigator.share) { await navigator.share({ title: 'ふたりでカタチ', url }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(url); toast('URLをコピーしました'); } catch (e) { prompt('このURLを相棒に送ってください', url); }
  });

  // ---------- メニュー ----------
  $('pl-menu').addEventListener('click', () => {
    Snd.play('tap');
    $('mn-info').textContent = S ? `レベル${S.level}・${S.round} 問目` : '';
    $('mn-lobby').classList.toggle('hidden', !auth());
    $('menu').classList.remove('hidden');
  });
  $('mn-close').addEventListener('click', () => $('menu').classList.add('hidden'));
  $('mn-lobby').addEventListener('click', () => { $('menu').classList.add('hidden'); toLobby(true); });
  $('mn-title').addEventListener('click', () => { $('menu').classList.add('hidden'); toTitle(); });
  $('nw-title').addEventListener('click', toTitle);

  // ---------- 通信 ----------
  Link.on('state', () => { if ($('scr-lobby').classList.contains('active')) renderLobby(); });
  Link.on('open', (role) => {
    App.role = role === 'host' ? 'A' : 'B';
    $('netwait').classList.add('hidden');
    Snd.play('join'); vib(60);
    if (App.role === 'A') { if (S) send({ t: 'state', S }); }
    else send({ t: 'hello' });
    if ($('scr-lobby').classList.contains('active')) renderLobby();
  });
  Link.on('lost', () => {
    Live = null;
    if ($('scr-play').classList.contains('active')) $('netwait').classList.remove('hidden');
    if ($('scr-lobby').classList.contains('active')) renderLobby();
  });
  Link.on('error', (msg) => toast(msg, 4000));
  Link.on('msg', (m) => {
    switch (m.t) {
      case 'hello': if (App.role === 'A' && S) send({ t: 'state', S }); break;
      case 'state':
        if (App.role !== 'B' || !m.S) return;
        S = m.S;
        onState();
        break;
      case 'act': if (App.role === 'A') applyAct('B', m.a); break;
      case 'live': Live = m.e || null; if (S) renderUI(); break;
      case 'lobby': if (App.role === 'B') toLobby(false); break;
      case 'ping': break;
    }
  });
  setInterval(() => { if (App.mode === 'net' && Link.open) Link.send({ t: 'ping' }); }, 1500);

  // ---------- タイトル ----------
  $('btn-play').addEventListener('click', () => {
    Snd.init(); Snd.play('tap');
    App.mode = 'net'; App.role = null;
    Link.start();
    showScreen('scr-lobby'); renderLobby();
  });
  $('btn-local').addEventListener('click', () => {
    Snd.init(); Snd.play('tap');
    App.mode = 'local'; App.role = null;
    showScreen('scr-lobby'); renderLobby();
  });
  $('btn-rules').addEventListener('click', () => showScreen('scr-rules'));
  $('btn-rules-back').addEventListener('click', () => showScreen('scr-title'));
  const syncMute = () => { $('btn-mute').textContent = Snd.muted ? '🔇 音なし' : '🔊 音あり'; };
  syncMute();
  $('btn-mute').addEventListener('click', () => {
    Snd.muted = !Snd.muted;
    try { localStorage.setItem('katachi_mute', Snd.muted ? '1' : '0'); } catch (e) { /* noop */ }
    syncMute(); Snd.init(); Snd.play('tap');
  });

  // ---------- アプリとして入れる（Android の Chrome など） ----------
  let installEv = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEv = e; $('btn-install').classList.remove('hidden'); });
  $('btn-install').addEventListener('click', async () => {
    if (!installEv) return;
    installEv.prompt();
    try { await installEv.userChoice; } catch (e) { /* noop */ }
    installEv = null; $('btn-install').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => { $('btn-install').classList.add('hidden'); toast('ホーム画面に入れました'); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* noop */ }); });
  }

  // 画面を消さない
  let wl = null;
  async function wakeLock() { try { if (navigator.wakeLock && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) { /* noop */ } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && App.mode) wakeLock(); });
  document.addEventListener('pointerdown', () => { if (App.mode) wakeLock(); }, { once: false, passive: true });

  // ---------- ループ ----------
  function frame() { render(); requestAnimationFrame(frame); }
  requestAnimationFrame(frame);

  // ---------- テスト用 ----------
  if (params.get('debug') === '1') {
    window.__kata = {
      App, get S() { return S; }, set S(v) { S = v; }, get E() { return E; }, set E(v) { E = v; },
      get Live() { return Live; }, set Live(v) { Live = v; },
      applyAct, startRound, newRound, onState, renderUI, render, fit, toLobby, PW, PH,
      local() { App.mode = 'local'; App.role = null; },
    };
  }
})();
