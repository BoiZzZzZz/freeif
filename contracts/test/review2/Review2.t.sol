// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdError} from "forge-std/StdError.sol";
import {PromoVault} from "../../src/PromoVault.sol";
import {VaultTest} from "../VaultTest.sol";

/// Second review (Nov 13), before the contract freeze. Tests named `test_finding_...` pass while
/// showing an outcome the report calls a finding. Tests named `test_note_...` pass while showing
/// behavior that is by design but worth knowing. Every other test pins down something the review
/// checked and found sound.

/// @dev The deployed vault as it stood on Nov 13 (read at block 72223619): 65.582447 USDC held,
///      26 locked by three open promos (16 + 8 + 2), 39.582447 free, exactly 50,000,000 shares,
///      dispute window 30 seconds, void grace 60 seconds, exposure cap 20%.
abstract contract DeployedShape is VaultTest {
    address internal deployer = makeAddr("deployer");
    uint256 internal constant FREE = 39_582_447;

    uint256 internal game2; // promo 9: two customers at $8, premium $7.06, a game
    uint256 internal game1; // promo 16: one customer at $8, premium $3.62, the same game
    uint256 internal cover; // promo 21: a cover of $2, premium $0.80, a temperature market

    function setUp() public virtual override {
        super.setUp();
        vault.setDisputeWindow(30);
        vault.setVoidGrace(60);
        _deposit(deployer, 50 * USDC);
        // What the nineteen finished promos left in the vault.
        usdc.mint(address(vault), 4_102_447);

        game2 = _createPromo(8 * USDC, 2, 7_060_000);
        game1 = _createPromo(8 * USDC, 1, 3_620_000);
        cover = _create(_coverQuote(merchant, 2 * USDC, 800_000));

        assertEq(usdc.balanceOf(address(vault)), 65_582_447);
        assertEq(vault.lockedCollateral(), 26 * USDC);
        assertEq(vault.freeBalance(), FREE);
        assertEq(vault.totalShares(), 50_000_000);
    }

    /// @dev A cover as the pricing service signs one for a temperature market: one claim, the
    ///      business is the payee, sold until the day begins, 24 hours before the market closes.
    function _coverQuote(address business, uint256 payout, uint256 premium)
        internal
        returns (PromoVault.Quote memory q)
    {
        q = _quote(payout, 1, premium);
        q.merchant = business;
        q.hedgeMode = true;
        q.marketCloseTime = q.claimDeadline + 24 hours;
    }

    function _withdrawable(address lp) internal view returns (uint256) {
        return vault.shares(lp) * vault.freeBalance() / vault.totalShares();
    }
}

