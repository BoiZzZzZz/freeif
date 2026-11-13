// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {PromoVault} from "../src/PromoVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared setup and helpers. Promos are opened through the real createPromo with a quote
///      signed by the test pricer key.
abstract contract VaultTest is Test {
    using stdStorage for StdStorage;

    uint256 internal constant USDC = 1e6;

    string internal constant EVENT_ID_PLAIN = "362998";
    bytes32 internal constant EVENT_ID = keccak256("362998");
    bytes32 internal constant SYMBOL = keccak256("GEMI-NFL-2610251700-IND-MIN-M-MIN");

    /// @dev Written out here, not read from the vault, so a change to the type string or the
    ///      domain in the contract fails the signature tests.
    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(address merchant,address claimSigner,bytes32 geminiEventId,bytes32 instrumentSymbol,uint256 payoutPerClaim,uint32 maxClaims,uint256 premium,uint64 claimDeadline,uint64 marketCloseTime,bool hedgeMode,uint64 expiry,bytes32 nonce)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev The EIP-2612 type, the same one Arc's USDC reports from PERMIT_TYPEHASH().
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockUSDC internal usdc;
    PromoVault internal vault;

    address internal pricer;
    uint256 internal pricerPk;
    address internal oracle = makeAddr("oracle");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal merchant;
    uint256 internal merchantPk;
    address internal relayer = makeAddr("relayer");

    uint256 private _nonce;

    event Deposited(address indexed lp, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed lp, uint256 sharesBurned, uint256 amount);
    event PromoCreated(
        uint256 indexed promoId,
        address indexed merchant,
        bytes32 indexed instrumentSymbol,
        PromoVault.Quote quote
    );
    event ClaimRegistered(uint256 indexed promoId, address indexed customer, uint32 claimCount);

    event Settled(
        uint256 indexed promoId,
        bool outcomeYes,
        string geminiEventId,
        string resolutionSide,
        uint64 settledAt
    );

    event Vetoed(uint256 indexed promoId);
    event SettlementReset(uint256 indexed promoId);

    event Finalized(uint256 indexed promoId, bool outcomeYes, uint256 collateralReleased);

    event Voided(uint256 indexed promoId, address indexed merchant, uint256 premiumRefunded);

    event Paid(uint256 indexed promoId, address indexed customer, uint256 amount);
    event PayoutFailed(uint256 indexed promoId, address indexed customer, uint256 amount);

    function setUp() public virtual {
        (pricer, pricerPk) = makeAddrAndKey("pricer");
        (merchant, merchantPk) = makeAddrAndKey("merchant");
        usdc = new MockUSDC();
        vault = new PromoVault(usdc, pricer, oracle);
    }

    // ------------------------------------------------------------ liquidity

    function _deposit(address lp, uint256 amount) internal returns (uint256 minted) {
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(vault), amount);
        minted = vault.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Writes lockedCollateral directly. Only for states no call sequence can reach.
    function _setLocked(uint256 amount) internal {
        stdstore.target(address(vault)).sig("lockedCollateral()").checked_write(amount);
    }

    // ------------------------------------------------------------ quotes

    /// @dev A quote for `merchant` with the relayer as claim signer. Claims close in one day, the
    ///      market closes in three, the quote lasts 90 seconds, and every quote has a new nonce.
    function _quote(uint256 payoutPerClaim, uint32 maxClaims, uint256 premium)
        internal
        returns (PromoVault.Quote memory)
    {
        return PromoVault.Quote({
            merchant: merchant,
            claimSigner: relayer,
            geminiEventId: EVENT_ID,
            instrumentSymbol: SYMBOL,
            payoutPerClaim: payoutPerClaim,
            maxClaims: maxClaims,
            premium: premium,
            claimDeadline: uint64(block.timestamp + 1 days),
            marketCloseTime: uint64(block.timestamp + 3 days),
            hedgeMode: false,
            expiry: uint64(block.timestamp + 90),
            nonce: bytes32(++_nonce)
        });
    }

    /// @dev The EIP-712 digest, built field by field without calling the vault.
    function _digest(PromoVault.Quote memory q) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("PromoVault"), keccak256("1"), block.chainid, address(vault)
            )
        );
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.merchant,
                    q.claimSigner,
                    q.geminiEventId,
                    q.instrumentSymbol,
                    q.payoutPerClaim,
                    q.maxClaims
                ),
                abi.encode(q.premium, q.claimDeadline, q.marketCloseTime, q.hedgeMode, q.expiry, q.nonce)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signWith(uint256 pk, PromoVault.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(q));
        return abi.encodePacked(r, s, v);
    }

    function _sign(PromoVault.Quote memory q) internal view returns (bytes memory) {
        return _signWith(pricerPk, q);
    }

    /// @dev Give the merchant named in the quote the premium and the approval.
    function _fund(PromoVault.Quote memory q) internal {
        usdc.mint(q.merchant, q.premium);
        vm.prank(q.merchant);
        usdc.approve(address(vault), q.premium);
    }

    /// @dev Fund the merchant, sign with the pricer key and create the promo.
    function _create(PromoVault.Quote memory q) internal returns (uint256 promoId) {
        _fund(q);
        bytes memory sig = _sign(q);
        vm.prank(q.merchant);
        promoId = vault.createPromo(q, sig);
    }

    function _createPromo(uint256 payoutPerClaim, uint32 maxClaims, uint256 premium)
        internal
        returns (uint256 promoId)
    {
        return _create(_quote(payoutPerClaim, maxClaims, premium));
    }

    // ------------------------------------------------------------ permits

    /// @dev An EIP-2612 permit from the key's address to the vault, at the owner's current nonce.
    ///      The domain separator is read from the token, as the web app will read it.
    function _signPermit(uint256 ownerPk, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address owner = vm.addr(ownerPk);
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, address(vault), value, usdc.nonces(owner), deadline)
        );
        return vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    /// @dev Give the merchant the premium but no approval, and create the promo with a permit
    ///      the merchant signs for exactly the premium.
    function _createWithPermit(PromoVault.Quote memory q) internal returns (uint256 promoId) {
        usdc.mint(q.merchant, q.premium);
        bytes memory sig = _sign(q);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(merchantPk, q.premium, deadline);
        vm.prank(q.merchant);
        promoId = vault.createPromoWithPermit(q, sig, deadline, v, r, s);
    }

    // ------------------------------------------------------------ lifecycle

    function _claim(uint256 promoId, address customer) internal {
        vm.prank(vault.getPromo(promoId).claimSigner);
        vault.registerClaim(promoId, customer);
    }

    /// @dev Register `count` new customers, named by promo and position.
    function _claimMany(uint256 promoId, uint256 count) internal returns (address[] memory customers) {
        customers = new address[](count);
        uint256 start = vault.getPromo(promoId).claimCount;
        for (uint256 i = 0; i < count; i++) {
            customers[i] =
                makeAddr(string.concat("customer-", vm.toString(promoId), "-", vm.toString(start + i)));
            _claim(promoId, customers[i]);
        }
    }

    function _warpToClaimDeadline(uint256 promoId) internal {
        uint64 deadline = vault.getPromo(promoId).claimDeadline;
        if (block.timestamp < deadline) vm.warp(deadline);
    }

    /// @dev Warp to the claim deadline if needed and post the result as the oracle.
    function _settle(uint256 promoId, bool outcomeYes) internal {
        _warpToClaimDeadline(promoId);
        vm.prank(oracle);
        vault.settle(promoId, outcomeYes, EVENT_ID_PLAIN, outcomeYes ? "yes" : "no");
    }

    /// @dev Settle, wait out the dispute window and finalize.
    function _settleAndFinalize(uint256 promoId, bool outcomeYes) internal {
        _settle(promoId, outcomeYes);
        vm.warp(block.timestamp + vault.disputeWindow());
        vault.finalize(promoId);
    }

    /// @dev A 50-customer promo: the merchant pays `premium` and `maxPayout` is locked.
    function _openPromo(uint256 premium, uint256 maxPayout) internal returns (uint256 promoId) {
        return _createPromo(maxPayout / 50, 50, premium);
    }
}
