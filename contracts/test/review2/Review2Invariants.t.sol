// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PromoVault} from "../../src/PromoVault.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Second review (Nov 13). A second stateful harness, written without looking at how the
///      first one decides what is legal. It differs from `VaultHandler` in four ways:
///
///      1. It has its own model of when each call must go through and when it must be refused,
///         and checks both directions on every call (`_record`). The first handler only makes
///         legal calls, plus ten kinds of forbidden ones.
///      2. One set of addresses plays every role: the same address can be an LP, a merchant and a
///         customer of its own promo. Customers can also be the vault itself and the dead address.
///      3. Any address can be on the USDC blocklist, the vault included (USDC paused, or the vault
///         blocked: SPEC "Known limits").
///      4. USDC arrives in the vault outside any vault call (a plain transfer), and the owner
///         changes the dispute window and the void grace while promos are alive.
contract Review2Handler is Test {
    uint256 internal constant MAX_PROMOS = 24;
    uint256 internal constant MAX_UNFINISHED = 8;
    string internal constant EVENT_ID_PLAIN = "362998";
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    error BadTransition(uint256 promoId, PromoVault.Status from, PromoVault.Status to);

    PromoVault internal immutable vault;
    MockUSDC internal immutable usdc;
    address internal immutable owner;
    address internal immutable oracle;
    uint256 internal immutable pricerPk;
    address public immutable relayer;

    address[] public actors;
    mapping(address => uint256) internal keyOf;
    /// @dev Who a claim can name: every actor, the vault, the dead address, and the zero address.
    address[] internal payees;

    uint256 internal nonce;
    uint256 public lastSeed;
    mapping(uint256 => PromoVault.Status) internal lastStatus;

    /// @dev How often each call went through, and how often it was refused (as the model said).
    mapping(string => uint256) public went;
    mapping(string => uint256) public refused;
    uint256 public payoutsFailed;
    uint256 public selfPayouts;

    constructor(PromoVault vault_, MockUSDC usdc_, uint256 pricerPk_, address oracle_, address owner_) {
        vault = vault_;
        usdc = usdc_;
        pricerPk = pricerPk_;
        oracle = oracle_;
        owner = owner_;
        relayer = makeAddr("r2-relayer");
        for (uint256 i = 0; i < 4; i++) {
            (address actor, uint256 key) = makeAddrAndKey(string.concat("r2-actor-", vm.toString(i)));
            actors.push(actor);
            keyOf[actor] = key;
            payees.push(actor);
        }
        payees.push(address(vault_));
        payees.push(DEAD);
        payees.push(address(0));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ------------------------------------------------------------ helpers

    function _vaultBalance() internal view returns (uint256) {
        return usdc.balanceOf(address(vault));
    }

    function _free() internal view returns (uint256) {
        return _vaultBalance() - vault.lockedCollateral();
    }

    /// @dev A transfer between the vault and `who` fails.
    function _cut(address who) internal view returns (bool) {
        return usdc.blocked(who) || usdc.blocked(address(vault));
    }

    /// @dev Mint, whatever the blocklist says: a blocked address still holds what it held.
    function _give(address to, uint256 amount) internal {
        bool was = usdc.blocked(to);
        if (was) usdc.setBlocked(to, false);
        usdc.mint(to, amount);
        if (was) usdc.setBlocked(to, true);
    }

    function _record(string memory what, bool ok, bool legal) internal {
        if (ok != legal) {
            fail(
                string.concat(
                    what, ok ? ": went through, the model says refused" : ": refused, the model says legal"
                )
            );
        }
        if (ok) went[what]++;
        else refused[what]++;
        _edges();
    }

    /// @dev A promo in the wanted status when there is one, starting from a random one. One call
    ///      in seven takes a random promo whatever its status, to try the call where it is wrong.
    function _pick(uint256 seed, PromoVault.Status wanted) internal view returns (bool any, uint256 id) {
        uint256 n = vault.promoCount();
        if (n == 0) return (false, 0);
        id = seed % n;
        if (seed % 7 == 0) return (true, id);
        for (uint256 i = 0; i < n; i++) {
            uint256 candidate = (id + i) % n;
            if (vault.getPromo(candidate).status == wanted) return (true, candidate);
        }
        return (true, id);
    }

    /// @dev Promos that still hold a lock or wait for a result.
    function _unfinished() internal view returns (uint256 count) {
        uint256 n = vault.promoCount();
        for (uint256 id = 0; id < n; id++) {
            PromoVault.Status status = lastStatus[id];
            if (
                status == PromoVault.Status.Open || status == PromoVault.Status.Settled
                    || status == PromoVault.Status.Vetoed || status == PromoVault.Status.FinalizedYes
            ) count++;
        }
    }

    /// @dev An open promo that still takes customers, when there is one.
    function _pickClaimable(uint256 seed) internal view returns (bool any, uint256 id) {
        uint256 n = vault.promoCount();
        if (n == 0) return (false, 0);
        id = seed % n;
        if (seed % 7 == 0) return (true, id);
        for (uint256 i = 0; i < n; i++) {
            uint256 candidate = (id + i) % n;
            PromoVault.Promo memory p = vault.getPromo(candidate);
            if (
                p.status == PromoVault.Status.Open && block.timestamp < p.claimDeadline
                    && p.claimCount < p.maxClaims
            ) return (true, candidate);
        }
        return (true, id);
    }

    function _edges() internal {
        uint256 n = vault.promoCount();
        for (uint256 id = 0; id < n; id++) {
            PromoVault.Status from = lastStatus[id];
            PromoVault.Status to = vault.getPromo(id).status;
            if (from == to) continue;
            if (!_edge(from, to)) revert BadTransition(id, from, to);
            lastStatus[id] = to;
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

    // ------------------------------------------------------------ liquidity

    function deposit(uint256 actorSeed, uint256 amount) external {
        address lp = actors[actorSeed % actors.length];
        amount = bound(amount, 0, 4_000e6);
        if (amount % 7 == 0) amount = amount % 3_000; // dust, and zero, now and then

        uint256 total = vault.totalShares();
        uint256 expected;
        if (total == 0) {
            expected = amount > 1_000 ? amount - 1_000 : 0;
        } else {
            uint256 basis = _free() + vault.pendingCollateral();
            expected = basis == 0 ? 0 : amount * total / basis;
        }
        bool legal = !vault.paused() && expected != 0 && !_cut(lp);

        _give(lp, amount);
        vm.prank(lp);
        usdc.approve(address(vault), amount);
        uint256 before = _vaultBalance();
        uint256 held = vault.shares(lp);

        bool ok;
        vm.prank(lp);
        try vault.deposit(amount) returns (uint256 minted) {
            ok = true;
            assertEq(
                minted, expected, "deposit minted something other than amount * shares / (free + pending)"
            );
        } catch {}
        _record("deposit", ok, legal);
        assertEq(_vaultBalance() - before, ok ? amount : 0);
        assertEq(vault.shares(lp) - held, ok ? expected : 0);
    }

    function withdraw(uint256 actorSeed, uint256 shareAmount) external {
        address lp = actors[actorSeed % actors.length];
        uint256 held = vault.shares(lp);
        shareAmount = shareAmount % 5 == 0 ? held : bound(shareAmount, 0, held + 1);

        bool legal = shareAmount != 0 && shareAmount <= held && !_cut(lp);
        uint256 expected = legal ? shareAmount * _free() / vault.totalShares() : 0;
        uint256 before = _vaultBalance();
        uint256 lpBefore = usdc.balanceOf(lp);

        bool ok;
        vm.prank(lp);
        try vault.withdraw(shareAmount) returns (uint256 out) {
            ok = true;
            assertEq(out, expected, "withdraw paid something other than shares * free / total");
        } catch {}
        _record("withdraw", ok, legal);
        assertEq(before - _vaultBalance(), expected);
        assertEq(usdc.balanceOf(lp) - lpBefore, expected);
        assertEq(held - vault.shares(lp), ok ? shareAmount : 0);
    }

    /// @dev USDC that arrives outside any vault call.
    function donate(uint256 amount) external {
        _give(address(vault), bound(amount, 1, 50e6));
        went["donate"]++;
    }

    // ------------------------------------------------------------ promos

    function create(
        uint256 actorSeed,
        uint256 payoutPerClaim,
        uint32 maxClaims,
        uint256 premium,
        uint256 flags,
        uint256 deadlineIn,
        uint256 closeAfter
    ) external {
        lastSeed = flags;
        if (vault.promoCount() >= MAX_PROMOS || _unfinished() >= MAX_UNFINISHED) return;
        (PromoVault.Quote memory q, bool legal) =
            _newQuote(actors[actorSeed % actors.length], payoutPerClaim, maxClaims, premium, flags);
        q.claimDeadline = uint64(block.timestamp + bound(deadlineIn, 1, 2 days));
        q.marketCloseTime = q.claimDeadline + uint64(bound(closeAfter, 0, 30 hours));
        _tryCreate(q, legal, (flags >> 8) % 2 == 0);
    }

    /// @dev One quote in eight puts exactly one base unit more than the exposure cap at risk and
    ///      one in eight exactly the cap; the others are raised in premium until they fit, as the
    ///      pricing service refuses to sign what does not fit.
    function _newQuote(
        address merchant,
        uint256 payoutPerClaim,
        uint32 maxClaims,
        uint256 premium,
        uint256 flags
    ) internal returns (PromoVault.Quote memory q, bool legal) {
        bool hedge = flags % 3 == 0;
        payoutPerClaim = bound(payoutPerClaim, 1, 60e6);
        maxClaims = hedge ? 1 : uint32(bound(maxClaims, 1, 5));
        uint256 maxPayout = payoutPerClaim * maxClaims;
        premium = bound(premium, 0, maxPayout);
        uint256 cap = _free() * vault.maxExposureBps() / 10_000;
        uint256 edge = (flags >> 16) % 8;
        if (edge <= 1) {
            // One payout whose risk is the cap (edge 1) or the cap plus one (edge 0).
            maxClaims = 1;
            premium = bound(premium, 1, 10e6);
            payoutPerClaim = cap + premium + (edge == 0 ? 1 : 0);
            maxPayout = payoutPerClaim;
        } else if (maxPayout - premium > cap) {
            premium = maxPayout - cap;
        }
        legal = !vault.paused() && maxPayout - premium <= cap && !_cut(merchant);
        if (edge == 0) assertFalse(legal);

        q = PromoVault.Quote({
            merchant: merchant,
            claimSigner: relayer,
            geminiEventId: keccak256(bytes(EVENT_ID_PLAIN)),
            instrumentSymbol: keccak256("GEMI-R2"),
            payoutPerClaim: payoutPerClaim,
            maxClaims: maxClaims,
            premium: premium,
            claimDeadline: 0,
            marketCloseTime: 0,
            hedgeMode: hedge,
            expiry: uint64(block.timestamp + 90),
            nonce: bytes32(++nonce)
        });
    }

    function _tryCreate(PromoVault.Quote memory q, bool legal, bool withPermit) internal {
        _give(q.merchant, q.premium);
        uint256 id = vault.promoCount();
        uint256 before = _vaultBalance();
        uint256 lockedBefore = vault.lockedCollateral();
        bytes memory sig = _signQuote(q);

        bool ok;
        if (withPermit) {
            uint256 deadline = block.timestamp + 10 minutes;
            (uint8 v, bytes32 r, bytes32 s) = _signPermit(q.merchant, q.premium, deadline);
            // For one quote in three a stranger hands the permit to USDC first.
            if (uint256(q.nonce) % 3 == 0) {
                usdc.permit(q.merchant, address(vault), q.premium, deadline, v, r, s);
                went["permit submitted first"]++;
            }
            vm.prank(q.merchant);
            try vault.createPromoWithPermit(q, sig, deadline, v, r, s) {
                ok = true;
            } catch {}
        } else {
            vm.prank(q.merchant);
            usdc.approve(address(vault), q.premium);
            vm.prank(q.merchant);
            try vault.createPromo(q, sig) {
                ok = true;
            } catch {}
        }
        _record("create", ok, legal);

        if (!ok) {
            assertEq(_vaultBalance(), before);
            assertEq(vault.promoCount(), id);
            assertEq(vault.lockedCollateral(), lockedBefore);
            return;
        }
        went[q.hedgeMode ? "create a cover" : "create a promo"]++;
        PromoVault.Promo memory p = vault.getPromo(id);
        assertEq(_vaultBalance() - before, q.premium);
        assertEq(vault.lockedCollateral() - lockedBefore, q.payoutPerClaim * q.maxClaims);
        assertEq(p.collateralLocked, q.payoutPerClaim * q.maxClaims);
        assertEq(p.claimCount, q.hedgeMode ? 1 : 0);
        assertEq(usdc.allowance(q.merchant, address(vault)), 0, "a create left an allowance behind");
    }

    function _signQuote(PromoVault.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pricerPk, vault.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _signPermit(address merchant, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, merchant, address(vault), value, usdc.nonces(merchant), deadline)
        );
        return vm.sign(
            keyOf[merchant], keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash))
        );
    }

    function claim(uint256 promoSeed, uint256 payeeSeed, uint256 callerSeed) external {
        (bool any, uint256 id) = _pickClaimable(promoSeed);
        if (!any) return;
        PromoVault.Promo memory p = vault.getPromo(id);
        address payee = payees[payeeSeed % payees.length];
        // Now and then exactly at the deadline, the first second a claim is too late.
        if (payeeSeed % 16 == 0 && block.timestamp < p.claimDeadline) vm.warp(p.claimDeadline);
        address caller = callerSeed % 6 == 0 ? actors[callerSeed % actors.length] : relayer;
        // The merchant and the owner are not the claim signer, so they are refused like anyone.
        if (callerSeed % 6 == 1) caller = p.merchant;
        if (callerSeed % 6 == 2 && callerSeed % 5 == 0) caller = owner;

        bool legal = caller == relayer && !vault.paused() && p.status == PromoVault.Status.Open
            && block.timestamp < p.claimDeadline && p.claimCount < p.maxClaims && payee != address(0)
            && !vault.hasClaim(id, payee);

        bool ok;
        vm.prank(caller);
        try vault.registerClaim(id, payee) {
            ok = true;
        } catch {}
        _record("claim", ok, legal);
        assertEq(vault.getPromo(id).claimCount, p.claimCount + (ok ? 1 : 0));
        if (ok && payee == address(vault)) went["claim for the vault itself"]++;
        if (ok && payee == p.merchant) went["claim for the promo's own merchant"]++;
    }

    function settle(uint256 promoSeed, uint256 flags) external {
        (bool any, uint256 id) = _pick(promoSeed, PromoVault.Status.Open);
        if (!any) return;
        PromoVault.Promo memory p = vault.getPromo(id);
        if (flags % 2 == 0 && block.timestamp < p.claimDeadline) vm.warp(p.claimDeadline);
        bool yes = (flags >> 8) % 2 == 0;
        bool rightId = (flags >> 16) % 8 != 0;
        address caller = (flags >> 24) % 6 == 0 ? actors[0] : oracle;

        bool legal = caller == oracle && p.status == PromoVault.Status.Open
            && block.timestamp >= p.claimDeadline && rightId;

        bool ok;
        vm.prank(caller);
        try vault.settle(id, yes, rightId ? EVENT_ID_PLAIN : "362999", yes ? "yes" : "no") {
            ok = true;
        } catch {}
        _record("settle", ok, legal);
        if (!ok) return;
        PromoVault.Promo memory after_ = vault.getPromo(id);
        assertEq(after_.outcomeYes, yes);
        assertEq(after_.settledAt, block.timestamp);
        assertEq(after_.collateralLocked, p.collateralLocked);
    }

    function veto(uint256 promoSeed, uint256 callerSeed) external {
        (bool any, uint256 id) = _pick(promoSeed, PromoVault.Status.Settled);
        if (!any) return;
        PromoVault.Promo memory p = vault.getPromo(id);
        address caller = callerSeed % 6 == 0 ? actors[callerSeed % actors.length] : owner;
        bool legal = caller == owner && p.status == PromoVault.Status.Settled
            && block.timestamp < uint256(p.settledAt) + vault.disputeWindow();

        bool ok;
        vm.prank(caller);
        try vault.veto(id) {
            ok = true;
        } catch {}
        _record("veto", ok, legal);
    }

    function resetSettlement(uint256 promoSeed, uint256 callerSeed) external {
        (bool any, uint256 id) = _pick(promoSeed, PromoVault.Status.Vetoed);
        if (!any) return;
        address caller = callerSeed % 6 == 0 ? actors[callerSeed % actors.length] : owner;
        bool legal = caller == owner && vault.getPromo(id).status == PromoVault.Status.Vetoed;

        bool ok;
        vm.prank(caller);
        try vault.resetSettlement(id) {
            ok = true;
        } catch {}
        _record("reset", ok, legal);
    }

    function finalize(uint256 promoSeed, uint256 flags) external {
        (bool any, uint256 id) = _pick(promoSeed, PromoVault.Status.Settled);
        if (!any) return;
        PromoVault.Promo memory p = vault.getPromo(id);
        uint256 windowEnd = uint256(p.settledAt) + vault.disputeWindow();
        if (flags % 2 == 0 && block.timestamp < windowEnd) vm.warp(windowEnd);
        // Or one second before the window ends, the last second a finalize is too early.
        if (flags % 8 == 1 && windowEnd != 0 && block.timestamp < windowEnd - 1) vm.warp(windowEnd - 1);
        bool legal = p.status == PromoVault.Status.Settled && block.timestamp >= windowEnd;
        uint256 before = _vaultBalance();
        uint256 lockedBefore = vault.lockedCollateral();

        bool ok;
        vm.prank(actors[flags % actors.length]);
        try vault.finalize(id) {
            ok = true;
        } catch {}
        _record("finalize", ok, legal);
        assertEq(_vaultBalance(), before);
        if (!ok) return;

        PromoVault.Promo memory after_ = vault.getPromo(id);
        uint256 kept = p.outcomeYes ? p.payoutPerClaim * p.claimCount : 0;
        assertEq(after_.collateralLocked, kept, "finalize kept something other than the claimed payouts");
        assertEq(lockedBefore - vault.lockedCollateral(), p.collateralLocked - kept);
        PromoVault.Status want = !p.outcomeYes
            ? PromoVault.Status.FinalizedNo
            : (p.claimCount == 0 ? PromoVault.Status.PaidOut : PromoVault.Status.FinalizedYes);
        assertEq(uint8(after_.status), uint8(want));
        went[p.outcomeYes ? "finalize a yes" : "finalize a no"]++;
    }

    function voidPromo(uint256 promoSeed, uint256 flags) external {
        (bool any, uint256 id) =
            _pick(promoSeed, flags % 2 == 0 ? PromoVault.Status.Open : PromoVault.Status.Vetoed);
        if (!any) return;
        PromoVault.Promo memory p = vault.getPromo(id);
        uint256 voidableAfter = uint256(p.marketCloseTime) + vault.voidGrace();
        if ((flags >> 8) % 3 == 0 && block.timestamp <= voidableAfter) vm.warp(voidableAfter + 1);
        // Or exactly at the end of the grace, the last second a void is too early.
        if ((flags >> 8) % 3 == 1 && block.timestamp < voidableAfter) vm.warp(voidableAfter);
        address caller = (flags >> 16) % 6 == 0 ? actors[1] : owner;

        bool legal = caller == owner
            && (p.status == PromoVault.Status.Open || p.status == PromoVault.Status.Vetoed)
            && block.timestamp > voidableAfter && !_cut(p.merchant);
        uint256 before = _vaultBalance();
        uint256 merchantBefore = usdc.balanceOf(p.merchant);
        uint256 lockedBefore = vault.lockedCollateral();

        bool ok;
        vm.prank(caller);
        try vault.voidPromo(id) {
            ok = true;
        } catch {}
        _record("void", ok, legal);
        assertEq(before - _vaultBalance(), ok ? p.premiumPaid : 0);
        assertEq(usdc.balanceOf(p.merchant) - merchantBefore, ok ? p.premiumPaid : 0);
        assertEq(lockedBefore - vault.lockedCollateral(), ok ? p.collateralLocked : 0);
    }

    struct Batch {
        uint256 id;
        uint256 payout;
        uint256 taken;
        uint256 expectPaid;
        uint256 expectOut;
        address[] customers;
        uint256[] before;
        bool[] willPay;
    }

    function payoutBatch(uint256 promoSeed, uint32 count, uint256 callerSeed) external {
        Batch memory b;
        bool any;
        (any, b.id) = _pick(promoSeed, PromoVault.Status.FinalizedYes);
        if (!any) return;
        PromoVault.Promo memory p = vault.getPromo(b.id);
        count = uint32(bound(count, 0, 6));
        bool legal = p.status == PromoVault.Status.FinalizedYes && count != 0;
        if (legal) {
            uint256 left = p.claimCount - p.paidCount;
            b.taken = count < left ? count : left;
        }
        b.payout = p.payoutPerClaim;
        b.customers = new address[](b.taken);
        b.before = new uint256[](b.taken);
        b.willPay = new bool[](b.taken);
        // One batch in four finds its first customer on the blocklist, so payouts do fail.
        if (b.taken != 0 && callerSeed % 4 == 0) usdc.setBlocked(vault.claimants(b.id, p.paidCount), true);
        for (uint256 i = 0; i < b.taken; i++) {
            address customer = vault.claimants(b.id, p.paidCount + i);
            b.customers[i] = customer;
            b.before[i] = usdc.balanceOf(customer);
            b.willPay[i] = !_cut(customer);
            if (b.willPay[i]) {
                b.expectPaid++;
                if (customer != address(vault)) b.expectOut += b.payout;
                else selfPayouts++;
            }
        }
        _pay(b, count, legal, actors[callerSeed % actors.length]);
    }

    function _pay(Batch memory b, uint32 count, bool legal, address caller) internal {
        uint256 before = _vaultBalance();
        uint256 owedBefore = vault.totalOwedPayouts();
        uint256 lockedBefore = vault.lockedCollateral();

        bool ok;
        uint32 paid;
        vm.prank(caller);
        try vault.payoutBatch(b.id, count) returns (uint32 n) {
            ok = true;
            paid = n;
        } catch {}
        _record("pay", ok, legal);
        if (!ok) {
            assertEq(_vaultBalance(), before);
            return;
        }

        assertEq(paid, b.expectPaid, "payoutBatch returned the wrong count");
        assertEq(before - _vaultBalance(), b.expectOut, "payoutBatch sent the wrong total");
        assertEq(vault.totalOwedPayouts() - owedBefore, (b.taken - b.expectPaid) * b.payout);
        assertEq(lockedBefore - vault.lockedCollateral(), b.expectPaid * b.payout);
        for (uint256 i = 0; i < b.taken; i++) {
            address customer = b.customers[i];
            assertEq(vault.owedPayout(b.id, customer), b.willPay[i] ? 0 : b.payout);
            if (customer != address(vault)) {
                assertEq(usdc.balanceOf(customer) - b.before[i], b.willPay[i] ? b.payout : 0);
            }
        }
        payoutsFailed += b.taken - b.expectPaid;
        went["pay a customer"] += b.expectPaid;
    }

    function retryPayout(uint256 promoSeed, uint256 payeeSeed, bool unblockFirst) external {
        (uint256 id, address customer) = _findOwed(promoSeed, payeeSeed);
        if (unblockFirst) {
            usdc.setBlocked(customer, false);
            if (payeeSeed % 2 == 0) usdc.setBlocked(address(vault), false);
        }
        uint256 owed = vault.owedPayout(id, customer);
        bool legal = owed != 0 && !_cut(customer);
        uint256 before = _vaultBalance();
        uint256 customerBefore = usdc.balanceOf(customer);
        uint256 lockedBefore = vault.lockedCollateral();

        bool ok;
        vm.prank(actors[payeeSeed % actors.length]);
        try vault.retryPayout(id, customer) {
            ok = true;
        } catch {}
        _record("retry", ok, legal);
        if (!ok) {
            assertEq(vault.owedPayout(id, customer), owed);
            return;
        }
        assertEq(vault.owedPayout(id, customer), 0);
        assertEq(lockedBefore - vault.lockedCollateral(), owed);
        if (customer != address(vault)) {
            assertEq(before - _vaultBalance(), owed);
            assertEq(usdc.balanceOf(customer) - customerBefore, owed);
        }
    }

    /// @dev The first payout still owed, or a random promo and payee when nothing is owed.
    function _findOwed(uint256 promoSeed, uint256 payeeSeed) internal view returns (uint256, address) {
        uint256 n = vault.promoCount();
        if (vault.totalOwedPayouts() != 0 && promoSeed % 7 != 0) {
            for (uint256 i = 0; i < n; i++) {
                uint256 id = (promoSeed % n + i) % n;
                address[] memory list = vault.getClaimants(id);
                for (uint256 j = 0; j < list.length; j++) {
                    if (vault.owedPayout(id, list[j]) != 0) return (id, list[j]);
                }
            }
        }
        return (n == 0 ? 0 : promoSeed % n, payees[payeeSeed % (payees.length - 1)]);
    }

    // ------------------------------------------------------------ the world around the vault

    function setBlocked(uint256 seed) external {
        address target = seed % 11 == 0 ? address(vault) : payees[seed % (payees.length - 1)];
        usdc.setBlocked(target, (seed >> 8) % 3 == 0);
        // The vault does not stay blocked for a whole run: one call in three lets it back in.
        if ((seed >> 16) % 3 == 0) usdc.setBlocked(address(vault), false);
    }

    function admin(uint256 kind, uint256 value) external {
        kind = kind % 6;
        vm.startPrank(owner);
        if (kind == 0) vault.setMaxExposureBps(uint16(bound(value, 0, 10_000)));
        else if (kind == 1) vault.setDisputeWindow(uint32(bound(value, 0, 2 hours)));
        else if (kind == 2) vault.setVoidGrace(uint32(bound(value, 0, 12 hours)));
        else if (kind == 3) vault.pause();
        else vault.unpause();
        vm.stopPrank();
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }
}

