'use strict';
// 迷路づくりを裏の別スレッドで行う（重い計算でゲーム画面が固まらないように）
importScripts('physics.js?v=4', 'gen.js?v=4');
self.onmessage = (e) => {
  const { id, level, seed } = e.data || {};
  let r = null;
  try {
    const g = self.URA_GEN.make(level, seed);
    if (g) r = { pattern: g.pattern, hint: g.hint, plan: g.plan, actions: g.actions, step: g.step, draws: g.draws, needDraw: g.needDraw, level: g.level };
  } catch (err) { r = null; }
  self.postMessage({ id, r });
};
