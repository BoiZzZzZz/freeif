# FreeIf

Merchants run "your purchase is free if X happens" promotions. A USDC vault on Arc underwrites each promo at live Gemini prediction-market odds plus a spread. When Gemini settles the market, every registered customer is paid automatically.

Built for the UBC Hackathon 2026 (DeFi track). Work in progress: this README grows as each part lands.

## Layout

| Folder | What it holds |
|---|---|
| `contracts/` | `PromoVault.sol` and its tests (Foundry) |
| `keeper/` | Node service: game list, pricing, settlement keeper, claim relayer, and the event feed behind a QuickNode Stream webhook |
| `web/` | Next.js app for merchants and customers, and the vault's page for liquidity providers |

## What is live

| | |
|---|---|
| Vault | [`0x68a00243927f250dBcD9160b5d06623b62B2e06d`](https://explorer.testnet.arc.io/address/0x68a00243927f250dBcD9160b5d06623b62B2e06d) on Arc testnet (chain 5042002), verified |
| App | [`https://freeif.app`](https://freeif.app): [`/merchant`](https://freeif.app/merchant) sets up a promo, `/claim/[id]` covers a customer, `/promo/[id]` is its status page, [`/lp`](https://freeif.app/lp) is the vault for liquidity providers. Add `?mechanics=1` to see where each number comes from. Details in [`web/README.md`](web/README.md) |
| Keeper | `https://freeif-production.up.railway.app` ([`/health`](https://freeif-production.up.railway.app/health)), API in [`keeper/README.md`](keeper/README.md) |
| First payout | [`0xfa5224c6…3fd5235`](https://explorer.testnet.arc.io/tx/0xfa5224c67e6c4bddfed785966555073b0739771081b9067fa3b4c747a3fd5235): three customers paid after Gemini settled a 5-minute BTC market "yes" |

## How Arc is used

The vault, every promo and every payout are on Arc testnet (chain 5042002). What Arc gives this app:

- **One currency.** USDC is what a merchant pays with, what the vault holds, what a customer is paid in, and what the network fee is paid in. A merchant's account needs USDC and nothing else: no second token to buy before the first promo.
- **Fees a shop can ignore.** Measured on two test promos on Nov 13 (at 20 to 23 gwei):

  | Step | Who sends it | Fee |
  |---|---|---|
  | Start a promo (`createPromoWithPermit`) | The merchant's account | $0.0068 |
  | Cover one customer (`registerClaim`) | The keeper's relayer | $0.0018 to $0.0021 |
  | Post the result (`settle`) | The keeper | $0.0008 |
  | Confirm it (`finalize`) | The keeper | $0.0010 |
  | Pay three customers (`payoutBatch`) | The keeper | $0.0024 |

  A whole promo with three customers cost under two cents. The merchant pays the first line from the same balance as the promo's price; a customer never pays a fee or signs a transaction.
- **Pay in one transaction.** Arc's USDC has `permit` (EIP-2612). The merchant's account signs a permit for exactly the promo's price, and `createPromoWithPermit` spends it in the same transaction. No standing approval is left behind.
- **Payouts pushed, not claimed.** A USDC transfer on Arc runs no code at the receiving address, so the vault can pay every customer of a promo in one batch. A transfer that fails does not stop the batch: that payout is set aside and retried. On promo 14 the three customers were paid 5 seconds after the result was confirmed.
- **Accounts by email.** Merchants and customers log in with an email code; their accounts are Circle user-controlled wallets on Arc. Only the vault's page for liquidity providers uses a browser wallet.
- **Fast enough to watch.** Blocks came every 0.5 to 1.1 seconds on the days measured, with one slow hour at 2 to 3 seconds.

The contract is verified on Arc's explorer: [`0x68a00243927f250dBcD9160b5d06623b62B2e06d`](https://explorer.testnet.arc.io/address/0x68a00243927f250dBcD9160b5d06623b62B2e06d). One thing to know when reading it: as the gas token USDC has 18 decimals, and through its ERC-20 interface, which the vault uses, it has 6.

## How Gemini is used

Gemini's prediction markets supply three things: the price of a promo, the picture of how that price moves, and the result. All of that is public market data read by the keeper (`keeper/src/gemini.ts`); no key is needed. The fourth use is a trade: the keeper places each promo's hedge as an order on Gemini's sandbox exchange (`keeper/src/hedge.ts`).

| What for | Route | What is read |
|---|---|---|
| The games a merchant can pick | `GET /v1/prediction-markets/events?status=active&search=NFL` (one league at a time) | Events whose ticker ends in `-M` (the game's winner): `startTime`, `participants`, `subcategory`, and for each contract `sportsSide`, `prices.bestBid` and `prices.bestAsk` |
| The price of a promo | `GET /v1/book/{instrumentSymbol}?limit_bids=1&limit_asks=0` and `GET /v1/prediction-markets/events/{eventTicker}` | From the book: the best bid, and every offer with how many contracts are at each price. From the event: its `status`; the contract's `marketState`, `prices.lastTradePrice`, `expiryDate`, and `description` (the rule the result is decided by, shown word for word under Proof) |
| How the chance has moved | `GET /v1/book/{instrumentSymbol}?limit_bids=1&limit_asks=1`, every 30 seconds for each open promo | The best bid and the best ask. The promo page draws them as its chart, from the price the promo was sold at to the newest reading (`GET /promos/:id/odds` on the keeper) |
| The result | `GET /v1/prediction-markets/events/{eventTicker}` once the promo has stopped taking customers | The contract's `resolutionSide`, `yes` or `no`, and the event's `id` |
| The hedge | `POST /v1/prediction-markets/order` and `/order/cancel` on the sandbox exchange, with a sandbox API key | For each open promo, a limit order to buy "yes" on its contract: one contract per dollar of payout, at the price the promo was sold on. The order id shows on `/lp` and under Proof |

- **The price.** A promo costs what its hedge would cost on Gemini, plus 5%. A "yes" contract pays $1 if the result happens, so the promo's whole payout is bought from the book's offers, cheapest first, and the chance a merchant sees is what a dollar of payout costs that way. Inside the best offer that is the ask. A bigger promo reaches dearer offers, so a few contracts offered low do not set the price of a large promo. The part of a payout the book does not offer cannot be hedged: it is priced at the dearest offer taken and carries 15%. All of this holds while the book is a market: someone on each side, at most half a dollar apart. A book with a side missing is priced on the highest price it shows with 15% on top, and only if the result has traded; an offer with nobody on the other side and no trade behind it is not a price. The rules are in [`keeper/README.md`](keeper/README.md), "Pricing rules".
- **The result, and how to check it.** The vault stores the hash of Gemini's event id and of the contract's symbol when the promo is created. `settle(promoId, outcomeYes, eventId, resolutionSide)` reverts unless the event id it is given hashes to the stored one, so a result can only be posted for the event the promo was sold on. To check a promo: open its page, open Proof, follow "Gemini event" to Gemini's own answer for that event, and compare the contract's `resolutionSide` with the `Settled` event of "Settlement on Arc".
- **The hedge.** A "yes" contract pays $1 if the result happens, so buying one for every dollar a promo can pay is the other side of the vault's position. The keeper places that order through Gemini's trading API on the sandbox exchange and keeps its id with the promo. The sandbox lists crypto and commodity markets only, so a promo on a game shows the order the keeper would place, marked simulated. No money moves either way: the vault has no path to Gemini, and that is roadmap. Details in [`keeper/README.md`](keeper/README.md), "The hedge".
- **One contract per promo.** A promo names exactly one Gemini contract. Nothing in the vault or the pricing assumes sports: the test loop runs on 5-minute BTC markets.

## The QuickNode Stream

The promo page and the customer's card are live: a line appears when a customer is covered, when the result is posted, when each customer is paid. Those are events on the vault, and a QuickNode Stream is how they get from the chain to the page.

| | |
|---|---|
| Network | Arc Testnet |
| Dataset | `logs` |
| Filter | [`keeper/stream/filter.js`](keeper/stream/filter.js): keep a log when its address is the vault and its first topic is one of the eleven events the app shows or acts on; name it, and add its promo id and the account it is about. Return `null` for a block with none, so nothing is delivered |
| Destination | Webhook, `POST https://freeif-production.up.railway.app/stream`. The keeper checks QuickNode's signature on each delivery (or the secret header the Stream sends) |

```js
function main(payload) {
  var logs = collect(payload.data, []);   // blocks > transactions > logs
  var events = [];
  for (var i = 0; i < logs.length; i++) {
    var log = logs[i];
    if (String(log.address).toLowerCase() !== VAULT) continue;
    var kind = EVENTS[log.topics[0]];       // topic hash -> { name, promo, account }
    if (!kind) continue;
    events.push({ event: kind.name, promoId: kind.promo ? parseInt(log.topics[1], 16) : null, /* tx, block, time, topics, data */ });
  }
  return events.length === 0 ? null : { vault: VAULT, events: events };
}
```

What the keeper does with a delivery: it decodes each log with the contract's ABI, keeps it, and pushes it over server-sent events to every page that has that promo open (`GET /promos/:id/events`). The page shows the line at once and reads the promo again. A `Finalized` event with a "yes" also wakes the settlement loop, so the payout follows the confirmation by seconds.

Why a Stream and not polling: one delivery per block with vault activity reaches one place and fans out to every viewer. No browser asks the chain, and the public RPC's rate limit stops being the app's limit.

What happens when the Stream is late or off: the keeper also reads the vault's logs from the chain every two seconds, and adds any event the Stream has not delivered once it is four seconds old. Every event is marked with the way it came. Turn on the mechanics view (`?mechanics=1`) on a promo page to see it on each line: "QuickNode Stream" or "RPC", with how many seconds after its block the keeper had the event.

The filter is tested as it runs, against real blocks of the deployed vault, and its topic hashes are checked against the ABI (`keeper/test/stream.test.ts`). More in [`keeper/README.md`](keeper/README.md), "The feed".

What was measured on Nov 13, on the first four promos run with the Stream on ([17](https://freeif.app/promo/17?mechanics=1), [18](https://freeif.app/promo/18?mechanics=1), [19](https://freeif.app/promo/19?mechanics=1) and [20](https://freeif.app/promo/20?mechanics=1), each on a 5-minute BTC market):

| | |
|---|---|
| Events that came by the Stream | 27 of 27, in 25 deliveries, every delivery with a valid QuickNode signature. The keeper's own read had nothing to add |
| From a block to the keeper having its event | 0.4 to 1.7 seconds, 1.05 on average. By the keeper's own read, before the Stream, it was 4 to 7 |
| From a block to the line on the promo page | One to two seconds (promo 20, watched in a browser) |
| A payout started by a delivery (promo 20) | The Stream delivered `Finalized` 1.4 seconds after its block; the three customers were paid three blocks after it, and the Stream delivered the three `Paid` events 1.0 second after theirs |
| The Stream's place on the chain | The newest block, with one block per delivery, while Arc made a block every 0.7 seconds |

Open one of those promos: the top of the page says "Live · QuickNode Stream", and each line under "What's happening" says how it came and how long after its block.

The Stream is made, tested, paused and removed by one script, `keeper/scripts/stream.ts` (`pnpm stream on`, `test`, `off`, `status`, `remove`), so its settings are in the repo. A Stream is billed for every block it reads, so it is paused when nobody is watching; the pages then run on the keeper's own read and say "RPC".

## Run the contract tests

```
cd contracts
forge test
```

Needs [Foundry](https://getfoundry.sh). Dependencies are git submodules: run `git submodule update --init` after cloning.

## Run the keeper tests

```
cd keeper
pnpm install
pnpm test
```

Needs Node 24 and pnpm.

## Run the web app

```
cd web
pnpm install
pnpm dev
```

It talks to the hosted keeper by default. The email login needs a Circle API key and app id; see [`web/README.md`](web/README.md).

## License

MIT
