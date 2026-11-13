# web

The FreeIf app: Next.js 16 (App Router), React 19, Tailwind 4, viem, `qrcode.react`, and Circle's user-controlled wallets for the email login.

| Page | Who it is for |
|---|---|
| `/merchant` | A shop owner sets up a promo: a game and a team, what is free, how many customers, the live cost, Pay |
| `/claim/[promoId]` | A customer at the counter scans the code, types an email and a 6-digit code, and is covered |
| `/promo/[id]` | The merchant's dashboard and the public status page: one status sentence, three numbers, the counter code, a live feed, proof |
| `/promo/[id]/print` | The counter sign with the code, printed from the browser |
| `/lp` | A liquidity provider: what the vault holds, how much of it is locked, what it has earned, both share prices, deposit and withdraw, every promo with what it locks and what it made, the risks, and the vault's activity |

Merchant and customer screens never say prediction market, USDC, wallet or gas. `/lp` is the one page that does, and the one page that uses a browser wallet (MetaMask and the like) instead of the email login. The footer link "See how it works under the hood" (or `?mechanics=1` in a link) turns on the mechanics view, which shows where each number comes from.

## How it talks to the rest

- **The keeper** (`../keeper`, API in its README) is called from the browser: the game list, the live price, the signed quote, the claim (with the customer's login token, which the keeper checks with Circle), and the promo's status. Names such as "the Lions win" come from the keeper, built from Gemini's data.
- **Live pages.** `/promo/[id]` and `/claim/[promoId]` keep the keeper's event stream open (`GET /promos/:id/events`, server-sent events). When an event on the promo reaches the keeper, from the QuickNode Stream or from the keeper's own read of the chain, its line is on the page at once and the page reads the promo again (three reads: at once, after 1.5 seconds, after 5). A timer reads the promo as well, every 15 seconds while the stream is open and every 4 while it is not, so a dropped connection costs seconds. A browser gives up on an event stream whose reconnect is answered with an error, which is what a keeper restart looks like, so the page opens a new one three seconds later (`src/lib/events.ts`). The feed is the promo's events on the vault; in the mechanics view each line says how the event reached the keeper and how long after its block.
- **Circle** is called from this app's server, because those calls need the API key. Everything a user does is a "challenge": a route under `/api/wallet` asks Circle for one with the user's token, and Circle's SDK in the browser shows its own window for it.

| Route | What it does |
|---|---|
| `GET /api/wallet/config` | The Circle app id, to start the SDK |
| `POST /api/wallet/email-token` | Circle emails a code to the address |
| `POST /api/wallet/open` | The user's wallet on Arc, or a challenge that creates it (an EOA) |
| `POST /api/wallet/permit` | A challenge to sign a USDC permit for exactly the promo's cost, to the vault |
| `POST /api/wallet/create-promo` | A challenge to send `createPromoWithPermit`, after the call is simulated |
| `POST /api/wallet/tx` | Where that transaction is, and the promo's id once it is in a block |

Paying for a promo is one transaction from the merchant's account: the account signs a permit for exactly the cost, and `createPromoWithPermit` spends it. No standing approval is left. The permit and the call are built on the server (`src/lib/server/promo-call.ts`), so these routes cannot be used to have an account sign or send anything else.

## The vault page

`/lp` reads `GET /vault` from the keeper (one read of the chain, shared) and keeps `GET /events` open, so the numbers move when something happens on the vault. A deposit is up to two confirmations in the wallet (an approval for exactly the amount, then `deposit`); a withdrawal is one (`withdraw`). Both calls are simulated against the chain before the wallet is asked.

The page shows two share prices because the vault has two. A deposit is priced on what is available plus the locks of promos still running, the most the shares can be worth. A withdrawal is priced on what is available alone, the least. They differ whenever a promo is open, so before a withdrawal the page says how much is received and how much "stays behind in open promos": that part goes to the providers who stay if those promos end "no".

## Run it

Needs Node 24 and pnpm.

```
pnpm install
pnpm dev            # http://localhost:3000
pnpm build
pnpm lint
pnpm typecheck
pnpm check:pay      # the server side of Pay against Arc and the hosted keeper; nothing is sent
pnpm abi            # copy the vault's ABI from ../keeper after a contract change
```

Settings:

| Variable | What it is |
|---|---|
| `CIRCLE_API_KEY`, `CIRCLE_APP_ID` | Circle's API key and app id. Server only |
| `NEXT_PUBLIC_KEEPER_URL` | The keeper. Default: the hosted one |
| `NEXT_PUBLIC_ARC_RPC_URL` | Default: the public Arc testnet RPC |

On Vercel the two Circle values are project variables. On a developer machine they are read from `~/.freeif/secrets.env` (or the file named in `FREEIF_SECRETS`), the same file the keeper reads; nothing secret is kept in this folder. The vault's address is not a setting: the server asks the keeper's `/health` for it.

`pnpm check:pay` plays the merchant with a plain test key (`TEST_MERCHANT_PK` in the secrets file) in place of the Circle wallet: a signed quote from the keeper, the permit, and the promo call, simulated on Arc. It also checks that a short permit, an altered quote and an expired quote are refused.

## Layout

| Path | What it holds |
|---|---|
| `src/app/` | The pages and the `/api/wallet` routes |
| `src/components/receipt-card.tsx` | The ticket: one component with a state, on every page |
| `src/components/merchant/` | The game picker, the price card and the Pay sheet |
| `src/components/claim-view.tsx`, `promo-view.tsx`, `print-view.tsx` | The three promo pages |
| `src/components/lp-view.tsx`, `src/lib/injected.ts` | The vault page, and the browser wallet it uses |
| `src/lib/wallet.tsx` | The login and Circle's challenges, as a React provider |
| `src/lib/keeper.ts` | The keeper's API and its types |
| `src/lib/use-promo.ts` | One promo, kept current: the keeper's event stream, and the timer behind it |
| `src/lib/events.ts` | The keeper's event stream in the browser, reopened by itself after the keeper restarts |
| `src/lib/promo.ts`, `format.ts` | A promo in words; money and times as people read them |
| `src/lib/server/` | Circle's API, the chain reads, the permit and the promo call |
| `src/lib/abi.ts` | Copied from the keeper |

## Known limits

- The `/api/wallet` routes have no rate limit, and `email-token` sends an email to any address it is given.
- The claim page sends the customer's login token to the keeper with the claim, and the keeper asks Circle whose it is: one claim per login per promo, for that login's own account. The token is a credential for an hour; it goes to the keeper over HTTPS and is not stored there.
- Buttons, inputs and the bottom sheet are written by hand, not taken from a component library. The sheet does not trap focus on purpose: Circle's window is an iframe on the page and has to sit above it.
- A login lasts one hour (Circle's user token). After that the app asks for the email again.
- Cash out shows the balance and says it is coming; it does not send money yet.