contract Review2FindingsTest is DeployedShape {
    /// FINDING 1 (the pricing service's rule, not a contract bug). A quote is good for 90 seconds
    /// and the vault honors it at the signed price whatever the market did meanwhile. On a market
    /// that is in play that is a free option. `pricer.ts` sells a 5 or 15-minute crypto window (and
    /// any event with no start time that is not a daily high) until 60 seconds before it closes,
    /// to anyone, with `hedgeMode` from the request body, so the buyer needs no customer and no
    /// login: ask for a quote at close - 150 s, watch the price for 89 seconds, and use the quote
    /// only if the window is now going your way.
    ///
    /// The numbers are the deployed vault's. Ask 0.50, premium = payout * 0.50 * 1.05 rounded up
    /// to a cent. The service signs up to risk <= 18% of the free balance (90% of the 20% cap):
    /// payout $14.99, premium $7.87, risk $7.12 against a limit of $7.1248.
    function test_finding_keeper_aQuoteOnARunningWindowIsAFreeOption() public {
        (address mallory,) = makeAddrAndKey("mallory");
        uint256 t0 = block.timestamp;

        PromoVault.Quote memory q = _coverQuote(mallory, 14_990_000, 7_870_000);
        q.marketCloseTime = uint64(t0 + 150); // the window closes in two and a half minutes
        q.claimDeadline = uint64(t0 + 90); // pricer.ts: close - INTERVAL_CUTOFF_SECONDS (60)
        q.expiry = uint64(t0 + 90); // pricer.ts: now + QUOTE_TTL_SECONDS (90)
        bytes memory sig = _sign(q);
        assertLe(q.payoutPerClaim - q.premium, FREE * 1800 / 10_000, "the service would not sign this size");

        uint256 lpBefore = _withdrawable(deployer);
        assertEq(lpBefore, 39_581_655);

        // Branch A: the window went against the buyer. The quote is dropped. It cost nothing.
        uint256 snapshot = vm.snapshotState();
        vm.warp(t0 + 200);
        assertEq(usdc.balanceOf(mallory), 0);
        assertEq(_withdrawable(deployer), lpBefore);
        vm.revertToState(snapshot);

        // Branch B: 89 seconds later the window is going the buyer's way (say 80%). The quote
        // still buys at 50%.
        vm.warp(t0 + 89);
        usdc.mint(mallory, q.premium);
        vm.startPrank(mallory);
        usdc.approve(address(vault), q.premium);
        uint256 id = vault.createPromo(q, sig);
        vm.stopPrank();

        vm.warp(q.marketCloseTime + 10);
        vm.prank(oracle);
        vault.settle(id, true, EVENT_ID_PLAIN, "yes");
        vm.warp(block.timestamp + 30);
        vault.finalize(id);
        vault.payoutBatch(id, 50);

        assertEq(usdc.balanceOf(mallory), 14_990_000, "paid $14.99 for $7.87");
        assertEq(vault.freeBalance(), FREE - 7_120_000);
        assertEq(lpBefore - _withdrawable(deployer), 7_119_858, "the LPs are down 18% of what was free");

        // If the window ends "yes" 80% of the times the buyer uses the quote, and the buyer uses
        // it half the time, each try is worth about 0.5 * (0.80 * 14.99 - 7.87) = $2.06 to the
        // buyer, about 5% of the free balance, every five minutes, at no cost when they pass.
        emit log_named_decimal_uint(
            "LP loss when the option is used, USDC", lpBefore - _withdrawable(deployer), 6
        );
    }

    /// FINDING 2 (low; a confirmed pick, shown here with its cost). Pause blocks `registerClaim`.
    /// A promo's whole payout is locked when it is created, so a claim adds no risk the vault did
    /// not already take; blocking it only takes away what the merchant paid for. A pause that
    /// covers the end of a claim window leaves the merchant with no customers, the result is
    /// posted as usual, and the premium goes to the LPs. Nothing in the contract gives it back:
    /// `voidPromo` needs an Open or Vetoed promo and the grace period after the market closes.
    function test_finding_pauseOverAClaimWindow_theMerchantPaysForCoverNobodyCanTake() public {
        address customer = makeAddr("a customer at the till");
        uint256 lpBefore = _withdrawable(deployer);

        vault.pause(); // the owner stops new risk because of some incident elsewhere
        vm.prank(relayer);
        vm.expectRevert(PromoVault.VaultPaused.selector);
        vault.registerClaim(game1, customer);

        vm.warp(vault.getPromo(game1).claimDeadline); // kickoff, still paused
        vault.unpause();

        // The team wins. The keeper posts the result and finalizes, as it does for every promo.
        vm.prank(oracle);
        vault.settle(game1, true, EVENT_ID_PLAIN, "yes");
        vm.warp(block.timestamp + 30);
        vault.finalize(game1);

        assertEq(uint8(vault.getPromo(game1).status), uint8(PromoVault.Status.PaidOut));
        assertEq(usdc.balanceOf(customer), 0, "the customer bought on a winning night and gets nothing");
        assertEq(usdc.balanceOf(merchant), 0, "the merchant's $3.62 is not returned");
        assertEq(
            _withdrawable(deployer) - lpBefore, 7_999_840, "the LPs keep the whole $8 lock, premium included"
        );

        vm.expectRevert(abi.encodeWithSelector(PromoVault.WrongStatus.selector, PromoVault.Status.PaidOut));
        vault.voidPromo(game1);
    }
}

