// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdError} from "forge-std/Test.sol";
import {PromoVault} from "../src/PromoVault.sol";
import {VaultTest} from "./VaultTest.sol";

contract SetupTest is VaultTest {
    function test_initialState() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.owner(), address(this));
        assertEq(vault.pricer(), pricer);
        assertEq(vault.oracle(), oracle);
        assertEq(vault.maxExposureBps(), 2000);
        assertEq(vault.disputeWindow(), 3600);
        assertEq(vault.voidGrace(), 7 days);
        assertFalse(vault.paused());
        assertEq(vault.totalShares(), 0);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.promoCount(), 0);
        assertEq(vault.freeBalance(), 0);
    }
}

contract DepositTest is VaultTest {
    function test_firstDeposit_mintsOneSharePerUnitLessDeadShares() public {
        uint256 minted = _deposit(alice, 1_000 * USDC);

        assertEq(minted, 1_000 * USDC - vault.DEAD_SHARES());
        assertEq(vault.shares(alice), minted);
        assertEq(vault.shares(vault.DEAD_ADDRESS()), vault.DEAD_SHARES());
        assertEq(vault.totalShares(), 1_000 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 1_000 * USDC);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(vault.freeBalance(), 1_000 * USDC);
    }

    function test_deposit_emitsDeposited() public {
        usdc.mint(alice, 50 * USDC);
        vm.startPrank(alice);
        usdc.approve(address(vault), 50 * USDC);
        vm.expectEmit(address(vault));
        emit Deposited(alice, 50 * USDC, 50 * USDC - 1_000);
        vault.deposit(50 * USDC);
        vm.stopPrank();
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(PromoVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_firstDeposit_revertsAtOrBelowDeadShares() public {
        usdc.mint(alice, 1_000);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.FirstDepositTooSmall.selector, 1_000, 1_001));
        vault.deposit(1_000);
        vm.stopPrank();
    }

    function test_deposit_revertsWithoutApproval() public {
        usdc.mint(alice, 10 * USDC);
        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(10 * USDC);
    }

    function test_secondDeposit_isProRata() public {
        _deposit(alice, 1_000 * USDC);
        uint256 minted = _deposit(bob, 250 * USDC);

        assertEq(minted, 250 * USDC);
        assertEq(vault.totalShares(), 1_250 * USDC);
    }

    function test_deposit_afterEarnings_mintsFewerShares() public {
        _deposit(alice, 1_000 * USDC);
        // The vault kept 100 USDC of premium: each share is now worth 1.10.
        usdc.mint(address(vault), 100 * USDC);

        uint256 minted = _deposit(bob, 110 * USDC);

        assertEq(minted, 100 * USDC);
    }

    function test_deposit_whilePromoOpen_isPricedOnTheLockAsWell() public {
        _deposit(alice, 1_000 * USDC);
        vault.setMaxExposureBps(10_000); // this test is about share pricing, not the exposure cap
        // A promo pays 390 in premium and locks 1,000. Free balance: 1,390 - 1,000 = 390.
        _openPromo(390 * USDC, 1_000 * USDC);
        assertEq(vault.freeBalance(), 390 * USDC);
        assertEq(vault.depositBalance(), 1_390 * USDC);

        // It takes 1,390, not 390, to buy as many shares as already exist.
        uint256 minted = _deposit(bob, 1_390 * USDC);

        assertEq(minted, 1_000 * USDC);
    }

    function test_deposit_whenEverythingIsLocked_isPricedOnTheLock() public {
        _deposit(alice, 1_000 * USDC);
        vault.setMaxExposureBps(10_000);
        _openPromo(0, 1_000 * USDC); // no premium, and the whole vault is locked
        assertEq(vault.freeBalance(), 0);

        uint256 minted = _deposit(bob, 10 * USDC);

        assertEq(minted, 10 * USDC);
    }

    function test_deposit_revertsWhenItWouldMintNothing() public {
        _deposit(alice, 1_000 * USDC);
        usdc.mint(address(vault), 1_000_000 * USDC); // share price is now about 1,001

        usdc.mint(bob, 1_000);
        vm.startPrank(bob);
        usdc.approve(address(vault), 1_000);
        vm.expectRevert(PromoVault.ZeroShares.selector);
        vault.deposit(1_000);
        vm.stopPrank();
    }

    /// Only reachable with the exposure cap at 100%: one promo locks every free unit, and then
    /// pays all of it out. The shares that exist are worth nothing, so a new share has no price.
    function test_deposit_revertsWhenNothingIsFreeOrPending() public {
        _deposit(alice, 1_000 * USDC);
        vault.setMaxExposureBps(10_000);
        uint256 promoId = _openPromo(0, 1_000 * USDC);
        _claimMany(promoId, 50);
        _settleAndFinalize(promoId, true);
        vault.payoutBatch(promoId, 50);
        assertEq(vault.depositBalance(), 0);

        usdc.mint(bob, 10 * USDC);
        vm.startPrank(bob);
        usdc.approve(address(vault), 10 * USDC);
        vm.expectRevert(PromoVault.NoFreeBalance.selector);
        vault.deposit(10 * USDC);
        vm.stopPrank();
    }

    /// The classic vault attack: be first, deposit dust, donate to inflate the share price,
    /// and let the next depositor's shares round down. The dead shares make the donor pay for it.
    function test_firstDepositorCannotProfitByInflatingTheSharePrice() public {
        uint256 dust = vault.DEAD_SHARES() + 1;
        _deposit(alice, dust); // alice holds 1 share
        usdc.mint(alice, 1_000 * USDC);
        vm.prank(alice);
        usdc.transfer(address(vault), 1_000 * USDC); // the donation

        uint256 bobShares = _deposit(bob, 500 * USDC);

        vm.prank(bob);
        uint256 bobOut = vault.withdraw(bobShares);
        vm.prank(alice);
        uint256 aliceOut = vault.withdraw(1);

        assertGe(bobOut, 499 * USDC, "victim loses under 0.2%");
        assertLt(aliceOut, 2 * USDC, "attacker recovers almost none of the 1,000 donated");
    }
}

