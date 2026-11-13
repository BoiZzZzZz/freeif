// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PromoVault} from "../src/PromoVault.sol";
import {VaultTest} from "./VaultTest.sol";

contract AdminTest is VaultTest {
    event PricerSet(address indexed pricer);
    event OracleSet(address indexed oracle);
    event MaxExposureBpsSet(uint16 bps);
    event DisputeWindowSet(uint32 window);
    event VoidGraceSet(uint32 grace);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        new PromoVault(IERC20(address(0)), pricer, oracle);
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        new PromoVault(usdc, address(0), oracle);
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        new PromoVault(usdc, pricer, address(0));
    }

    function test_setPricer_setsAndEmits() public {
        vm.expectEmit(address(vault));
        emit PricerSet(bob);
        vault.setPricer(bob);
        assertEq(vault.pricer(), bob);
    }

    function test_setPricer_revertsOnZeroAddress() public {
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        vault.setPricer(address(0));
    }

    function test_setOracle_setsAndEmits() public {
        vm.expectEmit(address(vault));
        emit OracleSet(bob);
        vault.setOracle(bob);
        assertEq(vault.oracle(), bob);
    }

    function test_setOracle_revertsOnZeroAddress() public {
        vm.expectRevert(PromoVault.ZeroAddress.selector);
        vault.setOracle(address(0));
    }

    function test_setMaxExposureBps_setsAndEmits() public {
        vm.expectEmit(address(vault));
        emit MaxExposureBpsSet(10_000);
        vault.setMaxExposureBps(10_000);
        assertEq(vault.maxExposureBps(), 10_000);
    }

    function test_setMaxExposureBps_revertsAbove100Percent() public {
        vm.expectRevert(abi.encodeWithSelector(PromoVault.ExposureCapTooHigh.selector, 10_001));
        vault.setMaxExposureBps(10_001);
    }

    function test_setDisputeWindow_setsAndEmits() public {
        vm.expectEmit(address(vault));
        emit DisputeWindowSet(120);
        vault.setDisputeWindow(120);
        assertEq(vault.disputeWindow(), 120);
    }

    function test_setVoidGrace_setsAndEmits() public {
        vm.expectEmit(address(vault));
        emit VoidGraceSet(600);
        vault.setVoidGrace(600);
        assertEq(vault.voidGrace(), 600);
    }

    function test_pause_andUnpause_setAndEmit() public {
        vm.expectEmit(address(vault));
        emit Paused(address(this));
        vault.pause();
        assertTrue(vault.paused());

        vm.expectEmit(address(vault));
        emit Unpaused(address(this));
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_everyAdminFunction_revertsForNonOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.setPricer(alice);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.setOracle(alice);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.setMaxExposureBps(1);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.setDisputeWindow(1);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.setVoidGrace(1);
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.pause();
        vm.expectRevert(PromoVault.NotOwner.selector);
        vault.unpause();
        vm.stopPrank();
    }

    function test_pause_blocksDeposit() public {
        _deposit(alice, 100 * USDC);
        vault.pause();

        usdc.mint(bob, 10 * USDC);
        vm.startPrank(bob);
        usdc.approve(address(vault), 10 * USDC);
        vm.expectRevert(PromoVault.VaultPaused.selector);
        vault.deposit(10 * USDC);
        vm.stopPrank();

        vault.unpause();
        _deposit(bob, 10 * USDC);
    }

    /// A pause must never trap LP funds.
    function test_pause_doesNotBlockWithdraw() public {
        uint256 aliceShares = _deposit(alice, 100 * USDC);
        vault.pause();

        vm.prank(alice);
        uint256 out = vault.withdraw(aliceShares);

        assertEq(out, aliceShares);
    }
}
