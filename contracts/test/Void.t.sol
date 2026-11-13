// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PromoVault} from "../src/PromoVault.sol";
import {SettlementBase} from "./Settlement.t.sol";

/// F12: a market Gemini voids or never settles. The merchant gets the premium back.
contract VoidPromoTest is SettlementBase {
    uint256 internal voidableAfter;

    function setUp() public override {
        super.setUp();
        voidableAfter = uint256(vault.getPromo(promoId).marketCloseTime) + vault.voidGrace();
    }

    /// SPEC invariant: exactly premiumPaid goes back, and the lock drops by that promo's lock.
    function test_voidPromo_refundsThePremiumAndReleasesTheLock() public {
        uint256 other = _createPromo(50 * USDC, 4, 90 * USDC);
        uint256 lockedBefore = vault.lockedCollateral();
        uint256 balanceBefore = usdc.balanceOf(address(vault));
        vm.warp(voidableAfter + 1);

        vm.expectEmit(address(vault));
        emit Voided(promoId, merchant, PREMIUM);
        vault.voidPromo(promoId);

        _assertStatus(promoId, PromoVault.Status.Voided);
        assertEq(usdc.balanceOf(merchant), PREMIUM, "the merchant gets exactly the premium back");
        assertEq(usdc.balanceOf(address(vault)), balanceBefore - PREMIUM);
        assertEq(vault.lockedCollateral(), lockedBefore - MAX_PAYOUT);
        assertEq(vault.getPromo(promoId).collateralLocked, 0);
        assertEq(vault.getPromo(other).collateralLocked, 200 * USDC, "the other promo is untouched");
    }

    /// A voided promo leaves the LPs exactly where they started.
    function test_voidPromo_leavesTheLpsWhole() public {
        vm.warp(voidableAfter + 1);
        vault.voidPromo(promoId);

        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.freeBalance(), LIQUIDITY);
    }

    function test_voidPromo_revertsUntilTheGraceHasPassed() public {
        vm.warp(voidableAfter);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.VoidGraceNotOver.selector, voidableAfter));
        vault.voidPromo(promoId);

        vm.warp(voidableAfter + 1);
        vault.voidPromo(promoId);
    }

    function test_voidPromo_revertsWhileTheMarketIsStillOpen() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.VoidGraceNotOver.selector, voidableAfter));
        vault.voidPromo(promoId);
    }

    /// The demo sets a short grace period.
    function test_voidPromo_followsTheGraceWhenItIsChanged() public {
        vault.setVoidGrace(600);
        uint256 marketClose = vault.getPromo(promoId).marketCloseTime;

        vm.warp(marketClose + 600);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.VoidGraceNotOver.selector, marketClose + 600));
        vault.voidPromo(promoId);

        vm.warp(marketClose + 601);
        vault.voidPromo(promoId);
    }

    function test_voidPromo_revertsForNonOwner() public {
        vm.warp(voidableAfter + 1);
        address[4] memory callers = [merchant, oracle, relayer, alice];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PromoVault.NotOwner.selector);
            vault.voidPromo(promoId);
        }
    }

    /// The owner vetoed a wrong result and Gemini never posts a right one.
    function test_voidPromo_worksOnAVetoedPromo() public {
        _settle(promoId, true);
        vault.veto(promoId);
        vm.warp(voidableAfter + 1);

        vault.voidPromo(promoId);

        _assertStatus(promoId, PromoVault.Status.Voided);
        assertEq(usdc.balanceOf(merchant), PREMIUM);
        assertEq(vault.lockedCollateral(), 0);
    }

    /// A promo with a standing result cannot be voided out from under its customers or the LPs.
    function test_voidPromo_revertsOnceThereIsAResult() public {
        vm.warp(voidableAfter + 1);
        _settle(promoId, true);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Settled));
        vault.voidPromo(promoId);

        vm.warp(block.timestamp + vault.disputeWindow());
        vault.finalize(promoId);
        vm.expectRevert(
            abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.FinalizedYes)
        );
        vault.voidPromo(promoId);

        uint256 lost = _createPromo(PAYOUT, MAX_CLAIMS, PREMIUM);
        _settleAndFinalize(lost, false);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(
            abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.FinalizedNo)
        );
        vault.voidPromo(lost);
    }

    function test_voidPromo_revertsWhenCalledTwice() public {
        vm.warp(voidableAfter + 1);
        vault.voidPromo(promoId);

        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Voided));
        vault.voidPromo(promoId);
        assertEq(usdc.balanceOf(merchant), PREMIUM, "no second refund");
    }

    function test_voidPromo_revertsForAnUnknownPromo() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 9));
        vault.voidPromo(9);
    }

    function test_voidPromo_worksWhilePaused() public {
        vault.pause();
        vm.warp(voidableAfter + 1);
        vault.voidPromo(promoId);
        assertEq(usdc.balanceOf(merchant), PREMIUM);
    }

    function test_voidPromo_closesThePromoForGood() public {
        vm.warp(voidableAfter + 1);
        vault.voidPromo(promoId);
        bytes memory err = abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Voided);

        vm.prank(oracle);
        vm.expectRevert(err);
        vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");

        vm.prank(relayer);
        vm.expectRevert(err);
        vault.registerClaim(promoId, bob);

        vm.expectRevert(err);
        vault.finalize(promoId);
    }

    function test_voidPromo_hedgeMode_refundsTheMerchant() public {
        PromoVault.Quote memory q = _quote(500 * USDC, 1, 205 * USDC);
        q.hedgeMode = true;
        uint256 hedge = _create(q);

        vm.warp(voidableAfter + 1);
        vault.voidPromo(hedge);

        assertEq(usdc.balanceOf(merchant), 205 * USDC);
        assertEq(vault.lockedCollateral(), MAX_PAYOUT, "only the first promo is still locked");
    }

    /// Even with every LP gone, the vault holds the refund: the premium sits inside the lock.
    function test_voidPromo_refundsAfterEveryLpHasLeft() public {
        uint256 aliceShares = vault.shares(alice);
        vm.prank(alice);
        vault.withdraw(aliceShares);

        vm.warp(voidableAfter + 1);
        vault.voidPromo(promoId);

        assertEq(usdc.balanceOf(merchant), PREMIUM);
        assertGe(usdc.balanceOf(address(vault)), vault.lockedCollateral());
    }

    function testFuzz_voidPromo_returnsExactlyThePremium(
        uint256 payoutPerClaim,
        uint32 maxClaims,
        uint256 premium
    ) public {
        // At most $9,000 locked: the vault has $9,880 free with the base promo open.
        payoutPerClaim = bound(payoutPerClaim, 1, 90 * USDC);
        maxClaims = uint32(bound(maxClaims, 1, 100));
        uint256 maxPayout = payoutPerClaim * maxClaims;
        premium = bound(premium, 0, maxPayout);
        vault.setMaxExposureBps(10_000);
        address other = makeAddr("another merchant");

        PromoVault.Quote memory q = _quote(payoutPerClaim, maxClaims, premium);
        q.merchant = other;
        uint256 id = _create(q);
        uint256 lockedBefore = vault.lockedCollateral();
        uint256 balanceBefore = usdc.balanceOf(address(vault));

        vm.warp(voidableAfter + 1);
        vault.voidPromo(id);

        assertEq(usdc.balanceOf(other), premium);
        assertEq(usdc.balanceOf(address(vault)), balanceBefore - premium);
        assertEq(vault.lockedCollateral(), lockedBefore - maxPayout);
        assertGe(usdc.balanceOf(address(vault)), vault.lockedCollateral());
    }
}