contract WithdrawTest is VaultTest {
    function test_withdraw_paysProRata() public {
        uint256 aliceShares = _deposit(alice, 1_000 * USDC);
        _deposit(bob, 500 * USDC);

        vm.prank(alice);
        uint256 out = vault.withdraw(aliceShares / 2);

        assertEq(out, aliceShares / 2);
        assertEq(usdc.balanceOf(alice), out);
        assertEq(vault.shares(alice), aliceShares - aliceShares / 2);
        assertEq(vault.totalShares(), 1_500 * USDC - aliceShares / 2);
    }

    function test_withdraw_emitsWithdrawn() public {
        uint256 minted = _deposit(alice, 100 * USDC);
        vm.expectEmit(address(vault));
        emit Withdrawn(alice, minted, minted);
        vm.prank(alice);
        vault.withdraw(minted);
    }

    function test_withdraw_includesEarnings() public {
        uint256 aliceShares = _deposit(alice, 1_000 * USDC);
        usdc.mint(address(vault), 100 * USDC);

        vm.prank(alice);
        uint256 out = vault.withdraw(aliceShares);

        // Everything except the dead shares' sliver of 1,100.
        assertApproxEqAbs(out, 1_100 * USDC, 1_100);
        assertLe(out, 1_100 * USDC);
    }

    function test_withdraw_revertsOnZero() public {
        _deposit(alice, 100 * USDC);
        vm.prank(alice);
        vm.expectRevert(PromoVault.ZeroAmount.selector);
        vault.withdraw(0);
    }

    function test_withdraw_revertsAboveHeldShares() public {
        uint256 aliceShares = _deposit(alice, 100 * USDC);
        _deposit(bob, 100 * USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PromoVault.InsufficientShares.selector, aliceShares, aliceShares + 1)
        );
        vault.withdraw(aliceShares + 1);
    }

    function test_withdraw_revertsForNonHolder() public {
        _deposit(alice, 100 * USDC);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.InsufficientShares.selector, 0, 1));
        vault.withdraw(1);
    }
}

