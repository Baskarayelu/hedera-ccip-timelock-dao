// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { Client } from "./Client.sol";
import { IAny2EVMMessageReceiver } from "./ICcipRouter.sol";

/// @notice Accepts CCIP messages from one router and advertises the receiver interface.
/// @dev Without the ERC-165 answer the OffRamp treats the receiver as an EOA and drops the data.
abstract contract CcipReceiverBase is IAny2EVMMessageReceiver {
    address public immutable ccipRouter;

    error ZeroRouter();
    error NotRouter(address caller);

    constructor(address router) {
        if (router == address(0)) revert ZeroRouter();
        ccipRouter = router;
    }

    /// @inheritdoc IAny2EVMMessageReceiver
    function ccipReceive(Client.Any2EVMMessage calldata message) external {
        if (msg.sender != ccipRouter) revert NotRouter(msg.sender);
        _ccipReceive(message);
    }

    function _ccipReceive(Client.Any2EVMMessage calldata message) internal virtual;

    function _supportsCcipReceiver(bytes4 interfaceId) internal pure returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
