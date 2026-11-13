// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PromoVault} from "../src/PromoVault.sol";
import {VaultTest} from "./VaultTest.sol";

/// @dev One promo: 10 customers at $20, premium $80, three claims registered.
abstract contract SettlementBase is VaultTest {
    uint256 internal constant PAYOUT = 20 * USDC;
    uint32 internal constant MAX_CLAIMS = 10;
    uint256 internal constant PREMIUM = 80 * USDC;
    uint256 internal constant MAX_PAYOUT = 200 * USDC;
    uint256 internal constant LIQUIDITY = 10_000 * USDC;

    uint256 internal promoId;
    uint64 internal claimDeadline;
    address[] internal customers;

    function setUp() public virtual override {
        super.setUp();
        _deposit(alice, LIQUIDITY);
        promoId = _createPromo(PAYOUT, MAX_CLAIMS, PREMIUM);
        claimDeadline = vault.getPromo(promoId).claimDeadline;
        customers = _claimMany(promoId, 3);
    }

    function _status(uint256 id) internal view returns (PromoVault.Status) {
        return vault.getPromo(id).status;
    }

    function _assertStatus(uint256 id, PromoVault.Status expected) internal view {
        assertEq(uint8(_status(id)), uint8(expected));
    }
}

contract SettleTest is SettlementBase {
    function test_settle_storesTheOutcomeAndStartsTheWindow() public {
        vm.warp(claimDeadline + 3 hours);
        vm.prank(oracle);
        vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");

        PromoVault.Promo memory p = vault.getPromo(promoId);
        assertTrue(p.outcomeYes);
        assertEq(p.settledAt, claimDeadline + 3 hours);
        _assertStatus(promoId, PromoVault.Status.Settled);
    }

    function test_settle_storesANoOutcome() public {
        _settle(promoId, false);

        assertFalse(vault.getPromo(promoId).outcomeYes);
        _assertStatus(promoId, PromoVault.Status.Settled);
    }

    /// The plain strings are in the event so the result can be checked against Gemini.
    function test_settle_emitsSettledWithThePlainStrings() public {
        vm.warp(claimDeadline);
        vm.expectEmit(address(vault));
        emit Settled(promoId, true, "362998", "yes", claimDeadline);
        vm.prank(oracle);
        vault.settle(promoId, true, "362998", "yes");
    }

    /// Settling moves no money and releases nothing; that waits for finalize.
    function test_settle_doesNotChangeTheLock() public {
        _settle(promoId, false);

        assertEq(vault.lockedCollateral(), MAX_PAYOUT);
        assertEq(vault.getPromo(promoId).collateralLocked, MAX_PAYOUT);
        assertEq(usdc.balanceOf(address(vault)), LIQUIDITY + PREMIUM);
    }

    function test_settle_revertsForEveryCallerButTheOracle() public {
        vm.warp(claimDeadline);
        address[5] memory callers = [address(this), merchant, relayer, pricer, alice];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PromoVault.NotOracle.selector);
            vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");
        }
    }

    function test_settle_followsTheOracleWhenItIsReplaced() public {
        vm.warp(claimDeadline);
        vault.setOracle(bob);

        vm.prank(oracle);
        vm.expectRevert(PromoVault.NotOracle.selector);
        vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");

        vm.prank(bob);
        vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");
    }

    function test_settle_revertsOneSecondBeforeTheClaimDeadline() public {
        vm.warp(claimDeadline - 1);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsStillOpen.selector, claimDeadline));
        vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");
    }

    function test_settle_worksAtTheClaimDeadline() public {
        vm.warp(claimDeadline);
        vm.prank(oracle);
        vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");
    }

    /// At every moment exactly one of the two is possible: a new claim, or a settlement.
    function testFuzz_claimsAndSettlementNeverOverlap(uint64 time) public {
        time = uint64(bound(time, block.timestamp, uint256(claimDeadline) + 30 days));
        vm.warp(time);

        if (time < claimDeadline) {
            vm.prank(oracle);
            vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsStillOpen.selector, claimDeadline));
            vault.settle(promoId, true, EVENT_ID_PLAIN, "yes");
            _claim(promoId, bob);
        } else {
            vm.prank(relayer);
            vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsClosed.selector, claimDeadline));
            vault.registerClaim(promoId, bob);
            _settle(promoId, true);
        }
    }

    function test_settle_revertsWhenTheEventIdIsNotThePromosEvent() public {
        vm.warp(claimDeadline);
        vm.prank(oracle);
        vm.expectRevert(PromoVault.EventIdMismatch.selector);
        vault.settle(promoId, true, "362999", "yes");
    }

    function test_settle_revertsWhenAlreadySettled() public {
        _settle(promoId, true);

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Settled));
        vault.settle(promoId, false, EVENT_ID_PLAIN, "no");
    }

    function test_settle_revertsForAnUnknownPromo() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 9));
        vault.settle(9, true, EVENT_ID_PLAIN, "yes");
    }

    function test_settle_worksWhilePaused() public {
        vault.pause();
        _settle(promoId, true);
        _assertStatus(promoId, PromoVault.Status.Settled);
    }

    function test_registerClaim_revertsOnceSettled() public {
        // A deadline at the market close, settled the moment it passes: still no late claim.
        _settle(promoId, true);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Settled));
        vault.registerClaim(promoId, bob);
    }
}

