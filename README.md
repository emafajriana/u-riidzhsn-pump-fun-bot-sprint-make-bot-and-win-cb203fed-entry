[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/emafajriana/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/emafajriana/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint: Make Bot and Win

A paper-trading bot for the [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) pump.fun replay sprint. It trades paper money on a replay of pump.fun bonding-curve data — no real funds, ever.

## Strategy: second-wind bounce

Most curves spike once and die; the ones that pay spike, pull back hard, and bounce with fresh buying. This bot buys only the bounce:

- **Entry:** curve ran +30% from create, pulled back 5–20% from its own peak, and buyers are returning (net SOL flow ≥ +0.15 over the last 20 slots, ≥3 distinct buyers in the last 40, latest trade a buy, last 10 slots not net selling). Creator never sold. Fixed 0.05 SOL stake, one entry per coin.
- **Exits:** take profit +40%, hard stop −15%, 20% trailing stop once +15% up, 1500-slot time box, instant exit on creator sell, a single 2+ SOL dump, or net flow below −0.5 SOL over 15 slots.

Fully deterministic (BigInt price ratios, insertion-ordered maps, no clock/randomness/IO) — the two grading runs reproduce byte for byte.

## Measured results (dev window, grade-local)

- **Net PnL −0.162 SOL** (90% interval −0.256 … −0.077), 210 fills over 105 coins, 105 round trips, win rate 21.9%, max drawdown 0.018. Guardrails met.
- Honest read: on the dev window this bot loses a little, like every strategy tried on this dataset (sibling bots: second-leg retest −0.143, early-momentum −0.58). The final window is a fresh 6-hour sample — this is a free lottery ticket that needs a friendlier window to place, not a measured edge.

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout (Node 22)
```

`vendor/makefun-bot.ts` is the kit's bot shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
