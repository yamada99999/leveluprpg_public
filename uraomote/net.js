'use strict';
// ウラオモテ迷宮 通信（スパークリンクと同じ PeerJS / WebRTC 方式）
//
// ホスト … ルームコードを名前にして PeerJS に登録し、相棒からの接続を1本だけ受け付ける
// 相棒 … ルームコードあてに接続する
// つながった後はどちらも対等で、{ t: '種類', ... } の JSON を送り合う。
(function () {
  const CFG = window.URA_CONFIG;
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const roomCode = () => Array.from({ length: 5 }, () => CHARS[crypto.getRandomValues(new Uint32Array(1))[0] % CHARS.length]).join('');

  const ERRORS = {
    'peer-unavailable': 'ルームが見つかりません（コードの打ち間違いか、ホストが閉じた可能性があります）',
    'network': '接続サーバーにつながりません。インターネット接続を確認してください',
    'server-error': '接続サーバーにつながりません。しばらくしてからもう一度試してください',
    'socket-error': '接続サーバーにつながりません。インターネット接続を確認してください',
    'socket-closed': '接続サーバーとの接続が切れました',
    'browser-incompatible': 'このブラウザは対応していません（Chrome や Safari の最新版で開いてください）',
    'timeout': 'つながりませんでした。ホストの画面が開いているか確認してください',
    'full': 'このルームはもう2人そろっています',
    'lib': '通信ライブラリを読み込めませんでした',
  };

  const Link = {
    peer: null,
    conn: null,
    role: null,
    room: null,
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, arg) { const f = this.handlers[ev]; if (f) f(arg); },
    errorText(e) { return ERRORS[e && e.type] || `通信エラー（${(e && (e.type || e.message)) || '不明'}）`; },

    host() {
      this.close();
      this.role = 'host';
      this.room = roomCode();
      this.openHost();
      return this.room;
    },

    openHost() {
      if (typeof window.Peer !== 'function') { this.emit('error', { type: 'lib' }); return; }
      const p = new window.Peer(CFG.peerPrefix + this.room, CFG.peerOptions);
      this.peer = p;
      this.emit('status', { state: 'starting', room: this.room });
      p.on('open', () => { if (this.peer === p) this.emit('status', { state: 'waiting', room: this.room }); });
      p.on('connection', (c) => {
        if (this.peer !== p) { c.close(); return; }
        if (this.conn && this.conn.open) {
          c.on('open', () => { try { c.send({ t: 'full' }); } catch (e) { /* noop */ } setTimeout(() => c.close(), 400); });
          return;
        }
        this.bind(c);
      });
      p.on('disconnected', () => {
        setTimeout(() => { if (this.peer === p && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) { /* noop */ } } }, 1500);
      });
      p.on('error', (e) => {
        if (this.peer !== p) return;
        console.warn('peer error', e.type, e);
        if (e.type === 'unavailable-id') { // コードが他の人とかぶった：振り直す
          try { p.destroy(); } catch (err) { /* noop */ }
          this.room = roomCode();
          this.openHost();
          return;
        }
        if (!this.conn) this.emit('error', e);
      });
    },

    join(room) {
      this.close();
      this.role = 'guest';
      this.room = room;
      if (typeof window.Peer !== 'function') { this.emit('error', { type: 'lib' }); return; }
      const p = new window.Peer(CFG.peerOptions);
      this.peer = p;
      this.emit('status', { state: 'connecting', room });
      const timer = setTimeout(() => {
        if (this.peer === p && !(this.conn && this.conn.open)) this.emit('error', { type: 'timeout' });
      }, 15000);
      p.on('open', () => {
        if (this.peer !== p) return;
        const c = p.connect(CFG.peerPrefix + room, { serialization: 'json', reliable: true });
        this.bind(c, () => clearTimeout(timer));
      });
      p.on('error', (e) => {
        if (this.peer !== p) return;
        console.warn('peer error', e.type, e);
        clearTimeout(timer);
        if (!this.conn) this.emit('error', e);
      });
    },

    bind(c, onOpen) {
      c.on('open', () => {
        this.conn = c;
        if (onOpen) onOpen();
        this.emit('open');
      });
      c.on('data', (m) => {
        if (!m || typeof m !== 'object' || !m.t) return;
        if (m.t === 'full') { this.emit('error', { type: 'full' }); return; }
        this.emit('msg', m);
      });
      const gone = () => {
        if (this.conn !== c) return;
        this.conn = null;
        this.emit('close');
      };
      c.on('close', gone);
      c.on('error', gone);
    },

    get open() { return !!(this.conn && this.conn.open); },

    send(m) {
      const c = this.conn;
      if (!c || !c.open) return;
      try { c.send(m); } catch (e) { /* noop */ }
    },

    close() {
      const c = this.conn, p = this.peer;
      this.conn = null;
      this.peer = null;
      if (c) { try { c.close(); } catch (e) { /* noop */ } }
      if (p) { try { p.destroy(); } catch (e) { /* noop */ } }
    },
  };

  window.Link = Link;
})();
