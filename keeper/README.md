# keeper

One Node process that does four jobs for `PromoVault`:

- **Pricing.** Reads the ask for a result from Gemini's prediction-market API, adds the spread, checks the vault can cover the promo, and signs the EIP-712 quote that `createPromo` checks.
- **Claim relayer.** Its key is every promo's claim signer, so it is the only address that can register a customer. One claim per email per promo.
- **Settlement loop.** Every 30 seconds: posts Gemini's result once claims are closed (`settle`), finalizes after the dispute window (`finalize`), pays the customers of a "yes" (`payoutBatch`), and retries payouts whose transfer failed (`retryPayout`).
- **Stream webhook.** Not built yet.

Each step of the loop is decided from on-chain state and simulated before it is sent, so a restart never repeats one.

## Run it

Needs Node 24 and pnpm. TypeScript runs directly; there is no build step.

```
pnpm install
pnpm start        # the API on port 8787 and the loop
pnpm test         # unit tests, plus three that read the deployed vault (skipped without VAULT_ADDRESS)
pnpm typecheck
pnpm abi          # rewrite src/abi.ts after a contract change (run `forge build` in ../contracts first)
```

Settings come from the environment. On a developer machine they are read from `~/.freeif/secrets.env` (or the file named in `FREEIF_SECRETS`), which is never inside this repo; variables already in the environment win.

| Variable | What it is |
|---|---|
| `VAULT_ADDRESS` | The deployed `PromoVault` |
| `PRICER_PK`, `ORACLE_PK`, `RELAYER_PK` | The three service keys. The keeper refuses to start if the first two are not the vault's `pricer` and `oracle` |
| `ARC_RPC_URL`, `QUICKNODE_ARC_RPC_URL` | RPC endpoints, tried in that order. Default: the public Arc testnet RPC |
| `USDC_ADDRESS`, `GEMINI_BASE` | Defaults: Arc testnet USDC, `https://api.gemini.com` |
| `PORT`, `KEEPER_LOOP_MS`, `KEEPER_RETRY_MS`, `KEEPER_DATA_DIR` | Defaults: 8787, 30000, 600000, `./data` |
| `SPREAD_BPS`, `MAX_LOCKED_BPS`, `EXPOSURE_HEADROOM_BPS`, `LOADING_BPS_PER_STEP` | Pricing settings. Defaults: 500, 6000, 9000, 0 |

## API

Amounts are USDC base units (6 decimals) as decimal strings. Times are unix seconds. Errors are `{ "error": { "code", "message" } }`; `message` is written for the person using the form.

| Route | What it does |
|---|---|
| `GET /health` | The vault, the three service addresses, the latest block, and the commit the hosted build was made from |
| `GET /health/rpc` | Whether each RPC endpoint answers, and how fast |
| `GET /price?eventTicker=&instrumentSymbol=&payoutPerClaim=&maxClaims=&claimDeadline=` | The price of a promo, unsigned. `breakdown` has `chance`, `mostOwed`, `fee` and `cost`; `maxCustomers` is the most the vault can cover right now; `limit` is `ok` or the limit the request is over |
| `POST /quote` | Body: the same fields plus `merchant` (and `hedgeMode`). Returns the price plus `quote` and `signature` for `createPromo(quote, signature)`. Good for 90 seconds, for that merchant only. Answers 422 with a reason when the vault cannot take the promo |
| `POST /claims` | Body: `promoId`, `customer`, `email`. Registers the customer on chain. 409 when the email has already claimed with another wallet |
| `GET /promos/:id` | The promo as the chain has it, with the event and result names behind its two hashes |
| `GET /intervals?series=BTC05M` | The next windows of a 5 or 15-minute crypto market (the test loop) |

`claimDeadline` is `start` (the default: the promo takes customers until the event starts), `30min` (until 30 minutes before) or a unix time no later than the start.

## Pricing rules

- `premium = expectedLoss * 1.05`, rounded up to a cent, where `expectedLoss = ask * payoutPerClaim * maxClaims`. Never below `expectedLoss * 1.02`.
- A quote is refused when the event has started, when there is no ask, when the result is so likely that the premium would exceed the payout, or when the vault is paused.
- Two limits on size. The contract's exposure cap: `maxPayout - premium` may be at most 20% of the vault's free balance, and the keeper uses 90% of that so a small withdrawal does not make a quote revert. And a ceiling across promos: no quote may leave more than 60% of the vault locked.
- Quotes that are signed and not yet used or expired count against both limits as if their promos existed.

## The test loop

`scripts/e2e.ts` plays a merchant and three customers against a running keeper, on the next 5-minute BTC market: price, signed quote, `createPromoWithPermit`, three relayed claims, then it waits for the keeper to settle, finalize and pay, and prints every transaction. About half the runs end "no" (nobody is paid); run it again for a "yes".

```
KEEPER_LOOP_MS=5000 pnpm start     # one terminal
pnpm e2e                           # another; add --pick likely to favor a "yes"
```

It needs `TEST_MERCHANT_PK` and `TEST_CUSTOMER_ADDRESSES` in the environment, a merchant wallet with a few USDC, and a deposit in the vault.

## Hosting

The keeper runs on Railway at `https://freeif-production.up.railway.app`, built from `Dockerfile` with `keeper/` as the service's root folder, and redeployed on every push to `main`. Its file is on a volume mounted at `/data` (`KEEPER_DATA_DIR=/data`), so a redeploy keeps the record of which emails have claimed. The health check is `GET /health`.

Run one keeper per vault. A second one with the same keys does no harm to the vault (every step is checked on chain first), but the two compete for transaction nonces. To test against the hosted keeper: `KEEPER_URL=https://freeif-production.up.railway.app pnpm e2e`.

## Layout

| File | What it holds |
|---|---|
| `src/pricing.ts` | The pricing math and the two limits, as pure functions |
| `src/pricer.ts` | The pricing service: Gemini's ask, the vault's state, the signed quote |
| `src/relayer.ts` | `registerClaim`, one claim per email |
| `src/keeper.ts` | The settlement loop |
| `src/server.ts`, `src/main.ts` | The HTTP API and the process |
| `src/gemini.ts`, `src/chain.ts`, `src/store.ts`, `src/config.ts` | Gemini's API, Arc and the quote's EIP-712 types, the JSON file, settings |
| `src/abi.ts` | Generated from the contract build |
