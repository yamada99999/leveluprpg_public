'use strict';
// 2台をつなぐ通信（PeerJS / WebRTC）。ウラオモテ迷宮・ふたりでカタチで共通。
//
// しくみ：
//   ・「2台で遊ぶ」を押した端末が「部屋」を作る（＝host）。部屋には4ケタの部屋番号がつく。
//     部屋の名前は「<config の peerPrefix>-<部屋番号>」。番号は同じタブの中では使い回す
//     （ページを開き直しても同じ番号で部屋を作り直すので、相棒は自動でつなぎ直せる）。
//   ・相棒は QR／URL（?join=番号）か、番号の入力で、その部屋へ直接つなぐ（＝guest）。
//     相手の名前が最初から分かっているので、待ち合わせの探し回りがなく、すぐつながる。
//   ・接続が切れても、画面を閉じない限り自動でつなぎ直す（同じ役・同じ部屋のまま）。
//     つなぎ直しでは、仲介サーバーへの登録（遅い）はできるだけ作り直さず、接続だけを張り直す。
(function () {
  const CFG = window.KATA_CONFIG || window.URA_CONFIG;
  const PREFIX = CFG.peerPrefix;
  const STALE_MS = 9000;     // これだけ相手から何も届かなければ、切れたとみなす
  const CONNECT_WAIT = 6000; // つなぎに行って、これだけ返事がなければもう一度
  const KEY = PREFIX + ':code';
  const idOf = (code) => `${PREFIX}-${code}`;
  const newCode = () => String(1000 + Math.floor(Math.random() * 9000));
  const store = {
    get() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } },
    set(v) { try { sessionStorage.setItem(KEY, v); } catch (e) { /* noop */ } },
  };

  const Link = {
    active: false,
    peer: null,
    conn: null,
    role: null,       // 'host'（部屋を作った人） | 'guest'（部屋に入った人）
    code: null,       // 部屋番号（4ケタの文字列）
    everOpen: false,  // 一度でもつながったか（「つなぎ直し中」の表示に使う）
    // 'idle' | 'searching'（部屋を準備中） | 'waiting'（相棒待ち） | 'joining'（部屋へ接続中）
    // | 'notfound'（その番号の部屋がまだない） | 'connected' | 'reconnecting'
    state: 'idle',
    lastRecv: 0,
    timers: {},
    takenTries: 0,
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, arg) { const f = this.handlers[ev]; if (f) f(arg); },
    setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } },
    get open() { return !!(this.conn && this.conn.open); },
    later(name, fn, ms) {
      clearTimeout(this.timers[name]);
      this.timers[name] = setTimeout(() => { if (this.active) fn(); }, ms);
    },
    clearTimers() { for (const k in this.timers) clearTimeout(this.timers[k]); this.timers = {}; },

    // 部屋を作る（番号は同じタブなら使い回す）
    host() {
      this.begin('host');
      this.code = store.get() || newCode();
      store.set(this.code);
      this.takenTries = 0;
      this.setState('searching');
      this.openRoom();
    },
    // 番号の部屋に入る
    join(code) {
      this.begin('guest');
      this.code = String(code).replace(/\D/g, '').slice(0, 4);
      this.setState('joining');
      this.openGuest();
    },
    start() { this.host(); }, // 古い呼び方
    begin(role) {
      this.stop();
      if (typeof window.Peer !== 'function') { this.emit('error', '通信ライブラリを読み込めませんでした'); return; }
      this.active = true;
      this.role = role;
      this.everOpen = false;
    },

    stop() {
      this.active = false;
      this.clearTimers();
      const c = this.conn, p = this.peer;
      this.conn = null; this.peer = null;
      if (c) { try { c.close(); } catch (e) { /* noop */ } }
      if (p) { try { p.destroy(); } catch (e) { /* noop */ } }
      this.setState('idle');
    },
    dropPeer() {
      const p = this.peer;
      this.peer = null;
      if (p) { try { p.destroy(); } catch (e) { /* noop */ } }
    },

    // ---- host ----
    openRoom() {
      if (!this.active) return;
      this.dropPeer();
      const p = new window.Peer(idOf(this.code), CFG.peerOptions);
      this.peer = p;
      p.on('open', () => {
        if (this.peer !== p) return;
        this.takenTries = 0;
        if (!this.open) this.setState(this.everOpen ? 'reconnecting' : 'waiting');
        this.emit('code', this.code);
      });
      p.on('connection', (c) => {
        if (this.peer !== p) { try { c.close(); } catch (e) { /* noop */ } return; }
        this.bind(c); // 新しい接続を優先（つなぎ直してきた相棒を受け入れる）
      });
      p.on('disconnected', () => {
        // 仲介サーバーとの接続だけが切れた（相棒との直通は生きている）。登録し直す
        this.later('rereg', () => { if (this.peer === p && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) { this.openRoom(); } } }, 800);
      });
      p.on('error', (e) => {
        if (this.peer !== p) return;
        console.warn('peer error (host)', e.type);
        if (e.type === 'unavailable-id') {
          // 開き直した直後で、前の自分の登録がまだ残っていることがある。少し待って同じ番号で。
          // それでもだめなら（ほかの誰かが使っている）新しい番号にする
          this.takenTries++;
          if (this.takenTries > 4 && !this.everOpen) { this.code = newCode(); store.set(this.code); this.takenTries = 0; }
          this.later('room', () => this.openRoom(), 1500);
          return;
        }
        this.later('room', () => this.openRoom(), 2000);
      });
    },

    // ---- guest ----
    openGuest() {
      if (!this.active) return;
      this.dropPeer();
      const p = new window.Peer(CFG.peerOptions);
      this.peer = p;
      p.on('open', () => { if (this.peer === p) this.dial(); });
      p.on('disconnected', () => {
        this.later('rereg', () => { if (this.peer === p && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) { this.openGuest(); } } }, 800);
      });
      p.on('error', (e) => {
        if (this.peer !== p) return;
        console.warn('peer error (guest)', e.type);
        if (e.type === 'peer-unavailable') {
          // その番号の部屋がない（まだ作られていない／作り直し中）。登録はそのままで、少し待ってもう一度
          if (!this.open) this.setState(this.everOpen ? 'reconnecting' : 'notfound');
          this.later('dial', () => this.dial(), 2000);
          return;
        }
        if (p.destroyed || ['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(e.type)) this.later('guest', () => this.openGuest(), 2000);
      });
    },
    // 部屋へ接続しに行く（登録は使い回す）
    dial() {
      const p = this.peer;
      if (!this.active || this.open || !p || p.destroyed) return;
      if (p.disconnected) { try { p.reconnect(); } catch (e) { this.openGuest(); } return; }
      if (!this.everOpen && this.state !== 'notfound') this.setState('joining');
      const c = p.connect(idOf(this.code), { serialization: 'json', reliable: true });
      this.bind(c);
      this.later('dial', () => { if (!this.open) this.dial(); }, CONNECT_WAIT);
    },

    bind(c) {
      c.on('open', () => {
        if (!this.active) { try { c.close(); } catch (e) { /* noop */ } return; }
        const old = this.conn;
        this.conn = c;
        if (old && old !== c) { try { old.close(); } catch (e) { /* noop */ } }
        clearTimeout(this.timers.dial);
        this.lastRecv = Date.now();
        this.everOpen = true;
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

    // 相棒との直通が切れた：役・部屋はそのままで、つなぎ直す
    lost() {
      const c = this.conn;
      this.conn = null;
      if (c) { try { c.close(); } catch (e) { /* noop */ } }
      if (!this.active) return;
      this.setState('reconnecting');
      this.emit('lost');
      if (this.role === 'host') {
        const p = this.peer; // 部屋は開けたまま待つ。部屋そのものが壊れていたら開き直す
        if (!p || p.destroyed) this.later('room', () => this.openRoom(), 300);
        else if (p.disconnected) { try { p.reconnect(); } catch (e) { this.later('room', () => this.openRoom(), 300); } }
      } else {
        this.later('dial', () => this.dial(), 300);
      }
    },

    // 定期チェック：無言が続いたら切れたとみなす／壊れた登録を作り直す
    watch() {
      if (!this.active) return;
      if (this.open && Date.now() - this.lastRecv > STALE_MS) { this.lost(); return; }
      if (!this.open && this.peer && this.peer.destroyed) {
        if (this.role === 'host') this.later('room', () => this.openRoom(), 300);
        else this.later('guest', () => this.openGuest(), 300);
      }
    },

    // 画面に戻ってきたとき（LINE やカメラから戻った）、つながっていなければすぐ確かめる
    wake() {
      if (!this.active) return;
      this.lastRecv = Math.max(this.lastRecv, Date.now() - 3000); // 戻った瞬間に「切れた」と決めつけない
      if (this.open) return;
      const p = this.peer;
      if (!p || p.destroyed) { if (this.role === 'host') this.openRoom(); else this.openGuest(); return; }
      if (p.disconnected) { try { p.reconnect(); } catch (e) { /* noop */ } }
      if (this.role === 'guest') this.later('dial', () => this.dial(), 200);
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
