// Pump.fun Bot Sprint: Make Bot and Win — "second-wind bounce" bot.
//
// Idea: most pump.fun curves spike once and die; the ones that pay are
// the ones that spike, pull back hard, and then bounce with fresh
// buying. So: buy only the bounce. A curve must have run up at least
// +30% from create, pulled back at least 8% from its own peak (but no
// more than 20% — deeper than that it is usually dead), and be showing
// buyers returning right now (positive net SOL flow over the last 20
// slots, at least 3 distinct buyers in the last 40, the latest trade a
// buy). One small fixed stake per coin, no pyramiding: a false bounce
// costs one stake, a real second wind pays for several losers.
//
// Exits: take profit at +40% of cost, hard stop at -15%, a 20%
// trailing stop once the position is +15% up, a 1500-slot time box,
// and instant exit on creator sell, a single 2+ SOL dump, or net flow
// turning hard negative (-0.5 SOL over 15 slots) — the fade exit that
// does the real loser-cutting when the bounce fails.
//
// Why this shape: on the shared dev window the two sibling bots tried
// early-momentum (boothlord v4: -0.58 SOL, 13% wins) and second-leg
// retest (jackxyz72: -0.14 SOL, 29.5% wins). The retest family was
// clearly better, so this bot stays in that family but buys deeper in
// the dip (8-20% below peak instead of within 3% of the high) and
// demands flow confirmation before entry, which the retest bot did not
// require at the moment of entry. Every parameter is a guess until
// grade-local says otherwise — see STATE.md for the measured numbers.
//
// Fees decide the sizing: a round trip costs ~1.25% of size per leg in
// curve fees plus 105,000 lamports of tx fees, so a stake below ~0.05
// SOL is fee food and a take-profit below ~+35% barely clears costs.
//
// Deterministic by construction: every decision is a pure function of
// the batches fed in (insertion-ordered maps, BigInt price ratios, no
// clock, no randomness, no I/O). The two grading runs must agree.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ params

const SOL = LAMPORTS_PER_SOL;
const BPS = 10_000n;

// Entry: how young a curve may be (slots since its CreateEvent).
const MIN_AGE_SLOTS = 60;
const MAX_AGE_SLOTS = 1_200;
// Entry: price now vs create price, in bps.
const MIN_RUNUP_BPS = 3_000; // +30% from create
// Entry: pullback from the coin's own peak, in bps. Must have dipped
// at least this far, but not further than MAX_PULLBACK_BPS.
const MIN_PULLBACK_BPS = 500; // >= 5% below peak
const MAX_PULLBACK_BPS = 2_000; // <= 20% below peak
// Entry: buyers returning — net SOL flow over the last N slots.
const FLOW_WINDOW_SLOTS = 20;
const MIN_RETURN_FLOW_LAMPORTS = 150_000_000n; // +0.15 SOL net buys
// The bounce must be happening NOW, not 20 slots ago: the most recent
// 10 slots must not be net selling (the pullback's own sells can sit
// inside the 20-slot window and must not veto a real bounce, but a
// fresh wave of selling right at entry time must).
const RECENT_FLOW_SLOTS = 10;
const BUYER_WINDOW_SLOTS = 40;
const MIN_BUYERS = 3;
// Entry: curve size band (real SOL reserve).
const MIN_REAL_SOL_LAMPORTS = 1_000_000_000n; // 1 SOL
const MAX_REAL_SOL_LAMPORTS = 50_000_000_000n; // 50 SOL
// Sizing: fixed stake per coin, capped at 1% of the real reserve.
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL, below this skip
// Exits: value vs cost basis (cost includes fees).
const STOP_LOSS_BPS = 1_500; // sell when value <= cost * 0.85
const TAKE_PROFIT_BPS = 4_000; // sell when value >= cost * 1.40
const TRAIL_ARM_BPS = 1_500; // trail arms at value >= cost * 1.15
const TRAIL_BPS = 2_000; // sell when value <= peak * 0.80
const MAX_HOLD_SLOTS = 1_500;
const COOLDOWN_SLOTS = 600;
const MAX_ENTRIES_PER_MINT = 1;
// A single sell of this size on a held coin means exit now.
const BIG_SELL_LAMPORTS = 2_000_000_000n; // 2 SOL
// Fade exit: net flow over this window below this means exit now.
const FADE_WINDOW_SLOTS = 15;
const FADE_FLOW_LAMPORTS = -500_000_000n; // -0.5 SOL
// Slippage: buys tight, sells at any price (getting out matters).
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 10_000;
// Flow: at most this many fresh buys per batch.
const MAX_NEW_BUYS_PER_BATCH = 2;
// Safety net: if the tape is too quiet late in the run, loosen up so
// the guardrail (20 distinct coins) is still met.
const LOOSEN_AFTER_SLOTS = 15_000;
const LOOSE_MIN_RUNUP_BPS = 1_500;
const LOOSE_MIN_FLOW_LAMPORTS = 50_000_000n;
const LOOSE_MIN_BUYERS = 2;