/// Withdrawals can never reach locked collateral (SPEC invariants, F11).
contract LockedCollateralTest is VaultTest {
    /// F11 regression: the only LP leaves while a promo is open, and the promo can still pay in full.
    function test_withdrawAll_whilePromoOpen_leavesTheFullPayout() public {
        uint256 aliceShares = _deposit(alice, 1_000 * USDC);
        vault.setMaxExposureBps(10_000); // one promo may take the whole vault, the worst case for F11
        _openPromo(390 * USDC, 1_000 * USDC);

        vm.prank(alice);
        uint256 out = vault.withdraw(aliceShares);

        assertLe(out, 390 * USDC, "alice gets at most the free balance");
        assertApproxEqAbs(out, 390 * USDC, 1_000);
        assertGe(usdc.balanceOf(address(vault)), 1_000 * USDC, "the full payout is still in the vault");
        assertEq(vault.lockedCollateral(), 1_000 * USDC);
    }

    function test_withdraw_whenEverythingIsLocked_paysNothing() public {
        uint256 aliceShares = _deposit(alice, 1_000 * USDC);
        vault.setMaxExposureBps(10_000);
        _openPromo(0, 1_000 * USDC); // no premium, and the whole vault is locked

        vm.prank(alice);
        uint256 out = vault.withdraw(aliceShares);

        assertEq(out, 0);
        assertEq(usdc.balanceOf(address(vault)), 1_000 * USDC);
    }

    function test_everyLpWithdrawingEverything_neverTouchesTheLock() public {
        uint256 aliceShares = _deposit(alice, 700 * USDC);
        uint256 bobShares = _deposit(bob, 300 * USDC);
        _openPromo(78 * USDC, 200 * USDC);
        _openPromo(120 * USDC, 200 * USDC);

        vm.prank(bob);
        vault.withdraw(bobShares);
        vm.prank(alice);
        vault.withdraw(aliceShares);

        assertGe(usdc.balanceOf(address(vault)), 400 * USDC);
        assertLt(vault.freeBalance(), 1_000, "only the dead shares' dust is left free");
    }

    /// If the vault ever held less than it has locked, nothing can be withdrawn at all. No call
    /// sequence reaches that state, so the lock is written straight into storage.
    function test_withdraw_revertsWhenBalanceIsBelowTheLock() public {
        uint256 aliceShares = _deposit(alice, 1_000 * USDC);
        _setLocked(1_000 * USDC + 1);

        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        vault.withdraw(aliceShares);
    }

    function testFuzz_withdraw_neverDipsIntoLockedCollateral(
        uint256 aliceIn,
        uint256 bobIn,
        uint256 premium,
        uint256 locked,
        uint256 aliceOutShares,
        uint256 bobOutShares
    ) public {
        aliceIn = bound(aliceIn, 1_001, 10_000_000 * USDC);
        bobIn = bound(bobIn, 1, 10_000_000 * USDC);
        premium = bound(premium, 0, 1_000_000 * USDC);

        uint256 aliceShares = _deposit(alice, aliceIn);
        uint256 bobShares = _deposit(bob, bobIn);
        // One promo with any lock the vault can cover, up to its whole balance once the premium
        // is in. A lock is at least 1 and never below the premium.
        vault.setMaxExposureBps(10_000);
        locked = bound(locked, premium == 0 ? 1 : premium, vault.freeBalance() + premium);
        _createPromo(locked, 1, premium);

        aliceOutShares = bound(aliceOutShares, 1, aliceShares);
        bobOutShares = bound(bobOutShares, 1, bobShares);

        uint256 freeBefore = vault.freeBalance();
        vm.prank(alice);
        uint256 aliceOut = vault.withdraw(aliceOutShares);
        vm.prank(bob);
        uint256 bobOut = vault.withdraw(bobOutShares);

        assertLe(aliceOut + bobOut, freeBefore, "paid out more than the free balance");
        assertGe(usdc.balanceOf(address(vault)), locked, "balance fell below locked collateral");
        assertEq(vault.lockedCollateral(), locked);
    }

    function testFuzz_depositThenWithdraw_neverReturnsMoreThanDeposited(uint256 aliceIn, uint256 bobIn)
        public
    {
        aliceIn = bound(aliceIn, 1_001, 10_000_000 * USDC);
        bobIn = bound(bobIn, 1, 10_000_000 * USDC);

        _deposit(alice, aliceIn);
        uint256 bobShares = _deposit(bob, bobIn);

        vm.prank(bob);
        uint256 out = vault.withdraw(bobShares);

        assertLe(out, bobIn);
    }
}

