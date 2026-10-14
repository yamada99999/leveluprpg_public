'use strict';
// AIの思考（読み切り）は1手数秒かかることがあるので、画面が固まらないよう別スレッドで計算する
importScripts('game.js');

self.onmessage = (e) => {
  const { id, op, game, level } = e.data;
  try {
    const result = op === 'move' ? self.G.aiMove(game, level) : self.G.analyze(game);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
