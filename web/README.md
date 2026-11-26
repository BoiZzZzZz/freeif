# web

The FreeIf app: Next.js 16 (App Router), React 19, Tailwind 4, viem, `qrcode.react`, and Circle's user-controlled wallets for the email login.

| Page | Who it is for |
|---|---|
| `/merchant` | A shop owner sets up a promo: a game and a team, what is free, how many customers, the live cost, Pay. The switch "My business gets paid" turns the same form into a cover: a day and a temperature range, an amount, the live cost, Pay (below) |
| `/claim/[promoId]` | A customer at the counter scans the code, types an email and a 6-digit code, and is covered. For a promo sold with claim cards it only says to ask for a card where you bought |
| `/promo/[id]` | The merchant's dashboard and the public status page: one status sentence, three numbers, the counter code (for the merchant, while the promo takes customers), a three-step timeline with real times (once there is a result), a live feed, a chart of how the chance has moved since the promo started, proof. For a card promo, the merchant sees how many cards are ready and the links to print them and the sign; everyone else is told to ask for a card |
| `/promo/[id]/print` | The counter sign with the code, printed from the browser. For a card promo it is an ad, "Free if ... Ask for your card", whose code opens the promo's public page |
| `/promo/[id]/cards` | A card promo's merchant: makes the cards in this browser, gets them ready, and prints them (below, "Claim cards") |
| `/card/[promoId]#<key>` | A claim card, scanned: what it is worth and when, the result, and Collect |
| `/plan` | A bar that covers its own promo night on an exchange: what is free, how many customers, then a game and a team; the page says what one order on Kalshi costs, and prints the vouchers (below, "A night the bar covers itself") |
| `/voucher?t=...` | A printed voucher, scanned: the game, and once it is over whether the voucher is good |
| `/lp` | A liquidity provider: what the vault holds, how much of it is locked, what it has earned, both share prices, deposit and withdraw, every promo with what it locks and what it made, each open promo's chance now and its hedge order, the risks, and the vault's activity |

Merchant and customer screens never say prediction market, USDC, wallet or gas. `/plan` names Kalshi and speaks of contracts, because its owner types those words into Kalshi's own screen. `/lp` is the one page that speaks DeFi, and the one page that uses a browser wallet (MetaMask and the like) instead of the email login. The footer link "See how it works under the hood" (or `?mechanics=1` in a link) turns on the mechanics view, which shows where each number comes from.

## How it talks to the rest

