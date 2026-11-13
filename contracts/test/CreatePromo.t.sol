// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PromoVault} from "../src/PromoVault.sol";
import {VaultTest} from "./VaultTest.sol";

contract CreatePromoTest is VaultTest {
    // SPEC section 2, the worked example: Lions to win at an ask of 0.39, $20 a customer, 200
    // customers. Max payout $4,000, premium $1,638, vault risk $2,362: exactly 20% of $11,810.
    uint256 internal constant PAYOUT = 20 * USDC;
    uint32 internal constant MAX_CLAIMS = 200;
    uint256 internal constant PREMIUM = 1_638 * USDC;
    uint256 internal constant MAX_PAYOUT = 4_000 * USDC;
    uint256 internal constant LIQUIDITY = 11_810 * USDC;

    function setUp() public override {
        super.setUp();
        _deposit(alice, LIQUIDITY);
    }

    function _expectRevertOnCreate(PromoVault.Quote memory q, bytes memory sig, bytes memory err) internal {
        vm.prank(q.merchant);
        vm.expectRevert(err);
        vault.createPromo(q, sig);
    }

    // ------------------------------------------------------------ the happy path

    function test_createPromo_storesThePromo() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);

        uint256 promoId = _create(q);

        assertEq(promoId, 0);
        assertEq(vault.promoCount(), 1);
        PromoVault.Promo memory p = vault.getPromo(promoId);
        assertEq(p.merchant, merchant);
        assertEq(p.claimSigner, relayer);
        assertEq(p.geminiEventId, EVENT_ID);
        assertEq(p.instrumentSymbol, SYMBOL);
        assertEq(p.payoutPerClaim, PAYOUT);
        assertEq(p.maxClaims, MAX_CLAIMS);
        assertEq(p.claimCount, 0);
        assertEq(p.premiumPaid, PREMIUM);
        assertEq(p.collateralLocked, MAX_PAYOUT);
        assertEq(p.claimDeadline, q.claimDeadline);
        assertEq(p.marketCloseTime, q.marketCloseTime);
        assertEq(p.settledAt, 0);
        assertEq(uint8(p.status), uint8(PromoVault.Status.Open));
        assertFalse(p.outcomeYes);
        assertEq(p.paidCount, 0);
        assertFalse(p.hedgeMode);
        assertEq(vault.getClaimants(promoId).length, 0);
    }

    /// F11: the lock is the whole payout, premium included.
    function test_createPromo_pullsThePremiumAndLocksTheFullPayout() public {
        _createPromo(PAYOUT, MAX_CLAIMS, PREMIUM);

        assertEq(usdc.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(address(vault)), LIQUIDITY + PREMIUM);
        assertEq(vault.lockedCollateral(), MAX_PAYOUT);
        assertEq(vault.freeBalance(), LIQUIDITY + PREMIUM - MAX_PAYOUT);
    }

    function test_createPromo_emitsPromoCreated() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vm.expectEmit(address(vault));
        emit PromoCreated(0, merchant, SYMBOL, q);
        vm.prank(merchant);
        vault.createPromo(q, sig);
    }

    function test_createPromo_numbersPromosInOrder() public {
        assertEq(_createPromo(PAYOUT, 10, 80 * USDC), 0);
        assertEq(_createPromo(PAYOUT, 10, 80 * USDC), 1);
        assertEq(vault.promoCount(), 2);
        assertEq(vault.lockedCollateral(), 400 * USDC);
    }

    // ------------------------------------------------------------ the quote

    function test_quoteDigest_matchesTheTypedDataHash() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        assertEq(vault.quoteDigest(q), _digest(q));
        assertEq(vault.QUOTE_TYPEHASH(), QUOTE_TYPEHASH);
    }

    function testFuzz_quoteDigest_matchesTheTypedDataHash(PromoVault.Quote memory q) public view {
        assertEq(vault.quoteDigest(q), _digest(q));
    }

    function test_createPromo_revertsWhenCallerIsNotTheQuoteMerchant() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vm.prank(bob);
        vm.expectRevert(PromoVault.NotQuoteMerchant.selector);
        vault.createPromo(q, sig);
    }

    function test_createPromo_revertsAtExpiry() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vm.warp(q.expiry);
        _expectRevertOnCreate(q, sig, abi.encodeWithSelector(PromoVault.QuoteExpired.selector, q.expiry));
    }

    function test_createPromo_worksOneSecondBeforeExpiry() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vm.warp(q.expiry - 1);
        vm.prank(merchant);
        vault.createPromo(q, sig);
    }

    function test_createPromo_revertsWhenTheQuoteIsUsedTwice() public {
        PromoVault.Quote memory q = _quote(PAYOUT, 10, 80 * USDC);
        _create(q);
        assertTrue(vault.usedQuoteNonce(q.nonce));

        _fund(q);
        _expectRevertOnCreate(
            q, _sign(q), abi.encodeWithSelector(PromoVault.QuoteNonceUsed.selector, q.nonce)
        );
    }

    /// The nonce is spent, whatever else the second quote says.
    function test_createPromo_revertsWhenANonceIsReusedOnADifferentQuote() public {
        PromoVault.Quote memory first = _quote(PAYOUT, 10, 80 * USDC);
        _create(first);

        PromoVault.Quote memory second = _quote(PAYOUT, 5, 40 * USDC);
        second.nonce = first.nonce;
        _fund(second);
        _expectRevertOnCreate(
            second, _sign(second), abi.encodeWithSelector(PromoVault.QuoteNonceUsed.selector, first.nonce)
        );
    }

    function test_createPromo_revertsWhenSignedByAnotherKey() public {
        (, uint256 otherPk) = makeAddrAndKey("not the pricer");
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);

        _expectRevertOnCreate(
            q, _signWith(otherPk, q), abi.encodeWithSelector(PromoVault.InvalidQuoteSignature.selector)
        );
    }

    /// The merchant cannot change any term after the pricer has signed.
    function test_createPromo_revertsWhenAnyFieldIsChangedAfterSigning() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);
        bytes memory err = abi.encodeWithSelector(PromoVault.InvalidQuoteSignature.selector);

        PromoVault.Quote memory t = _copy(q);
        t.claimSigner = bob;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.geminiEventId = keccak256("another event");
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.instrumentSymbol = keccak256("another contract");
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.payoutPerClaim = PAYOUT + 1;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.maxClaims = MAX_CLAIMS - 1;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.premium = PREMIUM - 1;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.claimDeadline = q.claimDeadline + 1;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.marketCloseTime = q.marketCloseTime + 1;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.expiry = q.expiry + 1;
        _expectRevertOnCreate(t, sig, err);

        t = _copy(q);
        t.nonce = bytes32(uint256(q.nonce) + 1);
        _expectRevertOnCreate(t, sig, err);

        // And the untouched quote still works.
        vm.prank(merchant);
        vault.createPromo(q, sig);
    }

    /// hedgeMode needs a one-claim quote to get as far as the signature check.
    function test_createPromo_revertsWhenHedgeModeIsChangedAfterSigning() public {
        PromoVault.Quote memory q = _quote(PAYOUT, 1, 8 * USDC);
        _fund(q);
        bytes memory sig = _sign(q);

        q.hedgeMode = true;
        _expectRevertOnCreate(q, sig, abi.encodeWithSelector(PromoVault.InvalidQuoteSignature.selector));
    }

    function test_createPromo_revertsOnAMalformedSignature() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory err = abi.encodeWithSelector(PromoVault.InvalidQuoteSignature.selector);

        _expectRevertOnCreate(q, "", err);
        _expectRevertOnCreate(q, hex"1234", err);
        _expectRevertOnCreate(q, new bytes(65), err);
    }

    /// A quote is bound to one vault on one chain through the EIP-712 domain.
    function test_createPromo_revertsWhenSignedForAnotherChain() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vm.chainId(block.chainid + 1);
        _expectRevertOnCreate(q, sig, abi.encodeWithSelector(PromoVault.InvalidQuoteSignature.selector));
    }

    function test_createPromo_revertsWhenSignedForAnotherVault() public {
        PromoVault other = new PromoVault(usdc, pricer, oracle);
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        bytes memory sig = _sign(q); // signed for `vault`

        vm.prank(merchant);
        vm.expectRevert(PromoVault.InvalidQuoteSignature.selector);
        other.createPromo(q, sig);
    }

    function test_createPromo_revertsAfterThePricerKeyIsReplaced() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vault.setPricer(bob);
        _expectRevertOnCreate(q, sig, abi.encodeWithSelector(PromoVault.InvalidQuoteSignature.selector));
    }

    // ------------------------------------------------------------ the terms

    function test_createPromo_revertsOnZeroPayoutOrZeroClaims() public {
        PromoVault.Quote memory q = _quote(0, MAX_CLAIMS, 0);
        _expectRevertOnCreate(q, _sign(q), abi.encodeWithSelector(PromoVault.ZeroAmount.selector));

        q = _quote(PAYOUT, 0, 0);
        _expectRevertOnCreate(q, _sign(q), abi.encodeWithSelector(PromoVault.ZeroAmount.selector));
    }

    /// Claims must be able to open: a deadline that has already passed is refused.
    function test_createPromo_revertsWhenTheClaimDeadlineHasPassed() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        q.claimDeadline = uint64(block.timestamp);
        _fund(q);

        _expectRevertOnCreate(
            q, _sign(q), abi.encodeWithSelector(PromoVault.ClaimDeadlinePassed.selector, q.claimDeadline)
        );
    }

    function test_createPromo_revertsWhenTheClaimDeadlineIsAfterTheMarketClose() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        q.claimDeadline = q.marketCloseTime + 1;
        _fund(q);

        _expectRevertOnCreate(
            q,
            _sign(q),
            abi.encodeWithSelector(
                PromoVault.ClaimDeadlineAfterClose.selector, q.claimDeadline, q.marketCloseTime
            )
        );
    }

    function test_createPromo_allowsAClaimDeadlineAtTheMarketClose() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        q.claimDeadline = q.marketCloseTime;
        _create(q);
    }

    function test_createPromo_revertsWhenThePremiumIsAboveTheMaxPayout() public {
        PromoVault.Quote memory q = _quote(PAYOUT, 10, 200 * USDC + 1);
        _fund(q);

        _expectRevertOnCreate(
            q,
            _sign(q),
            abi.encodeWithSelector(PromoVault.PremiumAboveMaxPayout.selector, 200 * USDC + 1, 200 * USDC)
        );
    }

    function test_createPromo_revertsWithoutApproval() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        usdc.mint(merchant, PREMIUM);
        bytes memory sig = _sign(q);

        vm.prank(merchant);
        vm.expectRevert();
        vault.createPromo(q, sig);
    }

    function test_createPromo_revertsWhilePaused() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);

        vault.pause();
        _expectRevertOnCreate(q, sig, abi.encodeWithSelector(PromoVault.VaultPaused.selector));

        vault.unpause();
        vm.prank(merchant);
        vault.createPromo(q, sig);
    }

    // ------------------------------------------------------------ the exposure cap

    /// The worked example sits exactly on the 20% cap; one base unit less premium is over it.
    function test_createPromo_revertsOneUnitOverTheExposureCap() public {
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM - 1);
        _fund(q);

        _expectRevertOnCreate(
            q,
            _sign(q),
            abi.encodeWithSelector(PromoVault.ExposureTooHigh.selector, 2_362 * USDC + 1, 2_362 * USDC)
        );
    }

    /// The cap is measured on the free balance, so an open promo lowers it for the next one.
    function test_createPromo_capShrinksAsCollateralIsLocked() public {
        _createPromo(PAYOUT, MAX_CLAIMS, PREMIUM);
        // Free balance is now 11,810 + 1,638 - 4,000 = 9,448, so the cap is 1,889.60.
        uint256 cap = 9_448 * USDC / 5;

        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        _expectRevertOnCreate(
            q, _sign(q), abi.encodeWithSelector(PromoVault.ExposureTooHigh.selector, 2_362 * USDC, cap)
        );

        // 160 customers at the same price per customer fits: 3,200 - 1,310.40 = 1,889.60.
        _createPromo(PAYOUT, 160, 1_310_400_000);
    }

    function test_createPromo_followsTheCapWhenItIsChanged() public {
        vault.setMaxExposureBps(1_000);
        PromoVault.Quote memory q = _quote(PAYOUT, MAX_CLAIMS, PREMIUM);
        _fund(q);
        bytes memory sig = _sign(q);
        _expectRevertOnCreate(
            q, sig, abi.encodeWithSelector(PromoVault.ExposureTooHigh.selector, 2_362 * USDC, 1_181 * USDC)
        );

        vault.setMaxExposureBps(2_000);
        vm.prank(merchant);
        vault.createPromo(q, sig);
    }

    function test_createPromo_revertsOnAnEmptyVault() public {
        uint256 aliceShares = vault.shares(alice);
        vm.prank(alice);
        vault.withdraw(aliceShares);
        assertEq(vault.freeBalance(), 1_000, "only the dead shares are left");

        PromoVault.Quote memory q = _quote(PAYOUT, 10, 80 * USDC);
        _fund(q);
        _expectRevertOnCreate(
            q, _sign(q), abi.encodeWithSelector(PromoVault.ExposureTooHigh.selector, 120 * USDC, 200)
        );
    }

    /// Any quote the cap lets through leaves the vault holding at least what it has locked.
    function testFuzz_createPromo_neverLocksMoreThanTheVaultHolds(
        uint256 payoutPerClaim,
        uint32 maxClaims,
        uint256 premium,
        uint16 capBps
    ) public {
        payoutPerClaim = bound(payoutPerClaim, 1, 1_000 * USDC);
        maxClaims = uint32(bound(maxClaims, 1, 1_000));
        uint256 maxPayout = payoutPerClaim * maxClaims;
        premium = bound(premium, 0, maxPayout);
        capBps = uint16(bound(capBps, 0, 10_000));
        vault.setMaxExposureBps(capBps);

        PromoVault.Quote memory q = _quote(payoutPerClaim, maxClaims, premium);
        _fund(q);
        bytes memory sig = _sign(q);
        uint256 cap = vault.freeBalance() * capBps / 10_000;

        vm.prank(merchant);
        if (maxPayout - premium > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(PromoVault.ExposureTooHigh.selector, maxPayout - premium, cap)
            );
            vault.createPromo(q, sig);
            assertEq(vault.lockedCollateral(), 0);
        } else {
            vault.createPromo(q, sig);
            assertEq(vault.lockedCollateral(), maxPayout);
            assertGe(usdc.balanceOf(address(vault)), maxPayout);
            assertEq(vault.freeBalance(), LIQUIDITY + premium - maxPayout);
        }
    }

    // ------------------------------------------------------------ hedge mode

    function test_createPromo_hedgeMode_registersTheMerchantAsTheOnlyClaimant() public {
        PromoVault.Quote memory q = _quote(500 * USDC, 1, 205 * USDC);
        q.hedgeMode = true;
        _fund(q);
        bytes memory sig = _sign(q);

        vm.expectEmit(address(vault));
        emit PromoCreated(0, merchant, SYMBOL, q);
        vm.expectEmit(address(vault));
        emit ClaimRegistered(0, merchant, 1);
        vm.prank(merchant);
        uint256 promoId = vault.createPromo(q, sig);

        PromoVault.Promo memory p = vault.getPromo(promoId);
        assertTrue(p.hedgeMode);
        assertEq(p.claimCount, 1);
        assertEq(p.maxClaims, 1);
        assertTrue(vault.hasClaim(promoId, merchant));
        address[] memory claimed = vault.getClaimants(promoId);
        assertEq(claimed.length, 1);
        assertEq(claimed[0], merchant);
        assertEq(vault.lockedCollateral(), 500 * USDC);
    }

    function test_createPromo_hedgeMode_revertsUnlessMaxClaimsIsOne() public {
        PromoVault.Quote memory q = _quote(PAYOUT, 2, 16 * USDC);
        q.hedgeMode = true;
        _fund(q);

        _expectRevertOnCreate(q, _sign(q), abi.encodeWithSelector(PromoVault.HedgeNeedsOneClaim.selector, 2));
    }

    // ------------------------------------------------------------ views

    function test_getPromo_revertsForAnUnknownPromo() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.UnknownPromo.selector, 0));
        vault.getPromo(0);
    }

    function _copy(PromoVault.Quote memory q) internal pure returns (PromoVault.Quote memory) {
        return abi.decode(abi.encode(q), (PromoVault.Quote));
    }
}
