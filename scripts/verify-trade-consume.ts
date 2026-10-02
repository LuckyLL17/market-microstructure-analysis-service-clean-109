/**
 * 成交事件价位处理修复的交叉核对脚本：
 * 1) OrderBook 单元级断言：同价位部分成交、价格边界、买卖方向、未匹配数量
 * 2) HTTP 交叉核对：实时接入 vs 回放重建 vs 指标查询（最佳价、深度、成交统计、重复推进）
 *
 * 运行：先启动服务 `npm run dev`，再执行 `npx tsx scripts/verify-trade-consume.ts`
 */
import assert from 'node:assert/strict';
import { OrderBook } from '../src/order-book.js';
import { MarketEvent, PriceLevel } from '../src/types.js';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:6190';
const SYMBOL = 'XTEST';
const DAY = '2026-10-02';
const T0 = Date.parse('2026-10-02T09:30:00.000Z');

let seq = 0;
function event(partial: Partial<MarketEvent> & { type: MarketEvent['type'] }): MarketEvent {
  seq += 1;
  return {
    id: `V-${seq}`, symbol: SYMBOL, tradingDay: DAY,
    timestamp: new Date(T0 + seq * 1000).toISOString(), sequence: seq,
    ...partial,
  } as MarketEvent;
}
function snap(bids: PriceLevel[], asks: PriceLevel[]): MarketEvent { return event({ type: 'snapshot', bids, asks }); }
function trade(aggressorSide: 'buy' | 'sell', price: number, quantity: number): MarketEvent { return event({ type: 'trade', aggressorSide, price, quantity }); }

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;
function assertLevels(actual: PriceLevel[], expected: PriceLevel[], label: string) {
  assert.equal(actual.length, expected.length, `${label}: level count ${actual.length} != ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(approx(actual[i].price, expected[i].price), `${label}[${i}].price ${actual[i].price} != ${expected[i].price}`);
    assert.ok(approx(actual[i].quantity, expected[i].quantity), `${label}[${i}].qty ${actual[i].quantity} != ${expected[i].quantity}`);
  }
}

// ---------------------------------------------------------------- 单元级断言
function unit() {
  const book = new OrderBook(SYMBOL);
  seq = 0;
  book.apply(snap(
    [{ price: 100.00, quantity: 500 }, { price: 99.99, quantity: 400 }, { price: 99.98, quantity: 300 }],
    [{ price: 100.01, quantity: 200 }, { price: 100.02, quantity: 300 }, { price: 100.03, quantity: 400 }, { price: 100.04, quantity: 500 }],
  ));

  // 买方 trade @100.02 量 350：吃掉 100.01 全部 + 100.02 部分，更高价位不动
  book.apply(trade('buy', 100.02, 350));
  let s = book.snapshot(10);
  assertLevels(s.asks, [{ price: 100.02, quantity: 150 }, { price: 100.03, quantity: 400 }, { price: 100.04, quantity: 500 }], 'unit buy partial asks');
  assert.equal(book.queueAhead('sell', 100.02), 150, '同价位部分成交后剩余量');
  assert.equal(book.getStats().unmatchedTradeQuantity, 0);

  // 买方 trade @100.03 量 1000：边界内只有 150+400=550，未匹配 450，100.04 不动
  book.apply(trade('buy', 100.03, 1000));
  s = book.snapshot(10);
  assertLevels(s.asks, [{ price: 100.04, quantity: 500 }], 'unit buy sweep bounded asks');
  assert.ok(approx(book.getStats().unmatchedTradeQuantity, 450), '买方未匹配数量');

  // 卖方 trade @99.99 量 600：吃掉 100.00 全部 + 99.99 部分，99.98 不动
  book.apply(trade('sell', 99.99, 600));
  s = book.snapshot(10);
  assertLevels(s.bids, [{ price: 99.99, quantity: 300 }, { price: 99.98, quantity: 300 }], 'unit sell partial bids');

  // 卖方 trade @99.98 量 10000：边界内仅 600，未匹配 9400，买盘清空但不越界
  book.apply(trade('sell', 99.98, 10000));
  s = book.snapshot(10);
  assertLevels(s.bids, [], 'unit sell sweep bids empty');
  assert.ok(approx(book.getStats().unmatchedTradeQuantity, 450 + 9400), '卖方未匹配数量累计');

  // 价差内部的 trade 不触碰任何一侧
  book.apply(trade('buy', 100.005, 10));
  s = book.snapshot(10);
  assertLevels(s.asks, [{ price: 100.04, quantity: 500 }], 'unit inside-spread asks untouched');
  assert.ok(approx(book.getStats().unmatchedTradeQuantity, 450 + 9400 + 10), '价差内未匹配累计');

  const stats = book.getStats();
  assert.equal(stats.tradeCount, 5);
  assert.ok(approx(stats.tradedQuantity, 350 + 1000 + 600 + 10000 + 10), '成交统计按事件全额累计');
  console.log('✔ 单元级断言通过（同价位部分成交 / 价格边界 / 买卖方向 / 未匹配数量）');
}

// ---------------------------------------------------------------- HTTP 交叉核对
async function http(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  return res.json() as Promise<any>;
}
const post = (path: string, body: unknown) => http(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function crossCheck() {
  seq = 0;
  const events: MarketEvent[] = [
    snap(
      [{ price: 100.00, quantity: 500 }, { price: 99.99, quantity: 400 }, { price: 99.98, quantity: 300 }],
      [{ price: 100.01, quantity: 200 }, { price: 100.02, quantity: 300 }, { price: 100.03, quantity: 400 }, { price: 100.04, quantity: 500 }],
    ),
    trade('buy', 100.02, 350),          // seq2: 100.01 清空, 100.02 余 150
    trade('buy', 100.03, 1000),         // seq3: 边界内 550, 未匹配 450, 余 100.04×500
    trade('sell', 99.99, 600),          // seq4: 100.00 清空, 99.99 余 300
    trade('sell', 99.98, 10000),        // seq5: 边界内 600, 未匹配 9400, 买盘空
    event({ type: 'new_order', orderId: 'V-B1', side: 'buy', price: 99.97, quantity: 120 }),   // seq6 挂单
    event({ type: 'new_order', orderId: 'V-S1', side: 'sell', price: 100.05, quantity: 80 }),  // seq7 挂单
    trade('buy', 100.02, 50),           // seq8: 卖一 100.04 高于成交价, 全部未匹配
    event({ type: 'cancel_order', orderId: 'seed-sell-100.04' }),                              // seq9 撤掉 100.04
  ];
  for (const e of events) {
    const r = await post('/api/market-data/events', e);
    assert.equal(r.accepted, true, `实时接入 seq=${e.sequence} 被拒绝`);
  }

  const expectedBids = [{ price: 99.97, quantity: 120 }];
  const expectedAsks = [{ price: 100.05, quantity: 80 }];
  const expectedStats = { tradeCount: 5, tradedQuantity: 12000, unmatchedTradeQuantity: 9900, sequence: 9 };

  // 实时：订单簿
  const live = await http(`/api/orderbook/${SYMBOL}`);
  assertLevels(live.bids, expectedBids, 'live bids');
  assertLevels(live.asks, expectedAsks, 'live asks');
  assert.equal(live.stats.tradeCount, expectedStats.tradeCount);
  assert.ok(approx(live.stats.tradedQuantity, expectedStats.tradedQuantity));
  assert.ok(approx(live.stats.unmatchedTradeQuantity, expectedStats.unmatchedTradeQuantity));

  // 实时：指标查询
  const analytics = await http(`/api/analytics/${SYMBOL}`);
  assert.ok(approx(analytics.bestBid, 99.97) && approx(analytics.bestAsk, 100.05), 'analytics 最佳价');
  assert.ok(approx(analytics.bidDepth, 120) && approx(analytics.askDepth, 80), 'analytics 深度');
  assert.ok(approx(analytics.spread, 0.08), 'analytics 价差');
  assert.ok(approx(analytics.imbalance, 0.2), 'analytics 失衡');
  const metrics = await http(`/api/metrics?symbol=${SYMBOL}`);
  assert.equal(metrics.bookStats.tradeCount, expectedStats.tradeCount);
  assert.ok(approx(metrics.bookStats.unmatchedTradeQuantity, expectedStats.unmatchedTradeQuantity), 'metrics 成交统计一致');

  // 回放：先单步 3 步，再 run 剩余，验证与实时一致
  const session = await post('/api/replay/sessions', { symbol: SYMBOL, tradingDay: DAY });
  assert.equal(session.eventCount, events.length);
  for (let i = 0; i < 3; i++) await post(`/api/replay/sessions/${session.id}/step`, {});
  const mid = await http(`/api/replay/sessions/${session.id}`);
  assert.equal(mid.cursor, 3);
  assertLevels(mid.book.asks, [{ price: 100.04, quantity: 500 }], 'replay 中途 asks');
  assert.ok(approx(mid.stats.unmatchedTradeQuantity, 450), 'replay 中途未匹配');
  const ran = await post(`/api/replay/sessions/${session.id}/run`, { steps: 100 });
  assert.equal(ran.status, 'completed');
  assertLevels(ran.book.bids, expectedBids, 'replay 最终 bids');
  assertLevels(ran.book.asks, expectedAsks, 'replay 最终 asks');
  assert.equal(ran.stats.tradeCount, expectedStats.tradeCount);
  assert.ok(approx(ran.stats.tradedQuantity, expectedStats.tradedQuantity));
  assert.ok(approx(ran.stats.unmatchedTradeQuantity, expectedStats.unmatchedTradeQuantity));

  // 重复推进：完成后再 run / step 均为空操作，盘口与统计不变
  const again = await post(`/api/replay/sessions/${session.id}/run`, { steps: 100 });
  assert.equal(again.processed, 0);
  assertLevels(again.book.bids, expectedBids, '重复 run bids');
  assertLevels(again.book.asks, expectedAsks, '重复 run asks');
  assert.equal(again.stats.tradeCount, expectedStats.tradeCount);
  const stepAgain = await post(`/api/replay/sessions/${session.id}/step`, {});
  assert.equal(stepAgain.done, true);
  const afterStep = await http(`/api/replay/sessions/${session.id}`);
  assertLevels(afterStep.book.bids, expectedBids, '重复 step bids');
  assert.equal(afterStep.stats.tradeCount, expectedStats.tradeCount);

  // 逐步回放（全程 step）与 run 回放结果一致
  const session2 = await post('/api/replay/sessions', { symbol: SYMBOL, tradingDay: DAY });
  let last: any;
  for (let i = 0; i < events.length; i++) last = await post(`/api/replay/sessions/${session2.id}/step`, {});
  assertLevels(last.book.bids, expectedBids, '逐步回放 bids');
  assertLevels(last.book.asks, expectedAsks, '逐步回放 asks');
  assert.ok(approx(last.stats.unmatchedTradeQuantity, expectedStats.unmatchedTradeQuantity));

  // 重复事件去重：重放最后一笔事件被拒绝且实时盘口不变
  const dup = await post('/api/market-data/events', events[events.length - 1]);
  assert.equal(dup.accepted, false);
  assert.equal(dup.anomaly.type, 'duplicate_sequence');
  const liveAfter = await http(`/api/orderbook/${SYMBOL}`);
  assertLevels(liveAfter.bids, expectedBids, '重复事件后 live bids');
  assertLevels(liveAfter.asks, expectedAsks, '重复事件后 live asks');
  assert.equal(liveAfter.stats.tradeCount, expectedStats.tradeCount);

  console.log('✔ HTTP 交叉核对通过（实时接入 / 回放重建 / 指标查询 / 重复推进）');
}

unit();
await crossCheck();
console.log('全部核对通过。');
