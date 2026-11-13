# keeper

One Node process that does seven jobs for `PromoVault`:

- **Game list.** Reads Gemini's active game-winner markets league by league and serves them to the merchant form, each team with its chance and the words a customer reads ("the Lions win"). It does the same for Gemini's daily high-temperature markets, which are what a business can buy cover on for itself (hedge mode).
- **Pricing.** Reads a result's order book from Gemini, prices the promo's payout on the offers that are there, adds the spread, checks the vault can cover the promo, and signs the EIP-712 quote that `createPromo` checks.
- **Claim relayer.** Its key is every promo's claim signer, so it is the only address that can register a customer. A claim carries the customer's Circle login token; the relayer asks Circle whose it is and registers only that user's own wallet, once per user per promo.
- **Settlement loop.** Every 30 seconds: posts Gemini's result once claims are closed (`settle`), finalizes after the dispute window (`finalize`), and pays the customers of a "yes" (`payoutBatch`, 50 per transaction). Every 10 minutes it retries payouts whose transfer failed (`retryPayout`).
- **Odds history.** On every pass of that loop it reads the top of Gemini's order book for the contract of each promo that has no result yet, and keeps the bid and the ask with the time. The promo page draws them as its chart: how the chance has moved since the promo started.
- **Hedge.** For each open promo it places a limit order on Gemini's sandbox exchange: buy "yes" on the promo's contract, one contract per dollar of payout, at the price the promo was sold on. The order's id is kept with the promo and cancelled when the promo is over. For a contract the sandbox does not list, it writes down the order it would place, marked simulated.
- **Event feed.** A QuickNode Stream posts the vault's logs to `POST /stream` as blocks land. The keeper decodes them, keeps them, and pushes each one to the pages that show its promo. It also reads the chain's logs itself, a few seconds behind, for any event the Stream has not delivered. Each event remembers which way it came.

Each step of the loop is decided from on-chain state and simulated before it is sent, so a restart never repeats one.

## Run it

Needs Node 24 and pnpm. TypeScript runs directly; there is no build step.

```
pnpm install
pnpm start        # the API on port 8787 and the loop
pnpm test         # unit tests (Gemini, Circle and the chain are fakes), plus three that read the deployed vault (skipped without VAULT_ADDRESS)
pnpm typecheck
pnpm abi          # rewrite src/abi.ts after a contract change (run `forge build` in ../contracts first)
pnpm ship         # deploy the pushed commit to Railway and wait for it
pnpm stream on    # start the QuickNode Stream at the newest block (also: status, test, off, remove)
```

Settings come from the environment. On a developer machine they are read from `~/.freeif/secrets.env` (or the file named in `FREEIF_SECRETS`), which is never inside this repo; variables already in the environment win.