contract Review2NotesTest is DeployedShape {
    /// The vault checks the event a result is posted for, never the contract inside it. A game has
    /// one contract per team and a temperature market has six ranges, all under one event id, so
    /// for those the chain cannot tell which result the oracle read. `Settled` carries the event
    /// id and "yes" or "no"; the instrument is only in `PromoCreated`, as a hash.
    function test_note_settle_checksTheEventNeverTheInstrument() public {
        PromoVault.Quote memory warm = _coverQuote(merchant, USDC, 400_000);
        warm.instrumentSymbol = keccak256("GEMI-WXHIGH-AUS-2611150459-T66");
        PromoVault.Quote memory hot = _coverQuote(merchant, USDC, 400_000);
        hot.instrumentSymbol = keccak256("GEMI-WXHIGH-AUS-2611150459-B67-69");
        uint256 a = _create(warm);
        uint256 b = _create(hot);

        // Exactly one range can be right. Both "yes" go through with the same event id.
        _settle(a, true);
        _settle(b, true);
        assertTrue(vault.getPromo(a).outcomeYes);
        assertTrue(vault.getPromo(b).outcomeYes);
    }

    /// With the deployed void grace of 60 seconds a cover can be voided one minute after its
    /// market closes. Gemini posted two Austin results six hours after the close. Only the owner
    /// can do it, so this is a setting to put back with the dispute window, not a hole.
    function test_note_deployedVoidGrace_aCoverCanBeVoidedSixHoursBeforeItsResult() public {
        uint64 close = vault.getPromo(cover).marketCloseTime;
        vm.warp(uint256(close) + 61);
        vault.voidPromo(cover);
        assertEq(uint8(vault.getPromo(cover).status), uint8(PromoVault.Status.Voided));
        assertEq(usdc.balanceOf(merchant), 800_000);
    }

    function test_note_defaultVoidGrace_aCoverCannotBeVoidedBeforeItsResult() public {
        vault.setVoidGrace(7 days);
        uint64 close = vault.getPromo(cover).marketCloseTime;
        vm.warp(uint256(close) + 6 hours);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.VoidGraceNotOver.selector, uint256(close) + 7 days));
        vault.voidPromo(cover);
    }

    /// Known limit, with the deployed numbers: when the last LP leaves while promos are pending,
    /// the 1,000 dead shares own the locks. A share is then worth cents, not a millionth of a
    /// dollar, and every later deposit loses up to one share's worth to rounding. It stays small.
    function test_note_afterEveryLpLeft_aDepositLosesLessThanOneSharesWorthToRounding() public {
        vm.prank(deployer);
        uint256 out = vault.withdraw(49_999_000);
        assertEq(out, 39_581_655, "the deployer leaves $26.00 of locks and 792 units behind");
        assertEq(vault.totalShares(), 1_000);
        assertEq(vault.depositBalance(), 26_000_792);

        uint256 minted = _deposit(bob, 10 * USDC);
        assertEq(minted, 384);

        _settleAndFinalize(game2, false);
        _settleAndFinalize(game1, false);
        _settleAndFinalize(cover, false);
        vm.prank(bob);
        uint256 back = vault.withdraw(minted);
        assertEq(back, 9_988_659);
        assertLt(10 * USDC - back, 26_013, "bob lost more than one share was worth");
    }

    /// The dispute window is read when veto and finalize are called. Raising it after a promo's
    /// window has ended, and before anyone finalized, opens the veto again.
    function test_note_raisingTheDisputeWindow_reopensTheVetoOfAPromoNobodyFinalized() public {
        _settle(game1, true);
        vm.warp(block.timestamp + 30);
        // finalize would work now. Instead the owner sets the window back to an hour.
        vault.setDisputeWindow(3600);

        vm.expectRevert();
        vault.finalize(game1);
        vault.veto(game1);
        assertEq(uint8(vault.getPromo(game1).status), uint8(PromoVault.Status.Vetoed));
    }
}

