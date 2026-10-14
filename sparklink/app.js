'use strict';

const $app = document.getElementById('app');
const S = {
  roomId: null, token: null, view: null, session: 0, offline: false,
  drag: null, tapFrom: null, pendingRender: false, lastMoveCount: null, winShown: null, rematchFirst: null, review: null, branch: null, boardState: null,
  anCache: new Map(), anWant: null, anErr: null, anTimer: null, noticeId: undefined,
};
// Androidアプリの中で動いているときだけ使える機能（共有・画面の常時点灯など）
const native = () => (typeof window.AndroidApp === 'object' ? window.AndroidApp : null);
function callNative(fn, ...args) {
  try { const n = native(); if (n && typeof n[fn] === 'function') { n[fn](...args); return true; } } catch {}
  return false;
}
const U = 30; // 格子1単位のピクセル（点と点の間隔は 2U）
const COLOR_NAME = { R: '赤', B: '青' };
const LEVELS = [['easy', 'よわい'], ['normal', 'ふつう'], ['hard', 'つよい']];
const FIRSTS = [['random', 'ランダム'], ['self', '自分が先手'], ['opp', '自分が後手']];
const HANDICAPS = [[0, '平手'], [1, '1手'], [2, '2手'], [3, '3手'], [4, '4手'], [5, '5手'], [6, '6手']];
const SIDES = [['self', '自分'], ['opp', '相手']];
const UNDO_MSG = {
  accepted: '相手がOKしたので一手戻しました',
  rejected: '一手戻るの申請は断られました',
  expired: '相手が指したため、一手戻るの申請は取り消されました',
};

// ---------- utils ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// 自分がホストならこの端末の中のホスト（host.js）へ、友達のルームなら PeerJS で友達の端末へ（net.js）
async function api(path, body) {
  const r = await Net.request(path, body);
  const j = r.json || { error: '通信エラーが発生しました' };
  if (r.status >= 400) throw new Error(j.error || 'エラーが発生しました');
  return j;
}
const act = (type, extra = {}) =>
  api('/api/action', { roomId: S.roomId, token: S.token, type, ...extra }).catch((e) => toast(e.message));

// ---------- board geometry (server/game.js と同じ規則) ----------
const key = (x, y) => `${x},${y}`;
function isSlot(n, mx, my) {
  const m = 2 * n;
  if (mx % 2 === 1 && my % 2 === 1) return mx >= 1 && mx <= m - 1 && my >= 1 && my <= m - 1;
  if (mx % 2 === 0 && my % 2 === 0) return mx >= 2 && mx <= m - 2 && my >= 2 && my <= m - 2;
  return false;
}
function endpoints(color, mx, my) {
  const vertical = color === 'R' ? mx % 2 === 1 : mx % 2 === 0;
  return vertical ? [[mx, my - 1], [mx, my + 1]] : [[mx - 1, my], [mx + 1, my]];
}
function colorDots(n, color) {
  const dots = [];
  if (color === 'R') { for (let y = 0; y <= 2 * n; y += 2) for (let x = 1; x < 2 * n; x += 2) dots.push([x, y]); } else { for (let y = 1; y < 2 * n; y += 2) for (let x = 0; x <= 2 * n; x += 2) dots.push([x, y]); }
  return dots;
}
const isStart = (color, x, y) => (color === 'R' ? y === 0 : x === 0);

// 始点ラインから電気が流れている線と、その向き。seen には到達した点（始点含む）が入る
function powered(n, owner, color) {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const seen = new Set();
  const queue = [];
  const flows = [];
  for (const [x, y] of colorDots(n, color)) if (isStart(color, x, y)) { seen.add(key(x, y)); queue.push([x, y]); }
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of DIRS) {
      if (owner[key(x + dx, y + dy)] !== color) continue;
      const nx = x + 2 * dx; const ny = y + 2 * dy;
      if (seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      flows.push({ from: [x, y], to: [nx, ny] });
      queue.push([nx, ny]);
    }
  }
  return { flows, seen };
}

// つながっていれば始点→ゴールのスロット列を返す（server の game.js trace と同じ）
function winPathOf(n, owner, color) {
  const parent = new Map();
  const queue = [];
  for (const [x, y] of colorDots(n, color)) if (isStart(color, x, y)) { parent.set(key(x, y), null); queue.push([x, y]); }
  for (let qi = 0; qi < queue.length; qi++) {
    const [x, y] = queue[qi];
    if (color === 'R' ? y === 2 * n : x === 2 * n) {
      const path = [];
      let k = key(x, y);
      while (parent.get(k)) { const p = parent.get(k); path.unshift(p.slot); k = key(p.from[0], p.from[1]); }
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (owner[key(x + dx, y + dy)] !== color) continue;
      const nk = key(x + 2 * dx, y + 2 * dy);
      if (parent.has(nk)) continue;
      parent.set(nk, { from: [x, y], slot: key(x + dx, y + dy) });
      queue.push([x + 2 * dx, y + 2 * dy]);
    }
  }
  return null;
}

function dotNear(n, color, p, maxDist = 0.85) {
  let x; let y;
  if (color === 'R') { x = Math.round((p.x - 1) / 2) * 2 + 1; y = Math.round(p.y / 2) * 2; } else { x = Math.round(p.x / 2) * 2; y = Math.round((p.y - 1) / 2) * 2 + 1; }
  const inX = color === 'R' ? x >= 1 && x <= 2 * n - 1 : x >= 0 && x <= 2 * n;
  const inY = color === 'R' ? y >= 0 && y <= 2 * n : y >= 1 && y <= 2 * n - 1;
  if (!inX || !inY) return null;
  return Math.hypot(p.x - x, p.y - y) <= maxDist ? [x, y] : null;
}

function targetsFrom(n, owner, [x, y]) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .filter(([dx, dy]) => isSlot(n, x + dx, y + dy) && !owner[key(x + dx, y + dy)])
    .map(([dx, dy]) => [x + 2 * dx, y + 2 * dy]);
}

// ---------- BGM（対局画面でループ再生） ----------
const bgm = new Audio('bgm/game.mp3');
bgm.loop = true;
bgm.preload = 'none';
S.muted = store.get('spark:muted', false);
S.volume = store.get('spark:volume', 45);
// 音量は各自のブラウザごとに保存（相手の設定には影響しない）
function applyVolume() {
  bgm.volume = Math.max(0, Math.min(100, S.volume)) / 100;
  const btn = document.getElementById('muteBtn');
  const slider = document.getElementById('volume');
  if (btn) btn.textContent = S.muted || S.volume === 0 ? '🔇' : S.volume < 40 ? '🔉' : '🔊';
  if (slider) slider.value = S.muted ? 0 : S.volume;
}
function syncBgm() {
  const want = !!(S.view && S.view.game) && !S.muted && S.volume > 0 && !S.paused;
  if (want && bgm.paused) bgm.play().catch(() => {}); // 自動再生が拒否されたら、次のクリック時に再挑戦
  else if (!want && !bgm.paused) bgm.pause();
}

