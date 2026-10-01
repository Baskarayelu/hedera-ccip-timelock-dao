// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC-20 standing in for the HTS token's ERC-20 facade, or for USDC on the remote chain.
contract MockERC20 is ERC20 {
    uint8 internal immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Token that skims 1% on every transfer, like an HTS token with a fractional custom fee.
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 6) { }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value / 100;
        super._update(from, address(0xFEE), fee);
        super._update(from, to, value - fee);
    }
}

/// @notice Target that always reverts with a long reason, to test receipt truncation.
contract Reverter {
    function boom() external pure {
        revert(
            "this revert reason is deliberately much longer than the receipt limit so the executor must truncate it before it pays to send it back across chains, otherwise a hostile target could make every receipt arbitrarily expensive for the DAO that called it"
        );
    }
}