/// A cover through the side paths, on a vault with room.
contract Review2CoverTest is VaultTest {
    uint256 internal constant PAYOUT = 250 * USDC;
    uint256 internal constant PREMIUM = 100 * USDC;

    function setUp() public override {
        super.setUp();
        _deposit(alice, 10_000 * USDC);
    }

    function _cover() internal returns (uint256 id) {
        PromoVault.Quote memory q = _quote(PAYOUT, 1, PREMIUM);
        q.hedgeMode = true;
        q.marketCloseTime = q.claimDeadline + 24 hours;
        id = _createWithPermit(q);
    }

    function _assertNothingLocked() internal view {
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.pendingCollateral(), 0);
        assertEq(vault.totalOwedPayouts(), 0);
    }

    function test_cover_wrongResultVetoedAndPostedAgain_paysTheBusinessOnce() public {
        uint256 id = _cover();
        _settle(id, false);
        vault.veto(id);
        vault.resetSettlement(id);

        // Claims stay closed after a reset, for the relayer and for the business alike.
        vm.prank(relayer);
        vm.expectRevert();
        vault.registerClaim(id, bob);

        _settleAndFinalize(id, true);
        assertEq(vault.payoutBatch(id, 50), 1);
        assertEq(usdc.balanceOf(merchant), PAYOUT);
        _assertNothingLocked();

        vm.expectRevert();
        vault.payoutBatch(id, 1);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.NothingOwed.selector, id, merchant));
        vault.retryPayout(id, merchant);
    }

    function test_cover_vetoedAndVoided_refundsThePremiumAndNothingElse() public {
        uint256 id = _cover();
        _settle(id, true);
        vault.veto(id);
        vm.warp(uint256(vault.getPromo(id).marketCloseTime) + vault.voidGrace() + 1);
        vault.voidPromo(id);

        assertEq(usdc.balanceOf(merchant), PREMIUM);
        assertEq(vault.freeBalance(), 10_000 * USDC);
        _assertNothingLocked();
        vm.expectRevert();
        vault.payoutBatch(id, 1);
    }

    /// The business is also the vault's largest LP, buys a cover and takes all its liquidity out.
    /// The cover still pays in full, and what the business gave up by leaving is its part of the
    /// vault's risk on its own cover: it cannot use the two roles against the other LP.
    function test_cover_theBusinessIsAlsoAnLpAndLeaves_stillPaidInFull_andGainsNothingByIt() public {
        uint256 minted = _deposit(merchant, 30_000 * USDC);
        uint256 id = _cover();

        vm.prank(merchant);
        uint256 out = vault.withdraw(minted);
        assertEq(30_000 * USDC - out, 112_500_000, "it leaves 3/4 of the $150 at risk behind");

        _settleAndFinalize(id, true);
        vault.payoutBatch(id, 1);
        assertEq(usdc.balanceOf(merchant), out + PAYOUT);
        // Alice is down her quarter of the $150 the vault put at risk, no more.
        uint256 held = vault.shares(alice);
        vm.prank(alice);
        uint256 aliceOut = vault.withdraw(held);
        assertApproxEqAbs(10_000 * USDC - aliceOut, 37_500_000, 1_000);
        _assertNothingLocked();
    }

    function test_cover_paidWhilePausedAndWithTheCapSetToZero() public {
        uint256 id = _cover();
        vault.setMaxExposureBps(0);
        vault.pause();
        _settleAndFinalize(id, true);
        vault.payoutBatch(id, 1);
        assertEq(usdc.balanceOf(merchant), PAYOUT);
        _assertNothingLocked();
    }

    function test_cover_blockedBusiness_owedThenRetried_whateverTheLpsDoMeanwhile() public {
        uint256 id = _cover();
        _settleAndFinalize(id, true);
        usdc.setBlocked(merchant, true);
        assertEq(vault.payoutBatch(id, 1), 0);
        assertEq(vault.totalOwedPayouts(), PAYOUT);

        // Every LP leaves and a new one arrives. The owed payout is outside both prices.
        vm.startPrank(alice);
        vault.withdraw(vault.shares(alice));
        vm.stopPrank();
        uint256 minted = _deposit(bob, 500 * USDC);
        vm.prank(bob);
        assertLe(vault.withdraw(minted), 500 * USDC);
        assertGe(usdc.balanceOf(address(vault)), PAYOUT);

        usdc.setBlocked(merchant, false);
        vault.retryPayout(id, merchant);
        assertEq(usdc.balanceOf(merchant), PAYOUT);
        _assertNothingLocked();
    }
}

