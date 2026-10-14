'use strict';
// スパークリンク 通信
//
// 自分がホストのルーム … 同じ画面の中のホスト（host.js）を直接呼ぶ
// 友達のルームに参加   … PeerJS（WebRTC）で友達の端末のホストにつなぎ、{ id, path, body } を送って返事を待つ
// どちらも返事は { status, json } の形にそろえ、app.js からは区別せずに使える。
(function () {
  const CFG = window.SPARK_CONFIG;
  const REQUEST_TIMEOUT_MS = 12000;
  const POLL_TIMEOUT_MS = 30000; // ホストは最大20秒待ってから返事をする

  function netError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const Remote = {
    peer: null,
    conn: null,
    roomId: null,
    connecting: null,
    seq: 0,
    pending: new Map(),

    reset() {
      this.dropConn(netError('接続を切り替えました', 'reset'));
      this.roomId = null;
    },

    dropConn(err) {
      const c = this.conn;
      this.conn = null;
      if (c) { try { c.close(); } catch {} }
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    },

    // 接続仲介サーバーに自分を登録する（登録済みならそれを使う）
    getPeer() {
      if (typeof window.Peer !== 'function') return Promise.reject(netError('通信ライブラリを読み込めませんでした', 'lib'));
      let p = this.peer;
      if (p && !p.destroyed && p.open) return Promise.resolve(p);
      if (!p || p.destroyed) {
        p = new window.Peer(CFG.peerOptions);
        this.peer = p;
        p.on('error', (e) => {
          console.warn('peer error', e.type, e);
          // 相手が見つからない等は、つなごうとしている最中の処理へ伝える
          if (this.onPeerError) this.onPeerError(e);
        });
        p.on('disconnected', () => {
          setTimeout(() => { if (this.peer === p && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch {} } }, 1500);
        });
      } else if (p.disconnected) {
        try { p.reconnect(); } catch {}
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          // 固まった登録はいったん捨てて、次回は作り直す
          if (this.peer === p) { try { p.destroy(); } catch {} this.peer = null; }
          reject(netError('接続サーバーにつながりません。インターネット接続を確認してください', 'network'));
        }, REQUEST_TIMEOUT_MS);
        const onOpen = () => { cleanup(); resolve(p); };
        const onErr = (e) => {
          if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(e.type)) {
            cleanup();
            if (this.peer === p) { try { p.destroy(); } catch {} this.peer = null; }
            reject(netError(e.type === 'browser-incompatible'
              ? 'このブラウザは対戦に対応していません（Chrome や Safari の最新版で開いてください）'
              : '接続サーバーにつながりません。インターネット接続を確認してください', e.type));
          }
        };
        const cleanup = () => { clearTimeout(timer); p.off('open', onOpen); p.off('error', onErr); };
        p.on('open', onOpen);
        p.on('error', onErr);
      });
    },

    // ホストの端末につなぐ
    async ensure(roomId) {
      if (this.roomId !== roomId) { this.reset(); this.roomId = roomId; }
      if (this.conn && this.conn.open) return this.conn;
      if (!this.connecting) {
        this.connecting = this.open(roomId).finally(() => { this.connecting = null; });
      }
      return this.connecting;
    },

    async open(roomId) {
      const p = await this.getPeer();
      const conn = p.connect(CFG.peerPrefix + roomId, { serialization: 'json', reliable: true });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(netError('ホストにつながりません（ホストのアプリが開いているか確認してください）', 'timeout')), REQUEST_TIMEOUT_MS);
        const done = () => { clearTimeout(timer); this.onPeerError = null; };
        const fail = (e) => { done(); try { conn.close(); } catch {} reject(e); };
        conn.on('open', () => { done(); resolve(); });
        conn.on('error', (e) => fail(netError(`ホストとの接続に失敗しました（${e.type || e.message}）`, 'conn')));
        this.onPeerError = (e) => {
          if (e.type === 'peer-unavailable') fail(netError('ルームが見つかりません（ホストがアプリを閉じたか、URLが古い可能性があります）', 'unavailable'));
        };
      });
      if (this.roomId !== roomId) { try { conn.close(); } catch {} throw netError('接続を切り替えました', 'reset'); }
      conn.on('data', (msg) => {
        const p2 = msg && this.pending.get(msg.id);
        if (!p2) return;
        this.pending.delete(msg.id);
        clearTimeout(p2.timer);
        p2.resolve({ status: msg.status, json: msg.json });
      });
      const closed = () => { if (this.conn === conn) this.dropConn(netError('ホストとの接続が切れました', 'closed')); };
      conn.on('close', closed);
      conn.on('error', closed);
      this.conn = conn;
      return conn;
    },

    async request(roomId, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
      const conn = await this.ensure(roomId);
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(netError('ホストから応答がありません', 'timeout'));
          // 応答がない接続は壊れているとみなし、次回つなぎ直す
          if (this.conn === conn) this.dropConn(netError('ホストから応答がありません', 'timeout'));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        try {
          conn.send({ id, path, body });
        } catch (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(netError('ホストに送れませんでした', 'closed'));
        }
      });
    },
  };

  window.Net = {
    // 自分がホストのルームかどうか
    local: true,
    setLocal(v) {
      this.local = !!v;
      if (this.local) Remote.reset();
    },
    request(path, body) {
      if (this.local || path === '/api/create') return window.SparkHost.request(path, body);
      return Remote.request(String(body.roomId || '').toUpperCase(), path, body);
    },
    async poll(q) {
      if (this.local) return window.SparkHost.poll(q);
      const r = await Remote.request(q.room, '/api/poll', q, POLL_TIMEOUT_MS);
      return r.json;
    },
    disconnect() { Remote.reset(); },
  };
})();