- **The keeper** (`../keeper`, API in its README) is called from the browser: the game list, the live price, the signed quote, the claim (with the customer's login token, which the keeper checks with Circle), a card promo's card addresses (with the merchant's login token), and the promo's status. Names such as "the Lions win" come from the keeper, built from Gemini's data.
- **Live pages.** `/promo/[id]` and `/claim/[promoId]` keep the keeper's event stream open (`GET /promos/:id/events`, server-sent events). When an event on the promo reaches the keeper, from the QuickNode Stream or from the keeper's own read of the chain, its line is on the page at once and the page reads the promo again (three reads: at once, after 1.5 seconds, after 5). A timer reads the promo as well, every 15 seconds while the stream is open and every 4 while it is not, so a dropped connection costs seconds. A browser gives up on an event stream whose reconnect is answered with an error, which is what a keeper restart looks like, so the page opens a new one three seconds later (`src/lib/events.ts`). The feed is the promo's events on the vault; in the mechanics view each line says how the event reached the keeper and how long after its block.
- **The chart.** `/promo/[id]` draws the keeper's readings of the result's price on Gemini (`GET /promos/:id/odds`): one line on a 0 to 100% scale, from the moment the promo started to the newest reading, with a dot at the price the promo was sold at and a tick at kickoff. The first read takes every reading; while the promo has no result, a read every 30 seconds asks only for the new ones. Pointing at the line, or the arrow keys, reads one point; in the mechanics view that adds the bid and the ask, and a link to the readings as the keeper has them. It is drawn by hand as HTML and one SVG path (`src/components/odds-chart.tsx`), with no chart library.
- **Circle** is called from this app's server, because those calls need the API key. Everything a user does is a "challenge": a route under `/api/wallet` asks Circle for one with the user's token, and Circle's SDK in the browser shows its own window for it.

| Route | What it does |
|---|---|
| `GET /api/wallet/config` | The Circle app id, to start the SDK |
| `POST /api/wallet/email-token` | Circle emails a code to the address |
| `POST /api/wallet/open` | The user's wallet on Arc, or a challenge that creates it (an EOA) |
| `POST /api/wallet/permit` | A challenge to sign a USDC permit for exactly the promo's cost, to the vault |
| `POST /api/wallet/create-promo` | A challenge to send `createPromoWithPermit`, after the call is simulated |
| `POST /api/wallet/tx` | Where that transaction is, and the promo's id once it is in a block |
| `POST /api/wallet/cash-out` | A challenge to send part of the account's balance to an address its owner typed: always a plain USDC transfer from the account itself, checked and simulated first |

Paying for a promo is one transaction from the merchant's account: the account signs a permit for exactly the cost, and `createPromoWithPermit` spends it. No standing approval is left. The permit and the call are built on the server (`src/lib/server/promo-call.ts`), so these routes cannot be used to have an account sign or send anything else.

A new account holds nothing, so the test dollars are on the merchant page from the start (`src/lib/account.tsx`, one provider for the page, read by the header, the account bar, the form and the Pay sheet). When the keeper gives starter test dollars (`starter` in its `GET /health`, set by `STARTER_AMOUNT`):

- **Before a login** a bar above the form says "Try it with $8.00 in test dollars" with the button "Get $8.00 in test dollars" (the keeper's amount), which opens the email step. The home page says the same in one line under "Run a promo".
- **At a login on this page** an account that holds less than the amount, and that this browser has no record of a grant for, gets them without asking: the page sends the login's token and the account's address to the keeper's `POST /starter`, which asks Circle whose login it is and sends the dollars once per email. The bar shows "Adding your $8.00 in test dollars", then the new balance. A login the keeper refuses is forgotten, so the email step comes back. An email that has had its grant, or an account that already holds the amount, gets no line about it; any other refusal shows the keeper's sentence with "Try again".
- **Logged in**, the balance is in the header and in the bar, with "Add money" (the account's address, to send test dollars to) and "Cash out". It is read again after a grant, after a cash out and when the tab is looked at again.

The form sizes a promo to that money before Pay (`src/lib/fit.ts`: the balance's share of the cost, less the network fee and a cent for rounding). The money is the balance once logged in (with test dollars that are on their way counted in), or the starter amount for a visitor who is not logged in and whose browser has never paid for a promo. A number of customers the merchant has not set themselves comes down to what that pays for, with the line "Set to 5 customers to fit your $8.00 in test dollars." (a cover's untyped amount likewise, in whole dollars). It only comes down by itself; when the money turns out to be more (a login with a bigger balance) it goes back to the size from before and is sized again. A size the merchant set themselves is left alone, and a note under the price says "Your balance of $8.00 covers about 5 customers." with the button "Make it 5 customers". When the money pays for the size, the note says "Paid from your balance of $8.22."

The Pay sheet waits for test dollars that are on their way before it reads the balance. When the balance is still short (the price moved, or the merchant chose a bigger size), it keeps the balance sentence and adds what fits: "Your balance covers about 2 customers." with the main button "Make it 2 customers", which sets the form's count to that (never under 1 or over what the form allows) and closes the sheet, so the form shows the new price and the merchant presses Pay again. For a cover it is "Your balance covers about $40.00." and "Make it $40.00", in whole dollars rounded down; the amount then still comes down by itself to what the vault can cover, as the default does. The size offered is always below the one asked for, so a press never offers the same size again. "Change the promo" (or "Change the amount") only closes the sheet. When not one customer or $1.00 fits, the sheet says to lower the item's price or pick the other team (for a cover, to lower the amount), with the button back to the form only. An account whose grant did not go through is offered "Get $8.00 in test dollars" there again. Which accounts have had their grant is remembered in the browser (`freeif.starter`) only to choose what the page offers; the keeper decides. A keeper without starter test dollars, or one too old to say, shows no bar and sizes nothing for a visitor.

Cash out is the one other thing an account sends. A customer who was paid has "Cash out" under their balance, and a merchant has it next to theirs: a sheet with one field, an address, and a button that sends the balance less five cents (the account pays its own network fee from the same money). The transfer is built on the server (`src/lib/server/cash-out.ts`): it is refused when the address is not one, is the account's own, or is the token or the vault, and when the account does not hold the amount. It needs the login of the account that holds the money; a made-up login is refused before anything is built. Paying out to Venmo or a bank is not built.

## When something is wrong

- **The keeper cannot be reached.** A promo, claim or print page says "We can't reach FreeIf right now" and keeps asking; it does not sit on a loading box. A page that already shows a promo keeps showing it.
- **The live updates drop.** The promo page says "Reconnecting" where it said "Live", reads the promo every four seconds meanwhile, and says "Live" again when the event stream is back.
- **No live price.** The price card says "We can't get a live price right now. Try again in a moment." and asks again in 15 seconds. A stale price is never shown. The keeper keeps a game's names and times for a moment, so a slow answer from Gemini's event route alone no longer costs the price: the price itself is read from Gemini's order book each time.
- **The game has started, the price expired, the payment failed, the vault cannot cover the size.** Each has its own sentence in the form or the Pay sheet, and none of them charges anything.
- **A payout did not go through.** The vault sets it aside and the keeper sends it again. The customer's card says "Your $8.00 is set aside. We're sending it again." in place of "Paying you $8.00 now".
- **A promo that is full, closed or cancelled** says so on the customer's page, with the offer still in view.

## A cover: the business gets paid

A promo pays a shop's customers. The same contract can pay the shop: one payout, to the account that bought it, if a result happens. The vault calls that hedge mode; the form calls it "My business gets paid", and the pages call the thing a cover. `/merchant?cover=1` opens the form on it.

- **What can be covered.** Gemini's daily high-temperature markets (`GET /weather` on the keeper): a city, a day, and a button per two-degree range with its chance. A food truck in Austin that loses a cold Saturday picks "66°F or below". A range with no two-sided price on Gemini cannot be picked.
- **Until when.** A day can be bought until it begins. From then on its high is being measured.
- **How much.** One field: what the business gets if it happens. The price card shows the chance, "You'd receive" and the cost. When the vault cannot cover the amount, the form says how much it can ("We can cover up to $11.86 on this right now."), and an amount nobody has typed yet comes down by itself to the whole dollars under that.
- **Pay** is the same two screens and the same one transaction as a promo. The quote says `hedgeMode`, the vault registers the buyer as the one to be paid, and there is no code to scan: `/claim/[id]` for a cover says so.
- **Its page** (`/promo/[id]`) says "$2.00 to Test Tacos if the high in Austin on November 14 is 66°F or below", what was paid, the chart, and after the result a timeline that ends "You were paid $2.00". Gemini settles a day's high the next morning (about 11:00 UTC on the days checked), and the keeper posts the result on its next pass (every 30 seconds) and pays once the dispute window is over: 30 seconds on the deployed vault, an hour by default. No cover has reached a result yet; promo 21 is the first.
- On `/lp` a cover is listed as "Business cover", with its lock and its hedge order like any promo.

## Claim cards

A promo sold with claim cards (the keeper says so per promo: `cards` in `GET /promos/:id`) has no code at the counter and no "Get covered". The shop hands a printed card to each customer who buys; the card's money is collected after the result by whoever holds it.

- **A card is a key.** Right after Pay, the browser that paid goes to `/promo/[id]/cards`, makes one private key per customer the promo takes (`src/lib/cards.ts`), and keeps them in `localStorage` under `freeif.cards.<vault>.<promoId>` before any address leaves the page. Only the cards' addresses go to the keeper (`POST /promos/:id/cards`, with the merchant's login token), which registers each card as a customer. The page shows "12 of 50 cards ready" from the keeper's `cardProgress`, sends again what the keeper has neither registered nor queued, and asks for the email again when the login has run out.
- **The sheet.** Each card is a QR code for `https://freeif.app/card/<promoId>#<key>`, with the shop's name, what is free, "Free if ...", "Worth $8.00 if ...", "Scan after the game to collect." and its number. Two across and four down on a letter page. Until the merchant prints, the page says in red that the cards live only in this browser. The merchant can print them again from the same browser at any time; another browser sees "Your cards were made on another device". Cards nobody was handed are the merchant's, collected the same way.
- **The card page.** `/card/[promoId]#<key>` reads the key from after the `#`, which a browser never sends to a server, works out the card's address, and asks the keeper about that address (`GET /promos/:id?customer=`) and Arc for its balance. Nobody logs in to look. It reads "This card is worth $8.00 if the Patriots win" with when the result is due, then "Your team won" or "This card didn't win", "This card is worth $8.00" once paid, "Already collected", "This card isn't active" (an address the promo does not know) or "This card is cancelled".
- **Collect.** The holder logs in by email (the same login as everywhere else) and their browser sends the card's balance to their own account, signed with the card's key: no Circle screen, because the card is not a Circle account. The card pays its own network fee from its balance: the browser estimates the gas, adds 20%, and sends the balance less `ceil(gas limit × max fee / 10^12)` with exactly that gas limit and max fee. A fraction of a cent stays on the card. Then the account has Cash out, as for any paid customer.
- **The key never leaves the browser.** It is in the address bar after the `#`, in the page's memory, and in the merchant's `localStorage`; no request carries it (checked in headless Chrome on the production build: every request's address, headers and body).

## A night the bar covers itself

`/plan` is the same promo without the vault. Nothing on it logs in, pays or signs: the bar places one order in its own Kalshi account, and gives the free item itself.

- **The list.** `GET /api/plan/games?league=nba` (also `nhl`, `nfl`) is Kalshi's open game-winner markets that have not started, up to 8 days ahead. It is three reads of Kalshi's public API, no key: the open events with their two markets (`/events?series_ticker=KXNBAGAME&with_nested_markets=true`), the schedule (`/milestones?competition=NBA`: a market does not say when its game starts or who is at home), and the teams (`/structured_targets`). A team's nickname is in the schedule for football, in the team list for hockey, and in both for basketball. The server does the reading because Kalshi's API answers 403 to a browser on this site's origin.
- **The order.** `GET /api/plan/books?ticker=...` is one team's offers. Kalshi lists bids only, so an offer of "yes" at 61 cents is a "no" bid at 39, turned around. The page buys the promo's size from the offers, cheapest first (`order` in `src/lib/plan.ts`): one contract pays $1.00 if the team wins, so 50 customers at $8.00 is 400 contracts. The limit price is the dearest offer the order needs. The fee is Kalshi's schedule: 7% of contracts × price × (1 − price), rounded up to a cent, times the series' `fee_multiplier`. The books are read again every 15 seconds, and changing the number of customers asks nothing new.
- **The other exchange.** When the same game is found on Polymarket US (same start, same two nicknames; `gateway.polymarket.us`, public, no key), the card says what the same order costs there. It lists one market per game: the away team is its "long" side, and the home team is bought from the bids. Its fee rate is the one its market reports.
- **The vouchers.** Printed eight to a page, numbered, one per customer. A voucher's code opens `/voucher` with everything the voucher says in the address, and the page reads the game's result from Kalshi (`GET /api/plan/voucher?ticker=...`). The bar honors a voucher and keeps the paper: nothing stops a copied code from showing the same result, and the page pays nobody.
- **What it costs the owner.** The order's cost and fee, win or lose. If the team wins, Kalshi pays $1.00 a contract into the bar's Kalshi account, which is the menu price of what the bar gives away (or, with "Cover only what one costs me to make", its cost).

`pnpm check:plan` checks the arithmetic on fixed books (Kalshi's own fee table among them), then reads both exchanges for all three leagues, works out a 400-contract order on each, and reads a voucher's market. Tickers given after it are games with a result: `pnpm check:plan KXNBAGAME-26NOV24DALDEN-DAL`.

## The vault page

`/lp` reads `GET /vault` from the keeper (one read of the chain, shared) and keeps `GET /events` open, so the numbers move when something happens on the vault. A deposit is up to two confirmations in the wallet (an approval for exactly the amount, then `deposit`); a withdrawal is one (`withdraw`). Both calls are simulated against the chain before the wallet is asked.

The deposit and withdraw card speaks in dollars, not shares: "Your money here", "You can take out now", "Locked in open promos", and one paragraph on what locked means. A typed deposit says how much of it can be taken out again right away and how much is locked in the promos that are open; a typed withdrawal says how much is received and how much is left behind "with the people who keep their money in" (that part goes to the providers who stay if those promos end "no"). The vault's two share prices are in a fold at the bottom of the card, "The same thing, counted in shares", as one sum: a share's available part (what a withdrawal receives, the least the shares can be worth), plus its part of what is locked, equals both together (what a deposit pays, the most). The locked part is shown as the total less the available part, so the three numbers always add up.

## Run it

Needs Node 24 and pnpm.

```
pnpm install
pnpm dev            # http://localhost:3000
pnpm build
pnpm lint
pnpm typecheck
pnpm check:pay      # the server side of Pay against Arc and the hosted keeper; nothing is sent
pnpm check:plan     # the plan page's arithmetic, and its reads of Kalshi and Polymarket US; no key, nothing is sent
pnpm abi            # copy the vault's ABI from ../keeper after a contract change
```

Settings:

| Variable | What it is |
|---|---|
| `CIRCLE_API_KEY`, `CIRCLE_APP_ID` | Circle's API key and app id. Server only |
| `NEXT_PUBLIC_KEEPER_URL` | The keeper. Default: the hosted one |
| `NEXT_PUBLIC_ARC_RPC_URL` | Default: the public Arc testnet RPC |

On Vercel the two Circle values are project variables. On a developer machine they are read from `~/.freeif/secrets.env` (or the file named in `FREEIF_SECRETS`), the same file the keeper reads; nothing secret is kept in this folder. The vault's address is not a setting: the server asks the keeper's `/health` for it.

`pnpm check:pay` plays the merchant with a plain test key (`TEST_MERCHANT_PK` in the secrets file) in place of the Circle wallet: a signed quote from the keeper, the permit, and the promo call, simulated on Arc, once for a promo on a game and once for a cover on a temperature market, and the cash-out transfer. It also checks that a short permit, an altered quote, an expired quote and a cover's quote sent as a customer promo are refused, and that cash out refuses more than the balance, the account's own address, something that is not an address, and the token's address.

The site lists games and temperatures only. The 5-minute BTC markets, which settle in minutes where a game takes hours, are the keeper's test loop (`pnpm e2e` in `keeper/`), and the keeper signs a quote on them only with its test key.

## Layout

| Path | What it holds |
|---|---|
| `src/app/` | The pages and the `/api/wallet` routes |
| `src/components/receipt-card.tsx` | The ticket: one component with a state, on every page |
| `src/components/merchant/` | The form with its account bar, the game picker, the picker for a day and a temperature (a cover), the price card, the Pay sheet and the address box of "Add money" |
| `src/components/claim-view.tsx`, `promo-view.tsx`, `print-view.tsx` | The three promo pages |
| `src/components/cards-view.tsx`, `card-view.tsx`, `src/lib/cards.ts` | Claim cards: the merchant's page that makes, readies and prints them, the page a scanned card opens, and the keys, the card's link and collecting |
| `src/components/cash-out.tsx`, `src/lib/server/cash-out.ts` | The cash-out sheet, and the transfer it sends |
| `src/components/lp-view.tsx`, `src/lib/injected.ts` | The vault page, and the browser wallet it uses |
| `src/lib/wallet.tsx` | The login and Circle's challenges, as a React provider |
| `src/lib/account.tsx`, `fit.ts` | The merchant page's account (the balance, the starter test dollars and when they are asked for), and what a balance pays for |
| `src/components/starter-note.tsx` | The home page's line about the test dollars |
| `src/lib/keeper.ts` | The keeper's API and its types |
| `src/lib/use-promo.ts` | One promo, kept current: the keeper's event stream, and the timer behind it |
| `src/lib/events.ts` | The keeper's event stream in the browser, reopened by itself after the keeper restarts |
| `src/components/odds-chart.tsx`, `src/lib/use-odds.ts` | The chart on the promo page, and the readings behind it |
| `src/lib/promo.ts`, `format.ts` | A promo in words; money and times as people read them |
| `src/lib/server/` | Circle's API, the chain reads, the permit and the promo call, and the limit on how often one address may call the routes |
| `src/components/plan/`, `voucher-view.tsx` | The plan page (its game list, the order card, the printed vouchers) and the page a scanned voucher opens |
| `src/lib/plan.ts`, `plan-client.ts` | A plan's shapes and arithmetic (the size in contracts, the order from a book, the fee, a voucher's link), and the page's reads of `/api/plan` |
| `src/lib/server/kalshi.ts`, `polymarket.ts`, `plan-data.ts`, `kept.ts` | Kalshi's and Polymarket US's public market data, the two joined into what the page asks for, and the short memory that keeps a busy page from multiplying the reads |
| `src/lib/abi.ts` | Copied from the keeper |

## Known limits

- `/plan` shows prices; it does not hold one. The order's cost is what the offers on Kalshi's book would cost at the moment it was read, and it moves until the owner places the order. Two days before a game a book can be a few hundred contracts deep where on game day it is hundreds of thousands, and the card says so when an order is bigger than what is offered.
- `/plan`'s reads are limited to 120 a minute per address and kept in the server's memory for a few seconds (a book 3, a game list 20, a schedule 5 minutes). Like the other limits here they are per copy of the server.

- The `/api/wallet` routes are limited per address (`src/lib/server/limit.ts`): 240 calls a minute over all of them, and 20 login codes in ten minutes, each code being an email to whatever address was typed. The counts are in the server's memory and Vercel can run more than one copy of the server, so this stops a loop, not a determined sender. Circle has its own limit on the codes sent to one email address.
- The claim page sends the customer's login token to the keeper with the claim, and the keeper asks Circle whose it is: one claim per login per promo, for that login's own account. The token is a credential for an hour; it goes to the keeper over HTTPS and is not stored there.
- Buttons, inputs, the bottom sheet and the chart are written by hand, not taken from a component library. The sheet does not trap focus on purpose: Circle's window is an iframe on the page and has to sit above it.
- The app keeps a login for 55 minutes (Circle's user token lasts 60). After that it asks for the email again.
- Cash out sends to an address only. Its confirmation screen in Circle's window, and a real send, have not been run with a real login yet.
- A card promo's keys are in the `localStorage` of the browser that made them, and nowhere else until they are printed. Clearing that browser's data before printing loses the cards for good: their places on the promo are taken, and nobody can collect them. A card is a bearer note: whoever holds it, or a photo of its code, can collect it, and money nobody collects stays on the card for good.
- Collecting reads the card's balance, the gas and the fee from the public Arc RPC, which turns away more than about five quick calls in a row; collecting makes six and viem tries again on a refusal. Collecting has not been run with a real card yet (the keeper's test loop does the same transfer from a script).
