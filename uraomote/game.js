'use strict';
/* ウラオモテ迷宮 — 背中合わせの2台のスマホを傾けて玉を運ぶ協力迷路 */
(() => {
  // ---------- 定数 ----------
  const W = 360, H = 640, WALL = 12, R = 13;
  const G_ACC = 1150;   // 1G のときの加速度（盤面単位/秒²）
  const DAMP = 0.5;     // 空気抵抗
  const MAXV = 950;
  const REST = 0.3;     // 壁での跳ね返り
  const TH_SPEED = 2.0; // キー操作で束を回す速さ（rad/秒）
  const LEAN = 0.4;     // 「ゆっくり」中の重力の強さ
  const CP_CONFIRM = 1.2;    // トンネルを抜けてこの秒数無事ならチェックポイント
  const RESPAWN_HOLD = 1.2;  // 復活後に玉を止めておく秒数

  const LEVELS = window.URA_LEVELS;
  const CFG = window.URA_CONFIG;
  const Link = window.Link;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const SIDE = { A: { name: 'オモテ', cls: 'side-a' }, B: { name: 'ウラ', cls: 'side-b' } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now();
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const vib = (ms) => {
    try {
      const ua = navigator.userActivation;
      if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate(ms); // Android のみ（iPhone は非対応）
    } catch (e) { /* noop */ }
  };

  // ---------- 音 ----------
  const Snd = {
    ctx: null, muted: false,
    init() {
      if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; } }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(f, d, type = 'sine', v = 0.1, delay = 0, f2 = null) {
      const c = this.ctx; if (!c) return;
      const t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
      g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + d + 0.03);
    },
    play(n) {
      if (this.muted || !this.ctx) return;
      switch (n) {
        case 'tap': this.tone(700, 0.05, 'triangle', 0.05); break;
        case 'count': this.tone(660, 0.12, 'square', 0.05); break;
        case 'go': this.tone(990, 0.3, 'square', 0.06); break;
        case 'bump': this.tone(180, 0.06, 'triangle', 0.05); break;
        case 'star': [988, 1319, 1760].forEach((f, i) => this.tone(f, 0.18, 'sine', 0.08, i * 0.06)); break;
        case 'tunnel': this.tone(300, 0.4, 'sine', 0.09, 0, 1200); break;
        case 'arrive': this.tone(1200, 0.3, 'sine', 0.07, 0, 400); break;
        case 'fail': this.tone(400, 0.5, 'sawtooth', 0.07, 0, 80); break;
        case 'clear': [523, 659, 784, 1046, 1319].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.09, i * 0.1)); break;
        case 'join': this.tone(660, 0.12, 'sine', 0.07); this.tone(990, 0.2, 'sine', 0.07, 0.1); break;
      }
    },
  };
  try { Snd.muted = localStorage.getItem('uraomote_mute') === '1'; } catch (e) { /* noop */ }
  if (params.get('mute') === '1') Snd.muted = true;

  // ---------- 傾きセンサー ----------
  // deviceorientation の角度から「画面の中での重力の向き」を計算する（iPhone / Android 共通の仕様）。
  // 端末に固定した座標（x右・y下）で、1 = 1G。
  const Sensor = {
    enabled: false, g: [0, 1], last: 0, got: false,
    enable() {
      let req = null;
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          req = DeviceOrientationEvent.requestPermission(); // iPhone はタップ中に呼ぶ必要がある
        }
      } catch (e) { req = null; }
      const start = () => {
        if (this.enabled) return;
        this.enabled = true;
        window.addEventListener('deviceorientation', (e) => {
          if (e.beta == null || e.gamma == null) return;
          const b = e.beta * Math.PI / 180, gm = e.gamma * Math.PI / 180;
          const gx = Math.cos(b) * Math.sin(gm), gy = Math.sin(b);
          const k = this.got ? 0.35 : 1;
          this.g[0] += (gx - this.g[0]) * k;
          this.g[1] += (gy - this.g[1]) * k;
          this.got = true;
          this.last = now();
        });
      };
      if (req && req.then) return req.then((r) => { if (r === 'granted') start(); return r === 'granted'; }).catch(() => false);
      start();
      return Promise.resolve(true);
    },
    live() { return this.got && now() - this.last < 1000; },
  };

  // ---------- アプリ状態 ----------
  const App = {
    mode: null,        // 'solo' | 'host' | 'guest'
    mySides: [],
    connected: false,
    theta: 0,          // キー操作のときの束の回転（オモテから見て時計回りが正）
    partner: { k: 0, lean: false, s: false, g: [0, 1], t: 0 },
    lastRecv: 0, lastSend: 0,
    stageSel: 0,
    views: [],
  };
  const Input = { keyL: false, keyR: false, keyLean: false, btnL: false, btnR: false, btnLean: false };
  const localK = () => ((Input.keyR || Input.btnR) ? 1 : 0) - ((Input.keyL || Input.btnL) ? 1 : 0);
  const localLean = () => Input.keyLean || Input.btnLean;
  const mySide = () => (App.mode === 'guest' ? 'B' : 'A');
  const partnerSensor = () => App.mode !== 'solo' && App.partner.s && now() - App.partner.t < 1000;
  const thetaMode = () => !Sensor.live() && !partnerSensor();

  // 各面の画面の中での重力（背中合わせなので、裏の面は左右が反転する）
  function sideGravity(side) {
    const my = mySide();
    if (Sensor.live()) { const g = Sensor.g; return side === my ? [g[0], g[1]] : [-g[0], g[1]]; }
    if (partnerSensor()) { const g = App.partner.g; return side === my ? [-g[0], g[1]] : [g[0], g[1]]; }
    const m = (localLean() || (App.mode !== 'solo' && App.partner.lean)) ? LEAN : 1;
    const gx = Math.sin(App.theta) * m, gy = Math.cos(App.theta) * m;
    return side === 'A' ? [gx, gy] : [-gx, gy];
  }

  // ---------- 画面切り替え ----------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (id === 'scr-play') requestAnimationFrame(fit);
  }
  let toastTimer = 0;
  function toast(msg, ms = 2000) {
    const el = $('toast');
    el.innerHTML = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function alertBox(title, text) {
    $('al-title').textContent = title;
    $('al-text').textContent = text;
    $('alert').classList.remove('hidden');
  }

  // ---------- ゲーム ----------
  let G = null;

  function buildSide(L, side, pick) {
    const S = L[side] || {};
    const walls = [[0, 0, W, WALL], [0, H - WALL, W, WALL], [0, 0, WALL, H], [W - WALL, 0, WALL, H], ...(S.walls || [])];
    const traps = (S.trapGroups || []).map((grp, gi) => grp[((pick && pick[side]) || [])[gi] || 0]);
    const stars = (S.stars || []).map((s) => ({ ...s, r: s.r || 15 }));
    const tunnels = (L.tunnels || []).map((t) => ({ id: t.id, r: t.r || 22, x: side === 'A' ? t.x : W - t.x, y: t.y }));
    return { walls, traps, stars, tunnels };
  }
  function randomPick(L) {
    const p = {};
    for (const s of ['A', 'B']) p[s] = ((L[s] && L[s].trapGroups) || []).map((g) => Math.floor(Math.random() * g.length));
    return p;
  }

  function startStage(idx, pick) {
    const L = LEVELS[idx];
    App.stageSel = idx;
    G = {
      idx, L,
      sides: { A: buildSide(L, 'A', pick), B: buildSide(L, 'B', pick) },
      goal: { ...L.goal, r: L.goal.r || 24 },
      collected: new Set(),
      total: ((L.A.stars || []).length + (L.B.stars || []).length),
      ball: { side: L.start.side, x: L.start.x, y: L.start.y, vx: 0, vy: 0, ign: null, hidden: false },
      checkpoint: { side: L.start.side, x: L.start.x, y: L.start.y, ign: null },
      pendingCp: null,
      phase: 'count', count: 3, t0: 0, elapsed: 0, misses: 0,
      busy: 0, after: null, flash: null, lockToast: 0, lastBump: 0,
    };
    App.theta = 0;
    $('toast').classList.remove('show');
    $('result').classList.add('hidden');
    $('menu').classList.add('hidden');
    $('hud-name').textContent = `${idx + 1}. ${L.name}`;
    buildViews();
    showScreen('scr-play');
    wakeLock();
    Snd.play('count');
    showCount('3');
  }

  const owns = () => G && App.mySides.includes(G.ball.side);

  function send(m) { if (App.mode !== 'solo') Link.send(m); }

  function update(dt) {
    if (G.phase === 'count') {
      const prev = Math.ceil(G.count);
      G.count -= dt;
      const c = Math.ceil(G.count);
      if (G.count <= 0) {
        G.phase = 'play'; G.t0 = now();
        Snd.play('go'); showCount('GO!', 600);
        if (owns()) toast('玉はあなたの画面にあります');
        else toast('玉は相棒の画面。赤い罠を教えてあげて！');
      } else if (c !== prev) { Snd.play('count'); showCount(String(c)); }
      return;
    }
    if (G.phase !== 'play') return;
    G.elapsed = (now() - G.t0) / 1000;
    if (G.busy > 0) {
      G.busy -= dt;
      if (G.busy <= 0 && G.after) { const f = G.after; G.after = null; f(); }
      return;
    }
    if (!owns()) return;
    if (G.pendingCp) {
      G.pendingCp.t -= dt;
      if (G.pendingCp.t <= 0) {
        const { side, x, y, ign } = G.pendingCp;
        G.checkpoint = { side, x, y, ign };
        G.pendingCp = null;
        send({ t: 'cp', cp: G.checkpoint });
      }
    }
    stepBall(dt);
  }

  function stepBall(dt) {
    const b = G.ball, S = G.sides[b.side];
    if (b.hold > 0) { b.hold -= dt; b.vx = 0; b.vy = 0; return; } // 復活直後は少し待つ（束を水平に戻す時間）
    const g = sideGravity(b.side);
    b.vx += g[0] * G_ACC * dt;
    b.vy += g[1] * G_ACC * dt;
    const d = Math.max(0, 1 - DAMP * dt);
    b.vx *= d; b.vy *= d;
    let sp = Math.hypot(b.vx, b.vy);
    if (sp > MAXV) { b.vx *= MAXV / sp; b.vy *= MAXV / sp; sp = MAXV; }
    const n = Math.max(1, Math.ceil((sp * dt) / (R * 0.35)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      b.x += b.vx * h; b.y += b.vy * h;
      for (const w of S.walls) collide(b, w);
      b.x = clamp(b.x, WALL + R, W - WALL - R);
      b.y = clamp(b.y, WALL + R, H - WALL - R);
      if (checkObjects(b, S)) return;
    }
  }

  function collide(b, w) {
    const [x, y, ww, hh] = w;
    const cx = clamp(b.x, x, x + ww), cy = clamp(b.y, y, y + hh);
    const dx = b.x - cx, dy = b.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return;
    let nx, ny, pen;
    if (d2 < 1e-9) { // 中心が壁の中：一番近い辺から押し出す
      const l = b.x - x, r = x + ww - b.x, t = b.y - y, bo = y + hh - b.y;
      const m = Math.min(l, r, t, bo);
      if (m === l) { nx = -1; ny = 0; } else if (m === r) { nx = 1; ny = 0; } else if (m === t) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
      pen = R + m;
    } else {
      const dd = Math.sqrt(d2);
      nx = dx / dd; ny = dy / dd; pen = R - dd;
    }
    b.x += nx * pen; b.y += ny * pen;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const e = -vn > 60 ? REST : 0; // ゆっくり当たったときは跳ねさせない（床でのガタつき防止）
      b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
      if (-vn > 220 && now() - G.lastBump > 90) { G.lastBump = now(); Snd.play('bump'); }
    }
  }

  function rectDist(px, py, r) {
    const cx = clamp(px, r[0], r[0] + r[2]), cy = clamp(py, r[1], r[1] + r[3]);
    return Math.hypot(px - cx, py - cy);
  }

  function checkObjects(b, S) {
    for (const r of S.traps) {
      if (rectDist(b.x, b.y, r) < R * 0.55) { fail(); return true; }
    }
    for (const s of S.stars) {
      if (!G.collected.has(s.id) && Math.hypot(b.x - s.x, b.y - s.y) < s.r + R) collect(s.id, true);
    }
    for (const t of S.tunnels) {
      const d = Math.hypot(b.x - t.x, b.y - t.y);
      if (b.ign === t.id) { if (d > t.r + R + 2) b.ign = null; continue; }
      if (d < t.r * 0.6) { enterTunnel(t); return true; }
    }
    if (G.goal.side === b.side) {
      const d = Math.hypot(b.x - G.goal.x, b.y - G.goal.y);
      if (d < G.goal.r * 0.8) {
        if (G.collected.size >= G.total) { clearStage(); return true; }
        if (now() - G.lockToast > 2500) { G.lockToast = now(); toast(`ゴールはまだ閉じている（★ ${G.collected.size}/${G.total}）`); }
      }
    }
    return false;
  }

  function collect(id, mine) {
    if (G.collected.has(id)) return;
    G.collected.add(id);
    Snd.play('star'); vib(30);
    const all = G.collected.size >= G.total;
    toast(`★ ${G.collected.size}/${G.total}${all ? '　ゴールが開いた！' : ''}`);
    if (mine) send({ t: 'star', id });
  }

  function fail() {
    const b = G.ball;
    G.misses++;
    G.flash = { side: b.side, x: b.x, y: b.y, t: now(), type: 'fail' };
    b.hidden = true;
    Snd.play('fail'); vib(250);
    toast('💥 罠にはまった！ チェックポイントから再開');
    send({ t: 'fail', side: b.side, x: b.x, y: b.y, misses: G.misses });
    G.pendingCp = null;
    G.busy = 0.9;
    G.after = () => { const cp = G.checkpoint; placeBall(cp.side, cp.x, cp.y, 0, 0, cp.ign, 'respawn'); };
  }

  function enterTunnel(t) {
    const b = G.ball, to = other(b.side);
    const exit = G.sides[to].tunnels.find((x) => x.id === t.id);
    G.flash = { side: b.side, x: t.x, y: t.y, t: now(), type: 'tunnel' };
    b.hidden = true;
    Snd.play('tunnel'); vib(60);
    const vx = -b.vx * 0.5, vy = b.vy * 0.5; // 真裏に出るので左右の向きが反転
    G.busy = 0.35;
    G.after = () => placeBall(to, exit.x, exit.y, vx, vy, t.id, 'tunnel');
  }

  function placeBall(side, x, y, vx, vy, ign, reason) {
    G.ball = { side, x, y, vx, vy, ign, hidden: false, hold: reason === 'respawn' ? RESPAWN_HOLD : 0 };
    G.pendingCp = reason === 'tunnel' ? { side, x, y, ign, t: CP_CONFIRM } : null;
    if (App.mySides.includes(side)) {
      if (reason === 'tunnel') {
        Snd.play('arrive');
        toast(App.mode === 'solo' ? `トンネルを抜けて${SIDE[side].name}へ！` : '玉がこっちに来た！');
      }
    } else {
      send({ t: 'place', side, x, y, vx, vy, ign, reason });
      if (reason === 'tunnel') toast('玉は相棒の画面へ！ 赤い罠を教えてあげて');
      else toast('玉は相棒の画面で再開');
    }
  }

  function clearStage() {
    const res = { time: G.elapsed, misses: G.misses };
    send({ t: 'clear', ...res });
    showResult(res);
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
  }

  function showResult(res) {
    G.phase = 'clear';
    G.elapsed = res.time;
    Snd.play('clear'); vib([60, 40, 120]);
    const stars = res.misses === 0 ? 3 : res.misses <= 2 ? 2 : 1;
    $('rs-title').textContent = 'ステージクリア！';
    $('rs-rank').textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
    $('rs-detail').innerHTML = `タイム ${fmtTime(res.time)}　／　罠 ${res.misses}回`;
    const leader = App.mode !== 'guest';
    $('rs-host').classList.toggle('hidden', !leader);
    $('rs-wait').classList.toggle('hidden', leader);
    $('rs-next').classList.toggle('hidden', G.idx >= LEVELS.length - 1);
    $('result').classList.remove('hidden');
  }

  let countTimer = 0;
  function showCount(txt, ms) {
    const el = $('count');
    el.textContent = txt;
    clearTimeout(countTimer);
    if (ms) countTimer = setTimeout(() => { el.textContent = ''; }, ms);
  }

  // ---------- ホストの操作 ----------
  function leaderStart(idx) {
    const pick = randomPick(LEVELS[idx]);
    send({ t: 'start', stage: idx, pick });
    startStage(idx, pick);
  }
  function leaderLobby() {
    send({ t: 'lobby' });
    goLobby();
  }

  // ---------- 受信 ----------
  function onMsg(m) {
    App.lastRecv = now();
    switch (m.t) {
      case 'hello': App.connected = true; renderLobby(); break;
      case 'in':
        App.partner = { k: m.k | 0, lean: !!m.lean, s: !!m.s, g: Array.isArray(m.g) ? m.g : [0, 1], t: now() };
        if (App.mode === 'guest' && typeof m.th === 'number') App.theta = m.th;
        break;
      case 'start': if (App.mode === 'guest') startStage(m.stage, m.pick); break;
      case 'lobby': if (App.mode === 'guest') goLobby(); break;
      case 'place':
        if (!G) break;
        G.busy = 0; G.after = null;
        G.ball = { side: m.side, x: m.x, y: m.y, vx: m.vx, vy: m.vy, ign: m.ign, hidden: false, hold: m.reason === 'respawn' ? RESPAWN_HOLD : 0 };
        G.pendingCp = m.reason === 'tunnel' ? { side: m.side, x: m.x, y: m.y, ign: m.ign, t: CP_CONFIRM } : null;
        Snd.play('arrive'); vib(60);
        toast(m.reason === 'tunnel' ? '玉がこっちに来た！' : '玉はこっちで再開');
        break;
      case 'cp': if (G) G.checkpoint = m.cp; break;
      case 'star': if (G) collect(m.id, false); break;
      case 'fail':
        if (!G) break;
        G.misses = m.misses;
        G.flash = { side: m.side, x: m.x, y: m.y, t: now(), type: 'fail' };
        Snd.play('fail');
        toast('💥 相棒側で罠にはまった！');
        break;
      case 'clear': if (G) showResult(m); break;
    }
  }

  // ---------- 送信（入力の共有） ----------
  function netTick(t) {
    if (App.mode === 'solo' || !Link.open) return;
    if (t - App.lastSend < 50) return;
    App.lastSend = t;
    const m = { t: 'in', k: localK(), lean: localLean(), s: Sensor.live(), g: [+Sensor.g[0].toFixed(3), +Sensor.g[1].toFixed(3)] };
    if (App.mode === 'host') m.th = +App.theta.toFixed(4);
    Link.send(m);
  }

  // ---------- 描画 ----------
  function buildViews() {
    const box = $('views');
    box.innerHTML = '';
    App.views = App.mySides.map((side) => {
      const el = document.createElement('div');
      el.className = `view ${SIDE[side].cls}`;
      el.innerHTML = '<div class="vbox"><div class="vwrap"><canvas></canvas></div></div><div class="vlabel"></div>';
      box.appendChild(el);
      const canvas = el.querySelector('canvas');
      return { side, el, box: el.querySelector('.vbox'), wrap: el.querySelector('.vwrap'), canvas, ctx: canvas.getContext('2d'), label: el.querySelector('.vlabel'), w: 0, h: 0, scale: 1, lastLabel: '' };
    });
  }

  function fit() {
    if (!App.views.length) return;
    const st = $('stage');
    // 端末が横向きに回ってしまっても、盤面は端末に対して固定する（センサーの向きと合わせるため）
    let ang = 0;
    if (isTouch && App.mode !== 'solo') {
      if (screen.orientation && typeof screen.orientation.angle === 'number') ang = screen.orientation.angle;
      else if (typeof window.orientation === 'number') ang = window.orientation;
    }
    ang = ((ang % 360) + 360) % 360;
    let vw = window.innerWidth, vh = window.innerHeight;
    if (ang === 90 || ang === 270) [vw, vh] = [vh, vw];
    st.style.width = vw + 'px';
    st.style.height = vh + 'px';
    st.style.transform = `translate(-50%, -50%) rotate(${-ang}deg)`;

    $('pad').classList.toggle('hidden', !thetaMode());
    const hud = $('hud').offsetHeight;
    const pad = $('pad').classList.contains('hidden') ? 0 : $('pad').offsetHeight;
    const n = App.views.length;
    const availW = vw - 12 - (n - 1) * 10;
    const availH = vh - hud - pad - 12 - 30;
    const cw = availW / n;
    let h = availH, w = (h * W) / H;
    if (w > cw) { w = cw; h = (w * H) / W; }
    w = Math.floor(w); h = Math.floor(h);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const v of App.views) {
      v.el.style.width = cw + 'px';
      v.box.style.width = w + 'px'; v.box.style.height = h + 'px';
      v.canvas.style.width = w + 'px'; v.canvas.style.height = h + 'px';
      v.canvas.width = Math.round(w * dpr); v.canvas.height = Math.round(h * dpr);
      v.w = w; v.h = h; v.scale = (w / W) * dpr;
    }
  }

  function render() {
    const tm = thetaMode();
    for (const v of App.views) {
      // キー操作のときは、盤面そのものを回して「束を傾けている」様子を見せる
      if (tm) {
        const th = v.side === 'A' ? App.theta : -App.theta;
        const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
        const k = Math.min(v.w / (v.w * c + v.h * s), v.h / (v.w * s + v.h * c));
        v.wrap.style.transform = `rotate(${th}rad) scale(${k})`;
      } else if (v.wrap.style.transform) v.wrap.style.transform = '';
      drawView(v);
      const here = G.ball.side === v.side;
      const lbl = `${SIDE[v.side].name}${App.mode === 'solo' ? '' : '（あなた）'}` +
        (here ? '<span class="here">● 玉はここ</span>' : '<span class="away">◌ 玉は向こう側</span>');
      if (lbl !== v.lastLabel) { v.label.innerHTML = lbl; v.lastLabel = lbl; }
    }
    $('hud-stars').textContent = `${G.collected.size}/${G.total}`;
    $('hud-time').textContent = fmtTime(G.phase === 'count' ? 0 : G.elapsed);
    $('hud-miss').textContent = G.misses;
    const lag = App.mode !== 'solo' && Link.open && now() - App.lastRecv > 4000;
    $('hud-net').textContent = App.mode !== 'solo' && !Link.open ? '切断' : lag ? '通信待ち…' : '';
  }

  const COLORS = {
    A: { bg1: '#2a1d10', bg2: '#140d06', wall: '#d9913a', wallTop: '#ffcf86', faint: '#5fd7ff' },
    B: { bg1: '#0f2236', bg2: '#060d18', wall: '#3c7fd6', wallTop: '#9fe3ff', faint: '#ffb547' },
  };

  function drawView(v) {
    const ctx = v.ctx, side = v.side, S = G.sides[side], P = G.sides[other(side)], C = COLORS[side];
    const t = now() / 1000;
    ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);

    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, C.bg1); bg.addColorStop(1, C.bg2);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let y = 30; y < H; y += 36) for (let x = 30; x < W; x += 36) ctx.fillRect(x, y, 2, 2);

    // 相棒の面の壁（裏から透けて見える・うっすら）
    ctx.save();
    ctx.globalAlpha = 0.22; ctx.strokeStyle = C.faint; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]);
    for (const w of P.walls.slice(4)) ctx.strokeRect(W - w[0] - w[2] + 0.5, w[1] + 0.5, w[2] - 1, w[3] - 1);
    ctx.restore();

    // 相棒の面の罠（自分にだけ見える）
    for (const r of P.traps) drawTrap(ctx, W - r[0] - r[2], r[1], r[2], r[3], t);

    // トンネル
    for (const tn of S.tunnels) drawTunnel(ctx, tn, t);

    // ゴール
    if (G.goal.side === side) drawGoal(ctx, G.goal, G.collected.size >= G.total, t);

    // ★
    for (const s of S.stars) if (!G.collected.has(s.id)) drawStar(ctx, s.x, s.y, s.r, t);

    // 壁
    for (const w of S.walls) {
      ctx.fillStyle = C.wall; ctx.fillRect(w[0], w[1], w[2], w[3]);
      ctx.fillStyle = C.wallTop; ctx.fillRect(w[0], w[1], w[2], Math.min(3, w[3]));
    }

    // 玉
    const b = G.ball;
    if (b.side === side && !b.hidden && (owns() || G.phase === 'count')) {
      drawBall(ctx, b.x, b.y);
      if (b.hold > 0) { // 復活待ちのリング
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(b.x, b.y, R + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (b.hold / RESPAWN_HOLD)); ctx.stroke();
      }
    }

    // エフェクト
    const f = G.flash;
    if (f) {
      const age = (now() - f.t) / 1000;
      if (age > 1.2) G.flash = null;
      else {
        const fx = f.side === side ? f.x : W - f.x;
        const col = f.type === 'fail' ? '255,77,94' : '190,140,255';
        ctx.strokeStyle = `rgba(${col},${1 - age / 1.2})`;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(fx, f.y, 14 + age * 60, 0, Math.PI * 2); ctx.stroke();
        if (f.side !== side && f.type === 'fail') {
          ctx.fillStyle = `rgba(255,120,130,${1 - age / 1.2})`;
          ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('ここで罠に！', fx, f.y - 26);
        }
      }
    }
  }

  function drawTrap(ctx, x, y, w, h, t) {
    ctx.save();
    const a = 0.32 + 0.12 * Math.sin(t * 4);
    ctx.fillStyle = `rgba(255,60,80,${a})`;
    ctx.fillRect(x, y, w, h);
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = 'rgba(255,90,110,0.55)'; ctx.lineWidth = 3;
    for (let k = -h; k < w; k += 12) { ctx.beginPath(); ctx.moveTo(x + k, y + h); ctx.lineTo(x + k + h, y); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = '#ff4d5e'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚠', x + w / 2, y + h / 2);
  }

  function drawTunnel(ctx, tn, t) {
    const g = ctx.createRadialGradient(tn.x, tn.y, 2, tn.x, tn.y, tn.r);
    g.addColorStop(0, '#000'); g.addColorStop(0.7, '#1a0b33'); g.addColorStop(1, '#7c4dff');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(tn.x, tn.y, tn.r, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(tn.x, tn.y); ctx.rotate(t * 2.5);
    ctx.strokeStyle = 'rgba(200,170,255,0.85)'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.arc(0, 0, tn.r - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(230,215,255,0.9)'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(tn.id), tn.x, tn.y);
  }

  function drawGoal(ctx, gl, open, t) {
    ctx.save();
    ctx.lineWidth = 4;
    if (open) {
      const p = 0.5 + 0.5 * Math.sin(t * 5);
      ctx.fillStyle = `rgba(110,240,160,${0.25 + 0.2 * p})`;
      ctx.shadowColor = '#6ef0a0'; ctx.shadowBlur = 18;
      ctx.strokeStyle = '#6ef0a0';
    } else {
      ctx.fillStyle = 'rgba(160,160,190,0.15)';
      ctx.strokeStyle = 'rgba(180,180,210,0.6)';
    }
    ctx.beginPath(); ctx.arc(gl.x, gl.y, gl.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = open ? '#d9ffe8' : 'rgba(220,220,240,0.8)';
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(open ? 'GOAL' : '🔒', gl.x, gl.y);
  }

  function drawStar(ctx, x, y, r, t) {
    const s = r * (1 + 0.08 * Math.sin(t * 5));
    ctx.save();
    ctx.translate(x, y); ctx.rotate(Math.sin(t * 2) * 0.2);
    ctx.shadowColor = '#ffd84a'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffd84a';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? s * 0.45 : s;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawBall(ctx, x, y) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.5)'; ctx.shadowBlur = 10;
    const g = ctx.createRadialGradient(x - 4, y - 5, 2, x, y, R);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, '#d4d8f0'); g.addColorStop(1, '#5d6288');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------- メインループ ----------
  let lastT = now();
  function frame() {
    tick();
    requestAnimationFrame(frame);
  }
  // 画面が裏に回って requestAnimationFrame が止まっても、通信中のゲームが止まらないように予備のタイマーで進める
  setInterval(() => { if (now() - lastT > 120) tick(); }, 33);
  function tick() {
    const t = now();
    const dt = Math.min(0.04, (t - lastT) / 1000);
    lastT = t;
    if (App.mode === 'solo' || App.mode === 'host') {
      const kB = App.mode === 'host' && now() - App.partner.t < 1000 ? App.partner.k : 0;
      App.theta += TH_SPEED * dt * (localK() - kB);
      if (App.theta > Math.PI) App.theta -= Math.PI * 2;
      if (App.theta < -Math.PI) App.theta += Math.PI * 2;
    }
    if (G && $('scr-play').classList.contains('active')) { update(dt); render(); }
    netTick(t);
  }
  requestAnimationFrame(frame);
  setInterval(() => {
    if (!$('scr-play').classList.contains('active')) return;
    const want = !thetaMode();
    if ($('pad').classList.contains('hidden') !== want) fit();
  }, 500);
  window.addEventListener('resize', () => { if ($('scr-play').classList.contains('active')) fit(); });
  window.addEventListener('orientationchange', () => setTimeout(fit, 300));

  // ---------- 画面の常時点灯・全画面 ----------
  let wakeSentinel = null;
  async function wakeLock() {
    try { if ('wakeLock' in navigator && !wakeSentinel) { wakeSentinel = await navigator.wakeLock.request('screen'); wakeSentinel.addEventListener('release', () => { wakeSentinel = null; }); } } catch (e) { /* noop */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('scr-play').classList.contains('active')) wakeLock(); });
  function tryFullscreen() {
    if (!isTouch) return;
    const el = document.documentElement;
    try {
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null;
      if (p && p.then) p.then(() => { try { screen.orientation.lock('portrait').catch(() => {}); } catch (e) { /* noop */ } }).catch(() => {});
    } catch (e) { /* noop */ }
  }

  // ---------- ロビー ----------
  let netStatus = { state: '', room: '' };
  function inviteUrl(room) {
    // 確認用サーバー（http://localhost:8095 などポート付き）ではそのページ自身、
    // それ以外（公開ページ・APK）では config.js の公開URLを使う
    const here = location.origin + location.pathname;
    const dev = location.port !== '' || location.protocol === 'file:';
    const base = dev ? here : (CFG.publicUrl || here);
    return `${base}?room=${room}`;
  }

  function goLobby() {
    G = null;
    App.views = [];
    $('result').classList.add('hidden');
    $('menu').classList.add('hidden');
    renderLobby();
    showScreen('scr-lobby');
  }

  function renderLobby() {
    const solo = App.mode === 'solo', host = App.mode === 'host', guest = App.mode === 'guest';
    $('lb-title').textContent = solo ? 'ひとりで試す' : host ? 'ルーム（あなたはオモテ）' : 'ルーム（あなたはウラ）';
    $('lb-room').classList.toggle('hidden', solo);
    $('lb-code').textContent = Link.room || '-----';
    const url = host && Link.room ? inviteUrl(Link.room) : '';
    $('lb-url').textContent = url;
    $('lb-share').parentElement.classList.toggle('hidden', !host);

    let st = '';
    if (solo) st = 'オモテとウラを並べて表示します。<br>罠は「反対側の面」に透けて見えます（実際は相棒にしか見えません）。';
    else if (App.connected && Link.open) st = '<span class="ok">● 相棒とつながりました！</span>';
    else if (netStatus.state === 'error') st = `<span class="ng">● ${netStatus.msg}</span>`;
    else if (host) st = netStatus.state === 'waiting' ? '● 相棒の参加を待っています…<br><small>URLを送るか、コードを教えてね</small>' : '● 準備中…';
    else if (guest) st = '● ホストにつないでいます…';
    $('lb-status').innerHTML = st;

    const sen = Sensor.live() ? '<span class="ok">● 傾きセンサー：使えます</span>'
      : (isTouch ? '<span class="ng">● 傾きセンサー：使えません（画面のボタンで操作）</span>' : '● 傾きセンサーなし：← →キーで操作します');
    $('lb-sensor').innerHTML = sen;

    const leader = !guest;
    $('lb-host-area').classList.toggle('hidden', !leader);
    if (leader) {
      $('lb-stages').innerHTML = LEVELS.map((L, i) => `<button data-i="${i}" class="${i === App.stageSel ? 'on' : ''}">${i + 1}. ${L.name}<small>${L.hint}</small></button>`).join('');
      $('lb-start').disabled = !(solo || (App.connected && Link.open));
    }
    $('lb-wait').textContent = guest ? (App.connected && Link.open ? 'ホストがステージを選んでスタートするのを待っています…' : '') : '';
  }
  setInterval(() => { if ($('scr-lobby').classList.contains('active')) renderLobby(); }, 1000);

  // ---------- 通信イベント ----------
  Link.on('status', (s) => { netStatus = { ...netStatus, ...s }; renderLobby(); });
  Link.on('open', () => {
    App.connected = true; App.lastRecv = now();
    Link.send({ t: 'hello', side: mySide() });
    Snd.play('join'); vib(80);
    renderLobby();
  });
  Link.on('msg', onMsg);
  Link.on('error', (e) => {
    const msg = Link.errorText(e);
    netStatus = { ...netStatus, state: 'error', msg };
    if ($('scr-lobby').classList.contains('active')) renderLobby();
    else { $('title-err').textContent = msg; }
  });
  Link.on('close', () => {
    App.connected = false;
    if (App.mode === 'solo') return;
    alertBox('相棒との接続が切れました', 'もう一度ルームを作り直してください。');
  });

  // ---------- 入力 ----------
  const KEYMAP = { ArrowLeft: 'keyL', ArrowRight: 'keyR', ArrowDown: 'keyLean', a: 'keyL', d: 'keyR', s: 'keyLean' };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.key]; if (!k) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    Input[k] = true; e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { const k = KEYMAP[e.key]; if (k) Input[k] = false; });
  window.addEventListener('blur', () => { Input.keyL = Input.keyR = Input.keyLean = false; });
  const hold = (id, key) => {
    const el = $(id);
    const on = (e) => { e.preventDefault(); Input[key] = true; el.classList.add('on'); };
    const off = () => { Input[key] = false; el.classList.remove('on'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
  };
  hold('pad-l', 'btnL'); hold('pad-r', 'btnR'); hold('pad-lean', 'btnLean');

  // タイトル
  const syncMute = () => { $('btn-mute').textContent = Snd.muted ? '🔇 音なし' : '🔊 音あり'; };
  syncMute();
  $('btn-mute').addEventListener('click', () => {
    Snd.muted = !Snd.muted;
    try { localStorage.setItem('uraomote_mute', Snd.muted ? '1' : '0'); } catch (e) { /* noop */ }
    syncMute(); Snd.init(); Snd.play('tap');
  });
  function prepDevice() {
    Snd.init();
    const p = Sensor.enable();
    tryFullscreen();
    return p;
  }
  $('btn-create').addEventListener('click', () => {
    prepDevice();
    App.mode = 'host'; App.mySides = ['A']; App.connected = false; App.stageSel = 0;
    netStatus = { state: 'starting', room: '' };
    Link.host();
    goLobby();
  });
  const joinCodeInput = $('join-code');
  joinCodeInput.addEventListener('input', () => { joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('btn-join').addEventListener('click', () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (code.length !== 5) { $('title-err').textContent = '5文字のルームコードを入れてください'; return; }
    $('title-err').textContent = '';
    prepDevice();
    App.mode = 'guest'; App.mySides = ['B']; App.connected = false;
    netStatus = { state: 'connecting', room: code };
    Link.join(code);
    goLobby();
  });
  $('btn-solo').addEventListener('click', () => {
    prepDevice();
    Link.close();
    App.mode = 'solo'; App.mySides = ['A', 'B']; App.connected = false;
    goLobby();
  });
  $('btn-rules').addEventListener('click', () => showScreen('scr-rules'));
  $('btn-rules-back').addEventListener('click', () => showScreen('scr-title'));

  // ロビー
  $('lb-stages').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    App.stageSel = Number(b.dataset.i); Snd.play('tap'); renderLobby();
  });
  $('lb-start').addEventListener('click', () => { Snd.init(); leaderStart(App.stageSel); });
  $('lb-copy').addEventListener('click', async () => {
    const url = inviteUrl(Link.room);
    try { await navigator.clipboard.writeText(url); $('lb-copy').textContent = 'コピーしました'; } catch (e) { $('lb-copy').textContent = 'コピーできませんでした'; }
    setTimeout(() => { $('lb-copy').textContent = 'コピー'; }, 1500);
  });
  $('lb-share').addEventListener('click', async () => {
    const url = inviteUrl(Link.room);
    if (navigator.share) { try { await navigator.share({ title: 'ウラオモテ迷宮', text: `ウラオモテ迷宮で遊ぼう！ ルーム ${Link.room}`, url }); } catch (e) { /* キャンセル */ } }
    else { try { await navigator.clipboard.writeText(url); $('lb-share').textContent = 'URLをコピーしました'; setTimeout(() => { $('lb-share').textContent = '📤 URLを送る'; }, 1500); } catch (e) { /* noop */ } }
  });
  const toTitle = () => {
    Link.close(); G = null; App.views = []; App.mode = null; App.connected = false;
    $('alert').classList.add('hidden');
    showScreen('scr-title');
  };
  $('lb-leave').addEventListener('click', toTitle);
  $('al-btn').addEventListener('click', toTitle);

  // リザルト・メニュー
  $('rs-next').addEventListener('click', () => leaderStart(G.idx + 1));
  $('rs-retry').addEventListener('click', () => leaderStart(G.idx));
  $('rs-lobby').addEventListener('click', leaderLobby);
  $('hud-menu').addEventListener('click', () => {
    $('mn-hint').textContent = G ? G.L.hint : '';
    const leader = App.mode !== 'guest';
    $('mn-retry').classList.toggle('hidden', !leader);
    $('mn-lobby').classList.toggle('hidden', !leader);
    $('menu').classList.remove('hidden');
  });
  $('mn-close').addEventListener('click', () => $('menu').classList.add('hidden'));
  $('mn-retry').addEventListener('click', () => leaderStart(G.idx));
  $('mn-lobby').addEventListener('click', leaderLobby);
  $('mn-title').addEventListener('click', toTitle);

  // URLに ?room= があれば参加画面の準備
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (roomParam) {
    joinCodeInput.value = roomParam;
    $('title-err').textContent = '';
    $('btn-join').textContent = 'このルームに参加する（ウラ）';
  }

  // 開発用：コンソールから状態を見る
  if (params.get('debug') === '1') {
    window.__ura = {
      App, Input, Sensor,
      get G() { return G; },
      // 物理を手動で進める（自動テスト用）
      step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) update(dt); },
    };
  }
})();