// ------------------------------------------------------------------ tape

/** Everything remembered about one curve, fed only by batch events. */
interface Tape {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number | null;
  /** Price at create (virtual SOL / virtual token), as a ratio. */
  createSol: bigint;
  createTok: bigint;
  /** Best price seen since create, as a ratio, and when it happened. */
  peakSol: bigint;
  peakTok: bigint;
  peakSlot: number;
  buySol: bigint;
  sellSol: bigint;
  buyTrades: number;
  creatorSold: boolean;
  bigSellSeen: boolean;
  entries: number;
  lastExitSlot: number;
  firstSeenSlot: number;
  /** Recent trades, oldest first, capped: {slot, signed SOL, price, buyer}. */
  trades: Array<{
    slot: number;
    net: bigint;
    vSol: bigint;
    vTok: bigint;
    user: Pubkey;
    isBuy: boolean;
  }>;
}

/** A held position: when it was first seen and at what cost. */
interface Held {
  mint: Pubkey;
  sinceSlot: number;
  costLamports: bigint;
  tokenAmount: bigint;
  /** Best value (lamports) seen since entry; the trailing stop trails it. */
  peakLamports: bigint;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const startSlot = { value: -1 };

/** a >= b * (1 + bps/10000), all BigInt, no floats. */
function priceGte(aSol: bigint, aTok: bigint, bSol: bigint, bTok: bigint, bps: number): boolean {
  return aSol * bTok * BPS >= bSol * aTok * (BPS + BigInt(bps));
}

/** a <= b * (1 - bps/10000). */
function priceLte(aSol: bigint, aTok: bigint, bSol: bigint, bTok: bigint, bps: number): boolean {
  return aSol * bTok * BPS <= bSol * aTok * (BPS - BigInt(bps));
}

/** Compare two prices a/b vs c/d: 1 if a/b > c/d, -1 if <, 0 if equal. */
function priceCmp(aSol: bigint, aTok: bigint, bSol: bigint, bTok: bigint): number {
  const l = aSol * bTok;
  const r = bSol * aTok;
  return l > r ? 1 : l < r ? -1 : 0;
}

function tapeFor(mint: Pubkey, slot: number): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      mint,
      creator: "",
      createdSlot: null,
      createSol: 0n,
      createTok: 0n,
      peakSol: 0n,
      peakTok: 1n,
      peakSlot: slot,
      buySol: 0n,
      sellSol: 0n,
      buyTrades: 0,
      creatorSold: false,
      bigSellSeen: false,
      entries: 0,
      lastExitSlot: -1_000_000,
      firstSeenSlot: slot,
      trades: [],
    };
    tapes.set(mint, t);
  }
  return t;
}

/** Fold one batch's events into the tapes. Pure function of the batch. */
function feedEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const t = tapeFor(e.mint, e.slot);
      if (t.createdSlot === null) {
        t.createdSlot = e.slot;
        t.creator = e.creator;
        t.createSol = BigInt(e.virtual_sol_reserves);
        t.createTok = BigInt(e.virtual_token_reserves);
        t.peakSol = t.createSol;
        t.peakTok = t.createTok;
        t.peakSlot = e.slot;
      }
    } else if (e.event === "TradeEvent") {
      const t = tapeFor(e.mint, e.slot);
      const vSol = BigInt(e.virtual_sol_reserves);
      const vTok = BigInt(e.virtual_token_reserves);
      if (t.createdSlot === null) {
        // Trade seen before the create: anchor the price here instead.
        t.createdSlot = e.slot;
        t.creator = e.creator;
        t.createSol = vSol;
        t.createTok = vTok;
        t.peakSol = vSol;
        t.peakTok = vTok;
        t.peakSlot = e.slot;
      }
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) {
        t.buySol += sol;
        t.buyTrades += 1;
      } else {
        t.sellSol += sol;
        if (e.user === t.creator) t.creatorSold = true;
        if (sol >= BIG_SELL_LAMPORTS) t.bigSellSeen = true;
      }
      if (vTok > 0n && priceCmp(vSol, vTok, t.peakSol, t.peakTok) > 0) {
        t.peakSol = vSol;
        t.peakTok = vTok;
        t.peakSlot = e.slot;
      }
      t.trades.push({ slot: e.slot, net: e.is_buy ? sol : -sol, vSol, vTok, user: e.user, isBuy: e.is_buy });
      if (t.trades.length > 400) t.trades.shift();
    } else {
      // CompleteEvent: the curve is done; drop its tape so it is never
      // reconsidered, and forget any held record (harness closes it).
      tapes.delete(e.mint);
      held.delete(e.mint);
    }
  }
}