/// pendingCollateral is the locks of the promos that have no final result yet.
contract PendingCollateralTest is VaultTest {
    uint256 internal first;
    uint256 internal second;

    function setUp() public override {
        super.setUp();
        _deposit(alice, 10_000 * USDC);
        first = _openPromo(390 * USDC, 1_000 * USDC);
        second = _openPromo(100 * USDC, 500 * USDC);
    }

    function test_pendingCollateral_isZeroBeforeAnyPromo() public {
        PromoVault empty = new PromoVault(usdc, pricer, oracle);
        assertEq(empty.pendingCollateral(), 0);
        assertEq(empty.depositBalance(), 0);
    }

    function test_createPromo_addsTheFullPayoutToPending() public view {
        assertEq(vault.pendingCollateral(), 1_500 * USDC);
        assertEq(vault.lockedCollateral(), 1_500 * USDC);
        assertEq(vault.depositBalance(), 10_490 * USDC, "the deposits and both premiums");
    }

    function test_createPromoWithPermit_addsTheFullPayoutToPending() public {
        _createWithPermit(_quote(10 * USDC, 20, 50 * USDC));
        assertEq(vault.pendingCollateral(), 1_700 * USDC);
    }

    function test_settleVetoAndReset_leaveThePromoPending() public {
        _settle(first, true);
        assertEq(vault.pendingCollateral(), 1_500 * USDC);
        vault.veto(first);
        assertEq(vault.pendingCollateral(), 1_500 * USDC);
        vault.resetSettlement(first);
        assertEq(vault.pendingCollateral(), 1_500 * USDC);
    }

    function test_finalizeNo_takesThePromoOutOfPending() public {
        _settleAndFinalize(first, false);
        assertEq(vault.pendingCollateral(), 500 * USDC);
        assertEq(vault.depositBalance(), 10_490 * USDC, "the lock became free balance");
    }

    /// A "yes" takes the whole lock out of pending, the claimed part included: that part is now
    /// owed to customers, and a deposit must not be priced as if the LPs still had it.
    function test_finalizeYes_takesTheWholeLockOutOfPending() public {
        _claimMany(first, 20);
        _settleAndFinalize(first, true);
        assertEq(vault.pendingCollateral(), 500 * USDC);
        assertEq(vault.lockedCollateral(), 500 * USDC + 20 * 20 * USDC);
        assertEq(vault.depositBalance(), 10_490 * USDC - 400 * USDC, "less what the customers are owed");

        vault.payoutBatch(first, 20);
        assertEq(vault.pendingCollateral(), 500 * USDC, "a payout does not touch pending");
        assertEq(vault.depositBalance(), 10_090 * USDC);
    }

    function test_voidPromo_takesThePromoOutOfPending() public {
        vm.warp(uint256(vault.getPromo(first).marketCloseTime) + vault.voidGrace() + 1);
        vault.voidPromo(first);
        assertEq(vault.pendingCollateral(), 500 * USDC);
        assertEq(vault.depositBalance(), 10_100 * USDC, "the premium went back to the merchant");
    }
}