| Variable | What it is |
|---|---|
| `VAULT_ADDRESS` | The deployed `PromoVault` |
| `PRICER_PK`, `ORACLE_PK`, `RELAYER_PK` | The three service keys. The keeper refuses to start if the first two are not the vault's `pricer` and `oracle` |
| `CIRCLE_API_KEY` | Circle's API key, the one the web app uses. The relayer asks Circle whose login a claim carries. Required |
| `CLAIM_TEST_KEY` | Optional. A secret that lets the test loop register customers that have no login (see `POST /claims`) and have a quote signed on a 5 or 15-minute market (see `POST /quote`). Unset, that way in does not exist and those markets are not sold |
| `ARC_RPC_URL`, `QUICKNODE_ARC_RPC_URL` | RPC endpoints. The first is asked; the second only when the first cannot answer, and only while it is within 20 blocks of the first. Default: the public Arc testnet RPC |
| `GEMINI_SANDBOX_KEY`, `GEMINI_SANDBOX_SECRET` | Optional. An API key of a Gemini sandbox account (`https://exchange.sandbox.gemini.com`), for the hedge orders. Unset, every hedge is written down as simulated. `GEMINI_SANDBOX_BASE` defaults to `https://api.sandbox.gemini.com` |
| `QUICKNODE_STREAM_SECRET` | The secret the Stream proves itself with (its security token, and the header `x-stream-secret`). Unset, `POST /stream` refuses every delivery and the feed is read from the chain alone |
| `QUICKNODE_API_KEY` | Only for `pnpm stream`: a QuickNode API key with the Streams permission |
| `FEED_RPC_MS`, `FEED_GRACE_MS`, `FEED_START_BLOCK` | The keeper's own read of the vault's logs: how often (2000), how long a log waits for the Stream first (4000), and where the first read starts (default: the vault's first block, found by itself) |
| `USDC_ADDRESS`, `GEMINI_BASE` | Defaults: Arc testnet USDC, `https://api.gemini.com` |
| `PORT`, `KEEPER_LOOP_MS`, `KEEPER_RETRY_MS`, `KEEPER_DATA_DIR` | Defaults: 8787, 30000, 600000, `./data` |
| `SPREAD_BPS`, `THIN_SPREAD_BPS`, `MAX_LOCKED_BPS`, `EXPOSURE_HEADROOM_BPS`, `LOADING_BPS_PER_STEP` | Pricing settings. Defaults: 500, 1500, 6000, 9000, 0 |
| `MIN_MARKUP_BPS`, `LOADING_STEP_BPS` | The least a premium may be above the expected loss (200), and the size of one step of the loading that `LOADING_BPS_PER_STEP` switches on (500: every 5% of the vault locked) |
| `QUOTE_TTL_SECONDS`, `MIN_CLAIM_WINDOW_SECONDS`, `INTERVAL_CUTOFF_SECONDS` | How long a signed quote can be used (90), how close its claim deadline may be (30), and how long before its close a 5 or 15-minute market stops taking customers (60) |

## API

Amounts are USDC base units (6 decimals) as decimal strings. Times are unix seconds. Errors are `{ "error": { "code", "message" } }`; `message` is written for the person using the form.

| Route | What it does |
|---|---|
| `GET /health` | The vault, the three service addresses, the latest block, the commit the hosted build was made from, and `stream`: deliveries so far, how many carried QuickNode's signature, when the last one came, how many events the feed holds and how many of them the Stream delivered |
| `GET /health/rpc` | Whether each RPC endpoint answers, and how fast |
| `GET /games?league=nba` | One league's games that have not started, soonest first: `eventTicker`, `game` ("Cavaliers at Heat"), `startTime`, and for each team its `instrumentSymbol`, `team`, `condition` ("the Heat win"), `chance` and `quotable`. `leagues` lists the leagues (`nfl`, `nba`, `nhl`, `ncaaf`, `ncaam`) |
| `GET /weather` | The same shape for hedge mode: Gemini's daily high-temperature markets whose day has not begun, soonest first, then by city. Each one has `game` ("Austin high on November 14"), `city`, `day`, `startTime` (when its day begins: cover is sold until then), and under `teams` its temperature ranges from the coldest up, each with `team` ("66°F or below"), `condition` ("the high in Austin on November 14 is 66°F or below"), `chance` and `quotable` |
| `GET /price?eventTicker=&instrumentSymbol=&payoutPerClaim=&maxClaims=&claimDeadline=` | The price of a promo, unsigned. `breakdown` has `chance`, `mostOwed`, `fee` and `cost`; `mechanics` has the bid, the ask, the last trade, the spread used, `thin` (the book is not a market, so the spread is the wider one), `covered` (how much of the payout Gemini's offers cover) and `offers` (the cheapest five, as `[price, contracts]`); `maxCustomers` is the most customers the vault can cover right now and `maxPayout` the most one promo could pay in all; `limit` is `ok` or the limit the request is over; `display` has the words for the card (`game`, `team`, `subject`, `condition`, `league`, `startTime`) and `rule` is Gemini's rule for the result |
| `POST /quote` | Body: the same fields plus `merchant` (and `hedgeMode`, and `item` and `business` for the promo's card). Returns the price plus `quote` and `signature` for `createPromo(quote, signature)`. Good for 90 seconds, for that merchant only. Answers 422 with a reason when the vault cannot take the promo. With `hedgeMode: true` the payout goes to the merchant itself: `maxClaims` must be 1, `payoutPerClaim` is the whole payout, and a refusal for size carries `maxPayout`, the most the vault can cover. On a 5 or 15-minute market (the test loop's) the request needs the header `X-Test-Key: <CLAIM_TEST_KEY>`; without it the answer is 422 `test-only` ("This market is for testing only.") and nothing is signed (below) |
| `POST /claims` | Body: `promoId`, `customer`, `userToken` (the customer's Circle login token from the web app). The keeper asks Circle whose token it is, then registers the customer on chain. 401 `login` when Circle does not know the token (it lasts an hour), 403 `not-your-wallet` when `customer` is not one of that user's wallets on Arc, 409 `already-claimed` when that user has claimed this promo with another wallet, 502 `failed` when Circle or the chain cannot be reached. A repeated claim answers 200 with `alreadyRegistered: true` and sends nothing. The test loop sends `testUser` (any name) in place of `userToken`, with the header `X-Test-Key: <CLAIM_TEST_KEY>` |
| `GET /promos/:id` | The promo as the chain has it, with the event and result names behind its two hashes, the words for the card, `item` and `business`, `events` (the promo's events on the vault, oldest first, each with `via`: `stream` or `rpc`), `stream` (the Stream's deliveries so far and the time of the last), `hedge` (the promo's hedge order, below) and `txs` (the transactions the keeper sent for it). With `?customer=0x...` it adds `customer`: that address's place in line, and whether it has been paid. The chain is read once a second per promo at most, however many pages ask |
| `GET /promos/:id/events` | Server-sent events: each new event on the promo as a `vault` message, the moment the keeper has it. The pages keep this open |
| `GET /promos/:id/odds` | How the promo's chance has moved since it started. `points` are the keeper's readings of Gemini's book, oldest first, each `[time, chance, bid, ask]` with the three prices in basis points of a dollar (4100 is 0.41, a 41% chance); `start` is the reading the promo was priced on, at the time the promo started; `latest` is the newest reading; `everySeconds` is how often the book is read. With `?after=<time>` only the readings later than that. The chain is not read |
| `GET /events` | The same as `GET /promos/:id/events`, for every event on the vault |
| `GET /feed?limit=100` | The newest events of every kind, oldest first, and the Stream's record |
| `POST /stream` | The QuickNode Stream's webhook. Takes a delivery with QuickNode's signature or with the secret header; answers 401 to anything else |
| `GET /vault` | The vault as a liquidity provider reads it: `balance`, `locked`, `pending` (the locks of promos with no final result), `free` (what a withdrawal is priced on), `depositBasis` (what a deposit is priced on), `totalShares`, the two limits, `netEarned`, every promo with what it locks, what it made and, while it has no result, its `chance` at the newest reading of Gemini's book, its `hedge`, and the newest events. One read of the chain, shared for two seconds |
| `GET /intervals?series=BTC05M` | The next windows of a 5 or 15-minute crypto market (the test loop) |

`claimDeadline` is `start` (the default: the promo takes customers until the event starts), `30min` (until 30 minutes before) or a unix time no later than the start. The start is kickoff for a game. A daily temperature market has no start time on Gemini: its day is taken to begin 24 hours before the market closes (it closes at 04:59:59 UTC, the end of the day in Eastern time), and nothing is sold on it after that, because from then on the high is being measured. Any other event with no start time is refused (`unknown-event`), for a price and for a quote: nothing says when its result begins to be known.

The test loop's 5 and 15-minute markets take customers until 60 seconds before they close (`INTERVAL_CUTOFF_SECONDS`), so they are sold while they run. A signed quote stands for 90 seconds, and on a market that is running that is time to watch the price and use the quote only if it moved the buyer's way, at the vault's cost. So `POST /quote` signs a quote on one of those markets only for a request that carries the test key, and a keeper without `CLAIM_TEST_KEY` does not sell them at all. `GET /price` and `GET /intervals` sign nothing and stay open.

### Limits

None of these routes needs a login, so a client is the address its request came from (Railway's proxy puts it in `X-Real-IP`). Each address has an allowance per route that is handed back evenly: a quiet client may send a minute's worth at once and is then held to the rate. Past it the answer is 429 with `Retry-After` in seconds and `{ "error": { "code": "too-many", ... } }`.

| What | Per address |
|---|---|
| Every route but `GET /health` and `POST /stream` | 600 a minute |
| `GET /price` (a read of Gemini's book each) | 120 a minute |
| `POST /quote` (a signed quote holds its room in the vault for 90 seconds) | 10 a minute |
| `POST /claims` (two calls to Circle and a transaction each) | 30 a minute |
| `GET /intervals` (four reads of Gemini each) | 20 a minute |
| `GET /health/rpc` | 6 a minute |
| Event streams open at once (`/events`, `/promos/:id/events`) | 60, and 1,000 in all |

The numbers are set for a room of people behind one address to pass (a page that shows a promo asks about six times a minute, a merchant form four) and for a loop to stop. They do not stop someone who comes from many addresses, and they do not stop one address from holding the vault's room: a single signed quote at the most the vault can take keeps that room for its 90 seconds. `GET /health` is left out because the web app's own server asks it for the vault's address; the webhook has its own proof. The numbers are `LIMITS` in `src/limit.ts`.

## The game list and the words on the card

- Gemini lists every market of a game as its own event, and a page of 100 events is 3 to 12 MB. The keeper asks one league at a time with Gemini's `search` filter, keeps the events whose ticker ends in `-M` (the game's winner), and holds each league's list in memory. A list older than two minutes is served as it is while a new one is read, so only the first read after a start waits for Gemini; the keeper does that read itself when it starts.
- A team can be picked when its book is a market (a bid and an ask at most half a dollar apart) and it is not too likely. An empty book shows an ask of 0.02 with no bid; that is not a 2% chance.
- Names come from Gemini, never from the merchant: a pro team goes by its nickname ("Miami" with the participant "Miami Heat" is "the Heat"), a college by its own name. What a merchant does send, with the quote request, is what is free and the shop's name (`item`, `business`, 40 characters each). They are tied to the promo the first time it is read: a promo can only carry a quote's exact merchant, amounts and deadline if the pricer signed that quote.

## The odds history

A promo's page shows how its chance has moved since the promo started. The readings behind that chart are the keeper's own.

- **What is read.** Gemini's exchange API serves every prediction-market contract by its instrument symbol. `GET /v1/book/<symbol>?limit_bids=1&limit_asks=1` answers with the best bid and the best ask in about 140 bytes; the contract's event, which the pricing service reads for a quote, is about a megabyte for a game. The loop reads the book once per contract on every pass, so two promos on one team share a read, and it does not wait for the answer before it settles and pays.
- **The chance** is the ask: the price the pricing service quotes on. A book with a side missing is no price (an empty book on Gemini shows an ask of 0.02 and no bid), and neither is one whose two sides are more than half a dollar apart (a 5-minute window that has not started shows 0.01 against 0.99). Such a book adds no reading.
- **What is kept.** A reading that differs from the last one kept, and one every five minutes while nothing moves. When the book moves after a quiet stretch, the last reading before the move is kept too, so the line stays flat up to the move. At most 4,000 readings per promo: past that, the older half loses every second one.
- **The first point** is the price the promo was sold at. The pricing service keeps the reading each quote was priced on under the quote's nonce; when the feed gets the promo's `PromoCreated`, which carries that nonce, the reading becomes the promo's `start`, at the block's time.

Readings stop when the promo has a result on chain. A promo made before Nov 13 afternoon has no `start`, and its readings begin when this was deployed.

## The hedge

A promo is the vault's bet against a result. The other side of that bet can be bought on Gemini: a "yes" contract pays $1 if the result happens, so one contract for every dollar the promo can pay covers the payout. The keeper places that order for each open promo, on Gemini's **sandbox** exchange.

- **The order.** `POST /v1/prediction-markets/order` with `symbol` (the promo's contract), `outcome: "yes"`, `side: "buy"`, `orderType: "limit"`, `quantity` (the promo's full payout in dollars) and `price` (the chance the promo was sold on). Gemini's private API takes the JSON as a base64 header signed with HMAC-SHA384 and an empty body; the nonce is whole seconds and has to grow with every request, so the keeper sends one request at a time.
- **When.** On the first pass of the loop after the promo exists and has its first reading, so within about a minute. One order per promo. When the promo is finalized, paid or voided, the keeper cancels the order if it is still resting; an order that went with its market is marked closed, and one Gemini filled stays filled.
- **What a promo carries** (`hedge` in `GET /promos/:id` and `GET /vault`): `kind` (`sandbox` or `simulated`), `symbol`, `quantity`, `price`, `at`, and for a sandbox order its `orderId` and `status`.
- **Simulated.** Gemini's sandbox lists crypto and commodity markets only (100 events on Nov 13, no sports, no weather). An order for a game is refused with "Invalid instrument symbol", and the keeper keeps the order it would have placed, with the reason "Gemini's sandbox does not list this contract." The test loop's 5-minute BTC markets are listed, with the same symbols as on the live exchange, so their orders are real sandbox orders, unless the sandbox refuses the price: it refuses a buy priced far above its own best offer, and after three refusals the order is written down as simulated with Gemini's message (promo 20).
- **What it is not.** It moves no money: the sandbox trades with test funds, and the vault has no path for USDC to reach Gemini or for a hedge's proceeds to come back. Most sandbox books are empty, so an order usually rests; a 5-minute window that is running can have offers, and the orders for promos 15, 17 and 18 were filled (promo 15's record reads `closed`: it was written before the keeper kept `filled`). It shows the trade the vault's position calls for, placed through Gemini's trading API, next to the promo it belongs to.

## The feed: a QuickNode Stream, and the chain behind it

The promo page and the customer's card change when something happens on the vault: a customer is covered, a result is posted, a payout is sent. Those are the vault's events, and they reach the keeper two ways.

**The Stream** (`pnpm stream on` makes it; its settings are in `scripts/stream.ts`):

| | |
|---|---|
| Network | Arc Testnet (`arc-testnet`) |
| Dataset | `logs` |
| Filter | [`stream/filter.js`](stream/filter.js). It keeps the logs whose address is the vault and whose first topic is one of eleven events (`PromoCreated`, `ClaimRegistered`, `Settled`, `Vetoed`, `SettlementReset`, `Finalized`, `Voided`, `Paid`, `PayoutFailed`, `Deposited`, `Withdrawn`), names each one, and adds its promo id and the account it is about. A block with none returns `null`, so nothing is delivered for it |
| Destination | Webhook: `POST https://freeif-production.up.railway.app/stream`, no compression, three retries one second apart |
| Proof of origin | QuickNode signs each delivery with the Stream's security token (HMAC-SHA256 of nonce + timestamp + body); the Stream also sends the same secret in the header `x-stream-secret`. The keeper takes a delivery with either |

Why a Stream: the pages should change within about a second of the block, for every viewer, without each browser asking the chain. One delivery reaches the keeper and the keeper pushes it to every open page. The same delivery also starts work: a `Finalized` event with a "yes" wakes the settlement loop, so customers are paid right after the result is confirmed instead of on the next 30-second pass.

**The keeper's own read.** Every two seconds the keeper asks the chain for the vault's logs since the last block it read. A log the Stream has already delivered is skipped. A log it has not delivered is left alone until it is four seconds old, then added as `rpc`. So the Stream gets to deliver first, a late or stopped Stream costs a few seconds and nothing else, and events from before the Stream existed are there too: on its first start the keeper finds the block the vault was deployed in (by bisection on `eth_getCode`) and reads forward from there, in ranges of 9,000 blocks (Arc's RPC refuses more than 10,000).

Each event is kept with its block, its time, how it came (`via`) and when the keeper had it (`seenAt`), in the keeper's file. The mechanics view of the promo page shows both on each line: "QuickNode Stream" or "RPC", with how many seconds after its block the keeper had the event.

The filter is tested as it runs: `test/stream.test.ts` loads `stream/filter.js`, runs it on real blocks of the deployed vault (`test/fixtures/vault-logs.json`), and checks every topic hash in it against the contract's ABI. `pnpm stream test` runs the same file at QuickNode on one block.

A Stream is billed for every block it reads, whether the filter keeps anything or not, and a paused Stream resumes at the block it stopped at. So `pnpm stream off` pauses it when nothing is being shown, and `pnpm stream on` removes it and starts a new one at the newest block; the keeper's own read covers the gap.

Status on Nov 13: the Stream is made and has run. `pnpm stream on` made `freeif-vault` with an API key from a free plan (the Streams permission is enough), QuickNode took one block per delivery, and the Stream stayed at the newest block. On promos 17 to 20 (the test loop, four times) all 27 events came `via: "stream"` in 25 deliveries, every delivery passed the signature check, and the keeper had each event 0.4 to 1.7 seconds after its block (4 to 7 by its own read, before the Stream). Promo 20 ended "yes": `Finalized` came by the Stream and woke the loop, and the payout was in the third block after it. `GET /health` counts the deliveries (`stream.deliveries`, `stream.signed`, `stream.byStream`).

## Pricing rules

A promo costs what its hedge would cost on Gemini right now, plus a spread. A "yes" contract pays $1 if the result happens, so a promo that can pay $96 is covered by 96 contracts.

- **What is read.** The contract's order book, `GET /v1/book/<symbol>?limit_bids=1&limit_asks=0`: the best bid and every offer, with how many contracts are at each price. The contract's event is read with it, for the names, the times, the status and the last trade.
- **A market** is a book with a bid and an ask at most half a dollar apart. The promo's payout is bought from the offers, cheapest first, and the chance on the price card is what a dollar of payout costs that way. For a promo that fits inside the best offer that is the ask; a bigger one reaches dearer offers. Ten contracts offered at 0.25 in front of five hundred at 0.35 price a $10 promo at 25% and a $400 promo at 34.75%. This part carries a spread of 5%.
- **Past the offers.** The part of a payout the book does not offer cannot be hedged. It is priced at the dearest offer taken and carries 15%. Gemini's book for an Austin temperature bucket on Nov 13 had 100 contracts at 0.37 and 9 at 0.42: a payout of $250 costs $40.78 for the 109 and $59.22 for the other 141, so the chance reads 40% and the spread comes to 10.93%. An offer more than half a dollar above the bid is not counted as an offer.
- **A thin book** has a side missing, or its two sides are a placeholder (a 5-minute window that has not started shows 0.01 against 0.99). It is priced on the highest of what its offers cost, its bid and its last trade, all of it at 15%, and only if the result has traded: an offer with nobody on the other side and no trade behind it is not a price.
- The answer says which it was: `mechanics.thin`, `mechanics.spreadBps` (the spread used), `mechanics.covered` (how much of the payout the offers cover) and `mechanics.offers`.
- `premium = expectedLoss * (1 + spread)`, rounded up to a cent, where `expectedLoss = chance * payoutPerClaim * maxClaims`. Never below `expectedLoss * 1.02`.
- A quote is refused when the event has started (a game's kickoff, the beginning of a temperature market's day), when the event has no start time and is neither a temperature market nor a 5 or 15-minute market, when there is no price by the rules above, when the result is so likely that the premium would exceed the payout, when the vault is paused, or, on a 5 or 15-minute market, when the request does not carry the test key.
- Two limits on size. The contract's exposure cap: `maxPayout - premium` may be at most 20% of the vault's free balance, and the keeper uses 90% of that so a small withdrawal does not make a quote revert. And a ceiling across promos: no quote may leave more than 60% of the vault locked.
- Quotes that are signed and not yet used or expired count against both limits as if their promos existed.

## The test loop

`scripts/e2e.ts` plays a merchant and three customers against a running keeper, on the next 5-minute BTC market: price, signed quote (with the test key), `createPromoWithPermit`, three relayed claims, then it waits for the keeper to settle, finalize and pay, and prints every transaction. About half the runs end "no" (nobody is paid); run it again for a "yes".

```
KEEPER_LOOP_MS=5000 pnpm start     # one terminal
pnpm e2e                           # another; add --pick likely to favor a "yes"
```

It needs `TEST_MERCHANT_PK`, `TEST_CUSTOMER_ADDRESSES` and `CLAIM_TEST_KEY` in the environment, a merchant wallet with a few USDC, and a deposit in the vault. The keeper signs a quote on a 5-minute market only for a request with the test key, so the script sends it with its quote request, after checking that the same request without it is refused (`test-only`). The test customers are plain keys with no Circle login, so their claims go in with the test key too. The keeper must run with the same `CLAIM_TEST_KEY`; without one it sells no quote on these markets and the loop cannot run at all. Before those claims, the script checks that a claim with no login, one with a login Circle does not know, and a test claim with the wrong key are all refused.

## Hosting

The keeper runs on Railway at `https://freeif-production.up.railway.app`, built from `Dockerfile` with `keeper/` as the service's root folder. Its file is on a volume mounted at `/data` (`KEEPER_DATA_DIR=/data`), so a redeploy keeps the record of which logins have claimed. The health check is `GET /health`, which also names the commit that is live.

To deploy: push to `main`, then `pnpm ship`. It asks Railway to build the pushed commit and waits until the new build passes its health check (about a minute); if the build fails, the previous one keeps serving. It needs `RAILWAY_API_TOKEN`, `RAILWAY_SERVICE_ID` and `RAILWAY_ENVIRONMENT_ID`.

Run one keeper per vault. A second one with the same keys does no harm to the vault (every step is checked on chain first), but the two compete for transaction nonces. To test against the hosted keeper: `KEEPER_URL=https://freeif-production.up.railway.app pnpm e2e`.

## Layout

| File | What it holds |
|---|---|
| `src/games.ts`, `src/names.ts` | The game list for the merchant form, and the words for a game and a team |
| `src/labels.ts` | What is free and the shop's name, kept with the quote until its promo exists |
| `src/pricing.ts` | The pricing math and the three limits, as pure functions |
| `src/pricer.ts` | The pricing service: Gemini's ask, the vault's state, the signed quote |
| `src/relayer.ts`, `src/circle.ts` | `registerClaim`, one claim per Circle user, and the question to Circle: whose login is this, and which wallets are theirs |
| `src/keeper.ts` | The settlement loop |
| `src/odds.ts` | The odds history: the readings of Gemini's book for each open promo, and which of them are kept |
| `src/hedge.ts` | The hedge: Gemini's sandbox trading API (signing, the order, the cancel) and which promo gets which order |
| `src/stream.ts` | The feed: decoding a delivery, the events kept, the keeper's own read of the chain |
| `stream/filter.js`, `scripts/stream.ts` | The QuickNode Stream's filter, and the script that makes, tests, pauses and removes the Stream |
| `src/server.ts`, `src/main.ts` | The HTTP API and the process |
| `src/limit.ts` | How much one address may ask of the open routes, and how many event streams may be open |
| `src/gemini.ts`, `src/chain.ts`, `src/store.ts`, `src/config.ts` | Gemini's API, Arc (its endpoints and which one is asked) and the quote's EIP-712 types, the JSON file, settings |
| `src/abi.ts` | Generated from the contract build |
