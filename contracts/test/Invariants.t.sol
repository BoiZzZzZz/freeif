// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PromoVault} from "../src/PromoVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives the vault through random sequences of every state-changing call. Each action first
///      looks for a promo (or LP, or customer) it can legally act on and does nothing if there is
///      none, so a revert inside an action is a real failure: the invariant run has
///      fail_on_revert on. That turns "withdraw, finalize, payoutBatch and voidPromo always work
///      when they are due, paused or not" into something every run checks. The `forbidden`
///      action does the opposite: it tries calls the SPEC rules out and fails if one succeeds.
contract VaultHandler is Test {
    uint256 internal constant USDC = 1e6;
    uint256 internal constant MAX_PROMOS = 12;
    string internal constant EVENT_ID_PLAIN = "362998";

    enum Step {
        Claim,
        Settle,
        Veto,
        Reset,
        Finalize,
        Void,
        Pay
    }

    error BadTransition(uint256 promoId, PromoVault.Status from, PromoVault.Status to);
    error ForbiddenCallWentThrough(uint256 promoId, uint256 kind);

    PromoVault internal immutable vault;
    MockUSDC internal immutable usdc;
    address internal immutable owner;
    address internal immutable oracle;
    uint256 internal immutable pricerPk;
    address internal immutable relayer;

    address[] internal lps;
    address[] internal merchants;
    address[] internal customers;

    // Every USDC movement in or out of the vault, as the handler saw it.
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostPremiums;
    uint256 public ghostPaid;
    uint256 public ghostRefunded;
    mapping(uint256 => uint256) public paidByPromo;
    mapping(uint256 => uint256) public refundByPromo;

    /// @dev How many times each call went through, for the coverage check at the end of a run.
    mapping(Step => uint256) public done;

    /// @dev How many forbidden calls were tried (and reverted, or the run would have failed).
    uint256 public forbiddenTried;

    mapping(uint256 => PromoVault.Status) internal lastStatus;
    uint256 internal nonce;
    PromoVault.Quote internal lastQuote;

    constructor(PromoVault vault_, MockUSDC usdc_, uint256 pricerPk_, address oracle_, address owner_) {
        vault = vault_;
        usdc = usdc_;
        pricerPk = pricerPk_;
        oracle = oracle_;
        owner = owner_;
        relayer = makeAddr("relayer");
        for (uint256 i = 0; i < 3; i++) {
            lps.push(makeAddr(string.concat("lp-", vm.toString(i))));
        }
        for (uint256 i = 0; i < 2; i++) {
            merchants.push(makeAddr(string.concat("merchant-", vm.toString(i))));
        }
        for (uint256 i = 0; i < 8; i++) {
            customers.push(makeAddr(string.concat("customer-", vm.toString(i))));
        }
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    function lpAt(uint256 i) external view returns (address) {
        return lps[i];
    }

    // ------------------------------------------------------------ liquidity

    function deposit(uint256 lpSeed, uint256 amount) external {
        if (vault.paused()) return;
        amount = bound(amount, 1_001, 5_000 * USDC);
        uint256 total = vault.totalShares();
        if (total != 0) {
            uint256 free = vault.freeBalance();
            if (free == 0 || amount * total / free == 0) return;
        }
        address lp = lps[lpSeed % lps.length];

        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();

        ghostDeposited += amount;
        _afterAction();
    }

    /// @dev One call in four takes every share the LP holds.
    function withdraw(uint256 lpSeed, uint256 shareAmount) external {
        address lp = lps[lpSeed % lps.length];
        uint256 held = vault.shares(lp);
        if (held == 0) return;
        shareAmount = shareAmount % 4 == 0 ? held : bound(shareAmount, 1, held);

        vm.prank(lp);
        ghostWithdrawn += vault.withdraw(shareAmount);
        _afterAction();
    }

    // ------------------------------------------------------------ promos

    function createPromo(
        uint256 merchantSeed,
        uint256 payoutPerClaim,
        uint32 maxClaims,
        uint256 premium,
        bool hedgeMode,
        uint256 deadlineIn,
        uint256 closeAfter
    ) external {
        if (vault.paused() || vault.promoCount() >= MAX_PROMOS) return;
        payoutPerClaim = bound(payoutPerClaim, 1, 50 * USDC);
        maxClaims = hedgeMode ? 1 : uint32(bound(maxClaims, 1, 6));
        uint256 maxPayout = payoutPerClaim * maxClaims;
        premium = bound(premium, 0, maxPayout);
        // Raise the premium until the promo fits under the exposure cap, as the pricer would
        // refuse to quote anything that does not.
        uint256 cap = vault.freeBalance() * vault.maxExposureBps() / 10_000;
        if (maxPayout - premium > cap) premium = maxPayout - cap;

        uint64 claimDeadline = uint64(block.timestamp + bound(deadlineIn, 10 minutes, 6 hours));
        PromoVault.Quote memory q = PromoVault.Quote({
            merchant: merchants[merchantSeed % merchants.length],
            claimSigner: relayer,
            geminiEventId: keccak256(bytes(EVENT_ID_PLAIN)),
            instrumentSymbol: keccak256("GEMI-TEST"),
            payoutPerClaim: payoutPerClaim,
            maxClaims: maxClaims,
            premium: premium,
            claimDeadline: claimDeadline,
            marketCloseTime: claimDeadline + uint64(bound(closeAfter, 0, 6 hours)),
            hedgeMode: hedgeMode,
            expiry: uint64(block.timestamp + 90),
            nonce: bytes32(++nonce)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pricerPk, vault.quoteDigest(q));

        usdc.mint(q.merchant, premium);
        vm.startPrank(q.merchant);
        usdc.approve(address(vault), premium);
        vault.createPromo(q, abi.encodePacked(r, s, v));
        vm.stopPrank();

        ghostPremiums += premium;
        lastQuote = q;
        _afterAction();
    }

    function registerClaim(uint256 promoSeed, uint256 customerSeed) external {
        if (vault.paused()) return;
        (bool found, uint256 promoId) = _find(promoSeed, Step.Claim);
        if (found) _claim(promoId, customerSeed);
    }

    function settle(uint256 promoSeed, bool outcomeYes) external {
        (bool found, uint256 promoId) = _find(promoSeed, Step.Settle);
        if (found) _settle(promoId, outcomeYes);
    }

    function veto(uint256 promoSeed) external {
        (bool found, uint256 promoId) = _find(promoSeed, Step.Veto);
        if (!found) return;
        vm.prank(owner);
        vault.veto(promoId);
        done[Step.Veto]++;
        _afterAction();
    }

    function resetSettlement(uint256 promoSeed) external {
        (bool found, uint256 promoId) = _find(promoSeed, Step.Reset);
        if (found) _reset(promoId);
    }

    function finalize(uint256 promoSeed) external {
        (bool found, uint256 promoId) = _find(promoSeed, Step.Finalize);
        if (found) _finalize(promoId);
    }

    /// @dev One call in four waits out the grace period of a promo that is not voidable yet.
    function voidPromo(uint256 promoSeed) external {
        (bool found, uint256 promoId) = _find(promoSeed, Step.Void);
        if (!found) {
            if (promoSeed % 4 != 0) return;
            (found, promoId) = _findStatus(promoSeed, PromoVault.Status.Open);
            if (!found) return;
            vm.warp(uint256(vault.getPromo(promoId).marketCloseTime) + vault.voidGrace() + 1);
        }
        address promoMerchant = vault.getPromo(promoId).merchant;
        uint256 before = usdc.balanceOf(promoMerchant);

        vm.prank(owner);
        vault.voidPromo(promoId);

        uint256 refund = usdc.balanceOf(promoMerchant) - before;
        refundByPromo[promoId] += refund;
        ghostRefunded += refund;
        done[Step.Void]++;
        _afterAction();
    }

    function payoutBatch(uint256 promoSeed, uint32 count) external {
        (bool found, uint256 promoId) = _find(promoSeed, Step.Pay);
        if (found) _pay(promoId, count);
    }

    /// @dev Take one promo one step along its life, waiting for the clock when that is all it
    ///      needs: claim, settle, finalize, pay. With the single-step actions alone, most
    ///      sequences never get a promo as far as a payout. advanceAgain is the same action
    ///      under a second selector, so it runs twice as often.
    function advance(uint256 promoSeed, uint256 seed, bool outcomeYes) public {
        uint256 n = vault.promoCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 promoId = (promoSeed % n + i) % n;
            PromoVault.Promo memory p = vault.getPromo(promoId);
            if (p.status == PromoVault.Status.Open) {
                bool claimable =
                    block.timestamp < p.claimDeadline && p.claimCount < p.maxClaims && !vault.paused();
                if (claimable && seed % 3 != 0) return _claim(promoId, seed);
                if (block.timestamp < p.claimDeadline) vm.warp(p.claimDeadline);
                return _settle(promoId, outcomeYes);
            }
            if (p.status == PromoVault.Status.Settled) {
                uint256 windowEnd = uint256(p.settledAt) + vault.disputeWindow();
                if (block.timestamp < windowEnd) vm.warp(windowEnd);
                return _finalize(promoId);
            }
            if (p.status == PromoVault.Status.Vetoed) return _reset(promoId);
            if (p.status == PromoVault.Status.FinalizedYes) return _pay(promoId, uint32(seed % 4));
        }
    }

    function advanceAgain(uint256 promoSeed, uint256 seed, bool outcomeYes) external {
        advance(promoSeed, seed, outcomeYes);
    }

    // ------------------------------------------------------------ calls that must fail

    /// @dev Try one call the SPEC forbids, in whatever state the sequence has reached, and fail
    ///      the run if the vault lets it through:
    ///      0  registerClaim from anyone but the claim signer (F17)
    ///      1  registerClaim from the claim signer on a promo that is closed, full or not open
    ///      2  settle before the claim deadline, or on a promo that is not open
    ///      3  finalize before the dispute window ends, or on a promo that is not settled
    ///      4  payoutBatch on a promo that is not finalized "yes"
    ///      5  voidPromo before the grace period ends, or on a promo with a result
    ///      6  a second promo from a quote nonce that has been used
    function forbidden(uint256 promoSeed, uint256 kind, address caller) external {
        uint256 n = vault.promoCount();
        if (n == 0) return;
        uint256 promoId = promoSeed % n;
        PromoVault.Promo memory p = vault.getPromo(promoId);
        kind = kind % 7;
        bytes memory data;

        if (kind == 0) {
            if (caller == relayer) return;
            data = abi.encodeCall(vault.registerClaim, (promoId, customers[0]));
            vm.prank(caller);
        } else if (kind == 1) {
            if (_allowed(p, Step.Claim)) return;
            data = abi.encodeCall(vault.registerClaim, (promoId, makeAddr("a late customer")));
            vm.prank(relayer);
        } else if (kind == 2) {
            if (_allowed(p, Step.Settle)) return;
            data = abi.encodeCall(vault.settle, (promoId, true, EVENT_ID_PLAIN, "yes"));
            vm.prank(oracle);
        } else if (kind == 3) {
            if (_allowed(p, Step.Finalize)) return;
            data = abi.encodeCall(vault.finalize, (promoId));
        } else if (kind == 4) {
            if (_allowed(p, Step.Pay)) return;
            data = abi.encodeCall(vault.payoutBatch, (promoId, 1));
        } else if (kind == 5) {
            if (_allowed(p, Step.Void)) return;
            data = abi.encodeCall(vault.voidPromo, (promoId));
            vm.prank(owner);
        } else {
            // The last quote again, re-dated and re-signed by the pricer, with its spent nonce.
            PromoVault.Quote memory q = lastQuote;
            q.claimDeadline = uint64(block.timestamp + 1 hours);
            q.marketCloseTime = q.claimDeadline;
            q.expiry = uint64(block.timestamp + 90);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pricerPk, vault.quoteDigest(q));
            data = abi.encodeCall(vault.createPromo, (q, abi.encodePacked(r, s, v)));
            usdc.mint(q.merchant, q.premium);
            vm.prank(q.merchant);
            usdc.approve(address(vault), q.premium);
            vm.prank(q.merchant);
        }

        (bool ok,) = address(vault).call(data);
        if (ok) revert ForbiddenCallWentThrough(promoId, kind);
        forbiddenTried++;
    }

    // ------------------------------------------------------------ time and admin

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 4 hours));
    }

    function setMaxExposureBps(uint16 bps) external {
        vm.prank(owner);
        vault.setMaxExposureBps(uint16(bound(bps, 500, 10_000)));
    }

    function setPaused(uint8 seed) external {
        vm.startPrank(owner);
        if (seed % 4 == 0) vault.pause();
        else vault.unpause();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ the calls

    /// @dev Up to three customers a call, so promos fill before their deadline.
    function _claim(uint256 promoId, uint256 customerSeed) internal {
        PromoVault.Promo memory p = vault.getPromo(promoId);
        uint256 wanted = p.maxClaims - p.claimCount;
        if (wanted > 3) wanted = 3;
        for (uint256 i = 0; i < customers.length && wanted > 0; i++) {
            address customer = customers[(customerSeed % customers.length + i) % customers.length];
            if (vault.hasClaim(promoId, customer)) continue;
            vm.prank(relayer);
            vault.registerClaim(promoId, customer);
            wanted--;
            done[Step.Claim]++;
        }
        _afterAction();
    }

    function _settle(uint256 promoId, bool outcomeYes) internal {
        vm.prank(oracle);
        vault.settle(promoId, outcomeYes, EVENT_ID_PLAIN, outcomeYes ? "yes" : "no");
        done[Step.Settle]++;
        _afterAction();
    }

    function _reset(uint256 promoId) internal {
        vm.prank(owner);
        vault.resetSettlement(promoId);
        done[Step.Reset]++;
        _afterAction();
    }

    function _finalize(uint256 promoId) internal {
        vault.finalize(promoId);
        done[Step.Finalize]++;
        _afterAction();
    }

    function _pay(uint256 promoId, uint32 count) internal {
        uint256 before = usdc.balanceOf(address(vault));

        uint32 customersPaid = vault.payoutBatch(promoId, uint32(bound(count, 1, 4)));

        uint256 paid = before - usdc.balanceOf(address(vault));
        paidByPromo[promoId] += paid;
        ghostPaid += paid;
        done[Step.Pay] += customersPaid;
        _afterAction();
    }

    // ------------------------------------------------------------ internals

    /// @dev The first promo, starting from a random one, on which `step` is allowed right now.
    function _find(uint256 seed, Step step) internal view returns (bool, uint256) {
        uint256 n = vault.promoCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 promoId = (seed % n + i) % n;
            if (_allowed(vault.getPromo(promoId), step)) return (true, promoId);
        }
        return (false, 0);
    }

    function _findStatus(uint256 seed, PromoVault.Status status) internal view returns (bool, uint256) {
        uint256 n = vault.promoCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 promoId = (seed % n + i) % n;
            if (vault.getPromo(promoId).status == status) return (true, promoId);
        }
        return (false, 0);
    }

    function _allowed(PromoVault.Promo memory p, Step step) internal view returns (bool) {
        uint256 windowEnd = uint256(p.settledAt) + vault.disputeWindow();
        if (step == Step.Claim) {
            return p.status == PromoVault.Status.Open && block.timestamp < p.claimDeadline
                && p.claimCount < p.maxClaims;
        }
        if (step == Step.Settle) {
            return p.status == PromoVault.Status.Open && block.timestamp >= p.claimDeadline;
        }
        if (step == Step.Veto) return p.status == PromoVault.Status.Settled && block.timestamp < windowEnd;
        if (step == Step.Reset) return p.status == PromoVault.Status.Vetoed;
        if (step == Step.Finalize) {
            return p.status == PromoVault.Status.Settled && block.timestamp >= windowEnd;
        }
        if (step == Step.Void) {
            return (p.status == PromoVault.Status.Open || p.status == PromoVault.Status.Vetoed)
                && block.timestamp > uint256(p.marketCloseTime) + vault.voidGrace();
        }
        return p.status == PromoVault.Status.FinalizedYes;
    }

    /// @dev A promo only ever moves along the edges of the status diagram, and FinalizedNo,
    ///      PaidOut and Voided are final.
    function _afterAction() internal {
        uint256 n = vault.promoCount();
        for (uint256 promoId = 0; promoId < n; promoId++) {
            PromoVault.Status from = lastStatus[promoId];
            PromoVault.Status to = vault.getPromo(promoId).status;
            if (from == to) continue;
            if (!_edge(from, to)) revert BadTransition(promoId, from, to);
            lastStatus[promoId] = to;
        }
    }

    function _edge(PromoVault.Status from, PromoVault.Status to) internal pure returns (bool) {
        if (from == PromoVault.Status.Open) {
            return to == PromoVault.Status.Settled || to == PromoVault.Status.Voided;
        }
        if (from == PromoVault.Status.Settled) {
            return to == PromoVault.Status.Vetoed || to == PromoVault.Status.FinalizedYes
                || to == PromoVault.Status.FinalizedNo || to == PromoVault.Status.PaidOut;
        }
        if (from == PromoVault.Status.Vetoed) {
            return to == PromoVault.Status.Open || to == PromoVault.Status.Voided;
        }
        if (from == PromoVault.Status.FinalizedYes) return to == PromoVault.Status.PaidOut;
        return false;
    }
}

