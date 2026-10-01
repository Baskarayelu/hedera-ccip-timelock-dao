// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { IHRC719 } from "hedera-forking/IHRC719.sol";

import { Client } from "../ccip/Client.sol";
import { CcipReceiverBase } from "../ccip/CcipReceiverBase.sol";
import { ICcipRouter } from "../ccip/ICcipRouter.sol";
import { CrossChainMessages } from "../shared/CrossChainMessages.sol";

/// @notice The DAO's timelock and treasury, with a Chainlink CCIP outbox and receipt inbox.
/// @dev OpenZeppelin's TimelockController plus:
/// 1. `sendCrossChain`, callable only by an executing operation, which sends a call batch to this DAO's
///    account on another chain. The fee is quoted at execution and paid from the treasury, capped by
///    the `maxFee` the proposal was voted with.
/// 2. `ccipReceive`, which records the remote executor's receipt for each request.
/// The keeperless scheduling lives in {DaoGovernor}, which queues and executes through this contract.
contract DaoTimelock is TimelockController, CcipReceiverBase {
    struct Outbound {
        uint64 destChain;
        uint64 sentAt;
        uint64 validUntil;
        bytes32 operationId; // timelock operation that sent it
        uint256 fee; // tinybar
    }

    /// @dev Fixed-size on purpose: receipt gas must not depend on how a remote target reverted. The
    /// revert reason travels in the {CrossChainReceipt} event instead.
    struct Inbound {
        CrossChainMessages.Status status;
        uint64 executedAt; // remote timestamp
        uint64 receivedAt;
        bytes32 receiptMessageId;
    }

    /// @notice Seconds a cross-chain request stays executable on the remote chain.
    uint64 public requestTtl;

    mapping(uint64 chainSelector => address executor) public remoteExecutors;
    mapping(bytes32 messageId => Outbound) public outbound;
    mapping(bytes32 messageId => Inbound) internal _inbound;

    bytes32 private transient _executingOperation;

    event RemoteExecutorSet(uint64 indexed chainSelector, address executor);
    event RequestTtlChanged(uint64 ttl);
    event TokenAssociated(address indexed token);
    event CrossChainRequestSent(
        bytes32 indexed messageId,
        bytes32 indexed operationId,
        uint64 indexed destChain,
        address executor,
        uint256 fee,
        uint64 validUntil
    );
    event CrossChainReceipt(
        bytes32 indexed requestId,
        bytes32 indexed operationId,
        bytes32 receiptMessageId,
        CrossChainMessages.Status status,
        uint64 executedAt,
        bytes revertData
    );

    error OnlySelf();
    error OnlySelfOrAdmin();
    error UnknownDestination(uint64 chainSelector);
    error FeeAboveCap(uint256 fee, uint256 maxFee);
    error UnknownSender(uint64 chainSelector, bytes sender);
    error UnknownRequest(bytes32 requestId);
    error DuplicateReceipt(bytes32 requestId);
    error AssociationFailed(address token);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    /// @dev The admin exists only while the deploy script wires the DAO; it renounces afterwards.
    modifier onlySelfOrAdmin() {
        if (msg.sender != address(this) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert OnlySelfOrAdmin();
        _;
    }

    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin,
        address router,
        uint64 requestTtl_
    ) TimelockController(minDelay, proposers, executors, admin) CcipReceiverBase(router) {
        requestTtl = requestTtl_;
    }

    /// @inheritdoc TimelockController
    /// @dev Records which operation is running so cross-chain requests can name it.
    function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt)
        public
        payable
        override
    {
        bytes32 previous = _executingOperation;
        _executingOperation = hashOperation(target, value, payload, predecessor, salt);
        super.execute(target, value, payload, predecessor, salt);
        _executingOperation = previous;
    }

    /// @inheritdoc TimelockController
    /// @dev Records which operation is running so cross-chain requests can name it.
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        bytes32 previous = _executingOperation;
        _executingOperation = hashOperationBatch(targets, values, payloads, predecessor, salt);
        super.executeBatch(targets, values, payloads, predecessor, salt);
        _executingOperation = previous;
    }

    // ---------------------------------------------------------------------------------------------
    // Cross-chain outbox and receipts
    // ---------------------------------------------------------------------------------------------

    /// @notice Sends `calls` to this DAO's account on `destChain`. Only an executing operation can call it.
    /// @param destGasLimit Gas for `ccipReceive` on the destination, covering the calls and the receipt.
    /// @param maxFee Highest CCIP fee (tinybar) the proposal approved; the actual fee is quoted now.
    function sendCrossChain(
        uint64 destChain,
        CrossChainMessages.Call[] calldata calls,
        uint256 destGasLimit,
        uint256 maxFee
    ) external onlySelf returns (bytes32 messageId) {
        address executor = remoteExecutors[destChain];
        if (executor == address(0)) revert UnknownDestination(destChain);

        uint64 validUntil = uint64(block.timestamp) + requestTtl;
        CrossChainMessages.Request memory request;
        request.version = CrossChainMessages.VERSION;
        request.validUntil = validUntil;
        request.calls = calls;

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(executor),
            data: CrossChainMessages.encodeRequest(request),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: Client.extraArgsV2(destGasLimit)
        });

        uint256 fee = ICcipRouter(ccipRouter).getFee(destChain, message);
        if (fee > maxFee) revert FeeAboveCap(fee, maxFee);
        messageId = ICcipRouter(ccipRouter).ccipSend{ value: fee }(destChain, message);

        bytes32 operationId = _executingOperation;
        outbound[messageId] = Outbound({
            destChain: destChain,
            sentAt: uint64(block.timestamp),
            validUntil: validUntil,
            operationId: operationId,
            fee: fee
        });
        emit CrossChainRequestSent(messageId, operationId, destChain, executor, fee, validUntil);
    }

    /// @notice The remote outcome of a request this timelock sent (status `None` until the receipt lands).
    function receiptOf(bytes32 requestId) external view returns (Inbound memory) {
        return _inbound[requestId];
    }

    function setRemoteExecutor(uint64 chainSelector, address executor) external onlySelfOrAdmin {
        remoteExecutors[chainSelector] = executor;
        emit RemoteExecutorSet(chainSelector, executor);
    }

    function setRequestTtl(uint64 ttl) external onlySelf {
        requestTtl = ttl;
        emit RequestTtlChanged(ttl);
    }

    /// @notice Associates the treasury with an HTS token so it can hold it (HIP-719).
    function associateToken(address token) external onlySelfOrAdmin {
        if (!IHRC719(token).isAssociated()) IHRC719(token).associate();
        if (!IHRC719(token).isAssociated()) revert AssociationFailed(token);
        emit TokenAssociated(token);
    }

    /// @dev Accepts receipts only from the executor registered for the source chain, and only for
    /// requests this timelock sent. Each request gets one receipt.
    function _ccipReceive(Client.Any2EVMMessage calldata message) internal override {
        address executor = remoteExecutors[message.sourceChainSelector];
        if (executor == address(0) || message.sender.length != 32 || abi.decode(message.sender, (address)) != executor)
        {
            revert UnknownSender(message.sourceChainSelector, message.sender);
        }

        CrossChainMessages.Receipt memory receipt = CrossChainMessages.decodeReceipt(message.data);
        Outbound memory sent = outbound[receipt.requestId];
        if (sent.sentAt == 0 || sent.destChain != message.sourceChainSelector) {
            revert UnknownRequest(receipt.requestId);
        }
        if (_inbound[receipt.requestId].status != CrossChainMessages.Status.None) {
            revert DuplicateReceipt(receipt.requestId);
        }

        _inbound[receipt.requestId] = Inbound({
            status: receipt.status,
            executedAt: receipt.executedAt,
            receivedAt: uint64(block.timestamp),
            receiptMessageId: message.messageId
        });
        emit CrossChainReceipt(
            receipt.requestId,
            sent.operationId,
            message.messageId,
            receipt.status,
            receipt.executedAt,
            receipt.revertData
        );
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return _supportsCcipReceiver(interfaceId) || super.supportsInterface(interfaceId);
    }
}
