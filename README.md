# FreeIf

Merchants run "your purchase is free if X happens" promotions. A USDC vault on Arc underwrites each promo at live Gemini prediction-market odds plus a spread. When Gemini settles the market, every registered customer is paid automatically.

Built for the UBC Hackathon 2026 (DeFi track). Work in progress: this README grows as each part lands.

## Layout

| Folder | What it holds |
|---|---|
| `contracts/` | `PromoVault.sol` and its tests (Foundry) |
| `keeper/` | Node service: pricing, settlement keeper, claim relayer, QuickNode Stream webhook |
| `web/` | Next.js app for merchants, customers and liquidity providers |

## Run the contract tests

```
cd contracts
forge test
```

Needs [Foundry](https://getfoundry.sh). Dependencies are git submodules: run `git submodule update --init` after cloning.

## License

MIT
