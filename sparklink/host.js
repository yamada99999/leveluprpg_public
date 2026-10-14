'use strict';
// スパークリンク ホスト（元の server.js のルーム管理を、スマホ・ブラウザの中で動くように移植したもの）
//
// ルームを作った端末がそのまま「サーバー」になる。
//   自分の画面      … SparkHost.request / SparkHost.poll を直接呼ぶ
//   友達の画面      … PeerJS（WebRTC）のデータ通信で同じ API を呼んでくる（net.js）
// 友達対局のルームを作ると PeerJS にホストとして登録し、友達に送るURLを画面に表示する。
(function () {
  const G = self.G;
  const CFG = window.SPARK_CONFIG;
  const AI_LEVEL_NAME = { easy: 'AI（よわい）', normal: 'AI（ふつう）', hard: 'AI（つよい）' };
  const LEVEL_JA = { easy: 'よわい', normal: 'ふつう', hard: 'つよい' };
  const POLL_HOLD_MS = 20000;
  const OFFLINE_AFTER_MS = 10000; // スマホ同士の通信は少し遅れることがあるので、PC版より長めに待つ

  const rooms = new Map();

  // ---------- helpers ----------
  const randomInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  function roomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do {
      id = Array.from({ length: 5 }, () => chars[randomInt(chars.length)]).join('');
    } while (rooms.has(id));
    return id;
  }
  const newToken = () => randomHex(18);
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || '名無し';
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  const cleanLevel = (l, d) => (['easy', 'normal', 'hard'].includes(l) ? l : d);
  const cleanFirst = (f, d) => (['random', 'self', 'opp'].includes(f) ? f : d);
  const cleanSide = (s, d) => (['self', 'opp'].includes(s) ? s : d);
  const reply = (status, json) => ({ status, json });

  // Androidアプリの中で動いているときだけ使える機能（net.js と同じ窓口）
  const native = () => (typeof window.AndroidApp === 'object' ? window.AndroidApp : null);
  function nativeHosting(on) {
    try { if (native()) native().setHosting(!!on); } catch {}
  }

  // ---------- AI（別スレッド） ----------
  let worker = null;
  let workerSeq = 0;
  const workerJobs = new Map();
  function getWorker() {
    if (worker || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker('ai-worker.js');
      worker.onmessage = (e) => {
        const job = workerJobs.get(e.data.id);
        if (!job) return;
        workerJobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.result);
      };
      worker.onerror = (e) => {
        console.error('AI worker error', e);
        for (const job of workerJobs.values()) job.reject(new Error('AIの計算に失敗しました'));
        workerJobs.clear();
        worker = null;
      };
    } catch (e) {
      console.warn('Worker が使えないため、AIを画面と同じスレッドで動かします', e);
      worker = null;
    }
    return worker;
  }
  const plainGame = (g) => ({
    n: g.n, owner: g.owner, moves: g.moves, turn: g.turn, phase: g.phase, winner: g.winner,
    handicap: g.handicap, handicapColor: g.handicapColor, handicapRemaining: g.handicapRemaining,
  });
  function runAI(op, game, level) {
    const w = getWorker();
    if (!w) {
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve(op === 'move' ? G.aiMove(game, level) : G.analyze(game)); } catch (e) { reject(e); }
      }, 0));
    }
    return new Promise((resolve, reject) => {
      const id = ++workerSeq;
      workerJobs.set(id, { resolve, reject });
      w.postMessage({ id, op, game: plainGame(game), level });
    });
  }

  // ---------- 友達招待（PeerJS） ----------
  let peer = null;
  let peerRoom = null;
  const conns = new Set();

  function inviteUrl(id) {
    // 公開ページ（GitHub Pages など）をブラウザで開いているならそのURL、アプリ内なら設定のURL
    const onPublicPage = /^https?:$/.test(location.protocol) && !/androidplatform\.net$|^(localhost|127\.|\[::1\])/.test(location.hostname);
    const base = onPublicPage ? location.origin + location.pathname.replace(/[^/]*$/, '') : CFG.publicUrl;
    return `${base}${base.endsWith('/') ? '' : '/'}?room=${id}`;
  }

  function setInvite(room, patch) {
    room.invite = { ...room.invite, ...patch };
    broadcast(room);
  }

  function closePeer() {
    const p = peer;
    peer = null;
    peerRoom = null;
    for (const c of conns) { try { c.close(); } catch {} }
    conns.clear();
    if (p) { try { p.destroy(); } catch {} }
    nativeHosting(false);
  }

  function openPeer(room) {
    closePeer();
    if (typeof window.Peer !== 'function') return setInvite(room, { status: 'failed', url: inviteUrl(room.id), error: '通信ライブラリを読み込めませんでした' });
    // 招待URLはルームコードだけで決まるので、接続の準備を待たずにすぐ見せる（先に送っておける）
    setInvite(room, { status: 'starting', url: inviteUrl(room.id), error: null });
    const p = new window.Peer(CFG.peerPrefix + room.id, CFG.peerOptions);
    peer = p;
    peerRoom = room;
    nativeHosting(true);
    const failTimer = setTimeout(() => {
      if (peer === p && room.invite.status === 'starting') setInvite(room, { status: 'failed', error: '接続サーバーから応答がありません。インターネット接続を確認して「再試行」してください' });
    }, 20000);
    p.on('open', () => {
      if (peer !== p) return;
      clearTimeout(failTimer);
      setInvite(room, { status: 'ready', url: inviteUrl(room.id), error: null });
    });
    p.on('connection', (conn) => { if (peer === p) acceptConn(conn); else conn.close(); });
    // 接続サーバーとの接続が切れても、友達との直通は生きている。新しく参加する人のために再登録する
    p.on('disconnected', () => {
      setTimeout(() => {
        if (peer === p && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch {} }
      }, 1500);
    });
    p.on('error', (e) => {
      if (peer !== p) return;
      console.warn('peer error', e.type, e);
      if (e.type === 'unavailable-id') {
        // ルームコードが他の人と重なった：コードを振り直して登録し直す
        clearTimeout(failTimer);
        rooms.delete(room.id);
        room.id = roomCode();
        rooms.set(room.id, room);
        return openPeer(room);
      }
      if (room.invite.status !== 'ready') {
        clearTimeout(failTimer);
        setInvite(room, { status: 'failed', error: `友達招待の準備に失敗しました（${e.type || e.message}）。インターネット接続を確認して「再試行」してください` });
      }
    });
  }

  // 友達の端末からのデータ通信。{ id, path, body } を受けて { id, status, json } を返す
  const REMOTE_PATHS = new Set(['/api/info', '/api/join', '/api/action', '/api/poll']);
  function acceptConn(conn) {
    conns.add(conn);
    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const send = (r) => { if (conn.open) { try { conn.send({ id: msg.id, status: r.status, json: r.json }); } catch {} } };
      if (!REMOTE_PATHS.has(msg.path)) return send(reply(404, { error: 'not found' }));
      if (msg.path === '/api/poll') return handlePoll(msg.body || {}, { send, conn });
      try {
        send(await handleApi(msg.path, msg.body || {}));
      } catch (e) {
        console.error(e);
        send(reply(500, { error: 'ホスト側でエラーが発生しました' }));
      }
    });
    const gone = () => {
      if (!conns.delete(conn)) return;
      for (const room of rooms.values()) {
        for (const w of [...room.waiters]) {
          if (w.conn !== conn) continue;
          clearTimeout(w.timer);
          room.waiters.delete(w);
          room.lastSeen.set(w.token, Date.now());
        }
      }
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  // ---------- room / view ----------
  function isConnected(room, seat) {
    if (seat.isAI || seat.local) return true; // AIと、対面モードの相手（同じ端末）は常に接続中
    for (const w of room.waiters) if (w.token === seat.token) return true;
    return Date.now() - (room.lastSeen.get(seat.token) || 0) < OFFLINE_AFTER_MS;
  }

  function colorOfSeat(room, seat) {
    const g = room.game;
    if (!g) return null;
    return seat === g.redSeat ? G.R : G.B;
  }
  const seatOfColor = (room, color) => [0, 1].find((s) => colorOfSeat(room, s) === color);

  function viewFor(room, token) {
    const me = room.seats.findIndex((s) => s.token === token);
    const view = {
      v: room.version,
      roomId: room.id,
      status: room.status,
      isHost: token === room.hostToken,
      me,
      size: room.size,
      firstChoice: room.firstChoice,
      handicap: room.handicap,
      handicapFor: room.handicapFor,
      aiLevel: room.aiLevel,
      hasAI: room.seats.some((s) => s.isAI),
      watch: !!room.watch,
      local2p: !!room.local2p,
      wins: room.wins,
      undoReq: room.undoReq ? { seat: room.undoReq.seat } : null,
      undoNotice: room.undoNotice || null,
      invite: room.invite,
      seats: room.seats.map((s) => ({
        name: s.name, isAI: s.isAI, level: s.isAI ? s.level : null, connected: isConnected(room, s),
        isHost: s.token === room.hostToken,
      })),
    };
    const g = room.game;
    if (g) {
      view.game = {
        n: g.n,
        owner: g.owner,
        moves: g.moves,
        turn: g.turn,
        phase: g.phase,
        winner: g.winner,
        winPath: g.winPath,
        resigned: g.resigned,
        handicap: g.handicap,
        handicapColor: g.handicapColor,
        handicapRemaining: g.handicapRemaining,
        seatColors: [colorOfSeat(room, 0), colorOfSeat(room, 1)],
        // 対面モードは1台で両方の色を打つので、手番の色がそのまま「自分の色」
        myColor: room.local2p ? (g.phase === 'play' ? g.turn : null) : me >= 0 ? colorOfSeat(room, me) : null,
        log: g.log.slice(-40),
      };
    }
    // 自分の画面には同じオブジェクトが渡るので、描画側で書き換えても影響しないよう複製する
    return JSON.parse(JSON.stringify(view));
  }

  function connSignature(room) {
    return room.seats.map((s) => (isConnected(room, s) ? 1 : 0)).join('');
  }

  function broadcast(room) {
    room.version++;
    room.lastActive = Date.now();
    room.connSig = connSignature(room);
    const waiters = [...room.waiters];
    room.waiters.clear();
    for (const w of waiters) {
      clearTimeout(w.timer);
      room.lastSeen.set(w.token, Date.now());
      w.send(reply(200, viewFor(room, w.token)));
    }
  }

  const COLOR_NAME = { R: '赤', B: '青' };
  const nameOfColor = (room, c) => room.seats[seatOfColor(room, c)].name;

  // 局面の識別子（AIの計算中に一手戻る等で局面が変わったら、その計算結果は捨てる）
  function stateKey(g) {
    return `${g.phase}:${g.handicapRemaining}:${g.moves.map((m) => `${m.mx},${m.my}`).join(';')}`;
  }

  function schedule(room) {
    const g = room.game;
    if (!g || g.phase !== 'play') return;
    const k = stateKey(g);
    if (room.scheduledKey === k) return;
    room.scheduledKey = k;
    const seat = seatOfColor(room, g.turn);
    if (!room.seats[seat] || !room.seats[seat].isAI) return;
    setTimeout(async () => {
      if (room.game !== g || stateKey(g) !== k) return;
      const color = g.turn;
      let mv;
      try {
        mv = await runAI('move', g, room.seats[seat].level || room.aiLevel);
      } catch (e) {
        console.error(e);
        room.scheduledKey = null;
        return setTimeout(() => schedule(room), 1000);
      }
      if (room.game !== g || stateKey(g) !== k || !room.seats[seat] || !room.seats[seat].isAI) return;
      G.play(g, color, mv[0], mv[1]);
      afterChange(room);
    }, room.watch ? 600 : 300 + Math.random() * 400);
  }

  function afterChange(room) {
    const g = room.game;
    if (g && g.phase === 'finished' && !g.counted) {
      g.counted = true;
      const ws = seatOfColor(room, g.winner);
      room.wins[ws]++;
      if (g.resigned) G.addLog(g, `🏳 ${nameOfColor(room, g.resigned)} が投了`);
      G.addLog(g, `⚡ ${room.seats[ws].name}（${COLOR_NAME[g.winner]}）の勝ち！`);
      room.status = 'finished';
    }
    if (room.undoReq && (!g || g.phase !== 'play')) room.undoReq = null;
    broadcast(room);
    schedule(room);
  }

  let undoNoticeId = 0;
  function setUndoNotice(room, seat, result) {
    room.undoNotice = { id: ++undoNoticeId, seat, result };
  }

  function aiName(room, level, index) {
    return room.watch ? `AI-${index + 1}（${LEVEL_JA[level]}）` : AI_LEVEL_NAME[level];
  }

  function aiSeat(room, level, index) {
    const lv = cleanLevel(level, room.aiLevel);
    return { token: newToken(), isAI: true, level: lv, name: aiName(room, lv, index) };
  }

  // ルームを閉じる（参加者には「閉じられた」と伝える）
  function closeRoom(room, msg) {
    for (const w of [...room.waiters]) {
      clearTimeout(w.timer);
      w.send(reply(200, { fatal: msg }));
    }
    room.waiters.clear();
    rooms.delete(room.id);
    if (peerRoom === room) closePeer();
  }

  // ルームコードかトークンでルームを探す（コードの振り直しがあっても参加者が迷子にならないように）
  function findRoom(id, token) {
    const room = rooms.get(String(id || '').toUpperCase());
    if (room) return room;
    if (!token) return null;
    for (const r of rooms.values()) if (r.hostToken === token || r.seats.some((s) => s.token === token)) return r;
    return null;
  }

  // ---------- API ----------
  // q = { room, token, v }。res = { send(reply), conn }
  function handlePoll(q, res) {
    const token = q.token;
    const room = findRoom(q.room, token);
    if (!room || (token !== room.hostToken && !room.seats.some((s) => s.token === token))) {
      return res.send(reply(200, { fatal: 'ルームが見つからないか、参加が取り消されました' }));
    }
    room.lastSeen.set(token, Date.now());
    if (Number(q.v) !== room.version) return res.send(reply(200, viewFor(room, token)));
    const w = { token, send: res.send, conn: res.conn || null, timer: null };
    w.timer = setTimeout(() => {
      room.waiters.delete(w);
      room.lastSeen.set(token, Date.now());
      w.send(reply(200, viewFor(room, token)));
    }, POLL_HOLD_MS);
    room.waiters.add(w);
  }

  async function handleApi(path, body, local) {
    if (path === '/api/info') return reply(200, { app: 'sparklink' });

    if (path === '/api/invite') {
      // 招待の準備をやり直す（自分の画面からのみ）
      const room = local && findRoom(body.roomId, body.token);
      if (!room || body.token !== room.hostToken) return reply(403, { error: 'ホストのみ操作できます' });
      if (room.invite.status !== 'ready') openPeer(room);
      return reply(200, { ok: true });
    }

    if (path === '/api/create') {
      if (!local) return reply(403, { error: 'ルームは作れません' });
      // この端末で同時にホストするルームは1つだけ
      for (const r of [...rooms.values()]) closeRoom(r, 'ホストが新しいルームを作ったため、このルームは閉じられました');
      const id = roomCode();
      const token = newToken();
      const room = {
        id,
        hostToken: token,
        size: clamp(body.size, 3, 9, 6),
        firstChoice: cleanFirst(body.firstChoice, 'random'),
        handicap: clamp(body.handicap, 0, 6, 0),
        handicapFor: cleanSide(body.handicapFor, 'self'),
        aiLevel: cleanLevel(body.aiLevel, 'normal'),
        seats: [{ token, name: cleanName(body.name), isAI: false }],
        wins: [0, 0],
        waiters: new Set(),
        lastSeen: new Map([[token, Date.now()]]),
        version: 1,
        connSig: '',
        game: null,
        status: 'lobby',
        scheduledKey: null,
        lastActive: Date.now(),
        undoReq: null, // 友達対局の「一手戻る」申請 { seat }
        undoNotice: null, // 申請の結果 { id, seat, result: accepted | rejected | expired }
        invite: { status: 'off', url: null, error: null }, // off | starting | ready | failed
      };
      if (body.watch) {
        // AI同士の観戦：ホストは席に座らず見るだけ
        room.watch = true;
        room.handicap = 0;
        room.seats = [aiSeat(room, body.aiLevel, 0), aiSeat(room, body.aiLevel2, 1)];
      } else if (body.local2p) {
        // 対面モード：この端末を回して2人で遊ぶ。通信はしない
        room.local2p = true;
        room.seats.push({ token: newToken(), name: cleanName(body.name2), isAI: false, local: true });
      } else if (body.vsAI) {
        room.seats.push(aiSeat(room, body.aiLevel, 1));
      }
      rooms.set(id, room);
      if (!body.watch && !body.vsAI && !body.local2p) openPeer(room);
      return reply(200, { roomId: room.id, token });
    }

    const room = findRoom(body.roomId, body.token);
    if (!room) return reply(404, { error: 'ルームが見つかりません（URLを確認するか、ホストに新しく作ってもらってください）' });

    if (path === '/api/join') {
      if (body.token && (body.token === room.hostToken || room.seats.some((s) => s.token === body.token && !s.isAI))) {
        return reply(200, { roomId: room.id, token: body.token });
      }
      if (room.status !== 'lobby') return reply(409, { error: 'ゲームはすでに始まっています' });
      if (room.seats.length >= 2) return reply(409, { error: 'ルームが満員です' });
      const token = newToken();
      room.seats.push({ token, name: cleanName(body.name), isAI: false });
      room.lastSeen.set(token, Date.now());
      afterChange(room);
      return reply(200, { roomId: room.id, token });
    }

    if (path === '/api/leave') {
      // ホストが退出したらルームを閉じる（自分の画面からのみ）
      if (local && body.token === room.hostToken) closeRoom(room, 'ホストがルームを閉じました');
      return reply(200, { ok: true });
    }

    if (path !== '/api/action') return reply(404, { error: 'not found' });

    const token = body.token;
    const me = room.seats.findIndex((s) => s.token === token);
    if (me < 0 && token !== room.hostToken) return reply(403, { error: 'このルームの参加者ではありません' });
    room.lastSeen.set(token, Date.now());
    const isHost = token === room.hostToken;
    const notHost = () => (isHost ? null : reply(403, { error: 'ホストのみ操作できます' }));
    const ok = () => { afterChange(room); return reply(200, { ok: true }); };
    const fail = (msg) => reply(400, { error: msg });
    const g = room.game;

    switch (body.type) {
      case 'settings': {
        if (notHost()) return notHost();
        if (room.status === 'playing') return fail('対局中は変更できません');
        if (body.size != null) room.size = clamp(body.size, 3, 9, room.size);
        if (body.firstChoice != null) room.firstChoice = cleanFirst(body.firstChoice, room.firstChoice);
        if (body.handicap != null) room.handicap = clamp(body.handicap, 0, 6, room.handicap);
        if (body.handicapFor != null) room.handicapFor = cleanSide(body.handicapFor, room.handicapFor);
        if (body.aiSeat != null) {
          const i = Number(body.aiSeat);
          const s = room.seats[i];
          if (!s || !s.isAI) return fail('その席はAIではありません');
          s.level = cleanLevel(body.level, s.level);
          s.name = aiName(room, s.level, i);
          room.aiLevel = s.level;
        }
        return ok();
      }
      case 'kick': {
        if (notHost()) return notHost();
        if (room.local2p) return fail('対面モードでは外せません');
        if (room.status === 'playing') return fail('対局中は操作できません');
        const i = Number(body.seat);
        if (!room.seats[i] || room.seats[i].token === room.hostToken) return fail('その席は外せません');
        const [removed] = room.seats.splice(i, 1);
        for (const w of [...room.waiters]) {
          if (w.token !== removed.token) continue;
          clearTimeout(w.timer);
          room.waiters.delete(w);
          w.send(reply(200, { fatal: 'ホストによってルームから外されました' }));
        }
        room.lastSeen.delete(removed.token);
        room.wins = [0, 0];
        room.game = null;
        room.status = 'lobby';
        return ok();
      }
      case 'start': {
        if (notHost()) return notHost();
        if (room.status === 'playing') return fail('すでに対局中です');
        if (room.seats.length < 2) return fail('2人そろうと開始できます');
        if (body.firstChoice != null) room.firstChoice = cleanFirst(body.firstChoice, room.firstChoice);
        const hostSeat = room.seats.findIndex((s) => s.token === room.hostToken);
        const otherSeat = 1 - hostSeat;
        let redSeat;
        if (hostSeat < 0) redSeat = room.game ? 1 - room.game.redSeat : 0; // 観戦：対局ごとに先手を交代
        else if (room.firstChoice === 'self') redSeat = hostSeat;
        else if (room.firstChoice === 'opp') redSeat = otherSeat;
        else redSeat = randomInt(2);
        let handicapColor = null;
        if (room.handicap > 0 && hostSeat >= 0) {
          const recipientSeat = room.handicapFor === 'self' ? hostSeat : otherSeat;
          handicapColor = recipientSeat === redSeat ? G.R : G.B;
        }
        room.game = G.createGame(room.size, room.handicap, handicapColor);
        room.game.redSeat = redSeat;
        room.scheduledKey = null;
        room.undoReq = null;
        room.status = 'playing';
        G.addLog(room.game, `対局開始！ 赤（先手）：${room.seats[redSeat].name} ／ 青：${room.seats[1 - redSeat].name}`);
        if (handicapColor) G.addLog(room.game, `ハンデ：${nameOfColor(room, handicapColor)}（${COLOR_NAME[handicapColor]}）が自由に${room.handicap}手打てます`);
        return ok();
      }
      case 'toLobby': {
        if (notHost()) return notHost();
        room.game = null;
        room.status = 'lobby';
        return ok();
      }
      case 'replaceAI': {
        if (notHost()) return notHost();
        const i = Number(body.seat);
        const s = room.seats[i];
        if (!s || s.isAI || s.token === room.hostToken) return fail('その席はAIに交代できません');
        if (isConnected(room, s)) return fail('接続中のプレイヤーは交代できません');
        s.isAI = true;
        s.level = room.aiLevel;
        s.name = aiName(room, s.level, i);
        room.scheduledKey = null;
        room.undoReq = null;
        return ok();
      }
      case 'move': {
        if (!g) return fail('対局が始まっていません');
        if (me < 0) return fail('観戦中は操作できません');
        const color = room.local2p ? g.turn : colorOfSeat(room, me);
        const r = G.play(g, color, body.mx, body.my);
        if (!r.ok) return fail(r.error);
        // 申請中に相手が指したら、その申請は無効
        if (room.undoReq) {
          if (room.undoReq.seat !== me) setUndoNotice(room, room.undoReq.seat, 'expired');
          room.undoReq = null;
        }
        return ok();
      }
      case 'undo': {
        if (!g) return fail('対局が始まっていません');
        if (me < 0) return fail('観戦中は操作できません');
        if (g.phase !== 'play') return fail('対局中のみ戻せます');
        if (room.local2p) {
          // 対面モード：どちらの手でも、1手ずつ自由に戻せる
          if (!g.moves.length) return fail('戻せる手がありません');
          G.undo(g, 1);
          G.addLog(g, '↩ 一手戻しました');
          return ok();
        }
        const color = colorOfSeat(room, me);
        if (!G.undoCount(g, color)) return fail('戻せる手がありません');
        if (room.seats[1 - me].isAI) {
          // AI対戦：自分の手番の局面まで自由に戻せる
          G.undo(g, G.undoCount(g, color));
          G.addLog(g, `↩ ${room.seats[me].name} が一手戻しました`);
          return ok();
        }
        // 友達対局：相手の許可が必要
        if (room.undoReq) return fail(room.undoReq.seat === me ? 'すでに申請中です' : '相手からの申請に先に答えてください');
        room.undoReq = { seat: me };
        return ok();
      }
      case 'undoCancel': {
        if (!room.undoReq || room.undoReq.seat !== me) return fail('申請はありません');
        room.undoReq = null;
        return ok();
      }
      case 'undoAnswer': {
        const req = room.undoReq;
        if (!g || !req || me < 0 || req.seat === me) return fail('申請はありません');
        room.undoReq = null;
        const count = g.phase === 'play' ? G.undoCount(g, colorOfSeat(room, req.seat)) : 0;
        if (body.accept && count) {
          G.undo(g, count);
          G.addLog(g, `↩ ${room.seats[req.seat].name} の申請で一手戻しました`);
          setUndoNotice(room, req.seat, 'accepted');
        } else {
          setUndoNotice(room, req.seat, body.accept ? 'expired' : 'rejected');
        }
        return ok();
      }
      case 'analyze': {
        // 振り返り（解析モード）用。対局中の読み筋が漏れないよう、終局後のみ
        if (!g) return fail('対局が始まっていません');
        if (g.phase !== 'finished') return fail('解析は対局終了後に使えます');
        const idx = clamp(body.idx, 0, g.moves.length, g.moves.length);
        const s = G.stateAt(g, idx);
        // 検討中の変化手順（本譜の idx 手目から先に試した手）
        const extra = Array.isArray(body.extra) ? body.extra.slice(0, 200) : [];
        for (const m of extra) {
          if (!Array.isArray(m) || !G.play(s, s.turn, m[0], m[1]).ok) return fail('検討中の手順が正しくありません');
        }
        return reply(200, { idx, ...(await runAI('analyze', s)) });
      }
      case 'resign': {
        if (!g) return fail('対局が始まっていません');
        if (me < 0) return fail('観戦中は操作できません');
        // 対面モードでは、いま手番の人が投了する
        const r = G.resign(g, room.local2p ? g.turn : colorOfSeat(room, me));
        return r.ok ? ok() : fail(r.error);
      }
      default:
        return fail('不明な操作です');
    }
  }

  // 接続状態の変化（友達のアプリが閉じた・戻ってきた）を全員に知らせる
  setInterval(() => {
    for (const room of rooms.values()) if (connSignature(room) !== room.connSig) afterChange(room);
  }, 2000);

  window.SparkHost = {
    hasRoom: (id) => rooms.has(String(id || '').toUpperCase()),
    // 自分の画面からの呼び出し
    request: (path, body) => handleApi(path, body || {}, true),
    poll: (q) => new Promise((resolve) => handlePoll(q, { send: (r) => resolve(r.json), conn: null })),
  };
})();
