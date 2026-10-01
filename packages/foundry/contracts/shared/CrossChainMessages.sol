// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Wire format shared by the Hedera timelock and the remote executor.
library CrossChainMessages {
    uint8 internal constant VERSION = 1;

    /// @dev Longest revert reason carried back in a receipt, to keep receipt fees bounded.
    uint256 internal constant MAX_REVERT_BYTES = 256;

    /// @notice One call the DAO's remote account makes.
    struct Call {
        address target;
        uint256 value; // wei on the remote chain
        bytes data;
    }

    /// @notice Hedera -> remote: a batch to run from the DAO's account.
    /// @dev The batch is atomic. `validUntil` stops a message that was delayed in transit from
    /// executing long after the vote that approved it.
    struct Request {
        uint8 version;
        uint64 validUntil;
        Call[] calls;
    }

    enum Status {
        None,
        Executed,
        Failed,
        Expired
    }

    /// @notice Remote -> Hedera: what happened to a request.
    struct Receipt {
        bytes32 requestId; // CCIP messageId of the request
        Status status;
        uint64 executedAt; // remote block timestamp
        bytes revertData; // first MAX_REVERT_BYTES bytes of the failure reason, empty on success
    }

    function encodeRequest(Request memory request) internal pure returns (bytes memory) {
        return abi.encode(request);
    }

    function decodeRequest(bytes memory data) internal pure returns (Request memory) {
        return abi.decode(data, (Request));
    }

    function encodeReceipt(Receipt memory receipt) internal pure returns (bytes memory) {
        return abi.encode(receipt);
    }

    function decodeReceipt(bytes memory data) internal pure returns (Receipt memory) {
        return abi.decode(data, (Receipt));
    }

    /// @notice Truncates revert data so a hostile target cannot make the receipt expensive to send.
    function truncate(bytes memory data) internal pure returns (bytes memory out) {
        if (data.length <= MAX_REVERT_BYTES) return data;
        out = new bytes(MAX_REVERT_BYTES);
        for (uint256 i; i < MAX_REVERT_BYTES; ++i) {
            out[i] = data[i];
        }
    }
}