/// The SPEC section 1 invariants, checked after every call of every random sequence.
contract PromoVaultInvariantTest is Test {
    PromoVault internal vault;
    MockUSDC internal usdc;
    VaultHandler internal handler;
    address internal oracle = makeAddr("oracle");

    function setUp() public {
        (address pricer, uint256 pricerPk) = makeAddrAndKey("pricer");
        usdc = new MockUSDC();
        vault = new PromoVault(usdc, pricer, oracle);
        // Short enough that a sequence gets promos all the way to paid out or voided.
        vault.setDisputeWindow(1 hours);
        vault.setVoidGrace(6 hours);
        handler = new VaultHandler(vault, usdc, pricerPk, oracle, address(this));

        // Start with LP money in the vault, so promos put real capital at risk from the first call.
        handler.deposit(0, 5_000e6);
        handler.deposit(1, 2_500e6);

        bytes4[] memory selectors = new bytes4[](16);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.withdraw.selector;
        selectors[2] = VaultHandler.createPromo.selector;
        selectors[3] = VaultHandler.registerClaim.selector;
        selectors[4] = VaultHandler.settle.selector;
        selectors[5] = VaultHandler.veto.selector;
        selectors[6] = VaultHandler.resetSettlement.selector;
        selectors[7] = VaultHandler.finalize.selector;
        selectors[8] = VaultHandler.voidPromo.selector;
        selectors[9] = VaultHandler.payoutBatch.selector;
        selectors[10] = VaultHandler.advance.selector;
        selectors[11] = VaultHandler.advanceAgain.selector;
        selectors[12] = VaultHandler.warp.selector;
        selectors[13] = VaultHandler.setMaxExposureBps.selector;
        selectors[14] = VaultHandler.setPaused.selector;
        selectors[15] = VaultHandler.forbidden.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// F11: the vault always holds its locked collateral, and lockedCollateral is exactly the sum
    /// of the unpaid maximum payouts of every promo that is not finalized-no, paid out or voided.
    function invariant_balanceCoversLockedCollateral() public view {
        uint256 locked = vault.lockedCollateral();
        assertGe(usdc.balanceOf(address(vault)), locked, "balance below locked collateral");

        uint256 sumOfLocks;
        uint256 sumOfUnpaid;
        uint256 n = vault.promoCount();
        for (uint256 promoId = 0; promoId < n; promoId++) {
            PromoVault.Promo memory p = vault.getPromo(promoId);
            sumOfLocks += p.collateralLocked;
            assertEq(p.collateralLocked, _unpaidMaxPayout(p), "a promo's lock is not its unpaid max payout");
            sumOfUnpaid += _unpaidMaxPayout(p);
        }
        assertEq(locked, sumOfLocks, "lockedCollateral is not the sum of the promo locks");
        assertEq(locked, sumOfUnpaid, "lockedCollateral is not the sum of unpaid max payouts");
    }

    /// Every base unit is accounted for: nothing leaves the vault except withdrawals, payouts and
    /// void refunds.
    function invariant_vaultBalanceMatchesTheMoneyFlows() public view {
        assertEq(
            usdc.balanceOf(address(vault)),
            handler.ghostDeposited() + handler.ghostPremiums() - handler.ghostWithdrawn()
                - handler.ghostPaid() - handler.ghostRefunded()
        );

        uint256 sumOfShares = vault.shares(vault.DEAD_ADDRESS());
        for (uint256 i = 0; i < handler.lpCount(); i++) {
            sumOfShares += vault.shares(handler.lpAt(i));
        }
        assertEq(vault.totalShares(), sumOfShares, "shares do not add up");
    }

    /// Per promo: claims never pass maxClaims, payouts never pass payoutPerClaim * maxClaims, money
    /// is paid only after a final "yes", and a void refunds exactly the premium.
    function invariant_promoBooksStayConsistent() public view {
        uint256 n = vault.promoCount();
        for (uint256 promoId = 0; promoId < n; promoId++) {
            PromoVault.Promo memory p = vault.getPromo(promoId);
            address[] memory claimed = vault.getClaimants(promoId);
            uint256 paid = handler.paidByPromo(promoId);

            assertEq(claimed.length, p.claimCount);
            assertLe(p.claimCount, p.maxClaims, "more claims than maxClaims");
            assertLe(p.paidCount, p.claimCount, "more payouts than claims");
            assertEq(
                paid,
                p.payoutPerClaim * p.paidCount,
                "a customer was paid something other than payoutPerClaim"
            );
            assertLe(paid, p.payoutPerClaim * p.maxClaims, "paid more than the max payout");
            assertLe(p.premiumPaid, p.payoutPerClaim * p.maxClaims);

            if (paid > 0) {
                assertTrue(p.outcomeYes, "paid without a yes");
                assertTrue(
                    p.status == PromoVault.Status.FinalizedYes || p.status == PromoVault.Status.PaidOut,
                    "paid without a final yes"
                );
            }
            if (p.status == PromoVault.Status.PaidOut) {
                assertTrue(p.outcomeYes);
                assertEq(p.paidCount, p.claimCount, "paid out with customers still unpaid");
            }
            if (p.status == PromoVault.Status.Voided) {
                assertEq(
                    handler.refundByPromo(promoId), p.premiumPaid, "void did not refund exactly the premium"
                );
                assertEq(paid, 0);
            } else {
                assertEq(handler.refundByPromo(promoId), 0, "a refund without a void");
            }
            if (p.status == PromoVault.Status.Open) {
                assertEq(p.settledAt, 0);
                assertFalse(p.outcomeYes);
            }
            if (p.hedgeMode) {
                assertEq(p.maxClaims, 1);
                assertEq(claimed.length, 1);
                assertEq(claimed[0], p.merchant, "hedge mode must pay the merchant");
            }
        }
    }

    /// F11, from any reachable state: every LP withdraws every share, then every promo that has
    /// no final result yet resolves "yes", and every registered customer is still paid in full.
    function invariant_everyLpCanLeaveAndEveryPromoStillPaysInFull() public {
        uint256 snapshot = vm.snapshotState();

        for (uint256 i = 0; i < handler.lpCount(); i++) {
            address lp = handler.lpAt(i);
            uint256 held = vault.shares(lp);
            if (held == 0) continue;
            vm.prank(lp);
            vault.withdraw(held);
        }
        assertGe(usdc.balanceOf(address(vault)), vault.lockedCollateral(), "LPs withdrew locked collateral");

        uint256 n = vault.promoCount();
        uint256 latestDeadline = block.timestamp;
        for (uint256 promoId = 0; promoId < n; promoId++) {
            PromoVault.Promo memory p = vault.getPromo(promoId);
            if (p.status == PromoVault.Status.Vetoed) vault.resetSettlement(promoId);
            if (p.claimDeadline > latestDeadline) latestDeadline = p.claimDeadline;
        }
        vm.warp(latestDeadline);
        for (uint256 promoId = 0; promoId < n; promoId++) {
            if (vault.getPromo(promoId).status != PromoVault.Status.Open) continue;
            vm.prank(oracle);
            vault.settle(promoId, true, "362998", "yes");
        }
        vm.warp(block.timestamp + vault.disputeWindow());
        for (uint256 promoId = 0; promoId < n; promoId++) {
            if (vault.getPromo(promoId).status == PromoVault.Status.Settled) vault.finalize(promoId);
            PromoVault.Promo memory p = vault.getPromo(promoId);
            if (p.status != PromoVault.Status.FinalizedYes) continue;

            address last = vault.claimants(promoId, p.claimCount - 1);
            uint256 before = usdc.balanceOf(last);
            vault.payoutBatch(promoId, p.claimCount);
            assertEq(
                usdc.balanceOf(last) - before, p.payoutPerClaim, "the last customer was not paid in full"
            );
            assertTrue(vault.getPromo(promoId).status == PromoVault.Status.PaidOut);
        }
        assertEq(vault.lockedCollateral(), 0, "collateral still locked after every promo ended");

        vm.revertToState(snapshot);
    }

    /// @dev SPEC: the sum runs over every promo that is not finalized-no, paid out or voided.
    function _unpaidMaxPayout(PromoVault.Promo memory p) internal pure returns (uint256) {
        if (
            p.status == PromoVault.Status.Open || p.status == PromoVault.Status.Settled
                || p.status == PromoVault.Status.Vetoed
        ) {
            return p.payoutPerClaim * p.maxClaims;
        }
        if (p.status == PromoVault.Status.FinalizedYes) {
            return p.payoutPerClaim * (p.claimCount - p.paidCount);
        }
        return 0;
    }
}