/** Net SOL flow over the last N slots of this tape's trades. */
function netFlow(t: Tape, nowSlot: number, windowSlots: number): bigint {
  let flow = 0n;
  const from = nowSlot - windowSlots;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i];
    if (tr.slot < from) break;
    flow += tr.net;
  }
  return flow;
}

/** Distinct buyers over the last N slots of this tape's trades. */
function distinctBuyers(t: Tape, nowSlot: number, windowSlots: number): number {
  const buyers = new Set<Pubkey>();
  const from = nowSlot - windowSlots;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i];
    if (tr.slot < from) break;
    if (tr.isBuy) buyers.add(tr.user);
  }
  return buyers.size;
}

// ------------------------------------------------------------------ decisions

function looseMode(batch: Batch): boolean {
  return startSlot.value >= 0 && batch.slot - startSlot.value >= LOOSEN_AFTER_SLOTS;
}

/** Should this curve be bought now? All gates must pass. */
function entrySignal(state: BotState, batch: Batch, t: Tape): boolean {
  const curve = state.curves.get(t.mint);
  if (curve === undefined || curve.complete) return false;
  if (t.createdSlot === null) return false;
  const age = batch.slot - t.createdSlot;
  if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return false;
  if (t.createSol === 0n || t.createTok === 0n) return false;
  if (t.creatorSold) return false;
  if (t.entries >= MAX_ENTRIES_PER_MINT) return false;
  if (batch.slot - t.lastExitSlot < COOLDOWN_SLOTS) return false;

  const loose = looseMode(batch);
  const minRunup = loose ? LOOSE_MIN_RUNUP_BPS : MIN_RUNUP_BPS;
  const minFlow = loose ? LOOSE_MIN_FLOW_LAMPORTS : MIN_RETURN_FLOW_LAMPORTS;
  const minBuyers = loose ? LOOSE_MIN_BUYERS : MIN_BUYERS;

  const nowSol = curve.virtual_quote_reserves;
  const nowTok = curve.virtual_token_reserves;
  if (nowTok === 0n) return false;

  // Ran up from create, then pulled back from its own peak: the dip
  // must be real (>= 8%) but not a collapse (<= 20%).
  if (!priceGte(nowSol, nowTok, t.createSol, t.createTok, minRunup)) return false;
  if (!priceLte(nowSol, nowTok, t.peakSol, t.peakTok, MIN_PULLBACK_BPS)) return false;
  if (priceLte(nowSol, nowTok, t.peakSol, t.peakTok, MAX_PULLBACK_BPS)) return false;

  // Buyers returning: positive net flow over the last 20 slots, enough
  // distinct buyers recently, the latest trade a buy — and the most
  // recent 10 slots must not be net selling.
  if (netFlow(t, batch.slot, FLOW_WINDOW_SLOTS) < minFlow) return false;
  if (netFlow(t, batch.slot, RECENT_FLOW_SLOTS) < 0n) return false;
  if (distinctBuyers(t, batch.slot, BUYER_WINDOW_SLOTS) < minBuyers) return false;
  const last = t.trades[t.trades.length - 1];
  if (last === undefined || !last.isBuy) return false;

  // Curve size: real SOL in a sane band (dust and giants both skip).
  const rq = curve.real_quote_reserves;
  if (rq < MIN_REAL_SOL_LAMPORTS || rq > MAX_REAL_SOL_LAMPORTS) return false;
  return true;
}

