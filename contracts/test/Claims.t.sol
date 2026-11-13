// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PromoVault} from "../src/PromoVault.sol";
import {VaultTest} from "./VaultTest.sol";

contract RegisterClaimTest is VaultTest {
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint256 internal promoId;
    uint64 internal claimDeadline;

    function setUp() public override {
        super.setUp();
        _deposit(alice, 10_000 * USDC);
        // Three customers at $20 each.
        promoId = _createPromo(20 * USDC, 3, 24 * USDC);
        claimDeadline = vault.getPromo(promoId).claimDeadline;
    }

    function test_registerClaim_recordsTheCustomer() public {
        vm.prank(relayer);
        vault.registerClaim(promoId, carol);

        assertTrue(vault.hasClaim(promoId, carol));
        assertEq(vault.getPromo(promoId).claimCount, 1);
        assertEq(vault.claimants(promoId, 0), carol);
        assertEq(vault.getClaimants(promoId).length, 1);
    }

    function test_registerClaim_emitsClaimRegisteredWithTheRunningCount() public {
        vm.startPrank(relayer);
        vm.expectEmit(address(vault));
        emit ClaimRegistered(promoId, carol, 1);
        vault.registerClaim(promoId, carol);

        vm.expectEmit(address(vault));
        emit ClaimRegistered(promoId, dave, 2);
        vault.registerClaim(promoId, dave);
        vm.stopPrank();
    }

    function test_registerClaim_keepsRegistrationOrder() public {
        vm.startPrank(relayer);
        vault.registerClaim(promoId, dave);
        vault.registerClaim(promoId, carol);
        vault.registerClaim(promoId, bob);
        vm.stopPrank();

        address[] memory claimed = vault.getClaimants(promoId);
        assertEq(claimed.length, 3);
        assertEq(claimed[0], dave);
        assertEq(claimed[1], carol);
        assertEq(claimed[2], bob);
    }

    /// A claim moves no money: the full payout was locked when the promo was created.
    function test_registerClaim_doesNotChangeTheLock() public {
        uint256 lockedBefore = vault.lockedCollateral();
        uint256 balanceBefore = usdc.balanceOf(address(vault));

        vm.prank(relayer);
        vault.registerClaim(promoId, carol);

        assertEq(vault.lockedCollateral(), lockedBefore);
        assertEq(usdc.balanceOf(address(vault)), balanceBefore);
    }

    /// F17: only the claim signer named in the quote. Not the merchant, not the owner, not the
    /// oracle, not the pricer, not the customer.
    function test_registerClaim_revertsForEveryCallerButTheClaimSigner() public {
        address[6] memory callers = [merchant, address(this), oracle, pricer, carol, alice];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PromoVault.NotClaimSigner.selector);
            vault.registerClaim(promoId, carol);
        }
        assertEq(vault.owner(), address(this));
        assertEq(vault.getPromo(promoId).claimCount, 0);
    }

    function testFuzz_registerClaim_revertsForEveryCallerButTheClaimSigner(address caller) public {
        vm.assume(caller != relayer);
        vm.prank(caller);
        vm.expectRevert(PromoVault.NotClaimSigner.selector);
        vault.registerClaim(promoId, carol);
    }

    /// Each promo has its own claim signer.
    function test_registerClaim_revertsForTheClaimSignerOfAnotherPromo() public {
        PromoVault.Quote memory q = _quote(20 * USDC, 3, 24 * USDC);
        q.claimSigner = dave;
        uint256 other = _create(q);

        vm.prank(relayer);
        vm.expectRevert(PromoVault.NotClaimSigner.selector);
        vault.registerClaim(other, carol);

        vm.prank(dave);
        vault.registerClaim(other, carol);
    }

    function test_registerClaim_revertsForAnUnknownPromo() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 7));
        vault.registerClaim(7, carol);
    }

    function test_registerClaim_revertsAtTheClaimDeadline() public {
        vm.warp(claimDeadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsClosed.selector, claimDeadline));
        vault.registerClaim(promoId, carol);
    }

    function test_registerClaim_worksOneSecondBeforeTheClaimDeadline() public {
        vm.warp(claimDeadline - 1);
        vm.prank(relayer);
        vault.registerClaim(promoId, carol);
    }

    function testFuzz_registerClaim_revertsAtOrAfterTheClaimDeadline(uint64 time) public {
        time = uint64(bound(time, claimDeadline, type(uint64).max));
        vm.warp(time);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsClosed.selector, claimDeadline));
        vault.registerClaim(promoId, carol);
    }

    function test_registerClaim_revertsWhenThePromoIsFull() public {
        vm.startPrank(relayer);
        vault.registerClaim(promoId, carol);
        vault.registerClaim(promoId, dave);
        vault.registerClaim(promoId, bob);

        vm.expectRevert(abi.encodeWithSelector(PromoVault.PromoFull.selector, 3));
        vault.registerClaim(promoId, alice);
        vm.stopPrank();
    }

    function test_registerClaim_revertsOnASecondClaimByTheSameCustomer() public {
        vm.startPrank(relayer);
        vault.registerClaim(promoId, carol);

        vm.expectRevert(abi.encodeWithSelector(PromoVault.AlreadyClaimed.selector, carol));
        vault.registerClaim(promoId, carol);
        vm.stopPrank();
    }

    /// One claim per promo, not one claim ever.
    function test_registerClaim_allowsTheSameCustomerOnAnotherPromo() public {
        uint256 other = _createPromo(20 * USDC, 3, 24 * USDC);

        vm.startPrank(relayer);
        vault.registerClaim(promoId, carol);
        vault.registerClaim(other, carol);
        vm.stopPrank();

        assertTrue(vault.hasClaim(promoId, carol));
        assertTrue(vault.hasClaim(other, carol));
    }

    /// A payout to the zero address would revert and block everyone queued behind it.
    function test_registerClaim_revertsOnTheZeroAddress() public {
        vm.prank(relayer);
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        vault.registerClaim(promoId, address(0));
    }

    /// v2: a pause does not block claims. The promo locked every payout when it was created, so a
    /// claim takes no new risk; blocking it would only take away what the merchant paid for.
    function test_registerClaim_worksWhilePaused() public {
        uint256 lockedBefore = vault.lockedCollateral();
        uint256 balanceBefore = usdc.balanceOf(address(vault));
        vault.pause();

        vm.expectEmit(address(vault));
        emit ClaimRegistered(promoId, carol, 1);
        vm.prank(relayer);
        vault.registerClaim(promoId, carol);

        assertTrue(vault.paused());
        assertTrue(vault.hasClaim(promoId, carol));
        assertEq(vault.getPromo(promoId).claimCount, 1);
        assertEq(vault.claimants(promoId, 0), carol);
        assertEq(vault.lockedCollateral(), lockedBefore);
        assertEq(usdc.balanceOf(address(vault)), balanceBefore);

        // And on through an unpause, the count running on.
        vault.unpause();
        vm.expectEmit(address(vault));
        emit ClaimRegistered(promoId, dave, 2);
        vm.prank(relayer);
        vault.registerClaim(promoId, dave);
    }

    /// Hedge mode takes its one claim at creation, so nobody can register another.
    function test_registerClaim_hedgeMode_alwaysReverts() public {
        PromoVault.Quote memory q = _quote(500 * USDC, 1, 205 * USDC);
        q.hedgeMode = true;
        uint256 hedge = _create(q);

        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.PromoFull.selector, 1));
        vault.registerClaim(hedge, carol);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.PromoFull.selector, 1));
        vault.registerClaim(hedge, merchant);
        vm.stopPrank();
    }
}

