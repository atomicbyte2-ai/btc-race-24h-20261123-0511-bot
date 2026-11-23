# BTC Race Bot — btc-race-24h-20261123-0511

[![competition](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/atomicbyte2-ai/btc-race-24h-20261123-0511-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/atomicbyte2-ai/btc-race-24h-20261123-0511-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A BTC trading bot for the make.fun bounty "Race a BTC trading bot live for 24 hours".
It trades Coinbase Wrapped BTC (cbBTC) vs USDC on 1-minute bars, long only, starting
from $1,000 paper money.

## Strategy

1-minute BTC mean-reverts too fast for fast EMA crosses to pay the ~42 bps
round-trip cost (4 bps fee + 2 bps slippage + ~17 bps pool impact a side), so
this bot trades rarely and only for moves of 1% or more:

- **Core**: one early full-size buy, only when the market is not in a sharp
  1-hour decline (60-bar return above −0.5%) and price sits above its 2-hour
  EMA(120). It rides with a 1.2% trailing stop and a 2% hard stop, so a down
  day costs about one trailing stop instead of the whole drift.
- **Dip**: while flat, buy a pullback of at least 0.9% from the 60-bar high
  while price is still above its 4-hour EMA(240). Exit at +1.0% take-profit,
  −1.0% stop, or after 180 bars.
- **Circuit breaker**: no new entries once equity has drawn down 5% from its
  peak; exits are never blocked.

Warmup is 60 bars. The bot is fully deterministic: no clock, no network, no
randomness, no files outside the repo.

## Local grades (kit grade-local, `--driver process`)

| Window | Net PnL | Trades | Max DD | Fees |
| ------ | ------- | ------ | ------ | ---- |
| Dev 2026-11-22 → 2026-11-23 (new) | +$25.70 | 4 | 1.87% | $1.63 |
| Dev 2026-11-18 (old, second regime) | +$3.11 | 2 | 1.41% | $0.80 |

Net PnL at 2x fees is still positive on both windows (+$24.07 new, +$2.31 old).
Two local runs on the new window produce identical action logs (deterministic).

## Run

```sh
node main.ts
```

It speaks `agent-fun/bars-replay/v1` on stdin/stdout via the vendored SDK
(`vendor/makefun-bars.ts`, a byte-for-byte copy of the kit SDK).
