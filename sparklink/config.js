'use strict';
// スパークリンク 設定
window.SPARK_CONFIG = {
  // 友達に送るURLの頭の部分。この www フォルダを GitHub Pages などで公開した場所を書く。
  // （ブラウザでその公開ページを開いている場合は、自動でそのページのURLが使われる）
  publicUrl: 'https://yamada99999.github.io/leveluprpg_public/sparklink/',
  // PeerJS（WebRTC の接続仲介サーバー）上でのホストの名前の頭につける文字列
  peerPrefix: 'sparklink-v1-',
  // PeerJS の接続先。省略すると PeerJS 公式の無料サーバー（0.peerjs.com）と無料TURNを使う
  peerOptions: { debug: 1 },
};