/// @dev Named so that `--no-match-contract PromoVaultInvariantTest` leaves it out of the quick run.
contract Review2PromoVaultInvariantTest is Test {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    PromoVault internal vault;
    MockUSDC internal usdc;
    Review2Handler internal handler;
    address internal oracle = makeAddr("oracle");

    function setUp() public {
        (address pricer, uint256 pricerPk) = makeAddrAndKey("pricer");
        usdc = new MockUSDC();
        vault = new PromoVault(usdc, pricer, oracle);
        vault.setDisputeWindow(1 hours);
        vault.setVoidGrace(6 hours);
        handler = new Review2Handler(vault, usdc, pricerPk, oracle, address(this));

        handler.deposit(0, 3_000e6 + 1);
        handler.deposit(1, 1_500e6 + 1);
        assertEq(vault.totalShares(), 4_500e6 + 2);

        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = Review2Handler.deposit.selector;
        selectors[1] = Review2Handler.withdraw.selector;
        selectors[2] = Review2Handler.donate.selector;
        selectors[3] = Review2Handler.create.selector;
        selectors[4] = Review2Handler.create.selector;
        selectors[5] = Review2Handler.claim.selector;
        selectors[6] = Review2Handler.claim.selector;
        selectors[7] = Review2Handler.settle.selector;
        selectors[8] = Review2Handler.veto.selector;
        selectors[9] = Review2Handler.resetSettlement.selector;
        selectors[10] = Review2Handler.finalize.selector;
        selectors[11] = Review2Handler.voidPromo.selector;
        selectors[12] = Review2Handler.payoutBatch.selector;
        selectors[13] = Review2Handler.retryPayout.selector;
        selectors[14] = Review2Handler.setBlocked.selector;
        selectors[15] = Review2Handler.admin.selector;
        selectors[16] = Review2Handler.warp.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ------------------------------------------------------------ the invariants

    /// The vault holds its locks; every lock is what its promo's status says it must be; the three
    /// sums add up; shares add up.
    function invariant_r2_theBooksAddUp() public view {
        _checkBooks();
    }

    /// A stranger deposits, every promo without a final result ends "no", the stranger withdraws:
    /// never more than they brought, whatever the blocklist, the pause and the setters were.
    function invariant_r2_aDepositNeverLeavesWithMore() public {
        _checkDepositNeverGains(bound(handler.lastSeed(), 1e6, 1e12));
    }

    /// Every LP leaves, every pending promo ends "yes", every customer is paid or retried, and
    /// nothing stays locked or owed.
    function invariant_r2_everyoneLeavesAndEveryPromoPays() public {
        _checkEveryoneLeavesAndEveryPromoPays();
    }

    /// Fixed walks of 600 pseudo-random calls each (what fits in one test's gas), with the books
    /// checked after every call and the two what-if checks every 100. They also prove the harness is not idle: in
    /// each walk every kind of call must have gone through and must have been refused.
    function test_r2_randomWalk_one() public {
        _walk("review2-one", 11);
    }

    function test_r2_randomWalk_two() public {
        _walk("review2-two", 11);
    }

    function test_r2_randomWalk_three() public {
        _walk("review2-three", 7);
    }

    /// This walk spends most of its calls refused (the vault is paused early and stays paused), so
    /// only the first five kinds are required of it.
    function test_r2_randomWalk_four() public {
        _walk("review2-four", 5);
    }

    function test_r2_randomWalk_seven() public {
        _walk("review2-seven", 7);
    }

    function test_r2_randomWalk_five() public {
        _walk("review2-five", 7);
    }

    function test_r2_randomWalk_six() public {
        _walk("review2-six", 7);
    }

    function r2Books() external view {
        _checkBooks();
    }

    function r2WhatIfs(uint256 amount) external {
        _checkDepositNeverGains(amount);
        _checkEveryoneLeavesAndEveryPromoPays();
    }

    function r2Step(uint256 r) external {
        uint256 a = uint256(keccak256(abi.encode(r, 1)));
        uint256 b = uint256(keccak256(abi.encode(r, 2)));
        uint256 c = uint256(keccak256(abi.encode(r, 3)));
        uint256 kind = r % 20;
        if (kind == 0) {
            handler.deposit(a, b);
        } else if (kind == 1) {
            handler.withdraw(a, b);
        } else if (kind == 2) {
            handler.donate(a);
        } else if (kind <= 5) {
            handler.create(a, b, uint32(c), c >> 32, r >> 8, a >> 64, b >> 64);
        } else if (kind <= 8) {
            handler.claim(a, b, c);
        } else if (kind <= 10) {
            handler.settle(a, b);
        } else if (kind == 11) {
            handler.veto(a, b);
        } else if (kind == 12) {
            handler.resetSettlement(a, b);
        } else if (kind <= 14) {
            handler.finalize(a, b);
        } else if (kind == 15) {
            handler.voidPromo(a, b);
        } else if (kind <= 17) {
            handler.payoutBatch(a, uint32(b), c);
        } else if (kind == 18) {
            if (a % 2 == 0) handler.retryPayout(a, b, c % 2 == 0);
            else handler.setBlocked(b);
        } else {
            if (a % 3 == 0) handler.admin(b, c);
            else handler.warp(b % 3 hours);
        }
    }

    function _walk(string memory salt, uint256 mustReach) internal {
        for (uint256 i = 0; i < 600; i++) {
            uint256 r = uint256(keccak256(abi.encode(salt, i)));
            // Each through an external call, so its memory is given back: hundreds of steps in
            // one frame run out of memory.
            this.r2Step(r);
            this.r2Books();
            if (i % 100 == 99) this.r2WhatIfs(bound(r >> 16, 1e6, 1e12));
        }

        // The first seven are reached by every walk; the last four (the side paths) by walks one
        // and two, which is what `mustReach` says.
        string[11] memory both = [
            "deposit",
            "withdraw",
            "create",
            "claim",
            "settle",
            "finalize",
            "pay",
            "veto",
            "reset",
            "void",
            "retry"
        ];
        for (uint256 i = 0; i < both.length; i++) {
            emit log_named_uint(string.concat(both[i], ", went through"), handler.went(both[i]));
            emit log_named_uint(string.concat(both[i], ", refused"), handler.refused(both[i]));
            if (i >= mustReach) continue;
            assertGt(handler.went(both[i]), 0, string.concat(both[i], " never went through"));
            assertGt(handler.refused(both[i]), 0, string.concat(both[i], " was never refused"));
        }
        string[7] memory seen = [
            "create a cover",
            "create a promo",
            "finalize a yes",
            "finalize a no",
            "pay a customer",
            "claim for the vault itself",
            "claim for the promo's own merchant"
        ];
        for (uint256 i = 0; i < seen.length; i++) {
            emit log_named_uint(seen[i], handler.went(seen[i]));
        }
        emit log_named_uint("payouts that failed and became owed", handler.payoutsFailed());
        emit log_named_uint("payouts sent to the vault itself", handler.selfPayouts());
        emit log_named_uint("promos", vault.promoCount());
    }

    // ------------------------------------------------------------ the checks

    function _checkBooks() internal view {
        uint256 locked = vault.lockedCollateral();
        assertGe(usdc.balanceOf(address(vault)), locked, "balance below locked collateral");

        uint256 sumOfLocks;
        uint256 sumOfPending;
        uint256 sumOfOwed;
        uint256 n = vault.promoCount();
        for (uint256 id = 0; id < n; id++) {
            PromoVault.Promo memory p = vault.getPromo(id);
            bool pending = p.status == PromoVault.Status.Open || p.status == PromoVault.Status.Settled
                || p.status == PromoVault.Status.Vetoed;
            uint256 want = pending
                ? p.payoutPerClaim * p.maxClaims
                : (p.status == PromoVault.Status.FinalizedYes
                        ? p.payoutPerClaim * (p.claimCount - p.paidCount)
                        : 0);
            assertEq(p.collateralLocked, want, "a promo's lock is not what its status says");
            sumOfLocks += want;
            if (pending) sumOfPending += want;
            sumOfOwed += _owed(id, p);

            assertLe(p.claimCount, p.maxClaims);
            assertLe(p.paidCount, p.claimCount);
            assertLe(p.premiumPaid, p.payoutPerClaim * p.maxClaims);
            if (p.status == PromoVault.Status.Open) {
                assertEq(p.settledAt, 0);
                assertFalse(p.outcomeYes);
            }
            if (p.status == PromoVault.Status.PaidOut) {
                assertTrue(p.outcomeYes);
                assertEq(p.paidCount, p.claimCount);
            }
            if (pending || p.status == PromoVault.Status.FinalizedNo || p.status == PromoVault.Status.Voided)
            {
                assertEq(p.paidCount, 0, "a payout without a final yes");
            }
        }
        assertEq(vault.totalOwedPayouts(), sumOfOwed, "totalOwedPayouts is not the sum of owed payouts");
        assertEq(locked, sumOfLocks + sumOfOwed, "lockedCollateral is not the promo locks plus owed");
        assertEq(vault.pendingCollateral(), sumOfPending, "pendingCollateral is not the pending locks");

        uint256 sumOfShares = vault.shares(DEAD);
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            sumOfShares += vault.shares(handler.actors(i));
        }
        assertEq(vault.totalShares(), sumOfShares, "shares do not add up");
    }

    function _owed(uint256 id, PromoVault.Promo memory p) internal view returns (uint256 sum) {
        address[] memory claimed = vault.getClaimants(id);
        assertEq(claimed.length, p.claimCount);
        if (p.hedgeMode) {
            assertEq(p.maxClaims, 1);
            assertEq(claimed.length, 1);
            assertEq(claimed[0], p.merchant, "a cover must pay its merchant");
        }
        for (uint256 i = 0; i < claimed.length; i++) {
            uint256 owed = vault.owedPayout(id, claimed[i]);
            if (owed == 0) continue;
            assertLt(i, p.paidCount, "owed before payoutBatch reached the customer");
            assertEq(owed, p.payoutPerClaim, "owed something other than payoutPerClaim");
            sum += owed;
        }
    }

    function _clearTheWay() internal {
        if (vault.paused()) vault.unpause();
        usdc.setBlocked(address(vault), false);
        usdc.setBlocked(DEAD, false);
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            usdc.setBlocked(handler.actors(i), false);
        }
    }

    /// @dev Give every pending promo a result and make it final.
    function _endEveryPromo(bool yes) internal {
        uint256 n = vault.promoCount();
        uint256 latest = block.timestamp;
        for (uint256 id = 0; id < n; id++) {
            PromoVault.Promo memory p = vault.getPromo(id);
            if (p.status == PromoVault.Status.Vetoed) vault.resetSettlement(id);
            if (p.claimDeadline > latest) latest = p.claimDeadline;
        }
        vm.warp(latest);
        for (uint256 id = 0; id < n; id++) {
            if (vault.getPromo(id).status != PromoVault.Status.Open) continue;
            vm.prank(oracle);
            vault.settle(id, yes, "362998", yes ? "yes" : "no");
        }
        vm.warp(block.timestamp + vault.disputeWindow());
        for (uint256 id = 0; id < n; id++) {
            if (vault.getPromo(id).status == PromoVault.Status.Settled) vault.finalize(id);
        }
        assertEq(vault.pendingCollateral(), 0, "collateral still pending after every promo ended");
    }

    function _checkDepositNeverGains(uint256 amount) internal {
        uint256 snapshot = vm.snapshotState();
        _clearTheWay();

        address stranger = makeAddr("r2-stranger");
        usdc.mint(stranger, amount);
        vm.startPrank(stranger);
        usdc.approve(address(vault), amount);
        uint256 minted;
        try vault.deposit(amount) returns (uint256 m) {
            minted = m;
        } catch {}
        vm.stopPrank();

        if (minted != 0) {
            _endEveryPromo(false);
            vm.prank(stranger);
            uint256 out = vault.withdraw(minted);
            assertLe(out, amount, "a deposit left with more than it brought");
        }
        vm.revertToState(snapshot);
    }

    function _checkEveryoneLeavesAndEveryPromoPays() internal {
        uint256 snapshot = vm.snapshotState();
        _clearTheWay();

        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address lp = handler.actors(i);
            uint256 held = vault.shares(lp);
            if (held == 0) continue;
            vm.prank(lp);
            vault.withdraw(held);
        }
        assertGe(usdc.balanceOf(address(vault)), vault.lockedCollateral(), "LPs withdrew locked collateral");

        _endEveryPromo(true);
        uint256 n = vault.promoCount();
        for (uint256 id = 0; id < n; id++) {
            PromoVault.Promo memory p = vault.getPromo(id);
            if (p.status == PromoVault.Status.FinalizedYes) {
                uint32 paid = vault.payoutBatch(id, p.claimCount);
                assertEq(paid, p.claimCount - p.paidCount, "a customer was not paid with nothing in the way");
            }
            address[] memory claimed = vault.getClaimants(id);
            for (uint256 i = 0; i < claimed.length; i++) {
                if (vault.owedPayout(id, claimed[i]) != 0) vault.retryPayout(id, claimed[i]);
            }
        }
        assertEq(vault.totalOwedPayouts(), 0, "payouts still owed after every retry");
        assertEq(vault.lockedCollateral(), 0, "collateral still locked after every promo ended");

        vm.revertToState(snapshot);
    }
}
