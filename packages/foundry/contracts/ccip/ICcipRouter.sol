// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Client } from "./Client.sol";

/// @notice The CCIP Router calls this template makes.
interface ICcipRouter {
    function isChainSupported(uint64 destChainSelector) external view returns (bool);

    /// @return fee In the fee token's units; for native fees on Hedera that is tinybar.
    function getFee(uint64 destChainSelector, Client.EVM2AnyMessage memory message) external view returns (uint256 fee);

    /// @dev The router keeps the whole `msg.value`, so send exactly the quoted fee.
    function ccipSend(uint64 destChainSelector, Client.EVM2AnyMessage calldata message)
        external
        payable
        returns (bytes32 messageId);
}

/// @notice Receiver interface the CCIP OffRamp checks through ERC-165 before delivering data.
interface IAny2EVMMessageReceiver {
    function ccipReceive(Client.Any2EVMMessage calldata message) external;
}