contract VetoTest is SettlementBase {
    uint64 internal settledAt;

    function setUp() public override {
        super.setUp();
        _settle(promoId, true);
        settledAt = vault.getPromo(promoId).settledAt;
    }

    function test_veto_marksThePromoVetoedAndKeepsTheLock() public {
        vm.expectEmit(address(vault));
        emit Vetoed(promoId);
        vault.veto(promoId);

        _assertStatus(promoId, PromoVault.Status.Vetoed);
        assertEq(vault.lockedCollateral(), MAX_PAYOUT);
        assertEq(vault.getPromo(promoId).collateralLocked, MAX_PAYOUT);
    }

    function test_veto_worksInTheLastSecondOfTheWindow() public {
        vm.warp(settledAt + vault.disputeWindow() - 1);
        vault.veto(promoId);
    }

    function test_veto_revertsOnceTheWindowHasEnded() public {
        uint256 windowEnd = settledAt + vault.disputeWindow();
        vm.warp(windowEnd);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.DisputeWindowOver.selector, windowEnd));
        vault.veto(promoId);
    }

    function test_veto_revertsForNonOwner() public {
        address[4] memory callers = [oracle, merchant, relayer, alice];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PromoVault.NotOwner.selector);
            vault.veto(promoId);
        }
    }

    function test_veto_revertsUnlessSettled() public {
        uint256 open = _createPromo(PAYOUT, MAX_CLAIMS, PREMIUM);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Open));
        vault.veto(open);

        vault.veto(promoId);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Vetoed));
        vault.veto(promoId);
    }

    function test_veto_revertsForAnUnknownPromo() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 9));
        vault.veto(9);
    }

    function test_veto_worksWhilePaused() public {
        vault.pause();
        vault.veto(promoId);
        _assertStatus(promoId, PromoVault.Status.Vetoed);
    }

    /// A vetoed result cannot be posted over: the owner has to reset it first.
    function test_settle_revertsWhileVetoed() public {
        vault.veto(promoId);

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Vetoed));
        vault.settle(promoId, false, EVENT_ID_PLAIN, "no");
    }

    function test_resetSettlement_reopensThePromoForTheOracle() public {
        vault.veto(promoId);

        vm.expectEmit(address(vault));
        emit SettlementReset(promoId);
        vault.resetSettlement(promoId);

        PromoVault.Promo memory p = vault.getPromo(promoId);
        _assertStatus(promoId, PromoVault.Status.Open);
        assertFalse(p.outcomeYes);
        assertEq(p.settledAt, 0);
        assertEq(p.collateralLocked, MAX_PAYOUT);
        assertEq(p.claimCount, 3);
        assertEq(vault.lockedCollateral(), MAX_PAYOUT);
    }

    /// The whole dispute path: wrong result, veto, reset, the right result, a new window.
    function test_resetSettlement_thenTheOracleSettlesAgainWithANewWindow() public {
        vault.veto(promoId);
        vault.resetSettlement(promoId);

        vm.warp(block.timestamp + 2 hours);
        _settle(promoId, false);

        PromoVault.Promo memory p = vault.getPromo(promoId);
        _assertStatus(promoId, PromoVault.Status.Settled);
        assertFalse(p.outcomeYes);
        assertEq(p.settledAt, block.timestamp);
        // The new result can be vetoed too.
        vault.veto(promoId);
    }

    /// Resetting does not reopen claims: the deadline has passed.
    function test_resetSettlement_doesNotReopenClaims() public {
        vault.veto(promoId);
        vault.resetSettlement(promoId);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsClosed.selector, claimDeadline));
        vault.registerClaim(promoId, bob);
    }

    function test_resetSettlement_revertsUnlessVetoed() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.Settled));
        vault.resetSettlement(promoId);
    }

    function test_resetSettlement_revertsForNonOwner() public {
        vault.veto(promoId);
        vm.prank(oracle);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.resetSettlement(promoId);
    }
}