/// How the quote reaches the contract, below the ABI.
contract Review2EncodingTest is VaultTest {
    function setUp() public override {
        super.setUp();
        _deposit(alice, 10_000 * USDC);
    }

    /// A quote is twelve static fields, read straight from calldata and hashed with abi.encode.
    /// Set bits above a field's type (a uint32 with a 33rd bit, a bool of 2, an address with a
    /// 21st byte) and the call must not go through as some other quote.
    function test_createPromo_dirtyBitsInAnyNarrowField_revert() public {
        PromoVault.Quote memory q = _quote(20 * USDC, 10, 80 * USDC);
        _fund(q);
        bytes memory clean = abi.encodeCall(vault.createPromo, (q, _sign(q)));

        // Word of each field narrower than 32 bytes: merchant, claimSigner, maxClaims,
        // claimDeadline, marketCloseTime, hedgeMode, expiry.
        uint8[7] memory words = [0, 1, 5, 7, 8, 9, 10];
        for (uint256 i = 0; i < words.length; i++) {
            bytes memory dirty = bytes.concat(clean);
            dirty[4 + uint256(words[i]) * 32] = 0x01;
            vm.prank(merchant);
            (bool ok,) = address(vault).call(dirty);
            assertFalse(ok, "a quote with dirty bits went through");

            bytes memory digestCall = abi.encodePacked(vault.quoteDigest.selector, _slice(dirty, 4, 12 * 32));
            (bool digestOk,) = address(vault).staticcall(digestCall);
            assertFalse(digestOk, "quoteDigest hashed a quote with dirty bits");
        }
        assertEq(vault.promoCount(), 0);

        vm.prank(merchant);
        (bool cleanOk,) = address(vault).call(clean);
        assertTrue(cleanOk);
        assertEq(vault.promoCount(), 1);
    }

    function _slice(bytes memory data, uint256 from, uint256 length)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[from + i];
        }
    }

    /// The signature is bound to this chain and this vault through the domain, to one merchant
    /// through the struct, and to one use through the nonce: the same bytes cannot open a second
    /// promo through either function, in either order, for anyone.
    function test_quote_cannotBeReplayedAcrossTheTwoCreateFunctionsOrByAnotherCaller() public {
        PromoVault.Quote memory q = _quote(20 * USDC, 1, 8 * USDC);
        q.hedgeMode = true;
        bytes memory sig = _sign(q);
        uint256 id = _createWithPermit(q);
        assertEq(id, 0);

        _fund(q);
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.QuoteNonceUsed.selector, q.nonce));
        vault.createPromo(q, sig);

        usdc.mint(bob, q.premium);
        vm.startPrank(bob);
        usdc.approve(address(vault), q.premium);
        vm.expectRevert(PromoVault.NotQuoteMerchant.selector);
        vault.createPromo(q, sig);
        vm.stopPrank();

        // The "malleable twin" of the signature (s -> n - s, v flipped) is refused outright.
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        PromoVault.Quote memory q2 = _quote(20 * USDC, 1, 8 * USDC);
        (bytes32 r, bytes32 s, uint8 v) = _split(_sign(q2));
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        _fund(q2);
        vm.prank(merchant);
        vm.expectRevert(PromoVault.InvalidQuoteSignature.selector);
        vault.createPromo(q2, twin);
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    /// The largest numbers the types allow: a uint32 of customers at a payout that makes the
    /// product overflow reverts (checked arithmetic), it does not wrap to a small lock.
    function test_createPromo_payoutTimesClaimsThatOverflows_reverts() public {
        PromoVault.Quote memory q = _quote(type(uint256).max / 2, 3, 0);
        bytes memory sig = _sign(q);
        vm.prank(merchant);
        vm.expectRevert(stdError.arithmeticError);
        vault.createPromo(q, sig);
    }

    /// The times are uint64 in the quote and the promo; the furthest values do not wrap anywhere
    /// they are added to.
    function test_times_atTheTopOfUint64_doNotWrap() public {
        PromoVault.Quote memory q = _quote(20 * USDC, 1, 8 * USDC);
        q.claimDeadline = type(uint64).max;
        q.marketCloseTime = type(uint64).max;
        uint256 id = _create(q);
        vault.setVoidGrace(type(uint32).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                PromoVault.VoidGraceNotOver.selector, uint256(type(uint64).max) + type(uint32).max
            )
        );
        vault.voidPromo(id);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ClaimsStillOpen.selector, type(uint64).max));
        vault.settle(id, true, EVENT_ID_PLAIN, "yes");
    }
}

