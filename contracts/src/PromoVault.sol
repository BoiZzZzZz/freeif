// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PromoVault
/// @notice A USDC vault that underwrites "free if X happens" promotions. Liquidity providers deposit
///         USDC and hold shares. Each promo locks its full maximum payout, and that lock is outside
///         the balance LPs can withdraw.
/// @dev All amounts are USDC base units through the ERC-20 interface (6 decimals). On Arc the native
///      gas token is also USDC but with 18 decimals; this contract never touches native value.
contract PromoVault {
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
        uint256 collateralLocked; // payoutPerClaim * maxClaims, the full maximum payout
        uint64 claimDeadline; // claims must register before this; settlement is allowed after it
        uint64 marketCloseTime; // Gemini expiryDate, used only for the void grace period
        uint64 settledAt;
        Status status;
        bool outcomeYes;
        uint32 paidCount;
        bool hedgeMode; // true: one claim, paid to the merchant
    }

    // ---------------------------------------------------------------- constants

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

    error ZeroAmount();
    error FirstDepositTooSmall(uint256 amount, uint256 minimum);
    error ZeroShares();
    error InsufficientShares(uint256 held, uint256 requested);

    // ---------------------------------------------------------------- setup

    constructor(IERC20 usdc_, address pricer_, address oracle_) {
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
    function deposit(uint256 amount) external returns (uint256 sharesMinted) {
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

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, sharesMinted);
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

        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, shareAmount, amount);
    }
}
