// BTC race bot: trend-core + dip hybrid, long only, one position at a time.
//
// Idea (verified by local grading on both published dev windows, not by intuition):
// 1-minute BTC mean-reverts too fast for fast EMA crosses to pay the ~42 bps
// round-trip cost (fee 4 bps + slippage 2 bps + pool impact ~17 bps a side),
// so this bot trades rarely and only for moves of 1% or more:
//   - CORE: one early full-size buy, but only when the market is not in a sharp
//     1-hour decline (60-bar return above -0.5%) and price sits above its 2-hour
//     EMA(120). It then rides with a 1.2% trailing stop and a 2% hard stop, so a
//     down day costs about one trailing stop instead of the whole drift.
//   - DIP: while flat, buy a pullback of at least 0.9% from the 60-bar high
//     while price is still above its 4-hour EMA(240) (an uptrend pullback, not
//     a falling knife). Exit at +1.0% take-profit, -1.0% stop, or after 180 bars.
//   - CIRCUIT BREAKER: no new entries once equity has drawn down 5% from its
//     peak; exits are never blocked.
// Warmup: 60 bars of history before any entry. All decisions use closes only
// (fills happen at the next bar's open), prices are bigints on the wire, and
// indicators run in float64 on dollar closes exactly like the kit baselines,
// so the same bars always give the same orders: no clock, no network, no
// randomness, no files.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 200;
const WARMUP_BARS = 60;
const EMA_TREND_BARS = 120; // 2-hour trend filter for the core buy
const EMA_LONG_BARS = 240; // 4-hour trend filter for dip buys
const CORE_MIN_60M_RETURN_BPS = -50; // do not buy into a sharp 1-hour decline
const TRAIL_BPS = 120; // 1.2% trailing stop on the core position
const STOP_BPS = 200; // 2% hard stop on the core position
const DIP_BARS = 60; // pullback measured from this many bars' high
const DIP_BPS = 90; // at least 0.9% below the 60-bar high
const DIP_TP_BPS = 100; // dip take-profit 1.0%
const DIP_STOP_BPS = 100; // dip stop-loss 1.0%
const DIP_MAX_HOLD_BARS = 180;
const CIRCUIT_BREAKER_BPS = 500; // stop new entries after a 5% equity drawdown

/** One EMA over dollar closes: seeded as the mean of its first span of closes. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function ema(span: number): Ema {
  return { span, warm: [], value: null };
}

function emaStep(e: Ema, close: number): number | null {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return e.value;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  return e.value;
}

const closes: number[] = []; // dollar closes, oldest first, capped
const emaTrend = ema(EMA_TREND_BARS);
const emaLong = ema(EMA_LONG_BARS);

// Held-position bookkeeping, derived from the account each batch.
let mode: 'core' | 'dip' | null = null;
let entryPx = 0; // dollars per BTC at the fill that opened this position
let peakPx = 0; // highest close since entry, dollars
let holdBars = 0;
let coreBought = false; // a core position has been held at least once
let pendingMode: 'core' | 'dip' | null = null; // mode of the buy sent last batch
let peakEquity = 1000000000n; // quote units; seeded from hello.capital in onHello

function closeDollars(state: BarsState): number | null {
  const c = state.close(SYMBOL);
  if (c === null) return null;
  // price_scale is 5 for CBBTC: raw price / 1e5 = dollars per BTC.
  return Number(c) / 100000;
}

await runBars({
  onHello(state: BarsState): void {
    peakEquity = BigInt(state.hello.capital.quote_units);
  },
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];
    const close = closeDollars(state);
    if (close === null) return [];

    // Fold this bar into the indicators (every batch, warm-up included).
    closes.push(close);
    if (closes.length > 400) closes.splice(0, closes.length - 400);
    const trend = emaStep(emaTrend, close);
    const long = emaStep(emaLong, close);

    const held = state.positions.get(SYMBOL);
    const equity = state.equity;
    if (equity > peakEquity) peakEquity = equity;

    if (held !== undefined) {
      // A position is open. Learn its mode and entry from the buy we sent.
      if (mode === null) {
        mode = pendingMode;
        if (mode === 'core') coreBought = true;
        // Entry price from the account: cost / qty, in dollars per BTC.
        // cost is quote units (1e-6 USDC), qty is 1e-8 BTC, price raw is 1e-5 USD:
        // dollars = cost * 100 / qty.
        entryPx = (Number(held.cost) * 100) / Number(held.qty);
        peakPx = close;
        holdBars = 0;
      }
      pendingMode = null;
      holdBars += 1;
      if (close > peakPx) peakPx = close;
      const retBps = ((close - entryPx) / entryPx) * 10000;
      const trailBps = ((close - peakPx) / peakPx) * 10000;
      let exit = false;
      if (mode === 'core') {
        if (trailBps <= -TRAIL_BPS) exit = true;
        if (retBps <= -STOP_BPS) exit = true;
      } else {
        if (retBps >= DIP_TP_BPS) exit = true;
        if (retBps <= -DIP_STOP_BPS) exit = true;
        if (holdBars >= DIP_MAX_HOLD_BARS) exit = true;
      }
      if (exit) {
        mode = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: no position. The mode resets with the position.
    mode = null;
    pendingMode = null;
    if (closes.length <= WARMUP_BARS) return [];
    // Circuit breaker: a 5% equity drawdown stops NEW entries only.
    if (peakEquity > 0n && equity * 10000n < peakEquity * BigInt(10000 - CIRCUIT_BREAKER_BPS)) return [];

    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];

    // 60-bar return in bps, from closes 60 bars ago (index -61 holds it).
    const ref60 = closes.length > 60 ? closes[closes.length - 61] : null;
    const ret60Bps = ref60 !== null ? ((close - ref60) / ref60) * 10000 : null;

    // CORE entry: once only, not in a sharp 1-hour decline, above the 2h EMA.
    if (!coreBought && ret60Bps !== null && ret60Bps > CORE_MIN_60M_RETURN_BPS && trend !== null && close > trend) {
      pendingMode = 'core';
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // DIP entry: at least 0.9% below the 60-bar high, still above the 4h EMA.
    if (long !== null && close > long) {
      let hi = 0;
      const start = Math.max(0, closes.length - DIP_BARS);
      for (let i = start; i < closes.length; i++) if (closes[i]! > hi) hi = closes[i]!;
      if (hi > 0 && ((close - hi) / hi) * 10000 <= -DIP_BPS) {
        pendingMode = 'dip';
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }
    return [];
  },
});