/// A deposit is priced on the free balance plus the locks of promos that have no final result
/// yet. If it were priced on the free balance alone, a lock would be worth nothing until it is
/// released, and money that arrived just before the release would take it from the LPs whose
/// capital was inside it (review finding, Nov 12).
contract DepositWhilePromoPendingTest is VaultTest {
    uint256 internal constant LIQUIDITY = 11_810 * USDC;
    uint256 internal constant PAYOUT = 400 * USDC;
    uint32 internal constant MAX_CLAIMS = 10;
    uint256 internal constant MAX_PAYOUT = 4_000 * USDC;
    uint256 internal constant PREMIUM = 1_638 * USDC;

    address internal stranger = makeAddr("stranger");
    uint256 internal promoId;
    uint256 internal aliceShares;

    function setUp() public override {
        super.setUp();
        aliceShares = _deposit(alice, LIQUIDITY);
        promoId = _createPromo(PAYOUT, MAX_CLAIMS, PREMIUM);
        assertEq(vault.freeBalance(), 9_448 * USDC);
    }

    /// The result is "no" and the dispute window is over. A stranger deposits, calls finalize and
    /// withdraws, all in one transaction. The 4,000 the promo releases must stay with Alice.
    function test_deposit_rightBeforeFinalize_takesNothingFromTheReleasedLock() public {
        _settle(promoId, false);
        vm.warp(block.timestamp + vault.disputeWindow());

        uint256 loan = 1_000_000 * USDC;
        uint256 minted = _deposit(stranger, loan);
        vault.finalize(promoId);
        vm.prank(stranger);
        uint256 out = vault.withdraw(minted);

        assertLe(out, loan, "the stranger left with more than they brought");

        vm.prank(alice);
        uint256 aliceOut = vault.withdraw(aliceShares);
        // The only LP, after a "no": her 11,810 plus the 1,638 premium, less the dead shares' dust.
        assertApproxEqAbs(aliceOut, LIQUIDITY + PREMIUM, 10_000);
    }

    /// Bob deposits while the promo is open and the result is "no": he gets his deposit back and
    /// no part of a lock that was Alice's capital and Alice's premium.
    function test_deposit_whilePromoOpen_onANo_returnsTheDepositAndNoMore() public {
        uint256 bobIn = 9_448 * USDC;
        uint256 bobShares = _deposit(bob, bobIn);

        _settleAndFinalize(promoId, false);
        vm.prank(bob);
        uint256 bobOut = vault.withdraw(bobShares);
        vm.prank(alice);
        uint256 aliceOut = vault.withdraw(aliceShares);

        assertLe(bobOut, bobIn);
        assertApproxEqAbs(bobOut, bobIn, 10);
        assertApproxEqAbs(aliceOut, LIQUIDITY + PREMIUM, 10_000);
    }

    /// The same deposit when the result is "yes" and every claim is taken: Bob bought into the
    /// lock, so he carries his part of the loss. Alice does not carry all of it.
    function test_deposit_whilePromoOpen_onAYes_sharesTheLoss() public {
        uint256 bobIn = 9_448 * USDC;
        uint256 bobShares = _deposit(bob, bobIn);

        _claimMany(promoId, MAX_CLAIMS);
        _settleAndFinalize(promoId, true);
        vault.payoutBatch(promoId, MAX_CLAIMS);
        vm.prank(bob);
        uint256 bobOut = vault.withdraw(bobShares);
        vm.prank(alice);
        uint256 aliceOut = vault.withdraw(aliceShares);

        // Bob paid 9,448 into a vault valued at 13,448 (9,448 free and the 4,000 lock), so he
        // holds 9,448 / 22,896 of what is left: 11,810 + 1,638 + 9,448 - 4,000 = 18,896.
        uint256 left = LIQUIDITY + PREMIUM + bobIn - MAX_PAYOUT;
        assertApproxEqAbs(bobOut, left * bobIn / (LIQUIDITY + PREMIUM + bobIn), 10_000);
        assertLt(bobOut, bobIn, "bob took no part of the loss");
        assertGt(aliceOut, LIQUIDITY + PREMIUM - MAX_PAYOUT, "alice carried the whole loss");
    }

    /// The only LP leaves while the promo is open, and gives up her part of the lock. Money that
    /// arrives afterwards cannot pick the lock up for next to nothing.
    function test_deposit_afterEveryLpLeft_cannotTakeTheLock() public {
        vm.prank(alice);
        vault.withdraw(aliceShares);
        assertEq(vault.totalShares(), vault.DEAD_SHARES());

        uint256 strangerIn = 100 * USDC;
        uint256 minted = _deposit(stranger, strangerIn);
        _settleAndFinalize(promoId, false);
        vm.prank(stranger);
        uint256 out = vault.withdraw(minted);

        assertLe(out, strangerIn, "100 USDC bought the 4,000 lock");
    }

    /// Whenever a deposit arrives in the life of a promo, and whatever the result, withdrawing
    /// it after the promo has ended never returns more than was deposited.
    function testFuzz_deposit_atAnyPointOfAPromo_neverReturnsMoreThanDeposited(
        uint256 bobIn,
        uint256 stage,
        uint256 claims,
        bool outcomeYes
    ) public {
        bobIn = bound(bobIn, 1 * USDC, 10_000_000 * USDC);
        stage = bound(stage, 0, 2);
        claims = bound(claims, 0, MAX_CLAIMS);
        _claimMany(promoId, claims);

        // 0: while the promo is open. 1: in the dispute window. 2: when finalize is due.
        if (stage >= 1) _settle(promoId, outcomeYes);
        if (stage == 2) vm.warp(block.timestamp + vault.disputeWindow());
        uint256 bobShares = _deposit(bob, bobIn);
        if (stage == 0) _settle(promoId, outcomeYes);
        if (stage <= 1) vm.warp(block.timestamp + vault.disputeWindow());

        vault.finalize(promoId);
        if (outcomeYes && claims != 0) vault.payoutBatch(promoId, MAX_CLAIMS);
        vm.prank(bob);
        uint256 out = vault.withdraw(bobShares);

        assertLe(out, bobIn);
    }
}
