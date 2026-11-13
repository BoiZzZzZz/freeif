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

    function test_deposit_isPricedOnFreeBalanceOnly() public {
        _deposit(alice, 1_000 * USDC);
        // A promo pays 390 in premium and locks 1,000. Free balance: 1,390 - 1,000 = 390.
        _openPromo(390 * USDC, 1_000 * USDC);
        assertEq(vault.freeBalance(), 390 * USDC);

        // 390 buys as many shares as already exist, because it doubles the free balance.
        uint256 minted = _deposit(bob, 390 * USDC);

        assertEq(minted, 1_000 * USDC);
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
        _setLocked(1_000 * USDC);

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

    /// If the vault ever held less than it has locked, nothing can be withdrawn at all.
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
        usdc.mint(address(vault), premium);
        // Any lock the vault can cover, from nothing to its whole balance.
        locked = bound(locked, 0, usdc.balanceOf(address(vault)));
        _setLocked(locked);

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