/// Gas in payoutBatch (SPEC "Known limits": a transfer that runs out of gas would be recorded as
/// owed, if the rest of the call could still finish).
contract Review2PayoutGasTest is VaultTest {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        _deposit(alice, 10_000 * USDC);
        id = _createPromo(20 * USDC, 10, 80 * USDC);
        _claimMany(id, 3);
        _settleAndFinalize(id, true);
    }

    /// Whatever gas a caller gives the batch, it either reverts as a whole or pays everyone: no
    /// gas limit makes a healthy customer's payout "owed". Measured on the mock token, cold
    /// storage, one fresh call per run.
    function testFuzz_payoutBatch_noGasLimitTurnsAHealthyPayoutIntoAnOwedOne(uint256 gasLimit) public {
        gasLimit = bound(gasLimit, 25_000, 400_000);
        (bool ok,) = address(vault).call{gas: gasLimit}(abi.encodeCall(vault.payoutBatch, (id, 3)));
        assertEq(vault.totalOwedPayouts(), 0, "a payout became owed for lack of gas");
        if (ok) {
            assertEq(uint8(vault.getPromo(id).status), uint8(PromoVault.Status.PaidOut));
            assertEq(vault.lockedCollateral(), 0);
        } else {
            assertEq(vault.getPromo(id).paidCount, 0);
            assertEq(vault.lockedCollateral(), 60 * USDC);
        }
    }

    /// The same, at every gas limit from 25,000 to 400,000 in steps of 250.
    function test_payoutBatch_everyGasLimit_allOrNothing() public {
        bytes memory data = abi.encodeCall(vault.payoutBatch, (id, 3));
        uint256 least;
        for (uint256 gasLimit = 25_000; gasLimit <= 400_000; gasLimit += 250) {
            uint256 snapshot = vm.snapshotState();
            (bool ok,) = address(vault).call{gas: gasLimit}(data);
            assertEq(vault.totalOwedPayouts(), 0, "a payout became owed for lack of gas");
            if (ok && least == 0) least = gasLimit;
            vm.revertToState(snapshot);
        }
        assertGt(least, 0);
        emit log_named_uint("least gas at which a batch of three went through", least);
    }

    /// The keeper's batch size against a block: 50 payouts in one call, measured on the mock.
    function test_payoutBatch_fiftyCustomers_gas() public {
        uint256 big = _createPromo(1 * USDC, 60, 30 * USDC);
        _claimMany(big, 60);
        _settleAndFinalize(big, true);
        uint256 before = gasleft();
        vault.payoutBatch(big, 50);
        uint256 used = before - gasleft();
        emit log_named_uint("gas for a batch of 50", used);
        assertLt(used, 3_000_000);
    }
}

/// Found by breaking the contract on purpose: with `withdraw` changed to round its payout up, all
/// 215 existing unit tests and the invariant run still pass. The same for a constructor that
/// accepts a zero pricer or a zero oracle. These pin the three down.
contract Review2RoundingTest is VaultTest {
    /// One `new` per test. On this Foundry (1.8.6) a test ends at the first `new` that reverts as
    /// expected (the trace shows `new` run as `VM::deployCode`, and the test returns there), so
    /// the second and third checks of `AdminTest.test_constructor_revertsOnZeroAddress` never run.
    function test_constructor_revertsOnAZeroPricer() public {
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        new PromoVault(usdc, address(0), oracle);
    }

    function test_constructor_revertsOnAZeroOracle() public {
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        new PromoVault(usdc, pricer, address(0));
    }

    function setUp() public override {
        super.setUp();
        _deposit(alice, 1_000 * USDC);
        _deposit(bob, 1_000 * USDC);
    }

    /// One base unit arrives, so a share is worth a hair more than one unit. A single share must
    /// pay 1, not 2.
    function test_withdraw_roundsDown_whenAShareIsWorthAFractionMore() public {
        usdc.mint(address(vault), 1);
        vm.prank(bob);
        assertEq(vault.withdraw(1), 1);
    }

    /// After a loss a share is worth less than one unit. Taking shares out one at a time must not
    /// pay more than taking them out together, or the remainder comes from the LPs who stay.
    function test_withdraw_roundsDown_oneShareAtATimeNeverBeatsOneWithdrawal() public {
        // The vault loses $300 of its $2,000: a $400 cover bought for $100 pays.
        PromoVault.Quote memory q = _quote(400 * USDC, 1, 100 * USDC);
        q.hedgeMode = true;
        uint256 id = _create(q);
        _settleAndFinalize(id, true);
        vault.payoutBatch(id, 1);
        assertEq(vault.freeBalance(), 1_700 * USDC);

        uint256 together = 1_000 * vault.freeBalance() / vault.totalShares();
        assertEq(together, 850);
        uint256 oneByOne;
        vm.startPrank(bob);
        for (uint256 i = 0; i < 1_000; i++) {
            oneByOne += vault.withdraw(1);
        }
        vm.stopPrank();
        assertEq(oneByOne, 0, "a share worth 0.85 of a unit paid a whole unit");
        assertLe(oneByOne, together);
    }
}

