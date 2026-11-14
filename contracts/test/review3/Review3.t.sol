// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PromoVault} from "../../src/PromoVault.sol";
import {VaultTest} from "../VaultTest.sol";

/// Third review (v2: a pause no longer blocks registerClaim).
contract Review3PauseTest is VaultTest {
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal stranger = makeAddr("stranger");

    uint256 internal game; // $8 for two customers, premium $7.06 (promo 9's shape)
    uint256 internal cover; // hedge mode: the merchant is the one claimant

    function setUp() public override {
        super.setUp();
        _deposit(alice, 1_000 * USDC);
        game = _createPromo(8 * USDC, 2, 7_060_000);
        PromoVault.Quote memory q = _quote(2 * USDC, 1, 800_000);
        q.hedgeMode = true;
        cover = _create(q);
    }

    // ------------------------------------------------------------ the SPEC rule, both ways

    /// SPEC section 1: registerClaim goes through while paused whenever it would go through
    /// unpaused. Checked as a difference: from the same state, the same call made unpaused and
    /// made paused gives the same success, the same revert data and the same books.
    function testFuzz_registerClaim_pausedOrNot_sameResultAndSameBooks(
        uint8 promoPick,
        uint8 callerPick,
        uint8 customerPick,
        uint8 preClaims,
        uint32 warpBy,
        bool settleFirst
    ) public {
        uint256 k = preClaims % 3;
        if (k >= 1) _claim(game, carol);
        if (k >= 2) _claim(game, dave);
        if (settleFirst) _settle(game, preClaims % 2 == 0);
        vm.warp(block.timestamp + bound(warpBy, 0, 3 days));

        uint256[3] memory ids = [game, cover, 7];
        uint256 id = ids[promoPick % 3];
        address[6] memory callers = [relayer, merchant, address(this), oracle, pricer, stranger];
        address caller = callers[callerPick % 6];
        address[5] memory customers = [carol, dave, address(0), merchant, bob];
        address customer = customers[customerPick % 5];
        bytes memory data = abi.encodeCall(vault.registerClaim, (id, customer));

        uint256 snap = vm.snapshotState();
        vm.prank(caller);
        (bool okOpen, bytes memory retOpen) = address(vault).call(data);
        bytes32 booksOpen = _books(id, customer);

        vm.revertToState(snap);
        vault.pause();
        vm.prank(caller);
        (bool okPaused, bytes memory retPaused) = address(vault).call(data);
        bytes32 booksPaused = _books(id, customer);

        assertEq(okPaused, okOpen, "paused and unpaused disagree on success");
        assertEq(retPaused, retOpen, "paused and unpaused revert differently");
        assertEq(booksPaused, booksOpen, "paused and unpaused leave different books");
        assertTrue(vault.paused());
    }

    function _books(uint256 id, address customer) internal view returns (bytes32) {
        bytes memory promo = id < vault.promoCount()
            ? abi.encode(vault.getPromo(id), vault.getClaimants(id), vault.hasClaim(id, customer))
            : bytes("");
        return keccak256(
            abi.encode(
                promo,
                vault.lockedCollateral(),
                vault.pendingCollateral(),
                vault.totalOwedPayouts(),
                vault.totalShares(),
                usdc.balanceOf(address(vault))
            )
        );
    }

    // ------------------------------------------------------------ what a pause no longer stops

    /// The trade-off the change makes. Under v1 a pause was the owner's one immediate stop for a
    /// stolen relayer key: every promo names the relayer as its claim signer for good, and no
    /// setter can change it. Under v2 a pause does not stop it: whoever holds the key fills the
    /// open slots of every promo still taking claims with addresses of their own, and on a "yes"
    /// they are paid out of the lock the LPs would otherwise have got back.
    function test_stolenRelayerKey_aPauseNoLongerStopsIt() public {
        _claim(game, carol); // one real customer, one slot left
        uint256 freeBefore = vault.freeBalance();

        vault.pause(); // the owner's v1 answer to a stolen key
        address thief = makeAddr("thief");
        vm.prank(relayer); // the stolen key
        vault.registerClaim(game, thief);
        assertEq(vault.getPromo(game).claimCount, 2, "the thief took the last slot while paused");

        _settleAndFinalize(game, true);
        vault.payoutBatch(game, 50);
        assertEq(usdc.balanceOf(thief), 8 * USDC, "the thief is paid $8 on the yes");
        assertEq(usdc.balanceOf(carol), 8 * USDC, "the real customer is paid too");
        // Without the thief's claim finalize would have released $8 back to the free balance.
        assertEq(vault.freeBalance(), freeBefore, "the LPs get back none of the unclaimed slot");
    }

    /// The remedy left to the owner is blunt: veto the result inside the dispute window and void
    /// the promo once the void grace has passed after the market close (7 days by default, or
    /// sooner by lowering voidGrace for every promo). It works while paused, refunds the merchant,
    /// and takes the payout away from the real customer as well as from the thief.
    function test_stolenRelayerKey_theRemedyIsVetoThenVoid_whilePaused() public {
        _claim(game, carol);
        vault.pause();
        address thief = makeAddr("thief");
        vm.prank(relayer);
        vault.registerClaim(game, thief);

        _settle(game, true);
        vault.veto(game);
        PromoVault.Promo memory p = vault.getPromo(game);
        vm.warp(uint256(p.marketCloseTime) + vault.voidGrace() + 1);
        uint256 merchantBefore = usdc.balanceOf(merchant);
        vault.voidPromo(game);

        assertEq(usdc.balanceOf(merchant) - merchantBefore, 7_060_000, "the merchant is refunded");
        assertEq(usdc.balanceOf(thief), 0);
        assertEq(usdc.balanceOf(carol), 0, "the real customer loses the payout too");
        assertEq(vault.lockedCollateral(), 2 * USDC, "only the cover still locks");
        assertEq(vault.pendingCollateral(), 2 * USDC);
        assertTrue(vault.paused());
    }

    // ------------------------------------------------------------ what a pause still stops

    /// A quote signed before the pause cannot be used during it, and still can after it while
    /// it has not expired: the pause holds back new risk, it does not cancel quotes.
    function test_pause_holdsBackAQuoteSignedBeforeIt_untilTheUnpause() public {
        PromoVault.Quote memory q = _quote(8 * USDC, 1, 3_620_000);
        _fund(q);
        bytes memory sig = _sign(q);

        vault.pause();
        vm.prank(merchant);
        vm.expectRevert(PromoVault.VaultPaused.selector);
        vault.createPromo(q, sig);

        vault.unpause();
        vm.prank(merchant);
        uint256 id = vault.createPromo(q, sig);
        assertEq(id, 2);
    }
}
