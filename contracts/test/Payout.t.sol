// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PromoVault} from "../src/PromoVault.sol";
import {SettlementBase} from "./Settlement.t.sol";

/// @dev The base promo has 3 customers out of 10, at $20 each.
contract PayoutBatchTest is SettlementBase {
    function test_payoutBatch_paysEveryCustomerInRegistrationOrder() public {
        _settleAndFinalize(promoId, true);

        for (uint256 i = 0; i < 3; i++) {
            vm.expectEmit(address(vault));
            emit Paid(promoId, customers[i], PAYOUT);
        }
        uint32 paid = vault.payoutBatch(promoId, 50);

        assertEq(paid, 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(usdc.balanceOf(customers[i]), PAYOUT);
        }
        PromoVault.Promo memory p = vault.getPromo(promoId);
        assertEq(p.paidCount, 3);
        assertEq(p.collateralLocked, 0);
        _assertStatus(promoId, PromoVault.Status.PaidOut);
    }

    /// Payouts come out of the lock, never out of the LPs' free balance.
    function test_payoutBatch_paysOutOfTheLock() public {
        _settleAndFinalize(promoId, true);
        uint256 freeBefore = vault.freeBalance();

        vault.payoutBatch(promoId, 50);

        assertEq(vault.lockedCollateral(), 0);
        assertEq(usdc.balanceOf(address(vault)), LIQUIDITY + PREMIUM - 3 * PAYOUT);
        assertEq(vault.freeBalance(), freeBefore, "the free balance does not move");
    }

    function test_payoutBatch_paysInBatchesAndResumesWhereItStopped() public {
        _settleAndFinalize(promoId, true);

        assertEq(vault.payoutBatch(promoId, 2), 2);
        assertEq(usdc.balanceOf(customers[0]), PAYOUT);
        assertEq(usdc.balanceOf(customers[1]), PAYOUT);
        assertEq(usdc.balanceOf(customers[2]), 0);
        assertEq(vault.getPromo(promoId).paidCount, 2);
        assertEq(vault.lockedCollateral(), PAYOUT);
        _assertStatus(promoId, PromoVault.Status.FinalizedYes);

        assertEq(vault.payoutBatch(promoId, 2), 1);
        assertEq(usdc.balanceOf(customers[0]), PAYOUT, "nobody is paid twice");
        assertEq(usdc.balanceOf(customers[2]), PAYOUT);
        assertEq(vault.lockedCollateral(), 0);
        _assertStatus(promoId, PromoVault.Status.PaidOut);
    }

    function test_payoutBatch_canBeCalledByAnyone() public {
        _settleAndFinalize(promoId, true);

        vm.prank(makeAddr("a stranger"));
        vault.payoutBatch(promoId, 50);

        _assertStatus(promoId, PromoVault.Status.PaidOut);
    }

    function test_payoutBatch_worksWhilePaused() public {
        _settleAndFinalize(promoId, true);
        vault.pause();

        vault.payoutBatch(promoId, 50);

        assertEq(usdc.balanceOf(customers[2]), PAYOUT);
    }

    function test_payoutBatch_revertsOnZeroCount() public {
        _settleAndFinalize(promoId, true);
        vm.expectRevert(PromoVault.ZeroAmount.selector);
        vault.payoutBatch(promoId, 0);
    }

    function test_payoutBatch_revertsForAnUnknownPromo() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 9));
        vault.payoutBatch(9, 50);
    }

    /// SPEC invariant: payouts are impossible unless the promo finalized "yes".
    function test_payoutBatch_revertsWhileOpen() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Open));
        vault.payoutBatch(promoId, 50);
    }

    function test_payoutBatch_revertsDuringTheDisputeWindow() public {
        _settle(promoId, true);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Settled));
        vault.payoutBatch(promoId, 50);
    }

    function test_payoutBatch_revertsWhileVetoed() public {
        _settle(promoId, true);
        vault.veto(promoId);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Vetoed));
        vault.payoutBatch(promoId, 50);
    }

    function test_payoutBatch_revertsWhenTheOutcomeWasNo() public {
        _settleAndFinalize(promoId, false);
        vm.expectRevert(
            abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.FinalizedNo)
        );
        vault.payoutBatch(promoId, 50);
        assertEq(usdc.balanceOf(customers[0]), 0);
    }

    function test_payoutBatch_revertsWhenVoided() public {
        vm.warp(uint256(vault.getPromo(promoId).marketCloseTime) + vault.voidGrace() + 1);
        vault.voidPromo(promoId);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Voided));
        vault.payoutBatch(promoId, 50);
    }

    function test_payoutBatch_revertsOnceEveryoneIsPaid() public {
        _settleAndFinalize(promoId, true);
        vault.payoutBatch(promoId, 50);

        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.PaidOut));
        vault.payoutBatch(promoId, 50);
        assertEq(usdc.balanceOf(customers[0]), PAYOUT);
    }

    /// SPEC invariant: a full promo pays exactly payoutPerClaim * maxClaims and not a unit more.
    function test_payoutBatch_aFullPromoPaysExactlyTheMaxPayout() public {
        address[] memory more = _claimMany(promoId, 7);
        _settleAndFinalize(promoId, true);
        uint256 balanceBefore = usdc.balanceOf(address(vault));

        vault.payoutBatch(promoId, 50);

        assertEq(balanceBefore - usdc.balanceOf(address(vault)), MAX_PAYOUT);
        assertEq(usdc.balanceOf(more[6]), PAYOUT);
        assertEq(vault.lockedCollateral(), 0);
        // What is left is the LPs' money plus the premium, less what the vault lost on this promo.
        assertEq(vault.freeBalance(), LIQUIDITY + PREMIUM - MAX_PAYOUT);
    }

    /// F11, end to end: the only LP leaves while the promo is open, the result is "yes", and
    /// every customer is still paid in full.
    function test_payoutBatch_paysInFullAfterEveryLpHasLeft() public {
        _claimMany(promoId, 7);
        uint256 aliceShares = vault.shares(alice);
        vm.prank(alice);
        vault.withdraw(aliceShares);

        _settleAndFinalize(promoId, true);
        vault.payoutBatch(promoId, 50);

        address[] memory all = vault.getClaimants(promoId);
        assertEq(all.length, 10);
        for (uint256 i = 0; i < all.length; i++) {
            assertEq(usdc.balanceOf(all[i]), PAYOUT);
        }
        _assertStatus(promoId, PromoVault.Status.PaidOut);
    }

    /// Hedge mode: the merchant is the one claimant, so the payout goes to the merchant.
    function test_payoutBatch_hedgeMode_paysTheMerchant() public {
        PromoVault.Quote memory q = _quote(500 * USDC, 1, 205 * USDC);
        q.hedgeMode = true;
        uint256 hedge = _create(q);

        _settleAndFinalize(hedge, true);
        vm.expectEmit(address(vault));
        emit Paid(hedge, merchant, 500 * USDC);
        vault.payoutBatch(hedge, 50);

        assertEq(usdc.balanceOf(merchant), 500 * USDC);
        _assertStatus(hedge, PromoVault.Status.PaidOut);
    }

    /// Two promos on the same game: one pays, and its payouts leave the other lock alone.
    function test_payoutBatch_leavesOtherPromosLocked() public {
        uint256 other = _createPromo(50 * USDC, 4, 90 * USDC);
        _claimMany(other, 2);

        _settleAndFinalize(promoId, true);
        vault.payoutBatch(promoId, 50);

        assertEq(vault.lockedCollateral(), 200 * USDC);
        assertEq(vault.getPromo(other).collateralLocked, 200 * USDC);
        assertGe(usdc.balanceOf(address(vault)), 200 * USDC);
    }

    /// The SPEC worked example at full size: 200 customers at $20, paid in the batches of 50
    /// the keeper uses.
    function test_payoutBatch_twoHundredCustomersInBatchesOfFifty() public {
        _deposit(bob, 20_000 * USDC);
        uint256 big = _createPromo(20 * USDC, 200, 1_638 * USDC);
        address[] memory crowd = _claimMany(big, 200);
        _settleAndFinalize(big, true);

        for (uint256 batch = 1; batch <= 4; batch++) {
            assertEq(vault.payoutBatch(big, 50), 50);
            assertEq(vault.getPromo(big).paidCount, batch * 50);
        }

        _assertStatus(big, PromoVault.Status.PaidOut);
        assertEq(usdc.balanceOf(crowd[0]), 20 * USDC);
        assertEq(usdc.balanceOf(crowd[199]), 20 * USDC);
        assertEq(vault.getPromo(big).collateralLocked, 0);
    }

    function testFuzz_payoutBatch_paysEachCustomerExactlyOnce(
        uint8 claims,
        uint8 firstBatch,
        uint8 secondBatch
    ) public {
        uint256 extra = bound(claims, 0, 7);
        _claimMany(promoId, extra);
        uint256 total = 3 + extra;
        _settleAndFinalize(promoId, true);
        uint256 balanceBefore = usdc.balanceOf(address(vault));

        uint256 paid = vault.payoutBatch(promoId, uint32(bound(firstBatch, 1, 20)));
        if (paid < total) paid += vault.payoutBatch(promoId, uint32(bound(secondBatch, 1, 20)));
        if (paid < total) paid += vault.payoutBatch(promoId, 50);

        assertEq(paid, total);
        assertEq(balanceBefore - usdc.balanceOf(address(vault)), total * PAYOUT);
        assertLe(total * PAYOUT, MAX_PAYOUT);
        address[] memory all = vault.getClaimants(promoId);
        for (uint256 i = 0; i < all.length; i++) {
            assertEq(usdc.balanceOf(all[i]), PAYOUT);
        }
        assertEq(vault.lockedCollateral(), 0);
        _assertStatus(promoId, PromoVault.Status.PaidOut);
    }
}
