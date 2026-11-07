'use strict';
// ウラオモテ迷宮 通信（スパークリンクと同じ PeerJS / WebRTC 方式）
//
// ルームコードは使わない。決まった名前（config.js の peerId）の「部屋」が世界に1つだけある。
//   「ふたりで遊ぶ」を押すと、まずその名前で部屋を開こうとする（＝オモテ）。
//   もう誰かが開いていたら、そこへ接続する（＝ウラ）。
// どちらの順番で押してもよく、片方だけ先に待っていても、いつまでも待ち続ける。
// 接続が切れても、画面を閉じない限り自動でつなぎ直す（同じ役のまま）。
(function () {
  const CFG = window.URA_CONFIG;
  const ROOM = CFG.peerId;
  const STALE_MS = 6000;    // これだけ相手から何も届かなければ、切れたとみなす
  const GUEST_WAIT_MS = 7000;

  const Link = {
    active: false,
    peer: null,
    conn: null,
    role: null,       // 'host'（オモテ） | 'guest'（ウラ） | null（まだ決まっていない）
    state: 'idle',    // 'idle' | 'searching' | 'waiting' | 'connected' | 'reconnecting'
    lastRecv: 0,
    retryTimer: 0,
    guestTimer: 0,
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, arg) { const f = this.handlers[ev]; if (f) f(arg); },
    setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } },
    get open() { return !!(this.conn && this.conn.open); },

    start() {
      this.stop();
      if (typeof window.Peer !== 'function') { this.emit('error', '通信ライブラリを読み込めませんでした'); return; }
      this.active = true;
      this.role = null;
      this.setState('searching');
      this.pair();
    },

    stop() {
      this.active = false;
      clearTimeout(this.retryTimer); clearTimeout(this.guestTimer);
      const c = this.conn, p = this.peer;
      this.conn = null; this.peer = null;
      if (c) { try { c.close(); } catch (e) { /* noop */ } }
      if (p) { try { p.destroy(); } catch (e) { /* noop */ } }
      this.setState('idle');
    },

    later(fn, ms) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => { if (this.active) fn(); }, ms);
    },

    dropPeer() {
      clearTimeout(this.guestTimer);
      const p = this.peer;
      this.peer = null;
      if (p) { try { p.destroy(); } catch (e) { /* noop */ } }
    },

    // 前回の役を優先してつなぐ。役が未定なら、まず部屋を開いてみる
    pair() {
      if (!this.active) return;
      if (this.role === 'guest') this.tryGuest(); else this.tryHost();
    },

    tryHost() {
      this.dropPeer();
      const p = new window.Peer(ROOM, CFG.peerOptions);
      this.peer = p;
      p.on('open', () => {
        if (this.peer !== p) return;
        this.role = 'host';
        if (!this.open) this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'waiting');
      });
      p.on('connection', (c) => {
        if (this.peer !== p) { try { c.close(); } catch (e) { /* noop */ } return; }
        this.bind(c); // 新しい接続を優先（つなぎ直してきた相棒を受け入れる）
      });
      p.on('disconnected', () => {
        // 仲介サーバーとの接続だけが切れた。相棒との直通は生きているので、登録し直す
        setTimeout(() => { if (this.peer === p && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) { /* noop */ } } }, 1000);
      });
      p.on('error', (e) => {
        if (this.peer !== p) return;
        console.warn('peer error (host)', e.type);
        if (e.type === 'unavailable-id') {
          // もう部屋がある → そこへ参加する。
          // （前回オモテだった場合は、自分の古い登録が残っているだけかもしれないので、少し待ってまた開き直す）
          this.later(() => this.tryGuest(), 300);
          return;
        }
        this.later(() => this.pair(), 3000);
      });
    },

    tryGuest() {
      this.dropPeer();
      const p = new window.Peer(CFG.peerOptions);
      this.peer = p;
      const retry = () => this.later(() => (this.role === 'guest' ? this.tryGuest() : this.tryHost()), 1500);
      p.on('open', () => {
        if (this.peer !== p) return;
        const c = p.connect(ROOM, { serialization: 'json', reliable: true });
        this.bind(c);
        this.guestTimer = setTimeout(() => { if (this.peer === p && !this.open) retry(); }, GUEST_WAIT_MS);
      });
      p.on('error', (e) => {
        if (this.peer !== p) return;
        console.warn('peer error (guest)', e.type);
        retry();
      });
    },

    bind(c) {
      c.on('open', () => {
        if (!this.active) { try { c.close(); } catch (e) { /* noop */ } return; }
        const old = this.conn;
        this.conn = c;
        if (old && old !== c) { try { old.close(); } catch (e) { /* noop */ } }
        clearTimeout(this.guestTimer);
        clearTimeout(this.retryTimer);
        this.role = this.peer && this.peer.id === ROOM ? 'host' : 'guest';
        this.lastRecv = Date.now();
        this.setState('connected');
        this.emit('open', this.role);
      });
      c.on('data', (m) => {
        if (this.conn !== c) return;
        this.lastRecv = Date.now();
        if (m && typeof m === 'object' && m.t) this.emit('msg', m);
      });
      const gone = () => { if (this.conn === c) this.lost(); };
      c.on('close', gone);
      c.on('error', gone);
    },

    // 相棒との直通が切れた：役はそのままで、つなぎ直す
    lost() {
      const c = this.conn;
      this.conn = null;
      if (c) { try { c.close(); } catch (e) { /* noop */ } }
      if (!this.active) return;
      this.setState('reconnecting');
      this.emit('lost');
      if (this.role === 'host') {
        // 部屋はそのまま開けておく。部屋そのものが壊れていたら開き直す
        const p = this.peer;
        if (!p || p.destroyed) this.later(() => this.tryHost(), 500);
        else if (p.disconnected) { try { p.reconnect(); } catch (e) { this.later(() => this.tryHost(), 500); } }
      } else {
        this.later(() => this.tryGuest(), 800);
      }
    },

    // 定期チェック：無言が続いたら切れたとみなす／待機中に部屋が壊れていたら作り直す
    watch() {
      if (!this.active) return;
      if (this.open && Date.now() - this.lastRecv > STALE_MS) { this.lost(); return; }
      if (!this.open && this.role === 'host' && this.peer && this.peer.destroyed) this.later(() => this.tryHost(), 500);
    },

    // 画面に戻ってきたとき（LINEなどから戻った）、つながっていなければすぐ探し直す
    wake() {
      if (!this.active || this.open) return;
      if (this.role === 'host' && this.peer && !this.peer.destroyed) {
        if (this.peer.disconnected) { try { this.peer.reconnect(); } catch (e) { this.tryHost(); } }
        return;
      }
      this.later(() => this.pair(), 100);
    },

    send(m) {
      const c = this.conn;
      if (!c || !c.open) return;
      try { c.send(m); } catch (e) { /* noop */ }
    },
  };

  setInterval(() => Link.watch(), 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Link.wake(); });
  window.addEventListener('online', () => Link.wake());

  window.Link = Link;
})();
