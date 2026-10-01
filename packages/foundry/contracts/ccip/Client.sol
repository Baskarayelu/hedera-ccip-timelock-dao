// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink CCIP message types (ABI-compatible with Router 1.2.0).
/// @dev Written for this template instead of importing chainlink-evm, which is ~800 MB to install.
library Client {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    /// @dev Outbound message: `receiver` is `abi.encode(address)` for EVM destinations.
    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken; // address(0) pays in the chain's native coin
        bytes extraArgs;
    }

    /// @dev Inbound message delivered to `ccipReceive`: `sender` is `abi.encode(address)` for EVM sources.
    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    /// @dev `GenericExtraArgsV2` tag: bytes4(keccak256("CCIP GenericExtraArgsV2")).
    bytes4 internal constant GENERIC_EXTRA_ARGS_V2_TAG = 0x181dcf10;

    /// @notice Encodes the destination gas limit for `ccipReceive`.
    /// @dev Out-of-order execution is allowed: messages carry their own replay key and expiry.
    function extraArgsV2(uint256 gasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(GENERIC_EXTRA_ARGS_V2_TAG, abi.encode(gasLimit, true));
    }
}
