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
  const LINE_R = 3;          // 描いた床の太さ（半分）
  // 2台の傾きのずれチェック（背中合わせで一緒に傾けていないと強制やり直し）
  const SYNC_LIMIT = 45 * Math.PI / 180; // これ以上ずれたら「ずれている」
  const SYNC_TIME = 1.0;                 // ずれがこの秒数続いたら注意ポップアップ（ペナルティなし）
  const SYNC_OK = 25 * Math.PI / 180;    // ここまでそろえば OK を押せる
  const SYNC_LAG_MS = 450;               // 相棒の値が遅れて届く分の見込み
  const REALIGN_TIME = 0.5;

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
  // 効果音はすべてその場で合成する（音声ファイルなし）。
  //  ・玉と敵の「転がる音」「ぶつかる音」は、その玉がある面の端末から鳴らす（ひとりで試すときは オモテ=左・ウラ=右 に振り分け）
  //  ・転がる音は速さで大きさ・高さが変わる。ぶつかる音は、ぶつかった強さで大きさが変わる
  //  ・最後にコンプレッサーを通して、大きめに鳴らしても音割れしないようにしている
  const Snd = {
    ctx: null, muted: false, out: null, noise: null, rolls: new Map(),
    init() {
      if (!this.ctx) {
        try { this.setup(new (window.AudioContext || window.webkitAudioContext)()); } catch (e) { this.ctx = null; }
      }
      if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
    },
    // 出口（音量・コンプレッサー）と、ぶつかる音・転がる音のもとになる雑音を用意する
    setup(c) {
      this.ctx = c; this.rolls = new Map();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.2;
      this.out = c.createGain(); this.out.gain.value = this.muted ? 0 : 1;
      this.out.connect(comp); comp.connect(c.destination);
      const len = Math.floor(c.sampleRate * 2), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    },
    setMuted(m) {
      this.muted = m;
      if (this.out) this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
    },
    dest(pan) {
      const c = this.ctx;
      if (!pan || !c.createStereoPanner) return this.out;
      const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(this.out);
      return p;
    },
    tone(f, d, type = 'sine', v = 0.1, delay = 0, f2 = null, pan = 0) {
      const c = this.ctx; if (!c) return;
      const t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(this.dest(pan)); o.start(t); o.stop(t + d + 0.03);
    },
    // 雑音を帯域でしぼった短い音（コツッ・ザッ・シュッ）
    burst(f, q, d, v, delay = 0, pan = 0, f2 = null) {
      const c = this.ctx; if (!c) return;
      const t = c.currentTime + delay;
      const s = c.createBufferSource(); s.buffer = this.noise;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q; bp.frequency.setValueAtTime(f, t);
      if (f2) bp.frequency.exponentialRampToValueAtTime(f2, t + d);
      const g = c.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      s.connect(bp); bp.connect(g); g.connect(this.dest(pan));
      s.start(t, Math.random() * 1.5); s.stop(t + d + 0.03);
    },
    // ぶつかる音。v = ぶつかった速さ、mat = wall（壁）/ slope（斜めの床）/ line（描いた床）、kind = ball / enemy
    hit(v, mat, kind, pan = 0) {
      if (this.muted || !this.ctx) return;
      const a = Math.min(1, Math.max(0.15, (v - 40) / 560));
      const r = 0.92 + Math.random() * 0.16;
      if (kind === 'enemy') { // とげとげの敵：ガシャッ
        this.burst(2600 * r, 2.5, 0.08, 3.2 * a, 0, pan);
        this.burst(900 * r, 3, 0.06, 2.0 * a, 0.012, pan);
        this.tone(120 * r, 0.12, 'square', 0.35 * a, 0, 70, pan);
        return;
      }
      // 玉（ビー玉）：ゴッ（低い胴鳴り）＋ コツッ（硬い音）＋ カチッ（高い音）
      this.tone(140 * r, 0.16, 'sine', 1.6 * a, 0, 55, pan);
      if (mat === 'line') { // 描いた床：ポコン
        this.tone(560 * r, 0.18, 'triangle', 0.9 * a, 0, 500, pan);
        this.burst(1700 * r, 5, 0.05, 1.8 * a, 0, pan);
      } else {
        this.burst((mat === 'slope' ? 1250 : 900) * r, 2.2, 0.07, 3.4 * a, 0, pan);
      }
      this.tone(3000 * r, 0.05, 'sine', 0.4 * a, 0, null, pan);
    },
    // 玉どうし：カチン
    clack(v, pan = 0) {
      if (this.muted || !this.ctx) return;
      const a = Math.min(1, Math.max(0.2, (v - 40) / 500));
      this.tone(3300, 0.09, 'sine', 0.7 * a, 0, null, pan);
      this.tone(4500, 0.07, 'sine', 0.45 * a, 0, null, pan);
      this.burst(3200, 4, 0.03, 1.4 * a, 0, pan);
    },
    // 転がる音の声（転がるもの1つにつき1つ。ずっと鳴らしておき、音量で出し入れする）
    voice(id, kind) {
      let v = this.rolls.get(id);
      if (v && v.kind === kind) return v;
      const c = this.ctx, en = kind === 'enemy';
      const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = en ? 2.2 : 0.8; bp.frequency.value = 300;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = en ? 3000 : 1100;
      const g = c.createGain(); g.gain.value = 0;
      const am = c.createGain(); am.gain.value = 0; // ゴロゴロ・ガラガラのゆれ
      const lfo = c.createOscillator(); lfo.type = en ? 'square' : 'sine'; lfo.frequency.value = 4;
      const hum = c.createOscillator(); hum.type = 'triangle'; hum.frequency.value = 55; // 低いうなり（玉の重さ）
      const hg = c.createGain(); hg.gain.value = 0;
      const pan = c.createStereoPanner ? c.createStereoPanner() : null;
      const dst = pan || this.out;
      if (pan) pan.connect(this.out);
      lfo.connect(am); am.connect(g.gain);
      src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(dst);
      hum.connect(hg); hg.connect(dst);
      src.start(0, Math.random() * 1.5); lfo.start(); hum.start();
      v = { src, bp, g, am, lfo, hum, hg, pan, kind };
      this.rolls.set(id, v);
      return v;
    },
    // 毎フレーム：list = [{ id, kind, spd（速さ）, on（壁や床に接している）, pan }]。list にないものは静かにする
    roll(list) {
      const c = this.ctx; if (!c) return;
      const t = c.currentTime, seen = new Set();
      for (const o of list) {
        seen.add(o.id);
        const v = this.voice(o.id, o.kind), en = o.kind === 'enemy';
        const s = o.on ? Math.min(1, Math.max(0, (o.spd - 12) / 480)) : 0; // 宙を飛んでいる間は鳴らさない
        const lv = this.muted ? 0 : Math.pow(s, 0.65) * (en ? 0.4 : 0.55);
        v.g.gain.setTargetAtTime(lv * 0.7, t, 0.035);
        v.am.gain.setTargetAtTime(lv * (en ? 0.55 : 0.32), t, 0.035);
        v.lfo.frequency.setTargetAtTime(Math.max(1.5, o.spd / (en ? 10 : 80)), t, 0.05); // 1回転ごと（敵はとげの数ぶん）
        v.bp.frequency.setTargetAtTime((en ? 800 : 170) + o.spd * (en ? 1.8 : 0.75), t, 0.05);
        v.hum.frequency.setTargetAtTime(45 + o.spd * 0.06, t, 0.05);
        v.hg.gain.setTargetAtTime(en ? 0 : lv * 0.22, t, 0.05);
        if (v.pan) v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, o.pan)), t, 0.05);
      }
      for (const [id, v] of this.rolls) if (!seen.has(id)) {
        v.g.gain.setTargetAtTime(0, t, 0.03); v.am.gain.setTargetAtTime(0, t, 0.03); v.hg.gain.setTargetAtTime(0, t, 0.03);
      }
    },
    play(n, pan = 0) {
      if (this.muted || !this.ctx) return;
      switch (n) {
        case 'tap': this.tone(700, 0.06, 'triangle', 0.12); break;
        case 'count': this.tone(660, 0.14, 'square', 0.1); break;
        case 'go': this.tone(990, 0.35, 'square', 0.12); this.tone(1485, 0.3, 'triangle', 0.08, 0.02); break;
        case 'star': [988, 1319, 1760].forEach((f, i) => this.tone(f, 0.22, 'sine', 0.2, i * 0.06, null, pan)); break;
        case 'goal': // ゴールの穴に落ちる：コトン ＋ キラキラ
          this.tone(220, 0.18, 'sine', 0.7, 0, 90, pan); this.burst(700, 3, 0.08, 1.2, 0, pan);
          [988, 1319, 1760, 2349].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.2, 0.08 + i * 0.06, null, pan));
          break;
        case 'tunnel': // 吸いこまれる：ヒュウゥン
          this.tone(260, 0.45, 'sine', 0.45, 0, 1300, pan); this.burst(500, 1.5, 0.45, 1.6, 0, pan, 4000);
          break;
        case 'arrive': // 飛び出す：ポンッ
          this.tone(1300, 0.28, 'sine', 0.4, 0, 380, pan); this.burst(2400, 1.8, 0.2, 1.4, 0, pan, 600);
          break;
        case 'fail': this.tone(400, 0.55, 'sawtooth', 0.25, 0, 70); this.burst(300, 0.8, 0.4, 2.2); break;
        case 'clear': [523, 659, 784, 1046, 1319].forEach((f, i) => this.tone(f, 0.32, 'triangle', 0.2, i * 0.1)); break;
        case 'over': [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.2, i * 0.18)); break;
        case 'join': this.tone(660, 0.12, 'sine', 0.15); this.tone(990, 0.2, 'sine', 0.15, 0.1); break;
      }
    },
  };
  try { Snd.muted = localStorage.getItem('uraomote_mute') === '1'; } catch (e) { /* noop */ }
  if (params.get('mute') === '1') Snd.muted = true;

  // ---------- 傾きセンサー ----------
  // deviceorientation の角度から「画面の中での重力の向き」を計算する（iPhone / Android 共通の仕様）。
  // 端末に固定した座標（x右・y下）で、1 = 1G。
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  // 傾きの取り方は3通り。届いたものを使う（上ほど優先）：
  //   ① deviceorientation（向きの角度）
  //   ② devicemotion（加速度。重力込み）
  //   ③ GravitySensor / Accelerometer（Chrome の新しいセンサーの仕組み）
  // 受け取りはページを開いた時点で無条件に始める。許可の確認（requestPermission）は、
  // 機種を問わず「タップしたとき」にだけ呼び、その返事で受け取りを止めることはしない。
  const Sensor = {
    enabled: false, g: [0, 1], last: 0, got: false, src: '',
    hist: [], // 直近1秒の傾き（通信の遅れを考えて、相棒の値と比べるときに使う）
    t: { ori: 0, mot: 0, gen: 0 },
    diag: { oriN: 0, oriNull: 0, motN: 0, motNull: 0, gen: '—', perm: '—', permM: '—', pq: {} },
    feed(gx, gy, src) {
      const k = this.got ? 0.35 : 1;
      this.g[0] += (gx - this.g[0]) * k;
      this.g[1] += (gy - this.g[1]) * k;
      this.got = true; this.src = src;
      this.last = now();
      this.hist.push({ t: this.last, x: this.g[0], y: this.g[1] });
      while (this.hist.length && this.last - this.hist[0].t > 1000) this.hist.shift();
    },
    // 加速度（端末の座標・重力込み）→ 画面の中の重力の向き
    fromAcc(x, y, z, src) {
      const s = IOS && src === 'mot' ? -1 : 1; // iPhone の devicemotion は向きが逆
      const ax = x * s, ay = y * s, az = (z || 0) * s, m = Math.hypot(ax, ay, az);
      if (!(m > 3)) return; // 落下中・おかしな値
      this.feed(-ax / m, ay / m, src);
    },
    listen() {
      if (this.enabled) return;
      this.enabled = true;
      window.addEventListener('deviceorientation', (e) => {
        if (e.beta == null || e.gamma == null) { this.diag.oriNull++; return; }
        this.diag.oriN++;
        const b = e.beta * Math.PI / 180, gm = e.gamma * Math.PI / 180;
        this.t.ori = now();
        this.feed(Math.cos(b) * Math.sin(gm), Math.sin(b), 'ori');
      });
      window.addEventListener('devicemotion', (e) => {
        const a = e.accelerationIncludingGravity;
        if (!a || a.x == null || a.y == null) { this.diag.motNull++; return; }
        this.diag.motN++;
        this.t.mot = now();
        if (now() - this.t.ori < 500) return;
        this.fromAcc(a.x, a.y, a.z, 'mot');
      });
      this.startGeneric();
    },
    startGeneric() {
      if (this.gen) return;
      const C = window.GravitySensor || window.Accelerometer;
      if (!C) { this.diag.gen = '未対応'; return; }
      try {
        const s = new C({ frequency: 30 });
        s.addEventListener('reading', () => {
          this.t.gen = now();
          if (now() - this.t.ori < 500 || now() - this.t.mot < 500) return;
          this.fromAcc(s.x, s.y, s.z, 'gen');
        });
        s.addEventListener('error', (e) => { this.diag.gen = 'エラー：' + ((e.error && e.error.name) || '?'); this.gen = null; });
        s.start();
        this.gen = s;
        this.diag.gen = '起動';
      } catch (e) { this.diag.gen = 'エラー：' + e.name; }
    },
    // ブラウザの許可の状態を調べる（分かる機種だけ）
    async query() {
      if (!navigator.permissions || !navigator.permissions.query) return;
      for (const name of ['accelerometer', 'gyroscope', 'magnetometer']) {
        try { this.diag.pq[name] = (await navigator.permissions.query({ name })).state; } catch (e) { this.diag.pq[name] = '不明'; }
      }
    },
    // タップの中で呼ぶ：受け取りを始め、許可の確認があれば出す
    enable() {
      this.listen();
      const asks = [];
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          asks.push(DeviceOrientationEvent.requestPermission().then((r) => { this.diag.perm = r; return r; }, (e) => { this.diag.perm = 'エラー：' + e.name; return 'error'; }));
        }
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
          asks.push(DeviceMotionEvent.requestPermission().then((r) => { this.diag.permM = r; return r; }, (e) => { this.diag.permM = 'エラー：' + e.name; return 'error'; }));
        }
      } catch (e) { /* noop */ }
      if (this.diag.gen.startsWith('エラー')) { this.gen = null; this.startGeneric(); } // 許可のあとでやり直す
      this.query();
      return Promise.all(asks).then((rs) => rs.every((r) => r === 'granted'));
    },
    // 一度でも値が届けば「使える」。機種によっては動かしたときにしか値が届かないので、時間切れにはしない
    live() { return this.got; },
    // 今まさに値が届いているか（止まっていないか）
    fresh() { return this.got && now() - this.last < 600; },
    age() { return this.got ? Math.min(99999, Math.round(now() - this.last)) : 99999; },
  };

  // ---------- アプリ状態 ----------
  const App = {
    mode: null,        // 'solo' | 'host' | 'guest'
    mySides: [],
    connected: false,
    theta: 0,          // キー操作のときの束の回転（オモテから見て時計回りが正）
    partner: { k: 0, lean: false, s: false, g: [0, 1], t: 0, age: 99999 },
    lastRecv: 0, lastSend: 0,
    stageSel: 0,
    views: [],
  };
  const pageT = now(); // ページを開いた時刻（センサーが届かないと判断するまでの待ち時間に使う）
  const Input = { keyL: false, keyR: false, keyLean: false, btnL: false, btnR: false, btnLean: false };
  const localK = () => ((Input.keyR || Input.btnR) ? 1 : 0) - ((Input.keyL || Input.btnL) ? 1 : 0);
  const localLean = () => Input.keyLean || Input.btnLean;
  const mySide = () => (App.mode === 'guest' ? 'B' : 'A');
  const partnerSensor = () => App.mode !== 'solo' && App.partner.s && now() - App.partner.t < 1000;
  const partnerFresh = () => partnerSensor() && App.partner.age < 600;
  const thetaMode = () => !Sensor.live() && !partnerSensor();

  // 各面の画面の中での重力（背中合わせなので、裏の面は左右が反転する）
  // 2台は一体なので、どちらのセンサーを使っても同じ。自分のが止まっていたら相棒のを使う。
  function sideGravity(side) {
    const my = mySide();
    const own = () => { const g = Sensor.g; return side === my ? [g[0], g[1]] : [-g[0], g[1]]; };
    const par = () => { const g = App.partner.g; return side === my ? [-g[0], g[1]] : [g[0], g[1]]; };
    if (Sensor.fresh()) return own();
    if (partnerFresh()) return par();
    if (Sensor.live()) return own();
    if (partnerSensor()) return par();
    const m = (localLean() || (App.mode !== 'solo' && App.partner.lean)) ? LEAN : 1;
    const gx = Math.sin(App.theta) * m, gy = Math.cos(App.theta) * m;
    return side === 'A' ? [gx, gy] : [-gx, gy];
  }

  // ---------- 画面切り替え ----------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (id === 'scr-play') { requestAnimationFrame(fit); setTimeout(fit, 60); }
  }
  let toastTimer = 0;
  function toast(msg, ms = 2000) {
    const el = $('toast');
    el.innerHTML = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------- ゲーム ----------
  // 計算は「オモテ（ホスト）」か「ひとりで試す」の端末だけがまとめて行う。ウラは届いた位置を表示する。
  // （玉が複数・敵が両面を行き来するので、1台がまとめて計算したほうが食い違わない）
  let G = null;
  const PH = window.URA_PHYS;
  const mirrorRect = PH.mirrorRect;
  const mirrorPt = (p) => ({ ...p, x: W - p.x });
  const auth = () => App.mode === 'solo' || App.mode === 'host';

  // パターンを左右反転したもの（両方の面をそろって反転するので、背中合わせの対応は崩れない）
  function mirrorPattern(P) {
    const face = (F) => ({ walls: (F.walls || []).map(mirrorRect), slopes: (F.slopes || []).map((q) => [W - q[0], q[1], W - q[2], q[3]]), danger: (F.danger || []).map(mirrorRect) });
    return {
      start: P.start && mirrorPt(P.start), goal: mirrorPt(P.goal),
      balls: P.balls && P.balls.map(mirrorPt),
      enemies: P.enemies && P.enemies.map(mirrorPt),
      tunnels: (P.tunnels || []).map(mirrorPt),
      hearts: (P.hearts || []).map(mirrorPt),
      testDraws: P.testDraws && P.testDraws.map((d) => ({ face: d.face, seg: [W - d.seg[0], d.seg[1], W - d.seg[2], d.seg[3]] })),
      A: face(P.A || {}), B: face(P.B || {}),
    };
  }
  // ステージの全パターン（mirror: true なら左右反転版も加える）
  function patternsOf(L) {
    const base = L.patterns || [];
    return L.mirror ? [...base, ...base.map(mirrorPattern)] : base;
  }

  // ---------- スコアアタック ----------
  // ライフ3つで何階まで行けるか。階ごとにその場で迷路を作る（難しさレベル = 5 + 階）。
  const RUN_LIVES = 3, RUN_MAX_LIVES = 5;
  const levelFor = (floor) => 5 + floor;
  const loadBest = () => { try { return JSON.parse(localStorage.getItem('uraomote_best') || 'null'); } catch (e) { return null; } };
  const saveBest = (b) => { try { localStorage.setItem('uraomote_best', JSON.stringify(b)); } catch (e) { /* noop */ } };
  const bestText = () => { const b = loadBest(); return b ? `自己ベスト：${b.floors}階クリア（${fmtTime(b.time)}）` : '自己ベスト：まだ記録なし'; };

  // 迷路づくり（重いので、できれば裏の別スレッドで。今の階を遊んでいる間に次の階を作っておく）
  const GenSvc = {
    worker: null, seq: 0, waits: new Map(), next: null,
    init() {
      if (this.worker !== null) return;
      try {
        this.worker = new Worker('genworker.js?v=6');
        this.worker.onmessage = (e) => { const f = this.waits.get(e.data.id); if (f) { this.waits.delete(e.data.id); f(e.data.r); } };
        this.worker.onerror = () => { this.worker = false; for (const f of this.waits.values()) f(null); this.waits.clear(); };
      } catch (e) { this.worker = false; }
    },
    make(level) {
      this.init();
      const seed = Math.floor(Math.random() * 0xffffffff);
      if (this.worker) {
        const id = ++this.seq;
        return new Promise((res) => { this.waits.set(id, (r) => res(r || this.makeHere(level, seed))); this.worker.postMessage({ id, level, seed }); });
      }
      return new Promise((res) => setTimeout(() => res(this.makeHere(level, seed)), 30));
    },
    makeHere(level, seed) {
      const r = window.URA_GEN.make(level, seed);
      return r && { pattern: r.pattern, hint: r.hint, plan: r.plan, actions: r.actions, step: r.step, draws: r.draws, needDraw: r.needDraw, level: r.level };
    },
    prefetch(floor) { this.next = { floor, p: this.make(levelFor(floor)) }; },
    get(floor) {
      if (this.next && this.next.floor === floor) { const p = this.next.p; this.next = null; return p; }
      return this.make(levelFor(floor));
    },
  };

  // st = { idx（チュートリアルの番号。自動生成なら -1）, p（パターン番号）, gen（自動生成の中身）, run（スコアアタックの状態） }
  function startStage(st) {
    const gen = st.gen || null;
    const L = gen ? { name: '自動生成', hint: gen.hint } : LEVELS[st.idx];
    const pats = gen ? [gen.pattern] : patternsOf(L);
    const pi = Math.min(pats.length - 1, Math.max(0, st.p | 0));
    const P = pats[pi];
    if (!gen) App.stageSel = st.idx;
    const run = st.run ? { floor: st.run.floor | 0 || 1, lives: st.run.lives | 0, time: +st.run.time || 0, taken: (st.run.taken || []).slice() } : null;
    const world = PH.makeWorld(P, { hearts: !!run, takenHearts: run ? run.taken : [] });
    G = {
      st: { idx: st.idx, p: pi, gen, run: st.run || null },
      idx: st.idx, L, P, run, world,
      // 以前の名前でも使えるように（描画・テスト用）
      sides: world.faces, goal: world.goal, lines: world.lines, hearts: world.hearts,
      get ball() { return world.objs.find((o) => o.kind === 'ball' && !o.goaled) || world.objs[0]; },
      collected: new Set(), total: 0,
      phase: 'count', count: 3, t0: 0, elapsed: 0, misses: 0,
      busy: 0, after: null, flash: null, lastBump: 0, warpCount: 0, lastState: 0,
    };
    App.theta = 0;
    Draw.cancel();
    $('syncwait').classList.add('hidden');
    $('toast').classList.remove('show');
    $('result').classList.add('hidden');
    $('menu').classList.add('hidden');
    $('hud-name').textContent = run ? `🏆 ${run.floor}階` : `${st.idx + 1}. ${L.name}`;
    $('hud-life').classList.toggle('hidden', !run);
    $('hud-miss-wrap').classList.toggle('hidden', !!run);
    buildViews();
    showScreen('scr-play');
    wakeLock();
    Snd.play('count');
    showCount('3');
    // スコアアタック中は、次の階を今のうちに作っておく
    if (run && App.mode !== 'guest') GenSvc.prefetch(run.floor + 1);
  }

  function send(m) { if (App.mode !== 'solo') Link.send(m); }
  const ballsOn = (side) => G.world.objs.filter((o) => o.kind === 'ball' && o.side === side && !o.goaled).length;

  function update(dt) {
    if (App.mode !== 'solo' && !Link.open) return; // 通信が切れている間は一時停止
    if (G.phase === 'count') {
      const prev = Math.ceil(G.count);
      G.count -= dt;
      const c = Math.ceil(G.count);
      if (G.count <= 0) {
        G.phase = 'play'; G.t0 = now() - (G.resumeElapsed || 0) * 1000;
        Snd.play('go'); showCount('GO!', 600);
        if (App.mode !== 'solo') {
          const n = ballsOn(mySide()), all = G.world.objs.filter((o) => o.kind === 'ball').length;
          toast(n ? `玉${all > 1 ? `${n}つ` : ''}があなたの画面にあります${all > n ? '（相棒の画面にも！）' : ''}` : '玉は相棒の画面。赤い危険地帯を教えてあげて！');
        }
      } else if (c !== prev) { Snd.play('count'); showCount(String(c)); }
      return;
    }
    if (G.phase !== 'play') return;
    if (G.paused) return; // 注意ポップアップ中は止める（タイマーも止まる）
    G.elapsed = (now() - G.t0) / 1000;
    if (G.busy > 0) {
      G.busy -= dt;
      if (G.busy <= 0 && G.after) { const f = G.after; G.after = null; f(); }
      return;
    }
    if (!auth()) return; // ウラは、オモテから届く位置を表示するだけ
    if (checkSync(dt)) return;
    const ev = [];
    PH.step(G.world, sideGravity, dt, ev);
    handleEvents(ev);
    sendState(false);
  }

  // 計算した結果をウラへ送る（1秒に30回くらい）
  function sendState(force) {
    if (App.mode !== 'host' || !Link.open) return;
    const t = now();
    if (!force && t - G.lastState < 33) return;
    G.lastState = t;
    Link.send({
      t: 'st',
      o: G.world.objs.map((o) => [o.id, o.side, Math.round(o.x), Math.round(o.y), (o.goaled ? 1 : 0) | (o.dead ? 2 : 0) | (o.warpT > 0 ? 4 : 0) | (o.contact ? 8 : 0), Math.round(Math.hypot(o.vx, o.vy))]),
      h: Math.round(G.world.hold * 100) / 100,
    });
  }
  function applyState(m) {
    if (!G || !Array.isArray(m.o)) return;
    for (const a of m.o) {
      const o = G.world.objs.find((x) => x.id === a[0]);
      if (!o) continue;
      o.side = a[1]; o.x = a[2]; o.y = a[3];
      o.goaled = !!(a[4] & 1); o.dead = !!(a[4] & 2); o.warpT = a[4] & 4 ? 1 : 0;
      o.hidden = !!(a[4] & 7);
      o.contact = !!(a[4] & 8); o.spd = +a[5] || 0; o.spdT = now(); // 転がる音用
    }
    G.world.hold = +m.h || 0;
  }

  // 起きたことの音・表示（計算している端末で呼ぶ。ウラへは fx / fail などで知らせる）
  function handleEvents(ev) {
    for (const e of ev) {
      const o = e.o;
      switch (e.type) {
        case 'bump': case 'clack': hitSound(e); break;
        case 'warpIn':
          if (o.kind === 'ball') G.warpCount++;
          G.flash = { side: e.side, x: e.x, y: e.y, t: now(), type: 'tunnel' };
          fx({ k: 'warpIn', kind: o.kind, side: e.side, x: e.x, y: e.y });
          break;
        case 'warp': fx({ k: 'warp', kind: o.kind, side: o.side }); break;
        case 'goal': fx({ k: 'goal', side: o.side, left: G.world.objs.filter((b) => b.kind === 'ball' && !b.goaled).length }); break;
        case 'clear': clearStage(); return;
        case 'heart': gotHeart(e.h.id, true); break;
        case 'fail': failed(o, e.reason, e.rect); return;
      }
    }
  }

  // ぶつかる音（オモテで計算 → 玉がある面の端末で鳴らす）
  function hitSound(e) {
    const o = e.o, t = now();
    if (t - (o._hitT || 0) < 45) return; // 同じものが細かく何度も当たったときは間引く
    o._hitT = t;
    const m = { k: e.type, s: o.side, x: Math.round(o.x), v: Math.round(e.v || 0), m: e.mat || 'wall', kd: o.kind };
    if (App.mode === 'solo' || App.mySides.includes(o.side)) playHit(m);
    else send({ t: 'snd', ...m });
  }
  function playHit(m) {
    const pan = panOf(m.s, m.x);
    if (m.k === 'clack') Snd.clack(m.v, pan); else Snd.hit(m.v, m.m, m.kd, pan);
    if (m.v > 520 && m.kd === 'ball') vib(12); // 強くぶつかったときは手にも伝える
  }
  // 音を左右どちらから出すか：ひとりで試すときは オモテ=左・ウラ=右。さらに画面の中の左右の位置で少し振る
  function panOf(side, x) {
    const base = App.mode === 'solo' ? (side === 'A' ? -0.45 : 0.45) : 0;
    return base + ((x || W / 2) / W - 0.5) * 0.5;
  }
  // 転がる音：自分の面にあるものだけ（毎フレーム）
  function rollSound() {
    if (!Snd.ctx) return;
    const list = [];
    if (G && G.phase === 'play' && !G.paused && $('scr-play').classList.contains('active') && (App.mode === 'solo' || Link.open)) {
      const t = now();
      for (const o of G.world.objs) {
        if (o.hidden || !(App.mode === 'solo' || App.mySides.includes(o.side))) continue;
        const spd = auth() ? Math.hypot(o.vx, o.vy) : (t - (o.spdT || 0) < 250 ? o.spd || 0 : 0);
        list.push({ id: o.id, kind: o.kind, spd, on: !!o.contact, pan: panOf(o.side, o.x) });
      }
    }
    Snd.roll(list);
  }

  // 効果音とお知らせ（自分の面で起きたことかどうかで言い方を変える）
  function fx(f, remote) {
    if (!remote) send({ t: 'fx', ...f });
    const mine = App.mode === 'solo' || App.mySides.includes(f.side);
    const solo = App.mode === 'solo';
    const what = f.kind === 'enemy' ? '👾 敵' : '玉';
    if (f.k === 'warpIn') {
      if (remote) G.flash = { side: f.side, x: f.x, y: f.y, t: now(), type: 'tunnel' };
      if (mine) { Snd.play('tunnel', panOf(f.side, f.x)); vib(40); }
      if (!solo && mine) toast(f.kind === 'enemy' ? '👾 敵を相棒の画面に送った！' : '玉は相棒の画面へ！ 赤い危険地帯を教えてあげて');
    } else if (f.k === 'warp') {
      if (mine) Snd.play('arrive', panOf(f.side, W / 2));
      if (!solo && mine) toast(`${what}がこっちに来た！`);
      if (solo) toast(`${what}がワープを抜けて${SIDE[f.side].name}へ`);
    } else if (f.k === 'goal') {
      if (mine) { Snd.play('goal', panOf(f.side, W / 2)); vib(30); }
      if (f.left > 0) toast(`ゴール！ あと ${f.left} つ`);
    }
  }

  // ハート：ライフ +1（最大 RUN_MAX_LIVES）
  function gotHeart(id, local, lives) {
    if (!G.run) return;
    const h = G.world.hearts.find((x) => x.id === id);
    if (h) h.got = true;
    if (!G.run.taken.includes(id)) G.run.taken.push(id);
    G.run.lives = local ? Math.min(RUN_MAX_LIVES, G.run.lives + 1) : (typeof lives === 'number' ? lives : G.run.lives);
    Snd.play('star'); vib(40);
    toast(`♥ ライフ +1（${G.run.lives}）`);
    if (local) send({ t: 'heart', id, lives: G.run.lives });
  }

  // 玉がアウトになった（危険地帯・敵）
  function failed(o, reason, rect) {
    G.misses++;
    if (G.run) G.run.lives = Math.max(0, G.run.lives - 1);
    G.flash = { side: o.side, x: o.x, y: o.y, t: now(), type: 'fail' };
    // 見えない危険地帯の場所は教えない（口で伝え合うのがこのゲームの楽しさ）
    const visible = rect && G.world.faces[o.side].seen.some((r) => r.join() === rect.join());
    failToast(reason, visible, o.side);
    send({ t: 'fail', side: o.side, x: o.x, y: o.y, misses: G.misses, reason, visible: !!visible, lives: G.run ? G.run.lives : null });
    Snd.play('fail'); vib(250);
    G.busy = 0.9;
    if (G.run && G.run.lives <= 0) { G.after = () => runOver(true); return; }
    G.after = () => { PH.respawn(G.world, o); sendState(true); };
  }
  function failToast(reason, visible, side) {
    const mine = App.mode === 'solo' || App.mySides.includes(side);
    const life = G.run ? `（ライフ −1 → 残り ${G.run.lives}）` : '';
    let msg;
    if (reason === 'enemy') msg = mine ? '👾 敵にぶつかった！' : '👾 相棒側で敵にぶつかった！';
    else if (!mine) msg = '💥 相棒側で危険地帯に触れた！';
    else msg = visible ? '💥 危険地帯に触れた！' : '💥 見えない危険地帯に触れた！';
    toast(msg + life + (G.world.objs.some((x) => x.kind === 'enemy') ? '　敵も元の場所へ' : ''), 2800);
  }

  // 自分の傾きと、相棒の傾き（自分の面に直したもの）の角度の差。比べられないときは null。
  // 相棒の値は通信で少し遅れて届くので、自分の「少し前の値」とも比べて、一番近いものを使う。
  function syncDiff() {
    if (App.mode === 'solo' || params.get('nosync') === '1') return null;
    if (!Sensor.live() || !partnerSensor()) return null; // 片方にセンサーがない（PC など）ときはチェックしない
    const p = App.partner.g;
    const pm = [-p[0], p[1]];
    if (Math.hypot(pm[0], pm[1]) < 0.5) return null; // 寝かせすぎで向きが不安定
    const pa = Math.atan2(pm[1], pm[0]);
    const angle = (x, y) => { const d = Math.atan2(y, x) - pa; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); };
    let best = Math.hypot(Sensor.g[0], Sensor.g[1]) < 0.5 ? null : angle(Sensor.g[0], Sensor.g[1]);
    const lag = SYNC_LAG_MS + App.partner.age;
    for (const h of Sensor.hist) {
      if (now() - h.t > lag || Math.hypot(h.x, h.y) < 0.5) continue;
      const d = angle(h.x, h.y);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  // 傾きのずれ・センサーの停止を見張る（計算している端末だけが判定して、相棒にも知らせる）
  function checkSync(dt) {
    if (App.mode === 'solo' || G.syncMute || G.world.hold > 0) return false;
    const mineStopped = Sensor.got && Sensor.age() > 2000 && partnerFresh();
    const theirsStopped = partnerSensor() && App.partner.age > 2000 && Sensor.fresh();
    if (mineStopped || theirsStopped) {
      G.stallT = (G.stallT || 0) + dt;
      if (G.stallT > 0.5) { G.stallT = 0; pauseGame('sensor', mineStopped ? mySide() : other(mySide())); return true; }
    } else G.stallT = 0;
    const sd = syncDiff();
    if (sd !== null && sd > SYNC_LIMIT) {
      G.desyncT = (G.desyncT || 0) + dt;
      if (G.desyncT >= SYNC_TIME) { G.desyncT = 0; pauseGame('desync'); return true; }
    } else G.desyncT = 0;
    return false;
  }

  function pauseGame(reason, who, remote) {
    if (!G || G.paused) return;
    G.paused = { reason, who, since: now() };
    for (const o of G.world.objs) { o.vx = 0; o.vy = 0; }
    Snd.play('fail'); vib([80, 60, 80]);
    if (!remote) send({ t: 'pause', reason, who });
    const title = reason === 'sensor' ? '傾きセンサーが反応していません' : '2台の傾きがずれています';
    const text = reason === 'sensor'
      ? `${who === mySide() ? 'あなた' : '相棒'}のスマホの傾きセンサーが止まっているようです。画面を一度さわる・少し振る・ブラウザを開き直す、などを試してください。`
      : 'スマホを背中合わせにぴったり合わせて、2人で同じように持ってください。そろったら「OK」で再開します（ペナルティはありません）。';
    $('sw-title').textContent = title;
    $('sw-text').textContent = text;
    $('syncwait').classList.remove('hidden');
  }

  function resumeGame(remote, mute) {
    if (!G || !G.paused) return;
    if (mute) G.syncMute = true; // 「気にせず続ける」：このステージではもうチェックしない
    const pausedFor = now() - G.paused.since;
    G.paused = null;
    if (G.phase === 'play') G.t0 += pausedFor;
    G.desyncT = 0; G.stallT = 0;
    G.world.hold = Math.max(G.world.hold || 0, 0.8);
    $('syncwait').classList.add('hidden');
    if (!remote) send({ t: 'resume', mute: !!mute });
    toast('再開！');
  }

  // ポップアップの「今そろっているか」の表示（毎フレーム）
  function updateSyncWait() {
    if (!G || !G.paused) return;
    const sd = syncDiff();
    let ok, msg;
    if (G.paused.reason === 'sensor') {
      ok = Sensor.got ? (Sensor.age() < 600 && (!partnerSensor() || App.partner.age < 600)) : true;
      msg = ok ? '✅ 2台ともセンサーが動いています' : '⏳ センサーの反応を待っています…';
    } else {
      ok = sd === null || sd < SYNC_OK;
      msg = sd === null ? '（比べられません）' : `ずれ ${Math.round((sd * 180) / Math.PI)}° ${ok ? '✅ そろっています' : '… もう少し'}`;
    }
    $('sw-status').textContent = msg;
    $('sw-ok').disabled = !ok;
  }

  function clearStage() {
    const res = { time: G.elapsed, misses: G.misses };
    sendState(true);
    send({ t: 'clear', ...res });
    showResult(res);
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
  }

  function showResult(res, resumed) {
    if (G.phase === 'clear') return;
    G.phase = 'clear';
    G.elapsed = res.time;
    Snd.play('clear'); vib([60, 40, 120]);
    const leader = App.mode !== 'guest';
    if (G.run) {
      if (!resumed) G.run.time += res.time; // 再接続の復元では足さない（もう足してある）
      $('rs-title').textContent = `🏆 ${G.run.floor}階クリア！`;
      $('rs-rank').innerHTML = lifeHtml(G.run.lives);
      $('rs-detail').innerHTML = `この階 ${fmtTime(res.time)}　／　合計 ${fmtTime(G.run.time)}`;
      $('rs-next').textContent = `${G.run.floor + 1}階へ ▶`;
      $('rs-retry').classList.add('hidden');
      $('rs-lobby').textContent = 'あきらめてロビーへ';
    } else {
      const stars = res.misses === 0 ? 3 : res.misses <= 2 ? 2 : 1;
      $('rs-title').textContent = 'ステージクリア！';
      $('rs-rank').textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
      $('rs-detail').innerHTML = `タイム ${fmtTime(res.time)}　／　ミス ${res.misses}回`;
      $('rs-next').textContent = G.idx < LEVELS.length - 1 ? '次のステージへ' : '🏆 スコアアタックに挑戦！';
      $('rs-retry').classList.remove('hidden');
      $('rs-lobby').textContent = 'ステージ選択へ';
    }
    $('rs-next').disabled = false;
    $('rs-next').classList.remove('hidden');
    $('rs-host').classList.toggle('hidden', !leader);
    $('rs-wait').classList.toggle('hidden', leader);
    $('result').classList.remove('hidden');
  }

  const lifeHtml = (n) => { let s = ''; for (let i = 0; i < Math.max(RUN_LIVES, n); i++) s += i < n ? '♥' : '<span class="off">♥</span>'; return `<span class="life-big">${s}</span>`; };

  // ライフが0になった（スコアアタック終了）
  function runOver(local) {
    if (!G || !G.run || G.phase === 'over') return;
    if (local) send({ t: 'over' });
    G.phase = 'over';
    G.busy = 0; G.after = null;
    Snd.play('over'); vib([200, 80, 200]);
    const floors = G.run.floor - 1;
    const time = G.run.time + G.elapsed;
    const best = loadBest();
    const isNew = !best || floors > best.floors || (floors === best.floors && time < best.time);
    if (isNew && floors > 0) saveBest({ floors, time, at: Date.now() });
    $('rs-title').textContent = 'ゲームオーバー';
    $('rs-rank').innerHTML = `<span class="score">${floors}階クリア</span>`;
    $('rs-detail').innerHTML = `${G.run.floor}階でライフが尽きた（合計 ${fmtTime(time)}）<br>${isNew && floors > 0 ? '🎉 自己ベスト更新！' : bestText()}`;
    $('rs-next').textContent = 'もう一度挑戦';
    $('rs-next').disabled = false;
    $('rs-retry').classList.add('hidden');
    $('rs-lobby').textContent = 'ロビーへ';
    const leader = App.mode !== 'guest';
    $('rs-host').classList.toggle('hidden', !leader);
    $('rs-wait').classList.toggle('hidden', leader);
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
  function leaderStart(st) {
    send({ t: 'start', st });
    startStage(st);
  }
  function leaderTutorial(idx) {
    leaderStart({ idx, p: Math.floor(Math.random() * patternsOf(LEVELS[idx]).length) });
  }
  // スコアアタックの floor 階を始める（迷路ができるまで少し待つことがある）
  let genBusy = false;
  async function leaderFloor(run) {
    if (genBusy) return;
    genBusy = true;
    $('rs-next').disabled = true;
    const t = setTimeout(() => toast('🛠 迷路を作っています…', 3000), 250);
    const gen = await GenSvc.get(run.floor);
    clearTimeout(t);
    genBusy = false;
    if (!gen) { toast('迷路を作れませんでした。もう一度押してください'); $('rs-next').disabled = false; return; }
    leaderStart({ idx: -1, p: 0, gen, run });
  }
  function leaderStartRun() { leaderFloor({ floor: 1, lives: RUN_LIVES, time: 0, taken: [] }); }
  // 次へ（チュートリアルなら次のステージ、スコアアタックなら次の階）
  function leaderNext() {
    if (!G) return;
    if (G.run && G.phase === 'over') return leaderStartRun();
    if (G.run) return leaderFloor({ floor: G.run.floor + 1, lives: G.run.lives, time: G.run.time, taken: [] });
    if (G.idx >= LEVELS.length - 1) return leaderStartRun();
    leaderTutorial(G.idx + 1);
  }
  // 最初からやり直す（同じ形のまま。スコアアタックならライフ・取ったハートはそのまま）
  function leaderRestart() {
    if (!G || G.phase === 'over') return;
    leaderStart({ ...G.st, run: G.run ? { ...G.run, taken: G.run.taken.slice() } : null });
  }
  function requestRestart() {
    if (!G) return;
    if (!confirm('このステージを最初からやり直しますか？')) return;
    if (App.mode === 'guest') { send({ t: 'restartReq' }); toast('やり直しをお願いしました'); }
    else leaderRestart();
  }
  function leaderLobby() {
    send({ t: 'lobby' });
    goLobby();
  }

  // ---------- 受信 ----------
  function onMsg(m) {
    App.lastRecv = now();
    switch (m.t) {
      case 'hello': renderLobby(); break;
      case 'in':
        App.partner = { k: m.k | 0, lean: !!m.lean, s: !!m.s, g: Array.isArray(m.g) ? m.g : [0, 1], t: now(), age: typeof m.age === 'number' ? m.age : 0 };
        if (App.mode === 'guest' && typeof m.th === 'number') App.theta = m.th;
        break;
      case 'start': if (App.mode === 'guest' && m.st) startStage(m.st); break;
      case 'sync': if (App.mode === 'guest') resumeStage(m); break;
      case 'st': if (App.mode === 'guest') applyState(m); break;
      case 'fx': if (G && App.mode === 'guest') fx(m, true); break;
      case 'snd': if (G && App.mySides.includes(m.s)) playHit(m); break;
      case 'line':
        if (!G || (m.face !== 'A' && m.face !== 'B')) break;
        if (m.seg === null) { // 相棒が消しゴムで消した
          G.world.lines[m.face] = null;
          if (App.mySides.includes(m.face)) toast('相棒が床を消した');
          break;
        }
        if (!Array.isArray(m.seg) || !m.seg.slice(0, 4).every((n) => Number.isFinite(Number(n)))) break;
        const mineGone = !!G.world.lines[other(mySide())]; // 自分が描いていた床
        G.world.lines.A = null; G.world.lines.B = null; // ペンは2人で1本：前の床は消える
        G.world.lines[m.face] = m.seg.slice(0, 4).map(Number);
        if (App.mySides.includes(m.face)) { Snd.play('tap'); vib(30); toast('相棒があなたの画面に床を描いた！' + (mineGone ? '（あなたの床は消えた）' : '')); }
        break;
      case 'restartReq': if (App.mode === 'host' && G) leaderRestart(); break;
      case 'pause': if (G) pauseGame(m.reason, m.who, true); break;
      case 'resume': if (G) resumeGame(true, !!m.mute); break;
      case 'lobby': if (App.mode === 'guest') goLobby(); break;
      case 'fail':
        if (!G) break;
        G.misses = m.misses;
        G.flash = { side: m.side, x: m.x, y: m.y, t: now(), type: 'fail' };
        if (G.run && typeof m.lives === 'number') G.run.lives = m.lives;
        Snd.play('fail'); vib(250);
        failToast(m.reason, m.visible, m.side);
        break;
      case 'clear': if (G) showResult(m); break;
      case 'over': if (G) runOver(false); break;
      case 'heart': if (G) gotHeart(m.id, false, m.lives); break;
    }
  }

  // ---------- 送信（入力の共有） ----------
  function netTick(t) {
    if (App.mode === 'solo' || !Link.open) return;
    if (t - App.lastSend < 50) return;
    App.lastSend = t;
    const m = { t: 'in', k: localK(), lean: localLean(), s: Sensor.live(), age: Sensor.age(), g: [+Sensor.g[0].toFixed(3), +Sensor.g[1].toFixed(3)] };
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
      const v = { side, el, box: el.querySelector('.vbox'), wrap: el.querySelector('.vwrap'), canvas, ctx: canvas.getContext('2d'), label: el.querySelector('.vlabel'), w: 0, h: 0, scale: 1, lastLabel: '', rot: 0, k: 1 };
      Draw.attach(v);
      return v;
    });
  }

  // ---------- 床を描く ----------
  // 自分の画面を指でなぞると、真裏の相棒の面に「床」が出る（自分の面には出ない）。
  // ペンは2人で1本（どちらかが描くと、前の床は消える）。長さは stage.draw.maxLen まで。
  const Draw = {
    active: null, // { view, x0, y0, x1, y1, id }（描いている面の座標）
    cancel() { this.active = null; },
    // どのステージでも描ける（ステージ5からは「描かないと渡れない」だけ）
    enabled() { return !!(G && G.phase === 'play' && !G.paused); },
    maxLen() { return (G && G.L.draw && G.L.draw.maxLen) || 150; },
    toWorld(v, cx, cy) {
      const r = v.wrap.getBoundingClientRect();
      const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
      const c = Math.cos(-v.rot), s = Math.sin(-v.rot);
      const lx = (dx * c - dy * s) / v.k, ly = (dx * s + dy * c) / v.k;
      return { x: clamp((lx + v.w / 2) * (W / v.w), WALL, W - WALL), y: clamp((ly + v.h / 2) * (H / v.h), WALL, H - WALL) };
    },
    attach(v) {
      const cv = v.canvas;
      cv.addEventListener('pointerdown', (e) => {
        if (!this.enabled()) return;
        if (!v.w) fit();
        e.preventDefault();
        const p = this.toWorld(v, e.clientX, e.clientY);
        this.active = { view: v, x0: p.x, y0: p.y, x1: p.x, y1: p.y, id: e.pointerId };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      });
      cv.addEventListener('pointermove', (e) => {
        const a = this.active;
        if (!a || a.view !== v || a.id !== e.pointerId) return;
        const p = this.toWorld(v, e.clientX, e.clientY);
        let dx = p.x - a.x0, dy = p.y - a.y0;
        const len = Math.hypot(dx, dy), max = this.maxLen();
        if (len > max) { dx *= max / len; dy *= max / len; }
        a.x1 = a.x0 + dx; a.y1 = a.y0 + dy;
      });
      const finish = (e) => {
        const a = this.active;
        if (!a || a.view !== v || a.id !== e.pointerId) return;
        this.active = null;
        if (!this.enabled() || Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 24) return; // 短すぎる線は無視（タップ）
        // 真裏の相棒の面に出す（左右反転）
        const face = other(v.side);
        const seg = [W - a.x0, a.y0, W - a.x1, a.y1].map((n) => Math.round(n));
        if (!seg.every(Number.isFinite)) return;
        const had = G.lines.A || G.lines.B;
        G.lines.A = null; G.lines.B = null; // ペンは2人で1本：前の床（自分のでも相棒のでも）は消える
        G.lines[face] = seg;
        send({ t: 'line', face, seg });
        Snd.play('tap'); vib(20);
        toast((App.mode === 'solo' ? `${SIDE[face].name}に床を出した` : '相棒の画面に床を出した！') + (had ? '（ペンは2人で1本：前の床は消えた）' : ''));
      };
      cv.addEventListener('pointerup', finish);
      cv.addEventListener('pointercancel', () => { if (this.active && this.active.view === v) this.active = null; });
    },
  };

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
    App.stageRot = (-ang * Math.PI) / 180;

    $('pad').classList.toggle('hidden', !thetaMode());
    // 盤面に使える広さは、上部バー・ボタン・システムのバーをよけた残り（実際のレイアウトから測る）
    const n = App.views.length;
    for (const v of App.views) { v.box.style.width = '0px'; v.box.style.height = '0px'; }
    const vr = $('views');
    const availW = vr.clientWidth - 12 - (n - 1) * 10;
    const availH = vr.clientHeight - 12 - 30; // 30 は下の「玉はここ」の表示
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
        v.rot = th + (App.stageRot || 0); v.k = k;
      } else {
        if (v.wrap.style.transform) v.wrap.style.transform = '';
        v.rot = App.stageRot || 0; v.k = 1;
      }
      drawView(v);
      const nb = ballsOn(v.side), multi = G.world.objs.filter((o) => o.kind === 'ball').length > 1;
      const ne = G.world.objs.filter((o) => o.kind === 'enemy' && o.side === v.side && !o.hidden).length;
      const lbl = `${SIDE[v.side].name}${App.mode === 'solo' ? '' : '（あなた）'}` +
        (nb ? `<span class="here">● 玉${multi ? ` ×${nb}` : 'はここ'}</span>` : '<span class="away">◌ 玉は向こう側</span>') +
        (ne ? `<span class="enemy-tag">👾×${ne}</span>` : '');
      if (lbl !== v.lastLabel) { v.label.innerHTML = lbl; v.lastLabel = lbl; }
    }
    updateSyncWait();
    const hasMine = App.mode === 'solo' ? !!(G.lines.A || G.lines.B) : !!G.lines[other(mySide())];
    $('hud-erase').classList.toggle('hidden', !hasMine);
    $('hud-time').textContent = fmtTime(G.phase === 'count' ? 0 : G.elapsed);
    if (G.run) {
      let hs = '';
      for (let i = 0; i < Math.max(RUN_LIVES, G.run.lives); i++) hs += i < G.run.lives ? '♥' : '<span class="off">♥</span>';
      if ($('hud-life').dataset.v !== hs) { $('hud-life').innerHTML = hs; $('hud-life').dataset.v = hs; }
    }
    $('hud-miss').textContent = G.misses;
    const lag = App.mode !== 'solo' && Link.open && now() - App.lastRecv > 4000;
    const sd = syncDiff();
    const net = App.mode !== 'solo' && !Link.open ? '再接続中…' : lag ? '通信待ち…' : '';
    const sync = sd === null ? '' : sd > SYNC_LIMIT ? '⚠ 傾きがずれてる！' : '🤝';
    const hn = $('hud-net');
    hn.textContent = net || sync;
    hn.classList.toggle('ok', !net && sync === '🤝');
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
    ctx.beginPath();
    for (const q of P.slopes || []) { ctx.moveTo(W - q[0], q[1]); ctx.lineTo(W - q[2], q[3]); }
    ctx.stroke();
    ctx.restore();

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
    for (const q of S.slopes || []) drawSlope(ctx, q, C);

    // 自分にだけ見える危険地帯（自分の面でも、真裏の相棒の面でも触れたらアウト）。
    // 壁より手前に描く：自分の面では壁の中でも、真裏の相棒の面では通り道かもしれないので
    drawTraps(ctx, S.seen, t);

    // 描いた床
    ctx.save();
    ctx.lineCap = 'round';
    const mine = G.lines[side]; // 相棒が描いて、この面に出ている床
    if (mine) {
      ctx.shadowColor = '#fff3b0'; ctx.shadowBlur = 10;
      ctx.strokeStyle = '#ffe9a0'; ctx.lineWidth = LINE_R * 2;
      ctx.beginPath(); ctx.moveTo(mine[0], mine[1]); ctx.lineTo(mine[2], mine[3]); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    const given = G.lines[other(side)]; // 自分が描いて、相棒の面に出ている床（自分の画面ではうすく表示）
    if (given && App.mySides.length === 1) {
      ctx.strokeStyle = 'rgba(255,233,160,0.45)'; ctx.lineWidth = 3; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.moveTo(W - given[0], given[1]); ctx.lineTo(W - given[2], given[3]); ctx.stroke();
      ctx.setLineDash([]);
    }
    const a = Draw.active;
    if (a && a.view === v) { // 描いている途中
      ctx.strokeStyle = 'rgba(255,233,160,0.9)'; ctx.lineWidth = 4; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(a.x0, a.y0); ctx.lineTo(a.x1, a.y1); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // 玉と敵（この面にいるものだけ）
    for (const o of G.world.objs) {
      if (o.side !== side || o.hidden) continue;
      if (o.kind === 'enemy') { drawEnemy(ctx, o, side); continue; }
      drawBall(ctx, o.x, o.y);
      if (G.world.hold > 0) { // 復活待ちのリング
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(o.x, o.y, R + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, G.world.hold / PH.RESPAWN_HOLD)); ctx.stroke();
      }
    }

    // ハート
    for (const h of G.hearts) if (!h.got && h.side === side) drawHeart(ctx, h.x, h.y, t);

    // エフェクト（玉がある面だけ。見えない危険地帯の場所は相手の画面にも出さない）
    const f = G.flash;
    if (f) {
      const age = (now() - f.t) / 1000;
      if (age > 1.2) G.flash = null;
      else if (f.side === side) {
        const col = f.type === 'fail' ? '255,77,94' : '190,140,255';
        ctx.strokeStyle = `rgba(${col},${1 - age / 1.2})`;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(f.x, f.y, 14 + age * 60, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // 危険地帯：重なったり隣り合ったりしている四角は、1つの形にまとめて描く（輪郭は外まわりだけ・⚠はまとまりごとに1つ）
  const trapCache = new Map();
  function trapShape(rects) {
    const key = rects.map((r) => r.join(',')).join('|');
    const hit = trapCache.get(key);
    if (hit) return hit;
    // 4px 以内のずれは同じ線にそろえる（ぴったり並べたつもりの四角がすき間なくつながるように）
    const snapList = (vals) => { const out = []; for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 4) out.push(v); return out; };
    const near = (arr, v) => arr.reduce((b, c) => (Math.abs(c - v) < Math.abs(b - v) ? c : b));
    const xs = snapList(rects.flatMap((r) => [r[0], r[0] + r[2]]));
    const ys = snapList(rects.flatMap((r) => [r[1], r[1] + r[3]]));
    const rs = rects.map((r) => [near(xs, r[0]), near(ys, r[1]), near(xs, r[0] + r[2]), near(ys, r[1] + r[3])]).filter((r) => r[2] > r[0] && r[3] > r[1]);
    const nx = xs.length - 1, ny = ys.length - 1;
    const cov = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && rs.some((r) => r[0] <= xs[i] && xs[i + 1] <= r[2] && r[1] <= ys[j] && ys[j + 1] <= r[3]);
    const edges = [];
    // 横の輪郭（上下で塗り／空きが変わるところ）をつなげて1本ずつ
    for (let j = 0; j <= ny; j++) {
      let run = null;
      for (let i = 0; i <= nx; i++) {
        const e = i < nx && cov(i, j - 1) !== cov(i, j);
        if (e && run === null) run = xs[i];
        if (!e && run !== null) { edges.push([run, ys[j], xs[i], ys[j]]); run = null; }
      }
    }
    for (let i = 0; i <= nx; i++) {
      let run = null;
      for (let j = 0; j <= ny; j++) {
        const e = j < ny && cov(i - 1, j) !== cov(i, j);
        if (e && run === null) run = ys[j];
        if (!e && run !== null) { edges.push([xs[i], run, xs[i], ys[j]]); run = null; }
      }
    }
    // まとまり（重なる・接する四角どうし）ごとに ⚠ を1つ：いちばん大きい四角のまん中
    const par = rs.map((_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
      const p = rs[a], q = rs[b];
      if (p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3]) par[find(a)] = find(b);
    }
    const best = new Map();
    rs.forEach((r, i) => { const g = find(i), area = (r[2] - r[0]) * (r[3] - r[1]); if (!best.has(g) || best.get(g).area < area) best.set(g, { area, x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 }); });
    const shape = { rects: rs, edges, icons: [...best.values()] };
    if (trapCache.size > 50) trapCache.clear();
    trapCache.set(key, shape);
    return shape;
  }
  function drawTraps(ctx, rects, t) {
    if (!rects.length) return;
    const S = trapShape(rects);
    const path = () => { ctx.beginPath(); for (const r of S.rects) ctx.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]); };
    ctx.save();
    const a = 0.32 + 0.12 * Math.sin(t * 4);
    path(); // 同じ向きの四角を1つのパスで塗る＝重なったところも濃くならない
    ctx.fillStyle = `rgba(255,60,80,${a})`; ctx.fill();
    ctx.clip();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of S.rects) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]); }
    const h = y1 - y0;
    ctx.strokeStyle = 'rgba(255,90,110,0.55)'; ctx.lineWidth = 3;
    ctx.beginPath();
    for (let k = -h; k < x1 - x0; k += 12) { ctx.moveTo(x0 + k, y1); ctx.lineTo(x0 + k + h, y0); }
    ctx.stroke();
    // 輪郭は外まわりだけ（形の内側に半分だけ見える）
    ctx.strokeStyle = '#ff4d5e'; ctx.lineWidth = 4; ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (const e of S.edges) { ctx.moveTo(e[0], e[1]); ctx.lineTo(e[2], e[3]); }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const ic of S.icons) ctx.fillText('⚠', ic.x, ic.y);
  }
  // 斜めの床（はじめからある）：壁と同じ色の太い棒
  function drawSlope(ctx, s, C) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.wall; ctx.lineWidth = PH.SLOPE_R * 2;
    ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.stroke();
    // 上側のふち（壁の上面と同じ明るい色）
    const dx = s[2] - s[0], dy = s[3] - s[1], L = Math.hypot(dx, dy) || 1;
    let nx = dy / L, ny = -dx / L;
    if (ny > 0) { nx = -nx; ny = -ny; }
    ctx.strokeStyle = C.wallTop; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(s[0] + nx * 3, s[1] + ny * 3); ctx.lineTo(s[2] + nx * 3, s[3] + ny * 3); ctx.stroke();
    ctx.restore();
  }
  function drawTunnel(ctx, tn, t) {
    if (!tn.enter) { // 出口：入れない。うすい輪だけ（番号は出さない。どこに出るかは声で伝え合う）
      ctx.save();
      ctx.strokeStyle = 'rgba(190,160,255,0.5)'; ctx.lineWidth = 2; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(tn.x, tn.y, tn.r - 4, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      return;
    }
    const g = ctx.createRadialGradient(tn.x, tn.y, 2, tn.x, tn.y, tn.r);
    g.addColorStop(0, '#000'); g.addColorStop(0.7, '#1a0b33'); g.addColorStop(1, '#7c4dff');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(tn.x, tn.y, tn.r, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(tn.x, tn.y); ctx.rotate(t * 2.5);
    ctx.strokeStyle = 'rgba(200,170,255,0.85)'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.arc(0, 0, tn.r - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
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

  // 敵：とげとげの紫の玉に、怒った目（ひと目で敵とわかるように）
  //  ・顔はいつも「下」が重力の向き（束を回すと、顔も起き上がる）
  //  ・トゲの体は、転がった距離のぶんだけ回る（止まっていれば回らない）
  function drawEnemy(ctx, o, side) {
    const r = PH.ER, x = o.x, y = o.y;
    // 転がった分の回転：床（重力が下）で右へ動くと時計回り
    const g = sideGravity(side);
    if (o._lx !== undefined && o._ls === side) {
      const dx = x - o._lx, dy = y - o._ly;
      if (Math.hypot(dx, dy) < 80) o._roll = (o._roll || 0) + (dx * g[1] - dy * g[0]) / (r * 0.9);
    }
    o._lx = x; o._ly = y; o._ls = side;
    // 顔の向き：重力の向きへなめらかに追いつく（重力がほぼ無いときは前の向きのまま）
    if (Math.hypot(g[0], g[1]) > 0.3) {
      const target = Math.atan2(g[1], g[0]) - Math.PI / 2;
      const cur = o._face === undefined ? target : o._face;
      const d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
      o._face = cur + d * 0.25;
    }
    const face = o._face || 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o._roll || 0);
    ctx.shadowColor = '#ff2d6f'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#e0204f';
    ctx.beginPath();
    const spikes = 9;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i * Math.PI) / spikes, rr = i % 2 ? r * 0.82 : r * 1.35;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // 体と顔（顔の向き＝重力の向きに合わせる。光も「上」から当たる）
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(face);
    const body = ctx.createRadialGradient(-3, -4, 1, 0, 0, r);
    body.addColorStop(0, '#b06cff'); body.addColorStop(1, '#4a1680');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(-4.5, -1, 3.4, 3.8, 0, 0, Math.PI * 2); ctx.ellipse(4.5, -1, 3.4, 3.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a0010';
    ctx.beginPath(); ctx.arc(-4, 0, 1.7, 0, Math.PI * 2); ctx.arc(5, 0, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a0010'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-8, -6); ctx.lineTo(-2, -3.5); ctx.moveTo(8, -6); ctx.lineTo(2, -3.5); ctx.stroke(); // 怒ったまゆ
    ctx.restore();
  }

  function drawHeart(ctx, x, y, t) {
    const s = 1 + 0.1 * Math.sin(t * 6);
    ctx.save();
    ctx.translate(x, y); ctx.scale(s, s);
    ctx.shadowColor = '#ff6b8a'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#ff4f7b';
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.bezierCurveTo(-18, -2, -10, -16, 0, -6);
    ctx.bezierCurveTo(10, -16, 18, -2, 0, 12);
    ctx.fill();
    ctx.restore();
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
    rollSound();
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
  // 全画面のときは、時計・電池・カメラのバーが上に重なる機種があるので、上に余白をとる（style.css の html.fs）
  const syncFs = () => {
    document.documentElement.classList.toggle('fs', !!(document.fullscreenElement || document.webkitFullscreenElement));
    if ($('scr-play').classList.contains('active')) setTimeout(fit, 50);
  };
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  function tryFullscreen() {
    if (!isTouch) return;
    const el = document.documentElement;
    try {
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null;
      if (p && p.then) p.then(() => { try { screen.orientation.lock('portrait').catch(() => {}); } catch (e) { /* noop */ } }).catch(() => {});
    } catch (e) { /* noop */ }
  }

  // ---------- ロビー ----------
  function pageUrl() {
    // 確認用サーバー（http://localhost:8095 などポート付き）ではそのページ自身、
    // それ以外（公開ページ・APK）では config.js の公開URLを使う
    const here = location.origin + location.pathname;
    const dev = location.port !== '' || location.protocol === 'file:';
    return dev ? here : (CFG.publicUrl || here);
  }

  const joinUrl = () => pageUrl() + '?join=' + (Link.code || '');
  let qrFor = '';
  function renderQr(show) {
    $('lb-qr-card').classList.toggle('hidden', !show);
    $('lb-code').textContent = Link.code || '';
    if (!show || qrFor === joinUrl()) return;
    try { window.MiniQR.draw($('lb-qr'), joinUrl(), 210); qrFor = joinUrl(); } catch (e) { $('lb-qr-card').classList.add('hidden'); }
  }

  function goLobby() {
    G = null;
    App.views = [];
    $('result').classList.add('hidden');
    $('menu').classList.add('hidden');
    $('netwait').classList.add('hidden');
    renderLobby();
    showScreen('scr-lobby');
  }

  function renderLobby() {
    const solo = App.mode === 'solo';
    const role = Link.role;
    const open = Link.open;
    const host = !solo && role === 'host', guest = !solo && role === 'guest';
    $('lb-title').textContent = solo ? 'ひとりで試す' : host ? 'あなたは オモテ' : guest ? 'あなたは ウラ' : 'ふたりで遊ぶ';
    $('lb-net').classList.toggle('hidden', solo);

    let st = '';
    if (solo) st = 'オモテとウラを並べて表示します。<br>赤い危険地帯は、その面の人にだけ見えます（両方の面で触れたらアウト）。';
    else if (open) st = '<span class="ok">● 相棒とつながりました！</span>';
    else if (Link.state === 'reconnecting') st = '<span class="ng">● 接続が切れました。自動でつなぎ直しています…</span>';
    else if (Link.state === 'waiting') st = '● 相棒を待っています…<br><small>下の QR を相棒のスマホで読みとってね。</small>';
    else if (Link.state === 'joining') st = `● 部屋 <b>${Link.code}</b> につないでいます…`;
    else if (Link.state === 'notfound') st = `● 部屋 <b>${Link.code}</b> がまだ見つかりません…<br><small>相棒の画面の番号を確かめてね（このまま自動でつなぎ続けます）</small>`;
    else st = '● 部屋を準備しています…';
    if (!solo && App.netError) st += `<br><span class="ng">${App.netError}</span>`;
    $('lb-status').innerHTML = st;
    renderQr(!solo && !open && Link.role === 'host' && !!Link.code);

    // センサーは「スマホが動いたとき」にだけ値が届く機種もあるので、届くまでは「確認中」にしておく（エラー扱いしない）
    let sen;
    if (Sensor.live()) sen = '<span class="ok">● 傾きセンサー：使えます' + (Sensor.src === 'mot' ? '（加速度で代用中）' : Sensor.src === 'gen' ? '（重力センサーで代用中）' : '') + '</span>';
    else if (!isTouch) sen = '● 傾きセンサーなし：← →キーで操作します';
    else if (now() - pageT > 4000) sen = '<span class="ng">● 傾きセンサーの値が届いていません。下の「センサーの診断・設定」を開いてね</span>';
    else sen = '<span class="wait-s">● 傾きセンサー：確認中…（スマホを少し動かすと反応します）</span>';
    $('lb-sensor').innerHTML = sen;
    $('lb-sdiag').classList.toggle('alert', isTouch && !Sensor.live() && now() - pageT > 4000);

    const leader = solo || host;
    $('lb-host-area').classList.toggle('hidden', !leader);
    if (leader) {
      if (App.stageSel >= LEVELS.length) App.stageSel = 0;
      const html = LEVELS.map((L, i) => `<button data-i="${i}" class="${i === App.stageSel ? 'on' : ''}">${i + 1}. ${L.name}<small>${L.hint}</small></button>`).join('');
      if ($('lb-stages').dataset.html !== html) { $('lb-stages').innerHTML = html; $('lb-stages').dataset.html = html; }
      $('lb-start').disabled = !(solo || open);
      $('lb-run').disabled = !(solo || open);
      $('lb-best').textContent = bestText();
    }
    $('lb-wait').textContent = guest && open ? `オモテの人がスタートするのを待っています…（${bestText()}）` : '';
  }
  setInterval(() => { if ($('scr-lobby').classList.contains('active')) renderLobby(); }, 1000);

  // ---------- 通信イベント ----------
  function applyRole(role) {
    const mode = role === 'host' ? 'host' : 'guest';
    const changed = App.mode !== mode;
    App.mode = mode;
    App.mySides = [mode === 'host' ? 'A' : 'B'];
    return changed;
  }

  // 通信が切れている間は、ゲームを一時停止して待つ
  function syncNetWait() {
    const show = App.mode !== 'solo' && !!G && !Link.open && $('scr-play').classList.contains('active');
    $('netwait').classList.toggle('hidden', !show);
  }

  Link.on('state', () => { renderLobby(); syncNetWait(); });
  Link.on('open', (role) => {
    App.netError = '';
    const changed = applyRole(role);
    App.lastRecv = now();
    Link.send({ t: 'hello', role });
    Snd.play('join'); vib(80);
    if (changed && G) { goLobby(); } // まれに役が入れ替わったときは、ロビーからやり直す
    if (App.mode === 'host') {
      // オモテが状況を決める：ゲーム中なら再開データ、そうでなければロビーへ
      if (G) { const s = snapshot(); Link.send({ t: 'sync', ...s }); resumeStage(s); }
      else Link.send({ t: 'lobby' });
    }
    renderLobby(); syncNetWait();
  });
  Link.on('lost', () => { renderLobby(); syncNetWait(); });
  Link.on('code', () => renderLobby());
  Link.on('msg', onMsg);
  Link.on('error', (msg) => { App.netError = msg; renderLobby(); });

  // 再接続したときの再開データ（★・ミス・タイム・チェックポイントは引き継ぐ）
  function snapshot() {
    return {
      st: { ...G.st, run: G.run ? { ...G.run, taken: G.run.taken.slice() } : null },
      misses: G.misses, lines: { ...G.world.lines }, over: G.phase === 'over', cleared: G.phase === 'clear', elapsed: G.elapsed,
      objs: G.world.objs.map((o) => ({ id: o.id, side: o.side, x: o.x, y: o.y, goaled: !!o.goaled, cp: o.cp || null })),
    };
  }
  // 再開：ゴールした玉はそのまま、ほかの玉はそれぞれのチェックポイントから。敵はその場から
  function resumeStage(s) {
    if (!s.st) return;
    startStage(s.st);
    G.misses = s.misses || 0;
    G.resumeElapsed = s.elapsed || 0;
    if (s.lines) { G.world.lines.A = s.lines.A || null; G.world.lines.B = s.lines.B || null; }
    for (const so of s.objs || []) {
      const o = G.world.objs.find((x) => x.id === so.id);
      if (!o) continue;
      if (o.kind === 'ball') {
        o.goaled = !!so.goaled;
        const cp = so.cp || o.cp;
        o.cp = cp; o.side = cp.side; o.x = cp.x; o.y = cp.y; o.ign = cp.ign;
      } else { o.side = so.side; o.x = so.x; o.y = so.y; }
      o.hidden = !!o.goaled;
    }
    if (s.over) runOver(false);
    else if (s.cleared) showResult({ time: s.elapsed, misses: s.misses }, true);
    else toast('つながった！ チェックポイントから再開します');
  }

  // ---------- 入力 ----------
  const KEYMAP = { ArrowLeft: 'keyL', ArrowRight: 'keyR', ArrowDown: 'keyLean', a: 'keyL', d: 'keyR', s: 'keyLean' };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.key]; if (!k) return;
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
    Snd.setMuted(!Snd.muted);
    try { localStorage.setItem('uraomote_mute', Snd.muted ? '1' : '0'); } catch (e) { /* noop */ }
    syncMute(); Snd.init(); Snd.play('tap');
  });
  function prepDevice() {
    Snd.init();
    const p = Sensor.enable();
    tryFullscreen();
    return p;
  }
  // 受け取りはページを開いた時点で始める（許可の確認はタップのときだけ）
  Sensor.listen();
  Sensor.query();

  // ---------- センサーの診断・設定 ----------
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const IN_APP = /Line\/|FBAN|FBAV|Instagram|; wv\)|GSA\//i.test(navigator.userAgent); // LINE・Google アプリなどの中のブラウザ
  let diagTimer = 0;
  const PQ_NAME = { accelerometer: '加速度', gyroscope: 'ジャイロ', magnetometer: '磁気' };
  const PQ_STATE = { granted: '許可', denied: 'ブロック', prompt: '確認待ち' };
  function renderDiag() {
    const d = Sensor.diag, fresh = (t) => t && now() - t < 1000;
    const row = (name, ok, text) => '<div class="dg-row"><span class="dg-mk ' + (ok ? 'ok' : 'ng') + '">' + (ok ? '●' : '×') + '</span><b>' + name + '</b><span>' + text + '</span></div>';
    const pqKeys = Object.keys(d.pq);
    const pqText = pqKeys.length ? pqKeys.map((k) => (PQ_NAME[k] || k) + '：' + (PQ_STATE[d.pq[k]] || d.pq[k])).join('・') : '調べられない機種';
    const blocked = Object.values(d.pq).includes('denied') || d.perm === 'denied' || d.permM === 'denied';
    const where = IN_APP ? 'アプリの中のブラウザ（センサーが届かないことがある）' : (matchMedia('(display-mode: standalone)').matches ? 'ホーム画面のアプリ' : 'ブラウザ');
    $('sd-rows').innerHTML =
      row('向きセンサー', fresh(Sensor.t.ori), d.oriN + ' 回届いた' + (d.oriNull ? '（空っぽ ' + d.oriNull + ' 回）' : '')) +
      row('加速度（代用）', fresh(Sensor.t.mot), d.motN + ' 回届いた' + (d.motNull ? '（空っぽ ' + d.motNull + ' 回）' : '')) +
      row('重力センサー（代用）', fresh(Sensor.t.gen), d.gen) +
      row('ブラウザの許可', !blocked, pqText + (d.perm !== '—' ? '・確認の返事：' + d.perm : '')) +
      row('開いている場所', !IN_APP, where);
    const g0 = Sensor.g;
    $('sd-dot').style.transform = 'translate(' + (g0[0] * 46).toFixed(1) + 'px, ' + (g0[1] * 46 + 46).toFixed(1) + 'px)';
    $('sd-dot').classList.toggle('live', Sensor.fresh());
    $('sd-verdict').innerHTML = Sensor.fresh() ? '<span class="ok">傾きが届いています！ スマホを傾けると上の玉が転がります</span>'
      : blocked ? '<span class="ng">ブラウザの設定で「モーションセンサー」がブロックされています。下の手順で「許可」にしてね</span>'
      : IN_APP ? '<span class="ng">アプリの中のブラウザで開いています。「Chrome で開き直す」を押してね</span>'
      : '<span class="ng">値が届いていません。スマホを少し動かしてから「センサーを有効にする」を押し、だめなら下の手順を確かめてね</span>';
  }
  function openDiag() {
    $('sensorbox').classList.remove('hidden');
    $('sd-chrome').classList.toggle('hidden', !IS_ANDROID);
    clearInterval(diagTimer);
    renderDiag();
    diagTimer = setInterval(() => { if ($('sensorbox').classList.contains('hidden')) { clearInterval(diagTimer); return; } renderDiag(); }, 200);
  }
  $('lb-sdiag').addEventListener('click', () => { Sensor.enable(); openDiag(); });
  $('btn-sdiag').addEventListener('click', () => { Sensor.enable(); openDiag(); });
  $('lb-sensor').addEventListener('click', () => { Sensor.enable(); openDiag(); });
  $('sd-enable').addEventListener('click', () => { Sensor.enable().then(() => renderDiag()); renderDiag(); });
  $('sd-close').addEventListener('click', () => { $('sensorbox').classList.add('hidden'); if ($('scr-lobby').classList.contains('active')) renderLobby(); });
  // Chrome で開き直す（LINE やカメラの中のブラウザから抜け出す）
  // 開き直すときは、参加しようとしていた部屋番号も渡す（QR から来て、まだ参加していない／参加中）
  function openInChrome() {
    const u = new URL(location.href);
    const code = Link.role === 'guest' && Link.code ? Link.code : (!$('invite').classList.contains('hidden') ? inviteCode : '');
    if (code) u.searchParams.set('join', code);
    location.href = 'intent://' + u.host + u.pathname + u.search + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(u.href) + ';end';
  }
  $('sd-chrome').addEventListener('click', openInChrome);

  // ---------- Chrome 以外で開いたときの案内 ----------
  // Xiaomi のブラウザ・カメラの中のブラウザなどは、傾きセンサーの値をページに渡さないことがある。
  // Android で Chrome 以外と分かったら、上に「Chrome で開く」の案内を出す（センサーの値が届いたら消す）
  const UA = navigator.userAgent;
  const NOT_CHROME = IS_ANDROID && (!/Chrome\//.test(UA) || IN_APP ||
    /EdgA|OPR\/|OPT\/|SamsungBrowser|MiuiBrowser|XiaoMi|HeyTapBrowser|OppoBrowser|VivoBrowser|UCBrowser|YaBrowser|Firefox|DuckDuckGo|Version\/\d/i.test(UA));
  let barClosed = false;
  function syncChromeBar() {
    const onTitleOrLobby = $('scr-title').classList.contains('active') || $('scr-lobby').classList.contains('active');
    const show = NOT_CHROME && !barClosed && !Sensor.fresh() && onTitleOrLobby && now() - pageT > 1200;
    $('chromebar').classList.toggle('hidden', !show);
  }
  $('cb-open').addEventListener('click', openInChrome);
  $('cb-close').addEventListener('click', () => { barClosed = true; syncChromeBar(); });
  setInterval(syncChromeBar, 500);
  $('btn-play').addEventListener('click', () => {
    prepDevice();
    App.mode = 'net'; App.mySides = []; App.stageSel = 0; App.netError = '';
    Link.host();
    goLobby();
  });
  // 番号で相棒の部屋に入る
  function joinRoom(code) {
    prepDevice();
    App.mode = 'net'; App.mySides = []; App.stageSel = 0; App.netError = '';
    Link.join(code);
    goLobby();
  }
  $('btn-join').addEventListener('click', () => { $('jn-code').value = ''; $('jn-ok').disabled = true; $('joinbox').classList.remove('hidden'); setTimeout(() => $('jn-code').focus(), 50); });
  $('jn-cancel').addEventListener('click', () => $('joinbox').classList.add('hidden'));
  $('jn-code').addEventListener('input', () => { $('jn-code').value = $('jn-code').value.replace(/\D/g, '').slice(0, 4); $('jn-ok').disabled = $('jn-code').value.length !== 4; });
  $('jn-ok').addEventListener('click', () => { const c = $('jn-code').value; if (c.length !== 4) return; $('joinbox').classList.add('hidden'); joinRoom(c); });
  $('btn-solo').addEventListener('click', () => {
    prepDevice();
    Link.stop();
    App.mode = 'solo'; App.mySides = ['A', 'B'];
    goLobby();
  });
  // QR／URL から来たとき：「参加する」を出す（センサー・全画面・音には1回タップが要るため）
  const inviteCode = (params.get('join') || '').replace(/\D/g, '');
  if (params.has('join')) {
    try { const q = new URLSearchParams(location.search); q.delete('join'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '')); } catch (e) { /* noop */ }
    if (inviteCode.length === 4) { $('iv-code').textContent = inviteCode; $('invite').classList.remove('hidden'); }
  }
  $('iv-join').addEventListener('click', () => { $('invite').classList.add('hidden'); joinRoom(inviteCode); });
  $('iv-no').addEventListener('click', () => $('invite').classList.add('hidden'));
  $('btn-rules').addEventListener('click', () => showScreen('scr-rules'));
  $('btn-rules-back').addEventListener('click', () => showScreen('scr-title'));

  // ロビー
  $('lb-stages').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    App.stageSel = Number(b.dataset.i); Snd.play('tap'); renderLobby();
  });
  $('lb-start').addEventListener('click', () => { Snd.init(); if (!Sensor.live()) Sensor.enable(); leaderTutorial(App.stageSel); });
  $('lb-run').addEventListener('click', () => { Snd.init(); if (!Sensor.live()) Sensor.enable(); leaderStartRun(); });
  $('lb-share').addEventListener('click', async () => {
    const url = joinUrl();
    if (navigator.share) { try { await navigator.share({ title: 'ウラオモテ迷宮', text: 'ウラオモテ迷宮で遊ぼう！', url }); } catch (e) { /* キャンセル */ } }
    else { try { await navigator.clipboard.writeText(url); $('lb-share').textContent = 'URLをコピーしました'; setTimeout(() => { $('lb-share').textContent = '📤 URLで送る（LINE など）'; }, 1500); } catch (e) { /* noop */ } }
  });
  const toTitle = () => {
    if (App.mode !== 'solo' && Link.active && !confirm('通信を終了してタイトルに戻りますか？')) return;
    Link.stop(); G = null; App.views = []; App.mode = null;
    $('netwait').classList.add('hidden');
    showScreen('scr-title');
  };
  $('lb-leave').addEventListener('click', toTitle);
  $('nw-title').addEventListener('click', toTitle);

  // リザルト・メニュー
  $('rs-next').addEventListener('click', leaderNext);
  $('rs-retry').addEventListener('click', () => leaderTutorial(G.idx)); // チュートリアルの「もう一度」は形も変える
  $('hud-restart').addEventListener('click', requestRestart);
  // 消しゴム：自分が描いた床を消す
  $('hud-erase').addEventListener('click', () => {
    if (!G) return;
    const faces = App.mode === 'solo' ? ['A', 'B'] : [other(mySide())];
    for (const f of faces) { if (G.lines[f]) { G.lines[f] = null; send({ t: 'line', face: f, seg: null }); } }
    Snd.play('tap'); toast('床を消した');
  });
  $('sw-ok').addEventListener('click', () => resumeGame(false, false));
  $('sw-skip').addEventListener('click', () => resumeGame(false, true));
  $('rs-lobby').addEventListener('click', leaderLobby);
  $('hud-menu').addEventListener('click', () => {
    $('mn-hint').textContent = G ? G.L.hint : '';
    const leader = App.mode !== 'guest';
    $('mn-lobby').classList.toggle('hidden', !leader);
    $('menu').classList.remove('hidden');
  });
  $('mn-close').addEventListener('click', () => $('menu').classList.add('hidden'));
  $('mn-retry').addEventListener('click', () => { $('menu').classList.add('hidden'); requestRestart(); });
  $('mn-lobby').addEventListener('click', leaderLobby);
  $('mn-title').addEventListener('click', toTitle);


  // 開発用：コンソールから状態を見る
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

  if (params.get('debug') === '1') {
    window.__ura = {
      App, Input, Sensor,
      get G() { return G; },
      // 物理を手動で進める（自動テスト用）
      step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) update(dt); },
      // idx: チュートリアルの番号。pick.p: パターン番号
      start(idx, pick, run) { startStage({ idx, p: pick ? pick.p : 0, run: run || null }); },
      startGen(gen, run) { startStage({ idx: -1, p: 0, gen, run: run || null }); },
      makeGen(level, seed) { return GenSvc.makeHere(level, seed); },
      Snd, rollSound,
      patterns(idx) { return patternsOf(LEVELS[idx]); },
      setLine(face, seg) { G.world.lines.A = null; G.world.lines.B = null; G.world.lines[face] = seg; }, // ペンは2人で1本
      startRun() { leaderStartRun(); },
      fit,
    };
  }
})();
