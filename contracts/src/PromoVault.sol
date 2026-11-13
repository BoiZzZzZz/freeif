// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PromoVault
/// @notice A USDC vault that underwrites "free if X happens" promotions. Liquidity providers deposit
///         USDC and hold shares. Each promo locks its full maximum payout, and that lock is outside
///         the balance LPs can withdraw.
/// @dev All amounts are USDC base units through the ERC-20 interface (6 decimals). On Arc the native
///      gas token is also USDC but with 18 decimals; this contract never touches native value.
contract PromoVault is EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum Status {
        Open, // 0: accepting claims until claimDeadline, then waiting for the result
        Settled, // 1: result posted, dispute window running
        FinalizedYes, // 2: paying claimants
        FinalizedNo, // 3: nothing owed, premium kept
        Vetoed, // 4: guardian rejected the posted result
        PaidOut, // 5: every claimant paid
        Voided // 6: market voided, premium refunded
    }

    struct Promo {
        address merchant;
        address claimSigner; // the only address allowed to register claims for this promo
        bytes32 geminiEventId; // keccak256 of the Gemini event id string
        bytes32 instrumentSymbol; // keccak256 of the Gemini instrument symbol
        uint256 payoutPerClaim;
        uint32 maxClaims;
        uint32 claimCount;
        uint256 premiumPaid;
        uint256 collateralLocked; // what this promo still locks: starts at payoutPerClaim * maxClaims
        uint64 claimDeadline; // claims must register before this; settlement is allowed after it
        uint64 marketCloseTime; // Gemini expiryDate, used only for the void grace period
        uint64 settledAt;
        Status status;
        bool outcomeYes;
        uint32 paidCount;
        bool hedgeMode; // true: one claim, paid to the merchant
    }

    /// @notice A price for one promo, signed by the pricer as EIP-712 typed data.
    /// @dev Every field is a static type, so the struct ABI-encodes as its fields in order. Both
    ///      quoteDigest and the PromoCreated event rely on that.
    struct Quote {
        address merchant; // the only address that may use this quote
        address claimSigner; // copied into the promo
        bytes32 geminiEventId;
        bytes32 instrumentSymbol;
        uint256 payoutPerClaim;
        uint32 maxClaims;
        uint256 premium; // what the merchant pays
        uint64 claimDeadline;
        uint64 marketCloseTime;
        bool hedgeMode;
        uint64 expiry; // the quote is unusable at or after this time
        bytes32 nonce; // usable once
    }

    // ---------------------------------------------------------------- constants

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address merchant,address claimSigner,bytes32 geminiEventId,bytes32 instrumentSymbol,uint256 payoutPerClaim,uint32 maxClaims,uint256 premium,uint64 claimDeadline,uint64 marketCloseTime,bool hedgeMode,uint64 expiry,bytes32 nonce)"
    );

    /// @notice Shares minted to DEAD_ADDRESS on the first deposit and never redeemable.
    /// @dev Stops the first depositor from inflating the share price with a donation so that later
    ///      deposits round down to nothing. Costs the first depositor 0.001 USDC.
    uint256 public constant DEAD_SHARES = 1_000;
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ---------------------------------------------------------------- state

    IERC20 public immutable usdc;

    address public owner; // guardian: can veto during the dispute window, set keys, pause
    address public pricer; // signs EIP-712 quotes
    address public oracle; // posts settlements

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    /// @notice Sum of the unpaid maximum payouts of every open promo. LPs cannot withdraw it.
    uint256 public lockedCollateral;

    uint16 public maxExposureBps = 2000; // one promo may put at risk at most 20% of the free balance
    uint32 public disputeWindow = 3600; // seconds between settle and finalize
    uint32 public voidGrace = 7 days; // wait after marketCloseTime before a promo can be voided
    bool public paused;

    mapping(bytes32 => bool) public usedQuoteNonce;

    /// @dev Not public: the generated getter for a 16-field struct is too deep for the stack
    ///      without via-ir. Read promos through getPromo and promoCount.
    Promo[] internal promos;
    mapping(uint256 => address[]) public claimants; // promoId => customers, in registration order
    mapping(uint256 => mapping(address => bool)) public hasClaim;

    // ---------------------------------------------------------------- events and errors

    event Deposited(address indexed lp, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed lp, uint256 sharesBurned, uint256 amount);
    /// @dev The data is the quote's twelve fields in order, one word each.
    event PromoCreated(
        uint256 indexed promoId, address indexed merchant, bytes32 indexed instrumentSymbol, Quote quote
    );
    event ClaimRegistered(uint256 indexed promoId, address indexed customer, uint32 claimCount);
    /// @dev The plain Gemini event id and resolution side, so anyone can check the result against
    ///      Gemini's settled-events list.
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
    event PricerSet(address indexed pricer);
    event OracleSet(address indexed oracle);
    event MaxExposureBpsSet(uint16 bps);
    event DisputeWindowSet(uint32 window);
    event VoidGraceSet(uint32 grace);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error NotOwner();
    error NotOracle();
    error ZeroAddress();
    error ExposureCapTooHigh(uint16 bps);
    error VaultPaused();
    error ZeroAmount();
    error FirstDepositTooSmall(uint256 amount, uint256 minimum);
    error ZeroShares();
    error InsufficientShares(uint256 held, uint256 requested);
    error UnknownPromo(uint256 promoId);
    error NotQuoteMerchant();
    error QuoteExpired(uint64 expiry);
    error QuoteNonceUsed(bytes32 nonce);
    error InvalidQuoteSignature();
    error ClaimDeadlinePassed(uint64 claimDeadline);
    error ClaimDeadlineAfterClose(uint64 claimDeadline, uint64 marketCloseTime);
    error HedgeNeedsOneClaim(uint32 maxClaims);
    error PremiumAboveMaxPayout(uint256 premium, uint256 maxPayout);
    error ExposureTooHigh(uint256 vaultRisk, uint256 cap);
    error NotClaimSigner();
    error WrongStatus(Status status);
    error ClaimsClosed(uint64 claimDeadline);
    error PromoFull(uint32 maxClaims);
    error AlreadyClaimed(address customer);
    error ClaimsStillOpen(uint64 claimDeadline);
    error EventIdMismatch();
    error DisputeWindowOver(uint256 windowEnd);
    error DisputeWindowOpen(uint256 windowEnd);
    error VoidGraceNotOver(uint256 voidableAfter);

    // ---------------------------------------------------------------- setup

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    /// @dev Only on the functions that take new money or new risk. Withdrawals, settlement and
    ///      every payout path stay open, so a pause cannot trap funds.
    modifier whenNotPaused() {
        if (paused) revert VaultPaused();
        _;
    }

    constructor(IERC20 usdc_, address pricer_, address oracle_) EIP712("PromoVault", "1") {
        if (address(usdc_) == address(0) || pricer_ == address(0) || oracle_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        owner = msg.sender;
        pricer = pricer_;
        oracle = oracle_;
    }

    // ---------------------------------------------------------------- views

    function promoCount() external view returns (uint256) {
        return promos.length;
    }

    function getPromo(uint256 promoId) external view returns (Promo memory) {
        return _promo(promoId);
    }

    /// @notice Every customer registered for a promo, in registration order.
    function getClaimants(uint256 promoId) external view returns (address[] memory) {
        return claimants[promoId];
    }

    /// @notice The EIP-712 digest the pricer signs for a quote, under this vault's domain
    ///         (name "PromoVault", version "1", this chain, this address).
    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        // Quote has only static fields, so this is the typehash followed by each field in a word.
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q)));
    }

    function _promo(uint256 promoId) internal view returns (Promo storage) {
        if (promoId >= promos.length) revert UnknownPromo(promoId);
        return promos[promoId];
    }

    // ---------------------------------------------------------------- liquidity providers

    /// @notice USDC that is not locked behind an open promo. Shares are priced against this.
    /// @dev The checked subtraction is deliberate: if the vault ever held less than it has locked,
    ///      every deposit and withdrawal reverts here.
    function freeBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this)) - lockedCollateral;
    }

    /// @notice Deposit USDC and receive shares of the free balance.
    /// @param amount USDC base units. The caller must have approved the vault for it.
    /// @return sharesMinted Shares credited to the caller.
    function deposit(uint256 amount) external whenNotPaused returns (uint256 sharesMinted) {
        if (amount == 0) revert ZeroAmount();

        if (totalShares == 0) {
            // First deposit: 1 share per base unit, with DEAD_SHARES of them locked forever.
            if (amount <= DEAD_SHARES) revert FirstDepositTooSmall(amount, DEAD_SHARES + 1);
            sharesMinted = amount - DEAD_SHARES;
            shares[DEAD_ADDRESS] = DEAD_SHARES;
            totalShares = DEAD_SHARES;
        } else {
            // Priced before the transfer arrives. Rounds down, in favor of existing LPs.
            sharesMinted = amount * totalShares / freeBalance();
            if (sharesMinted == 0) revert ZeroShares();
        }

        totalShares += sharesMinted;
        shares[msg.sender] += sharesMinted;

        emit Deposited(msg.sender, amount, sharesMinted);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Burn shares for their portion of the free balance.
    /// @dev The payout is a fraction of freeBalance(), so it can never reach locked collateral:
    ///      burning every share in existence pays out at most the free balance.
    /// @param shareAmount Shares to burn.
    /// @return amount USDC base units sent to the caller.
    function withdraw(uint256 shareAmount) external returns (uint256 amount) {
        if (shareAmount == 0) revert ZeroAmount();
        uint256 held = shares[msg.sender];
        if (shareAmount > held) revert InsufficientShares(held, shareAmount);

        // Rounds down, in favor of the LPs who stay.
        amount = shareAmount * freeBalance() / totalShares;

        shares[msg.sender] = held - shareAmount;
        totalShares -= shareAmount;

        emit Withdrawn(msg.sender, shareAmount, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------- promos

    /// @notice Open a promo from a quote signed by the pricer. The caller pays the premium and the
    ///         vault locks the full maximum payout.
    /// @dev The caller must have approved the vault for q.premium.
    /// @return promoId Index of the new promo.
    function createPromo(Quote calldata q, bytes calldata sig)
        external
        whenNotPaused
        returns (uint256 promoId)
    {
        if (q.merchant != msg.sender) revert NotQuoteMerchant();
        if (q.expiry <= block.timestamp) revert QuoteExpired(q.expiry);
        if (usedQuoteNonce[q.nonce]) revert QuoteNonceUsed(q.nonce);
        if (q.payoutPerClaim == 0 || q.maxClaims == 0) revert ZeroAmount();
        if (q.claimDeadline <= block.timestamp) revert ClaimDeadlinePassed(q.claimDeadline);
        if (q.claimDeadline > q.marketCloseTime) {
            revert ClaimDeadlineAfterClose(q.claimDeadline, q.marketCloseTime);
        }
        if (q.hedgeMode && q.maxClaims != 1) revert HedgeNeedsOneClaim(q.maxClaims);

        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(quoteDigest(q), sig);
        if (err != ECDSA.RecoverError.NoError || signer != pricer) revert InvalidQuoteSignature();

        uint256 maxPayout = q.payoutPerClaim * q.maxClaims;
        if (q.premium > maxPayout) revert PremiumAboveMaxPayout(q.premium, maxPayout);
        {
            // The vault's own money at risk, against the free balance before the premium arrives.
            // The cap is at most 100%, so vaultRisk <= freeBalance, which is exactly what keeps
            // balance >= lockedCollateral once the premium is in and the payout is locked.
            uint256 vaultRisk = maxPayout - q.premium;
            uint256 cap = freeBalance() * maxExposureBps / 10_000;
            if (vaultRisk > cap) revert ExposureTooHigh(vaultRisk, cap);
        }

        usedQuoteNonce[q.nonce] = true;
        lockedCollateral += maxPayout;

        promoId = promos.length;
        Promo storage p = promos.push();
        p.merchant = q.merchant;
        p.claimSigner = q.claimSigner;
        p.geminiEventId = q.geminiEventId;
        p.instrumentSymbol = q.instrumentSymbol;
        p.payoutPerClaim = q.payoutPerClaim;
        p.maxClaims = q.maxClaims;
        p.premiumPaid = q.premium;
        p.collateralLocked = maxPayout;
        p.claimDeadline = q.claimDeadline;
        p.marketCloseTime = q.marketCloseTime;
        p.hedgeMode = q.hedgeMode;

        if (q.hedgeMode) {
            // The merchant is the one claimant, so a "yes" pays the merchant.
            p.claimCount = 1;
            hasClaim[promoId][q.merchant] = true;
            claimants[promoId].push(q.merchant);
        }

        emit PromoCreated(promoId, q.merchant, q.instrumentSymbol, q);
        if (q.hedgeMode) emit ClaimRegistered(promoId, q.merchant, 1);

        usdc.safeTransferFrom(msg.sender, address(this), q.premium);
    }

    /// @notice Register a customer for a promo. Only the promo's claim signer (the relayer named
    ///         in the quote) may call this; the merchant and the owner cannot.
    /// @dev In hedge mode the one claim is taken at creation, so this always reverts.
    function registerClaim(uint256 promoId, address customer) external whenNotPaused {
        Promo storage p = _promo(promoId);
        if (msg.sender != p.claimSigner) revert NotClaimSigner();
        if (p.status != Status.Open) revert WrongStatus(p.status);
        if (block.timestamp >= p.claimDeadline) revert ClaimsClosed(p.claimDeadline);
        if (p.claimCount >= p.maxClaims) revert PromoFull(p.maxClaims);
        if (customer == address(0)) revert ZeroAddress();
        if (hasClaim[promoId][customer]) revert AlreadyClaimed(customer);

        uint32 count = p.claimCount + 1;
        p.claimCount = count;
        hasClaim[promoId][customer] = true;
        claimants[promoId].push(customer);

        emit ClaimRegistered(promoId, customer, count);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Post the market result for a promo. Starts the dispute window.
    /// @dev Allowed from claimDeadline on, which is exactly when claims stop. The plain event id
    ///      must hash to the id the promo was created with; it and the resolution side are only
    ///      emitted, not stored.
    /// @param outcomeYes True if the promo's contract resolved "yes", so customers are owed.
    /// @param geminiEventIdPlain The Gemini event id as a string, for example "362998".
    /// @param resolutionSide The resolutionSide field Gemini published for the contract.
    function settle(
        uint256 promoId,
        bool outcomeYes,
        string calldata geminiEventIdPlain,
        string calldata resolutionSide
    ) external onlyOracle {
        Promo storage p = _promo(promoId);
        if (p.status != Status.Open) revert WrongStatus(p.status);
        if (block.timestamp < p.claimDeadline) revert ClaimsStillOpen(p.claimDeadline);
        if (keccak256(bytes(geminiEventIdPlain)) != p.geminiEventId) revert EventIdMismatch();

        p.outcomeYes = outcomeYes;
        p.settledAt = uint64(block.timestamp);
        p.status = Status.Settled;

        emit Settled(promoId, outcomeYes, geminiEventIdPlain, resolutionSide, uint64(block.timestamp));
    }

    /// @notice Reject a posted result. Only while its dispute window is running.
    /// @dev The promo keeps its full lock. From here the owner either calls resetSettlement so
    ///      the oracle can post again, or voids the promo once the void grace period has passed.
    function veto(uint256 promoId) external onlyOwner {
        Promo storage p = _promo(promoId);
        if (p.status != Status.Settled) revert WrongStatus(p.status);
        uint256 windowEnd = _disputeWindowEnd(p);
        if (block.timestamp >= windowEnd) revert DisputeWindowOver(windowEnd);

        p.status = Status.Vetoed;

        emit Vetoed(promoId);
    }

    /// @notice Clear a vetoed result and reopen the promo for the oracle to settle again.
    /// @dev Claims do not reopen: the claim deadline has already passed.
    function resetSettlement(uint256 promoId) external onlyOwner {
        Promo storage p = _promo(promoId);
        if (p.status != Status.Vetoed) revert WrongStatus(p.status);

        p.status = Status.Open;
        p.outcomeYes = false;
        p.settledAt = 0;

        emit SettlementReset(promoId);
    }

    /// @notice Make a posted result final once its dispute window has ended. Anyone may call.
    /// @dev "Yes": the lock shrinks to what the registered customers are owed, and the promo waits
    ///      for payoutBatch (with no customers it is PaidOut at once). "No": the whole lock is
    ///      released, and the premium inside it becomes free balance, which is the LPs' earning.
    function finalize(uint256 promoId) external {
        Promo storage p = _promo(promoId);
        if (p.status != Status.Settled) revert WrongStatus(p.status);
        uint256 windowEnd = _disputeWindowEnd(p);
        if (block.timestamp < windowEnd) revert DisputeWindowOpen(windowEnd);

        bool outcomeYes = p.outcomeYes;
        uint256 released;
        if (outcomeYes) {
            released = p.payoutPerClaim * (p.maxClaims - p.claimCount);
            p.status = p.claimCount == 0 ? Status.PaidOut : Status.FinalizedYes;
        } else {
            released = p.collateralLocked;
            p.status = Status.FinalizedNo;
        }
        p.collateralLocked -= released;
        lockedCollateral -= released;

        emit Finalized(promoId, outcomeYes, released);
    }

    /// @notice Cancel a promo whose market Gemini voided or never settled: the merchant gets the
    ///         premium back and the whole lock is released.
    /// @dev Only for a promo with no standing result (Open or Vetoed), and only once voidGrace has
    ///      passed since the market close. The refund is always covered: the premium is at most
    ///      the lock this call releases.
    function voidPromo(uint256 promoId) external onlyOwner {
        Promo storage p = _promo(promoId);
        if (p.status != Status.Open && p.status != Status.Vetoed) revert WrongStatus(p.status);
        uint256 voidableAfter = uint256(p.marketCloseTime) + voidGrace;
        if (block.timestamp <= voidableAfter) revert VoidGraceNotOver(voidableAfter);

        address promoMerchant = p.merchant;
        uint256 refund = p.premiumPaid;
        lockedCollateral -= p.collateralLocked;
        p.collateralLocked = 0;
        p.status = Status.Voided;

        emit Voided(promoId, promoMerchant, refund);
        usdc.safeTransfer(promoMerchant, refund);
    }

    /// @notice Pay the next `count` registered customers of a promo that finalized "yes". Anyone
    ///         may call; the keeper calls it in batches of 50.
    /// @dev Customers are paid in registration order, payoutPerClaim each, out of the promo's lock.
    ///      A count above what is left pays what is left. The promo is PaidOut after the last one.
    /// @return paid How many customers this call paid.
    function payoutBatch(uint256 promoId, uint32 count) external returns (uint32 paid) {
        Promo storage p = _promo(promoId);
        if (p.status != Status.FinalizedYes) revert WrongStatus(p.status);
        if (count == 0) revert ZeroAmount();

        uint32 start = p.paidCount;
        uint32 remaining = p.claimCount - start;
        paid = count < remaining ? count : remaining;
        uint32 end = start + paid;
        uint256 amount = p.payoutPerClaim;

        p.paidCount = end;
        p.collateralLocked -= amount * paid;
        lockedCollateral -= amount * paid;
        if (end == p.claimCount) p.status = Status.PaidOut;

        address[] storage list = claimants[promoId];
        for (uint32 i = start; i < end; i++) {
            address customer = list[i];
            emit Paid(promoId, customer, amount);
            usdc.safeTransfer(customer, amount);
        }
    }

    /// @dev The first moment a settled promo can be finalized, and the first moment a veto is
    ///      too late. Uses the current disputeWindow, not the one in force when it was settled.
    function _disputeWindowEnd(Promo storage p) internal view returns (uint256) {
        return uint256(p.settledAt) + disputeWindow;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Change the key that signs quotes. Quotes signed by the old key stop working.
    function setPricer(address pricer_) external onlyOwner {
        if (pricer_ == address(0)) revert ZeroAddress();
        pricer = pricer_;
        emit PricerSet(pricer_);
    }

    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    /// @notice Share of the free balance one promo may put at risk, in basis points.
    /// @dev Never above 100%: createPromo relies on vaultRisk <= freeBalance to keep the vault's
    ///      balance at or above lockedCollateral.
    function setMaxExposureBps(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert ExposureCapTooHigh(bps);
        maxExposureBps = bps;
        emit MaxExposureBpsSet(bps);
    }

    /// @notice Seconds between settle and finalize. Applies to promos already settled as well.
    function setDisputeWindow(uint32 window) external onlyOwner {
        disputeWindow = window;
        emit DisputeWindowSet(window);
    }

    function setVoidGrace(uint32 grace) external onlyOwner {
        voidGrace = grace;
        emit VoidGraceSet(grace);
    }

    /// @notice Stop new deposits, new promos and new claims. Nothing else is affected.
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