// ---------- session ----------
// ホストに「変化があったら教えて」と問い合わせ続けて（ロングポーリング）状態を受け取る
function disconnect() { S.session++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const homePath = () => location.pathname;

function enterRoom(roomId, token, local) {
  S.roomId = roomId;
  S.token = token;
  S.local = !!local;
  Net.setLocal(S.local);
  store.set('spark:session', { roomId, token, local: S.local });
  history.replaceState(null, '', `${homePath()}?room=${roomId}`);
  connect();
}

async function connect() {
  disconnect();
  const session = S.session;
  S.view = null;
  S.noticeId = undefined;
  let lostSince = 0;
  while (S.session === session) {
    try {
      const v = S.view ? S.view.v : 0;
      const j = await Net.poll({ room: S.roomId, token: S.token, v });
      if (S.session !== session) return;
      if (j.fatal) return leave(j.fatal);
      lostSince = 0;
      const changed = !S.view || j.v !== S.view.v || S.offline;
      S.offline = false;
      if (j.roomId && j.roomId !== S.roomId) {
        // ホスト側でルームコードが振り直された
        S.roomId = j.roomId;
        store.set('spark:session', { roomId: S.roomId, token: S.token, local: S.local });
        history.replaceState(null, '', `${homePath()}?room=${S.roomId}`);
      }
      S.view = j;
      // 自分が出した「一手戻る」申請の結果を知らせる（接続直後の古い結果は出さない）
      const nt = j.undoNotice;
      if (nt && nt.id !== S.noticeId) {
        if (S.noticeId !== undefined && nt.seat === j.me) toast(UNDO_MSG[nt.result]);
        S.noticeId = nt.id;
      } else if (S.noticeId === undefined) S.noticeId = null;
      if (changed) render();
    } catch (e) {
      if (S.session !== session) return;
      if (!S.offline) { S.offline = true; if (S.view) render(); }
      // ホストが長いあいだ見つからない＝ホストがアプリを閉じた
      if (!lostSince) lostSince = Date.now();
      if (Date.now() - lostSince > 90000) return leave('ホストとの接続が切れました（ホストがアプリを閉じた可能性があります）');
      await sleep(e && e.code === 'unavailable' ? 3000 : 1500);
    }
  }
}

function leave(msg) {
  disconnect();
  if (S.local && S.roomId) Net.request('/api/leave', { roomId: S.roomId, token: S.token }).catch(() => {});
  Net.disconnect();
  store.del('spark:session');
  S.view = null; S.roomId = null; S.token = null; S.local = false;
  document.body.classList.remove('in-game');
  syncNative();
  syncBgm();
  document.title = 'スパークリンク';
  history.replaceState(null, '', homePath());
  renderHome(null, msg);
}

// ---------- home ----------
function seg(name, options, current, cls = '') {
  return `<div class="seg ${cls}">${options.map(([v, label]) =>
    `<label><input type="radio" name="${name}" value="${v}" ${String(v) === String(current) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
}
const radioVal = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;

function renderHome(joinRoom, err) {
  disconnect();
  const name = store.get('spark:name', '');
  const cfg = store.get('spark:cfg', { mode: 'ai', size: 6, level: 'normal', firstChoice: 'random', handicap: 0, handicapFor: 'self' });
  const name2 = store.get('spark:name2', '');
  $app.innerHTML = `
  <div class="home">
    <div class="logo">
      ${logoSVG()}
      <h1 class="title-font">スパークリンク</h1>
      <p>線をつないで電気を通せ。運ゼロの2人対戦</p>
    </div>
    ${err ? `<div class="alert">${esc(err)}</div>` : ''}
    <div class="panel stack">
      <label class="field">あなたの名前
        <input id="name" maxlength="12" value="${esc(name)}" placeholder="なまえ（12文字まで）" autocomplete="nickname">
      </label>
    </div>
    ${joinRoom ? `
    <div class="panel stack">
      <h2>ルーム <span class="title-font">${esc(joinRoom)}</span> に参加</h2>
      <button class="btn big" data-act="join" data-room="${esc(joinRoom)}">参加する</button>
      <button class="link" data-act="home">自分でルームを作る</button>
    </div>` : `
    <div class="panel stack">
      <h2>対局を始める</h2>
      <div class="field">モード${seg('mode', [['ai', 'AIと対戦'], ['local', '対面で対戦'], ['friends', 'ネットで対戦'], ['watch', 'AI同士を観戦']], cfg.mode, 'grid2')}</div>
      <label class="field" data-mode="local">相手の名前
        <input id="name2" maxlength="12" value="${esc(name2)}" placeholder="あいて（12文字まで）" autocomplete="off">
      </label>
      <div class="field" data-mode="ai watch"><span data-label-ai>AIの強さ</span>${seg('level', LEVELS, cfg.level)}</div>
      <div class="field" data-mode="watch">AI-2の強さ${seg('level2', LEVELS, cfg.level2 || 'hard')}</div>
      <div class="field">盤の大きさ${seg('size', [[4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8']], cfg.size)}
        <span class="note">数字は1辺の長さ（6 なら赤の点が 6×7、青の点が 7×6）</span></div>
      <div class="field" data-mode="ai local friends">先手・後手${seg('firstChoice', FIRSTS, cfg.firstChoice)}</div>
      <div class="field" data-mode="ai local friends">ハンデ（最初に自由に打てる手数）${seg('handicap', HANDICAPS, cfg.handicap)}</div>
      <div class="field" data-mode="ai local friends" data-need-handicap>ハンデをもらうのは${seg('handicapFor', SIDES, cfg.handicapFor)}</div>
      <p class="note" data-mode="local">1台のスマホを2人で交互に使って対戦します（通信なし・オフラインOK）。「一手戻る」はどちらの手でも自由に使えます。先手・後手とハンデの「自分」はあなた、「相手」は相手の名前の人です。</p>
      <p class="note" data-mode="friends">ルームを作ると、友達に送るURLが画面に表示されます。友達はスマホやPCのブラウザでURLを開くだけで参加できます（インストール不要）。対局が終わるまで、このアプリは閉じないでください。</p>
      <p class="note" data-mode="watch">AI-1とAI-2が1局ごとに先手を交代して対局します。「つよい」同士だと理論上必ず先手が勝ちます。</p>
      <button class="btn big" id="createBtn" data-act="create">ルームを作成</button>
    </div>
    <div class="panel stack">
      <h2>ルームコードで参加</h2>
      <div class="row">
        <input id="code" class="code-input" maxlength="5" placeholder="ABCDE" autocapitalize="characters" autocomplete="off">
        <button class="btn" data-act="joinCode">参加</button>
      </div>
    </div>`}
    <button class="link" data-act="rules">📖 遊び方を見る</button>
  </div>`;
  updateHomeVisibility();
}

// 選んだ内容に関係ない項目は隠す（友達対局ならAIの強さ、平手ならハンデの相手）
function updateHomeVisibility() {
  const mode = radioVal('mode');
  const handicap = Number(radioVal('handicap') || 0);
  document.querySelectorAll('[data-mode]').forEach((el) => {
    el.hidden = !el.dataset.mode.split(' ').includes(mode) || ('needHandicap' in el.dataset && handicap === 0);
  });
  const label = document.querySelector('[data-label-ai]');
  if (label) label.textContent = mode === 'watch' ? 'AI-1の強さ' : 'AIの強さ';
  const btn = document.getElementById('createBtn');
  if (btn) btn.textContent = { ai: '対局を始める', local: '対局を始める', friends: 'ルームを作成', watch: '観戦を始める' }[mode] || 'ルームを作成';
}

function logoSVG() {
  return `<svg class="logo-svg" viewBox="0 0 120 60" aria-hidden="true">
    <line x1="10" y1="30" x2="50" y2="30" class="wire R"/><line x1="10" y1="30" x2="50" y2="30" class="flow"/>
    <line x1="70" y1="10" x2="70" y2="50" class="wire B"/><line x1="70" y1="10" x2="70" y2="50" class="flow"/>
    <circle cx="10" cy="30" r="7" class="dot R"/><circle cx="50" cy="30" r="7" class="dot R"/><circle cx="90" cy="30" r="7" class="dot R"/>
    <circle cx="70" cy="10" r="7" class="dot B"/><circle cx="70" cy="50" r="7" class="dot B"/>
  </svg>`;
}

function getName() {
  const input = document.getElementById('name');
  const name = input.value.trim();
  if (!name) { toast('名前を入力してください'); input.focus(); return null; }
  store.set('spark:name', name);
  return name;
}

async function createRoom(btn) {
  const name = getName();
  if (!name) return;
  const mode = radioVal('mode');
  const size = Number(radioVal('size'));
  const level = radioVal('level');
  const level2 = radioVal('level2');
  const firstChoice = radioVal('firstChoice');
  const handicap = Number(radioVal('handicap'));
  const handicapFor = radioVal('handicapFor');
  store.set('spark:cfg', { mode, size, level, level2, firstChoice, handicap, handicapFor });
  let name2 = '';
  if (mode === 'local') {
    name2 = document.getElementById('name2').value.trim() || 'あいて';
    store.set('spark:name2', name2);
  }
  btn.disabled = true;
  try {
    const res = await api('/api/create', {
      name, name2, size, aiLevel: level, aiLevel2: level2, firstChoice, handicap, handicapFor,
      vsAI: mode === 'ai', watch: mode === 'watch', local2p: mode === 'local',
    });
    enterRoom(res.roomId, res.token, true);
    if (mode !== 'friends') await act('start');
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

async function joinRoom(roomId, btn) {
  const name = getName();
  if (!name) return;
  roomId = roomId.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(roomId)) return toast('5文字のルームコードを入力してください');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '接続中…'; }
  Net.setLocal(false);
  try {
    // ホストがURLを送った直後でまだアプリに戻っていない場合もあるので、見つからなければ少し待って再挑戦
    let res;
    for (let i = 0; ; i++) {
      try { res = await api('/api/join', { roomId, name }); break; } catch (e) {
        if (i >= 12 || !['unavailable', 'timeout'].includes(e.code)) throw e;
        if (btn) btn.textContent = 'ホストを待っています…';
        await sleep(3000);
      }
    }
    enterRoom(res.roomId, res.token, false);
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------- render dispatch ----------
function render() {
  if (S.drag) { S.pendingRender = true; return; } // ドラッグ中は再描画を待つ
  S.pendingRender = false;
  const v = S.view;
  if (!v) return;
  document.body.classList.toggle('in-game', !!v.game);
  syncNative();
  if (!v.game || v.game.phase === 'play') { S.review = null; S.branch = null; }
  if (!v.game) S.boardState = null;
  syncBgm();
  if (!v.game) { document.title = 'スパークリンク'; return renderLobby(v); }
  renderGame(v);
}

// ---------- lobby ----------
function inviteBlock(v) {
  if (!v.isHost || v.hasAI || v.seats.length >= 2) return '';
  const inv = v.invite || {};
  if (!inv.url) return '<div class="invite"><h3 class="wait">🌐 友達に送るURLを準備しています…</h3></div>';
  // 接続の準備ができていなくてもURLは先に送れる（友達側は、つながるまで自動で待つ）
  let conn;
  if (inv.status === 'ready') conn = '<p class="note" style="margin:0">✅ 友達を待っています。送ったら、このアプリに戻って待っていてください。</p>';
  else if (inv.status === 'failed') {
    conn = `<p class="conn" style="margin:0">⚠ ${esc(inv.error || '接続の準備に失敗しました')}</p>
      <button class="btn small ghost" data-act="retryInvite">接続をやり直す</button>`;
  } else conn = '<p class="note wait" style="margin:0">⏳ 接続の準備中…（先にURLを送ってOK）</p>';
  return `<div class="invite">
      <h3>📨 このURLを友達に送ってください</h3>
      <button class="btn big share-btn" data-act="share">📤 共有（LINEなどで送る）</button>
      <div class="share">
        <input id="shareUrl" readonly value="${esc(inv.url)}">
        <button class="btn small" data-act="copy">コピー</button>
      </div>
      ${conn}
      <ol><li>「共有」を押して、LINEなどで友達にURLを送る</li><li>友達がURLを開いて名前を入れて「参加する」</li><li>ここに友達が表示されたら「対局開始」</li></ol>
    </div>`;
}

function renderLobby(v) {
  const rows = [0, 1].map((i) => {
    const s = v.seats[i];
    if (!s) return '<div class="seat-row empty"><div class="avatar">·</div><div class="nm">友達の参加を待っています…</div></div>';
    return `<div class="seat-row">
      <div class="avatar">${s.isAI ? '🤖' : '🙂'}</div>
      <div class="nm">${esc(s.name)}</div>
      ${s.isAI && v.isHost ? `<select class="lv" data-ai-seat="${i}" aria-label="AIの強さ">${LEVELS.map(([l, t]) => `<option value="${l}" ${l === s.level ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
      ${i === v.me ? '<span class="tag you">あなた</span>' : ''}
      ${s.isHost ? '<span class="tag host">ホスト</span>' : ''}
      ${!s.connected ? '<span class="tag off">未接続</span>' : ''}
      ${v.isHost && !s.isHost && !v.local2p ? `<button class="btn ghost small" data-act="kick" data-seat="${i}">外す</button>` : ''}
    </div>`;
  }).join('');
  const canStart = v.seats.length === 2;
  $app.innerHTML = `
  <div class="lobby">
    <div class="panel room-code">
      <div class="note">ルームコード</div>
      <div class="code title-font">${esc(v.roomId)}</div>
      ${inviteBlock(v)}
      ${S.offline ? '<p class="conn">⚠ 接続が切れています。再接続中…</p>' : ''}
    </div>
    <div class="panel stack">
      <h2>プレイヤー（${v.seats.length}/2）</h2>
      <div class="seats">${rows}</div>
      ${v.seats.length === 2 ? `<p class="note">通算成績：${esc(v.seats[0].name)} ${v.wins[0]}勝 − ${v.wins[1]}勝 ${esc(v.seats[1].name)}</p>` : ''}
    </div>
    ${v.isHost ? `
    <div class="panel stack">
      <h2>設定</h2>
      <div class="row">
        <label class="field" style="flex:1">盤の大きさ
          <select data-setting="size">${[4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${n === v.size ? 'selected' : ''}>${n}（赤${n}×${n + 1}）</option>`).join('')}</select>
        </label>
        ${v.watch ? '' : `<label class="field" style="flex:1">先手・後手
          <select data-setting="firstChoice">${firstsFor(v).map(([f, t]) => `<option value="${f}" ${f === v.firstChoice ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>`}
      </div>
      <div class="row">
        ${v.watch ? '' : `<label class="field" style="flex:1">ハンデ
          <select data-setting="handicap">${HANDICAPS.map(([h, t]) => `<option value="${h}" ${h === v.handicap ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>`}
        ${v.handicap > 0 && !v.watch ? `<label class="field" style="flex:1">ハンデをもらうのは
          <select data-setting="handicapFor">${SIDES.map(([s2, t]) => `<option value="${s2}" ${s2 === v.handicapFor ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>` : ''}
      </div>
      <button class="btn big" data-act="start" ${canStart ? '' : 'disabled'}>対局開始</button>
    </div>` : `
    <div class="panel" style="text-align:center">
      <p>ホストが対局を開始するのを待っています…</p>
      <p class="note">盤 ${v.size}${v.handicap > 0 ? ` ／ ハンデ${v.handicap}手` : ''}</p>
    </div>`}
    <div class="row" style="justify-content:center">
      <button class="link" data-act="rules">📖 遊び方</button>
      <button class="link" data-act="leave">退出する</button>
    </div>
  </div>`;
}

// ---------- game ----------
// 盤の外側に伸びる「配線コード」の装飾。色の始点/終点ラインの各点から外向きに1本ずつ。
// 実際に電気が届いている点だけが光る＝どこをつなげば良いか一目で分かる。
function cordStub(n, color, x, y, lit) {
  const P = (c) => c * U;
  const len = U * 0.5;
  let dx = 0; let dy = 0;
  if (color === 'R') dy = y === 0 ? -1 : 1; else dx = x === 0 ? -1 : 1;
  const x1 = P(x); const y1 = P(y);
  const x2 = P(x) + dx * len; const y2 = P(y) + dy * len;
  const cls = `cord ${color} ${lit ? 'lit' : ''}`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>` +
    `<circle cx="${x2}" cy="${y2}" r="${U * 0.14}" class="cordcap ${color} ${lit ? 'lit' : ''}"/>`;
}

// 勝利ラインの点順（始点→終点）を、勝った色の並びで復元する
function winFlowChain(color, path) {
  if (!path || !path.length) return [];
  const segs = [];
  const [fx, fy] = path[0].split(',').map(Number);
  const [p0, p1] = endpoints(color, fx, fy);
  let current = isStart(color, p0[0], p0[1]) ? p0 : p1;
  for (const k of path) {
    const [mx, my] = k.split(',').map(Number);
    const [p, q] = endpoints(color, mx, my);
    const next = (p[0] === current[0] && p[1] === current[1]) ? q : p;
    segs.push({ from: current, to: next });
    current = next;
  }
  return segs;
}

function boardSVG(v) {
  const g = v.game;
  const n = g.n;
  const M = 2 * n * U;
  const pad = U * 1.1;
  const P = (c) => c * U;
  const line = (a, b, cls, extra = '') => `<line x1="${P(a[0])}" y1="${P(a[1])}" x2="${P(b[0])}" y2="${P(b[1])}" class="${cls}" ${extra}/>`;
  const last = g.moves[g.moves.length - 1];
  const fresh = S.lastMoveCount !== g.moves.length;
  const winSet = new Set(g.winPath || []);
  const finished = !!g.winner;
  const poweredByColor = { R: powered(n, g.owner, 'R'), B: powered(n, g.owner, 'B') };

  let out = '';
  // 配線コード（始点・終点の目印）。始点側は常に通電中＝常時光る
  for (const color of ['R', 'B']) {
    const litSet = poweredByColor[color].seen;
    for (const [x, y] of colorDots(n, color)) {
      const edge = color === 'R' ? (y === 0 || y === 2 * n) : (x === 0 || x === 2 * n);
      if (!edge) continue;
      out += cordStub(n, color, x, y, litSet.has(key(x, y)));
    }
  }

  // 線（自分/相手が引いた配線）。直前の一手だけ光らせて分かりやすく
  for (const [k, color] of Object.entries(g.owner)) {
    const [mx, my] = k.split(',').map(Number);
    const [a, b] = endpoints(color, mx, my);
    const isLast = last && last.mx === mx && last.my === my;
    const isWin = winSet.has(k);
    out += line(a, b, `wire ${color} ${isLast && !finished ? 'last' : ''} ${isLast && fresh ? 'zap' : ''} ${isWin ? 'win' : ''}`);
    if (isLast && !finished) {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      out += `<circle cx="${P(mid[0])}" cy="${P(mid[1])}" r="${U * 0.1}" class="lastmark"/>`;
    }
  }
  // 電流アニメーションは勝敗が決まったときだけ：勝ったラインに沿って上下/左右に流す
  if (finished && g.winner) {
    for (const f of winFlowChain(g.winner, g.winPath)) out += line(f.from, f.to, `flow ${g.winner}`);
  }
  // 点
  const active = inputColor(g); // いま線を引ける色（対局中は自分の手番の自分の色、検討中は手番の色）
  for (const color of ['R', 'B']) {
    for (const [x, y] of colorDots(n, color)) {
      const mine = color === active;
      const sel = S.tapFrom && S.tapFrom[0] === x && S.tapFrom[1] === y;
      out += `<circle cx="${P(x)}" cy="${P(y)}" r="${U * 0.34}" class="dot ${color} ${mine ? 'mine' : ''} ${sel ? 'sel' : ''}" data-x="${x}" data-y="${y}"/>`;
    }
  }
  // 解析モード：AIの最善手を点線で示す（点に隠れないよう点より手前に描く）
  if (g.hint) {
    const [a, b] = endpoints(g.hint.color, g.hint.mx, g.hint.my);
    out += line(a, b, `hint ${g.hint.color}`);
    out += `<circle cx="${P(g.hint.mx)}" cy="${P(g.hint.my)}" r="${U * 0.22}" class="hintmark"/>`;
  }
  out += `<line id="dragLine" class="drag ${active || ''}" x1="0" y1="0" x2="0" y2="0" visibility="hidden"/>`;
  out += `<circle id="dragTip" class="tip" r="${U * 0.22}" cx="0" cy="0" visibility="hidden"/>`;
  S.lastMoveCount = g.moves.length;
  return `<svg class="board ${active ? 'active' : ''}" viewBox="${-pad} ${-pad} ${M + 2 * pad} ${M + 2 * pad}" data-n="${n}">${out}</svg>`;
}

// ---------- 振り返り・検討 ----------
// S.review: 本譜の何手目の局面か。S.branch: そこから試している変化手順 { base, moves, pos }（pos 手目までを表示）
// サーバーの game.js と同じ手順で局面を再現する（ハンデ中の連続手番も含む）
function simulate(g, list) {
  const owner = {};
  let turn = g.handicapColor || 'R';
  let rest = g.handicap || 0;
  let winner = null; let winPath = null;
  for (const m of list) {
    owner[key(m.mx, m.my)] = m.color;
    const path = winPathOf(g.n, owner, m.color);
    if (path) { winner = m.color; winPath = path; break; }
    if (rest > 0) { rest--; if (!rest) turn = g.handicapColor === 'R' ? 'B' : 'R'; } else turn = m.color === 'R' ? 'B' : 'R';
  }
  return { owner, turn: winner ? null : turn, winner, winPath };
}

// 振り返り中に表示している局面の手順（本譜＋変化）
function reviewMoves(g) {
  const b = S.branch;
  return b ? [...g.moves.slice(0, b.base), ...b.moves.slice(0, b.pos)] : g.moves.slice(0, S.review);
}

function reviewState(g) {
  const moves = reviewMoves(g);
  const sim = simulate(g, moves);
  // 投了で終わった本譜の最終局面は、盤上がつながっていなくても勝敗を表示する
  const end = !S.branch && S.review === g.moves.length;
  return {
    ...g, owner: sim.owner, moves, phase: 'review', turn: sim.turn, handicapRemaining: 0,
    winner: end ? g.winner : sim.winner, winPath: end ? g.winPath : sim.winPath,
  };
}

// 盤上で線を引ける色（引けなければ null）
function inputColor(g) {
  if (g.phase === 'review') return g.winner ? null : g.turn;
  return g.phase === 'play' && g.turn === g.myColor ? g.myColor : null;
}

// 検討中に盤へ線を引いた：本譜・変化と同じ手ならそのまま進み、違う手なら新しい変化にする
function addReviewMove(mx, my, color) {
  const g = S.view.game;
  const same = (m) => m && m.mx === mx && m.my === my;
  const b = S.branch;
  if (!b) {
    if (same(g.moves[S.review])) S.review++;
    else S.branch = { base: S.review, moves: [{ mx, my, color }], pos: 1 };
  } else if (same(b.moves[b.pos])) {
    b.pos++;
  } else {
    b.moves = [...b.moves.slice(0, b.pos), { mx, my, color }];
    b.pos++;
  }
  render();
}

// ---------- 解析（振り返り・検討中の局面をサーバーのAIが解析） ----------
const gameSig = (g) => `${g.n}|${g.handicap}${g.handicapColor || ''}|${g.moves.map((m) => `${m.mx},${m.my}`).join(';')}`;

// 解析済みなら結果を返す。未解析なら少し待ってから問い合わせる（手を続けて送ったときに無駄打ちしない）
function getAnalysis(g) {
  const b = S.branch;
  const idx = b ? b.base : S.review;
  const extra = b ? b.moves.slice(0, b.pos).map((m) => [m.mx, m.my]) : [];
  const k = `${gameSig(g)}@${idx}+${extra.join(';')}`;
  if (S.anCache.has(k)) return S.anCache.get(k);
  if (S.anWant !== k) {
    S.anWant = k;
    S.anErr = null;
    clearTimeout(S.anTimer);
    S.anTimer = setTimeout(async () => {
      try {
        const r = await api('/api/action', { roomId: S.roomId, token: S.token, type: 'analyze', idx, extra });
        S.anCache.set(k, r);
      } catch (e) {
        if (S.anWant === k) S.anErr = e.message;
      }
      if (S.anWant === k && S.review != null) render();
    }, 200);
  }
  return null;
}

function analysisPanel(v, real, a) {
  const nameOf = (c) => esc(v.seats[real.seatColors.indexOf(c)].name);
  const colored = (c) => `<b class="${c}">${COLOR_NAME[c]}</b>`;
  if (!a) {
    return `<div class="analysis"><h3>🤖 AI解析</h3>
      <p class="${S.anErr ? 'conn' : 'wait'}">${S.anErr ? `解析できませんでした（${esc(S.anErr)}）` : '解析中…'}</p></div>`;
  }
  if (a.over) {
    return `<div class="analysis"><h3>🤖 AI解析</h3><p>この局面で ${colored(a.theory)}（${nameOf(a.theory)}）の勝ちが決まっています。</p></div>`;
  }
  return `<div class="analysis">
    <h3>🤖 AI解析</h3>
    <dl>
      <dt>次の手番</dt><dd>${colored(a.turn)}（${nameOf(a.turn)}）</dd>
      <dt>最善手</dt><dd>盤上の <span class="hint-key ${a.turn}"></span> 点線の線</dd>
      <dt>お互い最善なら</dt><dd>${a.theory
    ? `${colored(a.theory)}（${nameOf(a.theory)}）の勝ち`
    : 'ハンデで連続して打つ途中のため判定なし'}</dd>
    </dl>
  </div>`;
}

// 先手・後手の選択肢。対面モードでは「自分／相手」ではなく2人の名前で出す
function firstsFor(v) {
  if (!v.local2p) return FIRSTS;
  return [['random', 'ランダム'], ['self', `${esc(v.seats[0].name)}が先手`], ['opp', `${esc(v.seats[1].name)}が先手`]];
}

function renderGame(v) {
  const real = v.game;
  const local = !!v.local2p; // 対面モード（1台で2人）
  const reviewing = S.review != null && real.phase === 'finished';
  const analysis = reviewing ? getAnalysis(real) : null;
  const g = reviewing ? reviewState(real) : real;
  S.boardState = g;
  if (analysis && analysis.best) g.hint = { color: analysis.turn, mx: analysis.best[0], my: analysis.best[1] };
  const N = real.moves.length;
  const me = v.me;
  const myColor = g.myColor;
  const myTurn = g.phase === 'play' && g.turn === myColor;
  const seatOf = (c) => g.seatColors.indexOf(c);
  const player = (c) => {
    const i = seatOf(c);
    const s = v.seats[i];
    const lit = myTurn && c === myColor; // 自分の手番の時だけ自分の色を光らせる。相手の手番の時はどちらも鎮める
    return `<div class="pl ${c} ${lit ? 'turn' : ''}">
      <span class="swatch"></span>
      <span class="nm">${esc(s.name)}${i === me && !local ? '（あなた）' : ''}</span>
      <span class="goal">${c === 'R' ? '上↕下' : '左↔右'}</span>
      ${g.handicapColor === c ? `<span class="tag handicap">ハンデ+${g.handicap}</span>` : ''}
      <span class="wins">${v.wins[i]}勝</span>
      ${!s.connected ? '<span class="tag off">切断中</span>' : ''}
      ${v.isHost && !s.connected && !s.isAI ? `<button class="btn ghost small" data-act="replaceAI" data-seat="${i}">AIに交代</button>` : ''}
    </div>`;
  };

  let status;
  if (reviewing) {
    const b = S.branch;
    const shown = g.moves.length;
    const m = g.moves[shown - 1];
    const head = b ? `<span class="tag branch">検討中</span> 本譜${b.base}手目からの変化：<b>${shown}</b>手目` : `振り返り：<b>${S.review}</b> / ${N}手目`;
    const what = m ? `　<b class="${m.color}">${esc(v.seats[seatOf(m.color)].name)}</b>（${COLOR_NAME[m.color]}）の手` : '　何も打っていない盤面';
    const result = b && g.winner ? `　→ <b class="${g.winner}">${COLOR_NAME[g.winner]}</b>の勝ち` : '';
    status = `${head}${what}${result}<br><span class="note">盤上で線を引くと、本譜と違う手を試せます</span>`;
  } else if (g.phase === 'finished') {
    const winSeat = seatOf(g.winner);
    const who = myColor ? (g.winner === myColor ? 'あなたの勝ち！' : 'あなたの負け…') : `<b class="${g.winner}">${esc(v.seats[winSeat].name)}</b> の勝ち！`;
    status = `${who}${g.resigned ? '（投了）' : ''}`;
  } else if (local && g.phase === 'play') {
    // 対面モード：いま打つ人の名前を大きく出す
    const s = v.seats[seatOf(g.turn)];
    status = g.handicapRemaining > 0
      ? `<b class="${g.turn}">${esc(s.name)}</b>（${COLOR_NAME[g.turn]}）の番：ハンデであと <b>${g.handicapRemaining}手</b> 自由に打てます`
      : `<b class="${g.turn}">${esc(s.name)}</b>（${COLOR_NAME[g.turn]}）の番：${COLOR_NAME[g.turn]}の点から隣の点へ線を引こう`;
  } else if (g.handicapRemaining > 0 && myTurn) {
    status = `あなたはハンデであと <b>${g.handicapRemaining}手</b> 自由に打てます：<b class="${myColor}">${COLOR_NAME[myColor]}</b>の点から隣の点へ`;
  } else if (g.handicapRemaining > 0) {
    const s = v.seats[seatOf(g.turn)];
    status = `<b class="${g.turn}">${esc(s.name)}</b> がハンデ中（あと${g.handicapRemaining}手）…`;
  } else if (myTurn) {
    status = `あなたの番：<b class="${myColor}">${COLOR_NAME[myColor]}</b>の点から隣の点へドラッグして線を引こう`;
  } else {
    const s = v.seats[seatOf(g.turn)];
    status = `<b class="${g.turn}">${esc(s.name)}</b> が考えています…`;
  }
  // 一手戻る：AI対戦なら即時、友達対局なら相手に申請して許可をもらう
  const req = g.phase === 'play' ? v.undoReq : null;
  const vsAI = me >= 0 && v.seats[1 - me] && v.seats[1 - me].isAI;
  const askedByOpp = req && me >= 0 && req.seat !== me;
  let undoUI = '';
  if (g.phase === 'play' && myColor) {
    const canTry = g.moves.length > 0;
    if (vsAI || local) undoUI = `<button class="btn ghost small" data-act="undo" ${canTry ? '' : 'disabled'}>↩ 一手戻る</button>`;
    else if (req && req.seat === me) undoUI = '<span class="note wait">一手戻るを申請中…</span><button class="btn ghost small" data-act="undoCancel">申請を取り消す</button>';
    else if (!req) undoUI = `<button class="btn ghost small" data-act="undo" ${canTry ? '' : 'disabled'}>↩ 一手戻るを申請</button>`;
  }
  const askBox = askedByOpp ? `<div class="undo-ask">
    <span><b>${esc(v.seats[req.seat].name)}</b> が「一手戻る」を申請しています。許可しますか？</span>
    <span class="row">
      <button class="btn small" data-act="undoAnswer" data-accept="1">OK</button>
      <button class="btn ghost small" data-act="undoAnswer" data-accept="0">拒否</button>
    </span>
  </div>` : '';
  document.title = askedByOpp ? '↩ 一手戻るの申請 - スパークリンク' : myTurn ? '▶ あなたの番！ - スパークリンク' : 'スパークリンク';

  const atStart = !S.branch && S.review === 0;
  const atEnd = S.branch ? S.branch.pos === S.branch.moves.length : S.review === N;
  const finished = g.phase === 'finished';
  const iWon = finished && !local && g.winner === myColor;
  const showWin = finished && S.winShown !== g.moves.length + ':' + g.winner;
  if (finished) S.winShown = g.moves.length + ':' + g.winner;

  $app.innerHTML = `
  <div class="topbar">
    <span class="title-font brand">⚡ スパークリンク</span>
    ${S.offline ? '<span class="conn">⚠ 再接続中…</span>' : ''}
    <span class="spacer"></span>
    <button class="btn ghost small" data-act="rules">📖 ルール</button>
    ${v.isHost ? '<button class="btn ghost small" data-act="toLobby">ロビーへ</button>' : ''}
  </div>
  <div class="players">${player('R')}${player('B')}</div>
  <div class="status ${myTurn ? 'mine' : ''}"><span>${status}</span></div>
  ${askBox}
  <div class="board-wrap">
    ${boardSVG({ ...v, game: g })}
    ${finished ? `<div class="win-banner ${g.winner} ${showWin ? 'pop' : ''}">
      <div class="big title-font">${iWon ? '⚡ あなたの勝ち！' : myColor && !local ? 'あなたの負け…' : `⚡ ${esc(v.seats[seatOf(g.winner)].name)} の勝ち！`}</div>
      <div>${myColor && !local ? `${esc(v.seats[seatOf(g.winner)].name)}（${COLOR_NAME[g.winner]}）の勝ち` : `${COLOR_NAME[g.winner]}の勝ち`}${g.resigned ? '（投了）' : ''}</div>
    </div>` : ''}
  </div>
  <div class="actions">
    ${undoUI}
    ${g.phase === 'play' && myColor ? '<button class="btn ghost small" data-act="resign">投了</button>' : ''}
    ${reviewing ? `<div class="review">
      ${S.branch ? `<div class="main-line"><button class="btn" data-act="rvMain">↩ 本譜に戻る（${S.branch.base}手目）</button></div>` : ''}
      <button class="btn ghost small" data-act="rvFirst" ${atStart ? 'disabled' : ''}>⏮ 最初</button>
      <button class="btn small" data-act="rvPrev" ${atStart ? 'disabled' : ''}>◀ 1手戻る</button>
      <button class="btn small" data-act="rvNext" ${atEnd ? 'disabled' : ''}>1手進む ▶</button>
      <button class="btn ghost small" data-act="rvLast" ${atEnd ? 'disabled' : ''}>最後 ⏭</button>
      <button class="link" data-act="rvExit">振り返りを終える</button>
      <span class="note" style="flex-basis:100%;text-align:center">キーボードの ← → でも操作できます</span>
      ${analysisPanel(v, real, analysis)}
    </div>` : ''}
    ${finished ? '<button class="btn ghost" data-act="rvStart">📼 この対局を振り返る</button>' : ''}
    ${finished && v.isHost ? `<div class="rematch">
      ${v.watch ? '' : seg('rematchFirst', firstsFor(v), S.rematchFirst || v.firstChoice)}
      <button class="btn big" data-act="start">再戦する</button>
    </div>` : ''}
    ${finished && !v.isHost ? '<p class="note">ホストの再戦を待っています…</p>' : ''}
  </div>
  <p class="note center">${S.tapFrom ? 'つなぐ先の点をタップ（別の場所をタップでキャンセル）' : '手数 ' + g.moves.length}</p>`;
}

// ---------- pointer (drag & tap) ----------
function svgPoint(svg, e) {
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: pt.x / U, y: pt.y / U };
}

// 自分の手はサーバーの返事を待たずに即座に盤へ反映する（エラーなら元に戻す）
function sendMove(from, to) {
  const mx = (from[0] + to[0]) / 2;
  const my = (from[1] + to[1]) / 2;
  S.tapFrom = null;
  const shown = S.boardState;
  if (shown && shown.phase === 'review') {
    if (shown.owner[key(mx, my)]) return render();
    return addReviewMove(mx, my, shown.turn);
  }
  const before = S.view;
  const g = before.game;
  const k = key(mx, my);
  const color = g.myColor;
  if (g.owner[k]) return render();
  const opp = color === 'R' ? 'B' : 'R';
  const ng = { ...g, owner: { ...g.owner, [k]: color }, moves: [...g.moves, { mx, my, color }] };
  if (ng.handicapRemaining > 0) { ng.handicapRemaining--; if (!ng.handicapRemaining) ng.turn = opp; } else ng.turn = opp;
  const path = winPathOf(ng.n, ng.owner, color);
  if (path) Object.assign(ng, { phase: 'finished', winner: color, winPath: path });
  S.view = { ...before, game: ng };
  render();
  api('/api/action', { roomId: S.roomId, token: S.token, type: 'move', mx, my }).catch((e) => {
    toast(e.message);
    if (S.view && S.view.game === ng) { S.view = before; render(); }
  });
}

function setTargets(svg, list) {
  svg.querySelectorAll('.dot.target').forEach((d) => d.classList.remove('target'));
  for (const [x, y] of list) {
    const el = svg.querySelector(`.dot[data-x="${x}"][data-y="${y}"]`);
    if (el) el.classList.add('target');
  }
}

document.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest && e.target.closest('svg.board');
  const g = S.boardState;
  if (!svg || !S.view || !S.view.game || !g) return;
  const color = inputColor(g);
  if (!color) return;
  const p = svgPoint(svg, e);

  if (S.tapFrom) {
    const t = targetsFrom(g.n, g.owner, S.tapFrom).find(([x, y]) => Math.hypot(p.x - x, p.y - y) <= 0.9);
    if (t) { e.preventDefault(); return sendMove(S.tapFrom, t); }
  }
  const d = dotNear(g.n, color, p);
  if (!d) { if (S.tapFrom) { S.tapFrom = null; render(); } return; }
  const targets = targetsFrom(g.n, g.owner, d);
  if (!targets.length) { toast('その点からは線を引けません'); return; }
  e.preventDefault();
  svg.setPointerCapture(e.pointerId);
  S.drag = { svg, from: d, targets, moved: false };
  const ln = svg.querySelector('#dragLine');
  ln.setAttribute('x1', d[0] * U); ln.setAttribute('y1', d[1] * U);
  ln.setAttribute('x2', d[0] * U); ln.setAttribute('y2', d[1] * U);
  ln.setAttribute('visibility', 'visible');
  setTargets(svg, targets);
});

document.addEventListener('pointermove', (e) => {
  const dr = S.drag;
  if (!dr) return;
  const p = svgPoint(dr.svg, e);
  if (Math.hypot(p.x - dr.from[0], p.y - dr.from[1]) > 0.5) dr.moved = true;
  const snap = dr.targets.find(([x, y]) => Math.hypot(p.x - x, p.y - y) <= 0.9);
  const end = snap || [p.x, p.y];
  const ln = dr.svg.querySelector('#dragLine');
  const tip = dr.svg.querySelector('#dragTip');
  ln.setAttribute('x2', end[0] * U); ln.setAttribute('y2', end[1] * U);
  ln.classList.toggle('snap', !!snap);
  tip.setAttribute('cx', end[0] * U); tip.setAttribute('cy', end[1] * U);
  tip.setAttribute('visibility', dr.moved ? 'visible' : 'hidden');
});

function endDrag(e, cancel) {
  const dr = S.drag;
  if (!dr) return;
  S.drag = null;
  const p = svgPoint(dr.svg, e);
  const snap = !cancel && dr.targets.find(([x, y]) => Math.hypot(p.x - x, p.y - y) <= 0.9);
  if (snap) return sendMove(dr.from, snap);
  if (!dr.moved && !cancel) {
    S.tapFrom = dr.from; // タップ操作：次に隣の点をタップ
  }
  render();
}
document.addEventListener('pointerup', (e) => endDrag(e, false));
document.addEventListener('pointercancel', (e) => endDrag(e, true));

// ---------- events ----------
function openRules(open) { document.getElementById('rules').hidden = !open; }

const handlers = {
  rules: () => openRules(true),
  closeRules: () => openRules(false),
  home: () => { history.replaceState(null, '', homePath()); renderHome(); },
  create: (el) => createRoom(el),
  join: (el) => joinRoom(el.dataset.room, el),
  joinCode: (el) => joinRoom(document.getElementById('code').value, el),
  leave: () => { if (confirm('ルームから退出しますか？')) leave(); },
  copy: () => {
    const input = document.getElementById('shareUrl');
    if (callNative('copyText', input.value)) return toast('URLをコピーしました');
    (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject())
      .then(() => toast('URLをコピーしました'))
      .catch(() => { input.select(); document.execCommand('copy'); toast('URLをコピーしました'); });
  },
  share: () => {
    const url = document.getElementById('shareUrl').value;
    const text = `⚡ スパークリンクで対戦しよう！\nURLを開いて名前を入れたら「参加する」を押してね\n${url}`;
    if (callNative('share', text)) return;
    if (navigator.share) return navigator.share({ title: 'スパークリンク', text }).catch(() => {});
    handlers.copy(); // 共有の仕組みがないブラウザでは、コピーで代用
  },
  retryInvite: () => api('/api/invite', { roomId: S.roomId, token: S.token }).catch((e) => toast(e.message)),
  mute: () => { S.muted = !S.muted; store.set('spark:muted', S.muted); applyVolume(); syncBgm(); },
  rvStart: () => { S.review = 0; S.branch = null; S.tapFrom = null; render(); },
  rvFirst: () => { S.review = 0; S.branch = null; S.tapFrom = null; render(); },
  rvPrev: () => {
    const b = S.branch;
    if (!b) S.review = Math.max(0, S.review - 1);
    else if (b.pos > 0) b.pos--;
    else { S.branch = null; S.review = Math.max(0, b.base - 1); } // 分岐点より前は本譜をたどる
    S.tapFrom = null; render();
  },
  rvNext: () => {
    const b = S.branch;
    if (b) b.pos = Math.min(b.moves.length, b.pos + 1);
    else S.review = Math.min(S.view.game.moves.length, S.review + 1);
    S.tapFrom = null; render();
  },
  rvLast: () => {
    if (S.branch) S.branch.pos = S.branch.moves.length;
    else S.review = S.view.game.moves.length;
    S.tapFrom = null; render();
  },
  rvMain: () => { S.review = S.branch.base; S.branch = null; S.tapFrom = null; render(); },
  rvExit: () => { S.review = null; S.branch = null; S.tapFrom = null; render(); },
  kick: (el) => act('kick', { seat: Number(el.dataset.seat) }),
  start: () => {
    S.tapFrom = null;
    const firstChoice = radioVal('rematchFirst');
    act('start', firstChoice ? { firstChoice } : {});
  },
  toLobby: () => { if (confirm('対局を中断してロビーに戻りますか？')) act('toLobby'); },
  replaceAI: (el) => act('replaceAI', { seat: Number(el.dataset.seat) }),
  resign: () => {
    const v = S.view;
    const g = v && v.game;
    const who = v && v.local2p && g ? `${v.seats[g.seatColors.indexOf(g.turn)].name}（${COLOR_NAME[g.turn]}）が` : '';
    if (confirm(`${who}投了しますか？`)) act('resign');
  },
  undo: () => { S.tapFrom = null; act('undo'); },
  undoCancel: () => act('undoCancel'),
  undoAnswer: (el) => act('undoAnswer', { accept: el.dataset.accept === '1' }),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && handlers[el.dataset.act]) { e.preventDefault(); if (!el.disabled) handlers[el.dataset.act](el); return; }
  if (e.target.id === 'rules') openRules(false);
});

document.addEventListener('pointerdown', syncBgm, true);

document.addEventListener('input', (e) => {
  if (e.target.id !== 'volume') return;
  S.volume = Number(e.target.value);
  S.muted = false;
  store.set('spark:volume', S.volume);
  store.set('spark:muted', false);
  applyVolume();
  syncBgm();
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'rematchFirst') { S.rematchFirst = e.target.value; return; }
  if (e.target.dataset.aiSeat != null) return act('settings', { aiSeat: Number(e.target.dataset.aiSeat), level: e.target.value });
  if (e.target.name === 'mode' || e.target.name === 'handicap') return updateHomeVisibility();
  const el = e.target.closest('[data-setting]');
  if (!el) return;
  const k = el.dataset.setting;
  const value = (k === 'size' || k === 'handicap') ? Number(el.value) : el.value;
  act('settings', { [k]: value });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { openRules(false); if (S.tapFrom) { S.tapFrom = null; render(); } }
  if (S.review != null && S.view && S.view.game && e.target.tagName !== 'INPUT') {
    if (e.key === 'ArrowLeft') handlers.rvPrev();
    if (e.key === 'ArrowRight') handlers.rvNext();
  }
  if (e.key === 'Enter' && e.target.id === 'code') handlers.joinCode(e.target.nextElementSibling);
});

// ---------- Androidアプリとの連携 ----------
// 友達対局のホスト中は、アプリを裏に回しても（LINEでURLを送る間など）通信が止まらないようにする
function syncNative() {
  const v = S.view;
  callNative('setHosting', !!(S.local && v && v.isHost && !v.hasAI && !v.local2p));
  callNative('setKeepScreenOn', !!(v && v.game));
}
// 戻るボタン：開いている物を閉じる → ルームにいれば退出の確認。true を返すとアプリは閉じない
window.__appBack = () => {
  if (!document.getElementById('rules').hidden) { openRules(false); return true; }
  if (S.tapFrom) { S.tapFrom = null; render(); return true; }
  if (S.review != null) { handlers.rvExit(); return true; }
  if (S.roomId) {
    const closesRoom = S.local && S.view && S.view.isHost && !S.view.hasAI && !S.view.local2p;
    if (confirm(closesRoom ? 'ルームを閉じて退出しますか？（友達との対局も終わります）' : 'ルームから退出しますか？')) leave();
    return true;
  }
  return false;
};
window.__appPause = () => { S.paused = true; syncBgm(); };
window.__appResume = () => { S.paused = false; syncBgm(); };

// ---------- boot ----------
applyVolume();
(async function boot() {
  const qRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const saved = store.get('spark:session', null);
  if (saved && saved.local) {
    // 自分がホストだったルームは、アプリやページを開き直すと消えている
    store.del('spark:session');
    if (!qRoom || qRoom === saved.roomId) {
      history.replaceState(null, '', homePath());
      return renderHome();
    }
  }
  if (qRoom && saved && !saved.local && saved.roomId === qRoom) {
    try {
      Net.setLocal(false);
      const res = await api('/api/join', { roomId: qRoom, token: saved.token });
      if (res.token === saved.token) return enterRoom(res.roomId, res.token, false);
    } catch (e) { /* fall through */ }
    store.del('spark:session');
  }
  if (qRoom) return renderHome(qRoom);
  renderHome();
})();
