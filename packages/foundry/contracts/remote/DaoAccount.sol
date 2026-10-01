// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { CrossChainMessages } from "../shared/CrossChainMessages.sol";

/// @notice A DAO's own account on the remote chain. Only the executor that created it can drive it,
/// and only with batches that arrived over CCIP from that one DAO.
/// @dev Deployed as a minimal clone per (source chain, source DAO), so each DAO gets a distinct
/// address that targets can trust: holding funds or owning contracts here is safe from other DAOs.
contract DaoAccount {
    address public executor;
    uint64 public sourceChainSelector;
    address public sourceDao;

    event CallsExecuted(uint256 count);

    error AlreadyInitialized();
    error NotExecutor(address caller);
    error CallFailed(uint256 index, bytes reason);

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor(msg.sender);
        _;
    }

    /// @dev Called once by the executor in the same transaction that clones the account.
    function initialize(uint64 sourceChainSelector_, address sourceDao_) external {
        if (executor != address(0)) revert AlreadyInitialized();
        executor = msg.sender;
        sourceChainSelector = sourceChainSelector_;
        sourceDao = sourceDao_;
    }

    /// @notice Runs the batch atomically: one failing call reverts all of them.
    function executeCalls(CrossChainMessages.Call[] calldata calls) external onlyExecutor {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{ value: calls[i].value }(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit CallsExecuted(calls.length);
    }

    /// @notice Sends native coin to the executor to pay this DAO's receipt fee.
    function payExecutor(uint256 amount) external onlyExecutor {
        (bool ok,) = executor.call{ value: amount }("");
        if (!ok) revert CallFailed(type(uint256).max, "");
    }

    receive() external payable { }
}
