// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @dev Stand-in for Arc's USDC ERC-20 interface: 6 decimals, anyone can mint, EIP-2612 permit,
///      and a blocklist that anyone can set. Like USDC, a transfer to or from a blocked address
///      reverts. The permit domain is not Arc's (that is name "USDC", version "2"), so tests read
///      DOMAIN_SEPARATOR() from the token, as a client should.
contract MockUSDC is ERC20, ERC20Permit {
    error Blocked(address account);

    mapping(address => bool) public blocked;

    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
