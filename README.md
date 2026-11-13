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

Why a Stream and not polling: one delivery per block with vault activity reaches one place, about a second after the block, and fans out to every viewer. No browser asks the chain, and the public RPC's rate limit stops being the app's limit.

What happens when the Stream is late or off: the keeper also reads the vault's logs from the chain every two seconds, and adds any event the Stream has not delivered once it is four seconds old. Every event is marked with the way it came. Turn on the mechanics view (`?mechanics=1`) on a promo page to see it on each line: "QuickNode Stream · 0.8 s after the block", or "RPC".

The filter is tested as it runs, against real blocks of the deployed vault, and its topic hashes are checked against the ABI (`keeper/test/stream.test.ts`). More in [`keeper/README.md`](keeper/README.md), "The feed".

Status on Nov 13: the webhook, the feed and the live pages are deployed, and every event so far reached the pages by the keeper's own read of the chain. The Stream itself is started with `pnpm stream on` in `keeper/` and has not been started yet.

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
