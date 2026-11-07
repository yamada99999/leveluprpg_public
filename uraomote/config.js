'use strict';
// ウラオモテ迷宮 設定
window.URA_CONFIG = {
  // このゲームの公開ページ（「このページのURLを送る」ボタンで使う）
  publicUrl: 'https://yamada99999.github.io/leveluprpg_public/uraomote/',
  // 2台が待ち合わせる「部屋」の名前（PeerJS 上で世界に1つ）。
  // ルームコードは使わず、この部屋に先に来た人がオモテ、後から来た人がウラになる。
  // 将来いろいろな人に配るときは、ここをルームコード式に戻す。
  peerId: 'uraomote-v2-yamada99999-room',
  // PeerJS の接続先。省略すると PeerJS 公式の無料サーバー（0.peerjs.com）を使う
  peerOptions: { debug: 1 },
};
