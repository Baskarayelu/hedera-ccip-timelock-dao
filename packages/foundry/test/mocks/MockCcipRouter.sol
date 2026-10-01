// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { Client } from "../../contracts/ccip/Client.sol";
import { IAny2EVMMessageReceiver } from "../../contracts/ccip/ICcipRouter.sol";

/// @notice One chain's CCIP router for tests. Two instances with different selectors model two chains
/// in one EVM; `deliver` on the destination router plays the OffRamp.
/// @dev Unlike the real router, this one keeps each message in storage, so `ccipSend` costs more gas
/// here than on a live network; tests size destination gas with that in mind.
contract MockCcipRouter {
    struct Sent {
        uint64 destChain;
        address sender;
        address receiver;
        bytes data;
        uint256 gasLimit;
        uint256 paid;
        bool delivered;
    }

    uint64 public immutable chainSelector;
    uint256 public fee;
    bool public sendsFail;

    mapping(bytes32 messageId => Sent) internal _sent;
    bytes32[] public sentIds;

    event MessageSent(bytes32 indexed messageId, uint64 indexed destChain, address sender, address receiver);

    constructor(uint64 chainSelector_, uint256 fee_) {
        chainSelector = chainSelector_;
        fee = fee_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setSendsFail(bool fail) external {
        sendsFail = fail;
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return fee;
    }

    function ccipSend(uint64 destChain, Client.EVM2AnyMessage calldata message)
        external
        payable
        returns (bytes32 messageId)
    {
        require(!sendsFail, "router: send disabled");
        require(msg.value >= fee, "router: insufficient fee");
        require(bytes4(message.extraArgs[:4]) == Client.GENERIC_EXTRA_ARGS_V2_TAG, "router: bad extraArgs");
        (uint256 gasLimit,) = abi.decode(message.extraArgs[4:], (uint256, bool));

        messageId = keccak256(abi.encode(chainSelector, sentIds.length, msg.sender, message.data));
        _sent[messageId] = Sent({
            destChain: destChain,
            sender: msg.sender,
            receiver: abi.decode(message.receiver, (address)),
            data: message.data,
            gasLimit: gasLimit,
            paid: msg.value,
            delivered: false
        });
        sentIds.push(messageId);
        emit MessageSent(messageId, destChain, msg.sender, _sent[messageId].receiver);
    }

    function sent(bytes32 messageId) external view returns (Sent memory) {
        return _sent[messageId];
    }

    function sentCount() external view returns (uint256) {
        return sentIds.length;
    }

    function lastMessageId() external view returns (bytes32) {
        return sentIds[sentIds.length - 1];
    }

    function markDelivered(bytes32 messageId) external {
        _sent[messageId].delivered = true;
    }

    /// @notice Delivers `messageId` from `source` to its receiver on this chain, with the requested gas.
    function deliver(MockCcipRouter source, bytes32 messageId) external {
        Sent memory m = source.sent(messageId);
        require(m.destChain == chainSelector, "router: wrong destination");
        require(!m.delivered, "router: already delivered");
        require(
            IERC165(m.receiver).supportsInterface(type(IAny2EVMMessageReceiver).interfaceId),
            "router: receiver does not support CCIP"
        );
        source.markDelivered(messageId);
        IAny2EVMMessageReceiver(m.receiver).ccipReceive{ gas: m.gasLimit }(
            Client.Any2EVMMessage({
                messageId: messageId,
                sourceChainSelector: source.chainSelector(),
                sender: abi.encode(m.sender),
                data: m.data,
                destTokenAmounts: new Client.EVMTokenAmount[](0)
            })
        );
    }

    /// @notice Calls `receiver.ccipReceive` with an arbitrary message, as a compromised or mistaken
    /// router would, to test receiver authentication.
    function deliverRaw(address receiver, Client.Any2EVMMessage calldata message) external {
        IAny2EVMMessageReceiver(receiver).ccipReceive(message);
    }
}
