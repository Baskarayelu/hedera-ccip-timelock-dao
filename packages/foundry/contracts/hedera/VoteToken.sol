// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ERC20Votes } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { ERC20Wrapper } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Wrapper.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { Time } from "@openzeppelin/contracts/utils/types/Time.sol";
import { IHRC719 } from "hedera-forking/IHRC719.sol";

/// @notice Wrap-to-vote: a 1:1 ERC20Votes wrapper around the DAO's HTS governance token.
/// @dev HTS balances move through native transfers that run no EVM code, so an HTS token cannot keep
/// vote checkpoints itself. Voting weight therefore lives here: `getPastVotes(account, snapshot)` is
/// fixed when a proposal starts, so tokens bought, moved or wrapped afterwards cannot vote on it.
/// The clock is the block timestamp because Hedera block numbers track ~2 s record files of irregular
/// length.
contract VoteToken is ERC20, ERC20Permit, ERC20Votes, ERC20Wrapper {
    event UnderlyingAssociated();

    error AssociationFailed();
    error UnexpectedDeposit(uint256 expected, uint256 received);

    constructor(IERC20 underlyingToken, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
        ERC20Wrapper(underlyingToken)
    { }

    /// @notice Associates this contract with the underlying HTS token so it can hold deposits.
    /// @dev Idempotent and harmless, so anyone may call it (the deploy script does). Success is read back
    /// through `isAssociated()` rather than from `associate()`'s return value.
    function associateUnderlying() external {
        IHRC719 token = IHRC719(address(underlying()));
        // forge-lint: disable-next-line(unused-return) success is read back through isAssociated()
        if (!token.isAssociated()) token.associate();
        if (!token.isAssociated()) revert AssociationFailed();
        emit UnderlyingAssociated();
    }

    /// @inheritdoc ERC20Wrapper
    /// @dev Mints only what actually arrived. An HTS token with fractional custom fees would deliver
    /// less than `value` and leave the wrapper under-collateralised, so such deposits revert.
    function depositFor(address account, uint256 value) public override returns (bool) {
        IERC20 token = underlying();
        uint256 before = token.balanceOf(address(this));
        super.depositFor(account, value);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != value) revert UnexpectedDeposit(value, received);
        return true;
    }

    /// @dev ERC-6372: votes are checkpointed by timestamp.
    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function decimals() public view override(ERC20, ERC20Wrapper) returns (uint8) {
        return super.decimals();
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }
}
