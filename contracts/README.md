# contracts

`PromoVault.sol`: the USDC vault that underwrites promos on Arc. One contract, a Foundry project.

Deployed and verified on Arc testnet (chain 5042002): [`0x828295d7213DBA6eB281354d61801082006f72e6`](https://explorer.testnet.arc.io/address/0x828295d7213DBA6eB281354d61801082006f72e6), v2, since Nov 14 (block 72249296). The first vault, v1, is [`0x68a00243927f250dBcD9160b5d06623b62B2e06d`](https://explorer.testnet.arc.io/address/0x68a00243927f250dBcD9160b5d06623b62B2e06d): every promo until Nov 15 ran on it, and its pause also blocked `registerClaim`.

```
git submodule update --init                                 # once after cloning, from the repo's root: forge-std and OpenZeppelin
forge build
forge test                                                  # everything, about a minute (nearly all of it the two invariant runs)
forge test --no-match-contract PromoVaultInvariantTest      # the 252 unit and fuzz tests, about 2 seconds (it leaves out both invariant contracts)
```

Solidity 0.8.28, evm version cancun, optimizer 200 runs, `via_ir` off. OpenZeppelin Contracts v5.7.0 (`EIP712`, `ECDSA`, `SafeERC20`).

## What it does

- Liquidity providers `deposit` USDC for shares and `withdraw` them. A withdrawal is priced on the free balance (`balance - lockedCollateral`), a deposit on the free balance plus the locks of promos with no final result.
- A merchant opens a promo with a quote signed by the pricer key (`createPromo`, or `createPromoWithPermit` with an EIP-2612 permit for exactly the premium). The whole payout is locked from that moment.
- The promo's claim signer registers customers (`registerClaim`) until the claim deadline. A quote with `hedgeMode` makes the merchant the one claimant, in the creating transaction.
- The oracle key posts the result (`settle`). After the dispute window anyone can `finalize` it, and anyone can pay the customers of a "yes" (`payoutBatch`). A transfer that fails is set aside and sent later (`retryPayout`).
- The owner can `veto` a result inside the window (then `resetSettlement`), `voidPromo` a promo with no standing result after a grace period (the premium is refunded), pause new deposits and new promos, and set the keys and limits. A pause blocks only `deposit`, `createPromo` and `createPromoWithPermit`: since v2 it no longer blocks `registerClaim`, because a promo locks every claim's payout when it is created, so claims on promos already open, withdrawals, settlement and payouts all go on.

## Tests

| File | What it covers |
|---|---|
| `test/VaultTest.sol` | The shared base: a test pricer key, the EIP-712 digest built by hand, helpers |
| `test/Liquidity.t.sol` | Deposit, withdraw, the lock, and deposit pricing while promos are pending |
| `test/CreatePromo.t.sol` | Quotes, the exposure cap, hedge mode, and the permit path |
| `test/Claims.t.sol` | Who may register a customer, and until when, paused or not |
| `test/Settlement.t.sol` | Settle, veto, reset, finalize |
| `test/Void.t.sol` | Voiding and the refund |
| `test/Payout.t.sol` | Batches, a transfer that fails, the retry |
| `test/Admin.t.sol` | The owner's settings, and which calls the pause blocks |
| `test/Invariants.t.sol` | A handler that makes random legal calls, and five invariants checked after each one, the first being `balance >= lockedCollateral` |
| `test/review2/Review2.t.sol` | The second review's tests (Nov 13). `test_finding_...` shows with numbers an outcome the review reported (a quote held open on a running market, fixed in the keeper); the second finding, a pause over a claim window, is fixed in v2 and its test now shows the customer registered and paid while paused; `test_note_...` shows behavior that is by design but worth knowing. The rest: covers (hedge mode) through a veto, a void, a blocklist and a pause, encoding and overflow, rounding, the constructor's zero-address checks, payout gas limits |
| `test/review2/Review2Invariants.t.sol` | A second invariant harness, with its own model of which calls must go through and which must be refused, checked both ways on every call. One address can play every role. Three invariants, and seven fixed walks of 600 calls each |
| `test/review3/Review3.t.sol` | The third review's tests (Nov 14, of v2): `registerClaim` paused and unpaused gives the same result and the same books from the same state (a fuzz test); what a pause no longer stops (a stolen claim signer key) and the owner's remedy (veto, then void); a quote signed before a pause works again after the unpause |
| `test/mocks/MockUSDC.sol` | A 6-decimal token with `permit` and a blocklist |
