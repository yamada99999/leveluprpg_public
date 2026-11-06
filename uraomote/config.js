'use strict';
// ウラオモテ迷宮 設定
window.URA_CONFIG = {
  // 友達に送るURLの頭の部分。空なら「今開いているページのURL」を使う。
  // GitHub Pages などで公開したら、その場所を書く（APK化したときに必要）。
  publicUrl: 'https://yamada99999.github.io/leveluprpg_public/uraomote/',
  // PeerJS（WebRTC の接続仲介サーバー）上でのホスト名の頭につける文字列
  peerPrefix: 'uraomote-v1-',
  // PeerJS の接続先。省略すると PeerJS 公式の無料サーバー（0.peerjs.com）を使う
  peerOptions: { debug: 1 },
};
