'use strict';
// ウラオモテ迷宮 設定
window.URA_CONFIG = {
  // このゲームの公開ページ（「このページのURLを送る」ボタンで使う）
  publicUrl: 'https://yamada99999.github.io/leveluprpg_public/uraomote/',
  // 部屋の名前の頭（PeerJS 上の名前は「これ-4ケタの部屋番号」）。部屋を作った人がオモテ、入った人がウラ。
  peerPrefix: 'uraomote-v3-yamada99999',
  // PeerJS の接続先。省略すると PeerJS 公式の無料サーバー（0.peerjs.com）を使う
  peerOptions: { debug: 1 },
};
