// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {PromoVault} from "../src/PromoVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared setup. Until createPromo exists, a promo's lock is simulated by writing
///      lockedCollateral directly and minting the premium to the vault.
abstract contract VaultTest is Test {
    using stdStorage for StdStorage;

    uint256 internal constant USDC = 1e6;

    MockUSDC internal usdc;
    PromoVault internal vault;

    address internal pricer;
    uint256 internal pricerPk;
    address internal oracle = makeAddr("oracle");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Deposited(address indexed lp, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed lp, uint256 sharesBurned, uint256 amount);

    function setUp() public virtual {
        (pricer, pricerPk) = makeAddrAndKey("pricer");
        usdc = new MockUSDC();
        vault = new PromoVault(usdc, pricer, oracle);
    }

    function _deposit(address lp, uint256 amount) internal returns (uint256 minted) {
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(vault), amount);
        minted = vault.deposit(amount);
        vm.stopPrank();
    }

    function _setLocked(uint256 amount) internal {
        stdstore.target(address(vault)).sig("lockedCollateral()").checked_write(amount);
    }

    /// @dev Stand-in for a promo: `premium` arrives and `maxPayout` is locked.
    function _openPromo(uint256 premium, uint256 maxPayout) internal {
        usdc.mint(address(vault), premium);
        _setLocked(vault.lockedCollateral() + maxPayout);
    }
}