/// v2: every claim rule still holds while the vault is paused. Only the pause check is gone.
contract RegisterClaimWhilePausedTest is VaultTest {
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint256 internal promoId;
    uint256 internal hedge;
    uint64 internal claimDeadline;

    function setUp() public override {
        super.setUp();
        _deposit(alice, 10_000 * USDC);
        promoId = _createPromo(20 * USDC, 3, 24 * USDC);
        PromoVault.Quote memory q = _quote(500 * USDC, 1, 205 * USDC);
        q.hedgeMode = true;
        hedge = _create(q);
        claimDeadline = vault.getPromo(promoId).claimDeadline;
        vault.pause();
    }

    function test_registerClaim_whilePaused_revertsForEveryCallerButTheClaimSigner() public {
        address[6] memory callers = [merchant, address(this), oracle, pricer, carol, alice];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PromoVault.NotClaimSigner.selector);
            vault.registerClaim(promoId, carol);
        }
        assertEq(vault.getPromo(promoId).claimCount, 0);

        vm.prank(relayer);
        vault.registerClaim(promoId, carol);
    }

    function testFuzz_registerClaim_whilePaused_revertsForEveryCallerButTheClaimSigner(address caller)
        public
    {
        vm.assume(caller != relayer);
        vm.prank(caller);
        vm.expectRevert(PromoVault.NotClaimSigner.selector);
        vault.registerClaim(promoId, carol);
    }

    function test_registerClaim_whilePaused_revertsAtTheClaimDeadline() public {
        vm.warp(claimDeadline - 1);
        vm.prank(relayer);
        vault.registerClaim(promoId, carol);

        vm.warp(claimDeadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsClosed.selector, claimDeadline));
        vault.registerClaim(promoId, dave);
    }

    function test_registerClaim_whilePaused_revertsWhenThePromoIsFull() public {
        vm.startPrank(relayer);
        vault.registerClaim(promoId, carol);
        vault.registerClaim(promoId, dave);
        vault.registerClaim(promoId, bob);

        vm.expectRevert(abi.encodeWithSelector(PromoVault.PromoFull.selector, 3));
        vault.registerClaim(promoId, alice);
        vm.stopPrank();
    }

    function test_registerClaim_whilePaused_revertsOnASecondClaimByTheSameCustomer() public {
        vm.startPrank(relayer);
        vault.registerClaim(promoId, carol);

        vm.expectRevert(abi.encodeWithSelector(PromoVault.AlreadyClaimed.selector, carol));
        vault.registerClaim(promoId, carol);
        vm.stopPrank();
    }

    function test_registerClaim_whilePaused_revertsOnTheZeroAddress() public {
        vm.prank(relayer);
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        vault.registerClaim(promoId, address(0));
    }

    function test_registerClaim_whilePaused_revertsOnceSettled() public {
        _settle(promoId, true);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Settled));
        vault.registerClaim(promoId, carol);
    }

    function test_registerClaim_whilePaused_revertsForAnUnknownPromo() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 7));
        vault.registerClaim(7, carol);
    }

    function test_registerClaim_whilePaused_hedgeMode_stillReverts() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.PromoFull.selector, 1));
        vault.registerClaim(hedge, carol);
    }
}
