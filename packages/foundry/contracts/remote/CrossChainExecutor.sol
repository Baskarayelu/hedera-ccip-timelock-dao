// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

import { Client } from "../ccip/Client.sol";
import { CcipReceiverBase } from "../ccip/CcipReceiverBase.sol";
import { ICcipRouter } from "../ccip/ICcipRouter.sol";
import { CrossChainMessages } from "../shared/CrossChainMessages.sol";
import { DaoAccount } from "./DaoAccount.sol";

/// @notice Runs governance requests that arrive over CCIP, each from the sending DAO's own account,
/// and reports every outcome back to the DAO.
/// @dev Permissionless and shared: any DAO on any CCIP-connected chain can use one deployment
/// without registering. The CCIP sender (source chain + address) is the identity: it selects a
/// deterministic `DaoAccount` clone, so one DAO can never act through another's account.
///
/// Safety properties:
/// - only the CCIP router can deliver, and each messageId is processed once;
/// - a request past its `validUntil` is not executed (a delayed message cannot act on a stale vote);
/// - a failing batch is recorded and reported instead of reverting, so the DAO learns why;
/// - the receipt fee comes from the DAO's account, or a small per-DAO allowance from the sponsor pool.
contract CrossChainExecutor is CcipReceiverBase {
    enum FeePayer {
        None,
        Account,
        Sponsor
    }

    /// @notice `DaoAccount` implementation cloned for each DAO.
    address public immutable accountImplementation;
    /// @notice Gas the receipt asks for on the DAO's chain.
    uint256 public immutable receiptGasLimit;
    /// @notice Receipts the sponsor pool pays for each DAO whose account cannot.
    uint256 public immutable sponsoredReceiptsPerDao;

    mapping(bytes32 messageId => CrossChainMessages.Status) public statusOf;
    mapping(address account => uint256 count) public sponsoredReceiptsUsed;

    event AccountCreated(address indexed account, uint64 indexed sourceChain, address indexed sourceDao);
    event RequestProcessed(
        bytes32 indexed messageId,
        uint64 indexed sourceChain,
        address indexed sourceDao,
        address account,
        CrossChainMessages.Status status,
        bytes revertData
    );
    event ReceiptSent(bytes32 indexed requestId, bytes32 receiptMessageId, uint256 fee, FeePayer paidBy);
    event ReceiptNotSent(bytes32 indexed requestId, uint256 fee, bytes reason);
    event Sponsored(address indexed from, uint256 amount);

    error AlreadyProcessed(bytes32 messageId);
    error InvalidSender(bytes sender);
    error UnsupportedVersion(uint8 version);
    error ReceiptUnfunded();
    error ReceiptRefundFailed();

    constructor(address router, uint256 receiptGasLimit_, uint256 sponsoredReceiptsPerDao_) CcipReceiverBase(router) {
        accountImplementation = address(new DaoAccount());
        receiptGasLimit = receiptGasLimit_;
        sponsoredReceiptsPerDao = sponsoredReceiptsPerDao_;
    }

    /// @notice Address of `sourceDao`'s account here, whether or not it exists yet.
    /// @dev Lets a DAO fund its account, or name it as a contract owner, before its first request.
    function accountOf(uint64 sourceChainSelector, address sourceDao) public view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, _salt(sourceChainSelector, sourceDao));
    }

    /// @notice Tops up the sponsor pool that pays receipts for DAOs with unfunded accounts.
    receive() external payable {
        emit Sponsored(msg.sender, msg.value);
    }

    /// @dev Exposed so that a malformed payload is caught by `try` instead of reverting delivery.
    function decodeRequest(bytes calldata data) external pure returns (CrossChainMessages.Request memory) {
        return CrossChainMessages.decodeRequest(data);
    }

    function _ccipReceive(Client.Any2EVMMessage calldata message) internal override {
        if (statusOf[message.messageId] != CrossChainMessages.Status.None) {
            revert AlreadyProcessed(message.messageId);
        }
        if (message.sender.length != 32) revert InvalidSender(message.sender);
        address sourceDao = abi.decode(message.sender, (address));

        DaoAccount account = _accountFor(message.sourceChainSelector, sourceDao);
        (CrossChainMessages.Status status, bytes memory revertData) = _run(account, message.data);
        statusOf[message.messageId] = status;
        emit RequestProcessed(
            message.messageId, message.sourceChainSelector, sourceDao, address(account), status, revertData
        );

        _sendReceipt(
            message.sourceChainSelector,
            sourceDao,
            account,
            CrossChainMessages.Receipt({
                requestId: message.messageId,
                status: status,
                executedAt: uint64(block.timestamp),
                revertData: revertData
            })
        );
    }

    function _run(DaoAccount account, bytes calldata data) internal returns (CrossChainMessages.Status, bytes memory) {
        try this.decodeRequest(data) returns (CrossChainMessages.Request memory request) {
            if (request.version != CrossChainMessages.VERSION) {
                return (
                    CrossChainMessages.Status.Failed,
                    abi.encodeWithSelector(UnsupportedVersion.selector, request.version)
                );
            }
            if (block.timestamp > request.validUntil) return (CrossChainMessages.Status.Expired, "");
            try account.executeCalls(request.calls) {
                return (CrossChainMessages.Status.Executed, "");
            } catch (bytes memory reason) {
                return (CrossChainMessages.Status.Failed, CrossChainMessages.truncate(reason));
            }
        } catch (bytes memory reason) {
            return (CrossChainMessages.Status.Failed, CrossChainMessages.truncate(reason));
        }
    }

    function _sendReceipt(uint64 destChain, address dao, DaoAccount account, CrossChainMessages.Receipt memory receipt)
        internal
    {
        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(dao),
            data: CrossChainMessages.encodeReceipt(receipt),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: Client.extraArgsV2(receiptGasLimit)
        });

        uint256 fee;
        try ICcipRouter(ccipRouter).getFee(destChain, message) returns (uint256 quoted) {
            fee = quoted;
        } catch (bytes memory reason) {
            emit ReceiptNotSent(receipt.requestId, 0, reason);
            return;
        }

        FeePayer paidBy;
        if (address(account).balance >= fee) {
            account.payExecutor(fee);
            paidBy = FeePayer.Account;
        } else if (address(this).balance >= fee && sponsoredReceiptsUsed[address(account)] < sponsoredReceiptsPerDao) {
            ++sponsoredReceiptsUsed[address(account)];
            paidBy = FeePayer.Sponsor;
        } else {
            emit ReceiptNotSent(receipt.requestId, fee, abi.encodeWithSelector(ReceiptUnfunded.selector));
            return;
        }

        try ICcipRouter(ccipRouter).ccipSend{ value: fee }(destChain, message) returns (bytes32 receiptMessageId) {
            emit ReceiptSent(receipt.requestId, receiptMessageId, fee, paidBy);
        } catch (bytes memory reason) {
            // Undo the payment: return the account's fee, or give the sponsored slot back.
            if (paidBy == FeePayer.Account) {
                (bool refunded,) = address(account).call{ value: fee }("");
                if (!refunded) revert ReceiptRefundFailed();
            } else {
                --sponsoredReceiptsUsed[address(account)];
            }
            emit ReceiptNotSent(receipt.requestId, fee, reason);
        }
    }

    function _accountFor(uint64 sourceChainSelector, address sourceDao) internal returns (DaoAccount account) {
        address predicted = accountOf(sourceChainSelector, sourceDao);
        if (predicted.code.length != 0) return DaoAccount(payable(predicted));

        account = DaoAccount(
            payable(Clones.cloneDeterministic(accountImplementation, _salt(sourceChainSelector, sourceDao)))
        );
        account.initialize(sourceChainSelector, sourceDao);
        emit AccountCreated(address(account), sourceChainSelector, sourceDao);
    }

    function _salt(uint64 sourceChainSelector, address sourceDao) internal pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainSelector, sourceDao));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return _supportsCcipReceiver(interfaceId);
    }
}