/** Size a buy: fixed stake, capped at 1% of the real SOL reserve. */
function buySizeLamports(state: BotState, mint: Pubkey): bigint {
  const cap = state.maxBuyLamports(mint);
  if (cap <= 0n) return 0n;
  const size = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
  return size >= MIN_BUY_LAMPORTS ? size : 0n;
}

/**
 * Decide this batch's orders. Exits first (never leave a loser open to
 * make room for a buy), then fresh entries while slots are free.
 */
function decide(state: BotState, batch: Batch): OrderInput[] {
  if (startSlot.value < 0) startSlot.value = batch.slot;
  feedEvents(batch);

  // Count entries on fills, not on orders: a rejected buy must not
  // burn the mint's one entry.
  for (const f of batch.fills) {
    if (f.status === "filled" && f.side === "buy") {
      const t = tapes.get(f.mint);
      if (t !== undefined) t.entries += 1;
    }
  }

  const orders: OrderInput[] = [];
  const pendingSell = new Set<Pubkey>();
  const pendingBuy = new Set<Pubkey>();
  for (const p of state.pending.values()) {
    if (p.order.side === "sell") pendingSell.add(p.order.mint);
    else pendingBuy.add(p.order.mint);
  }

  // Sync held records with the account: drop closed positions, note
  // newly filled ones with their cost basis.
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) {
      const t = tapes.get(mint);
      if (t !== undefined) t.lastExitSlot = batch.slot;
      held.delete(mint);
    }
  }
  for (const [mint, pos] of state.positions) {
    const h = held.get(mint);
    if (h === undefined) {
      held.set(mint, {
        mint,
        sinceSlot: batch.slot,
        costLamports: pos.cost_lamports,
        tokenAmount: pos.token_amount,
        peakLamports: pos.cost_lamports,
      });
    } else {
      h.costLamports = pos.cost_lamports;
      h.tokenAmount = pos.token_amount;
    }
  }

  // ---- exits: sell the whole position on the first trigger that hits.
  for (const [mint, h] of held) {
    if (pendingSell.has(mint)) continue;
    const curve = state.curves.get(mint);
    const t = tapes.get(mint);
    let exitAll = false;
    if (curve !== undefined && curve.virtual_token_reserves > 0n) {
      // Current value = tokens * price; track its peak for the trail.
      const value = (h.tokenAmount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      if (value > h.peakLamports) h.peakLamports = value;
      // Hard stop: value <= cost * 0.85.
      if (value * BPS <= h.costLamports * (BPS - BigInt(STOP_LOSS_BPS))) exitAll = true;
      // Take profit: value >= cost * 1.40.
      if (value * BPS >= h.costLamports * (BPS + BigInt(TAKE_PROFIT_BPS))) exitAll = true;
      // Trailing stop, armed once peak >= cost * 1.15:
      // value <= peak * 0.80.
      if (h.peakLamports * BPS >= h.costLamports * (BPS + BigInt(TRAIL_ARM_BPS))) {
        if (value * BPS <= h.peakLamports * (BPS - BigInt(TRAIL_BPS))) exitAll = true;
      }
    }
    if (batch.slot - h.sinceSlot >= MAX_HOLD_SLOTS) exitAll = true;
    if (t !== undefined && (t.creatorSold || t.bigSellSeen)) exitAll = true;
    // Fade exit: net flow over the last 15 slots below -0.5 SOL.
    if (t !== undefined && netFlow(t, batch.slot, FADE_WINDOW_SLOTS) < FADE_FLOW_LAMPORTS) exitAll = true;
    if (exitAll) {
      orders.push({
        side: "sell",
        mint,
        token_amount: h.tokenAmount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // ---- entries: curves in first-seen order; the per-batch cap spreads
  // entries across time instead of filling all slots on one batch.
  const openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  let buys = 0;
  if (openSlots > 0) {
    for (const t of tapes.values()) {
      if (buys >= MAX_NEW_BUYS_PER_BATCH || buys >= openSlots) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (state.positions.has(t.mint) || pendingBuy.has(t.mint)) continue;
      if (!entrySignal(state, batch, t)) continue;
      const size = buySizeLamports(state, t.mint);
      if (size === 0n) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({
        side: "buy",
        mint: t.mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      buys += 1;
    }
  }
  return orders;
}

// ------------------------------------------------------------------ run

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    return decide(state, batch);
  },
});
