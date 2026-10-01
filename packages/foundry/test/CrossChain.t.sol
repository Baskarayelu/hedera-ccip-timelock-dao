// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IGovernor } from "@openzeppelin/contracts/governance/IGovernor.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";

import { CcipReceiverBase } from "../contracts/ccip/CcipReceiverBase.sol";
import { Client } from "../contracts/ccip/Client.sol";
import { DaoGovernor } from "../contracts/hedera/DaoGovernor.sol";
import { DaoTimelock } from "../contracts/hedera/DaoTimelock.sol";
import { CrossChainExecutor } from "../contracts/remote/CrossChainExecutor.sol";
import { DaoAccount } from "../contracts/remote/DaoAccount.sol";
import { RemoteParameters } from "../contracts/remote/RemoteParameters.sol";
import { CrossChainMessages } from "../contracts/shared/CrossChainMessages.sol";
import { Reverter } from "./mocks/MockTokens.sol";
import { DaoFixture } from "./utils/DaoFixture.sol";

/// @notice Hedera DAO -> CCIP -> Base Sepolia executor -> DAO account -> targets -> receipt -> Hedera.
contract CrossChainTest is DaoFixture {
    bytes32 internal constant FEE_KEY = keccak256("protocol.feeBps");
    uint256 internal constant MAX_FEE = 2 * HBAR;
    uint256 internal constant DEST_GAS = 1_200_000; // mock router storage makes receipts dearer than on-chain

    address internal account;

    function setUp() public override {
        super.setUp();
        account = executor.accountOf(HEDERA, address(timelock));
        usdc.mint(account, 1_000e6); // the DAO's remote treasury
        vm.deal(account, 0.01 ether); // pays the DAO's receipts
    }

    function remoteCalls() internal view returns (CrossChainMessages.Call[] memory calls) {
        calls = new CrossChainMessages.Call[](2);
        calls[0] = CrossChainMessages.Call(address(params), 0, abi.encodeCall(RemoteParameters.set, (FEE_KEY, 30)));
        calls[1] = CrossChainMessages.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (grantee, 100e6)));
    }

    function crossChainProposal(CrossChainMessages.Call[] memory calls, string memory description)
        internal
        view
        returns (Proposal memory)
    {
        return single(
            address(timelock),
            0,
            abi.encodeCall(DaoTimelock.sendCrossChain, (BASE, calls, DEST_GAS, MAX_FEE)),
            description
        );
    }

    function passAndExecute(Proposal memory p) internal returns (uint256 id, bytes32 requestId) {
        id = propose(p);
        everyoneVotesFor(id);
        runToExecution(id);
        requestId = hederaRouter.lastMessageId();
    }

    // ---- end to end ------------------------------------------------------------------------------

    function test_proposalRunsOnBaseAndTheReceiptComesBack() public {
        Proposal memory p = crossChainProposal(remoteCalls(), "Set fee and pay a grant on Base");
        (uint256 id, bytes32 requestId) = passAndExecute(p);
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Executed));

        (uint64 dest,,, bytes32 opId, uint256 fee) = timelock.outbound(requestId);
        assertEq(dest, BASE);
        assertEq(opId, operationId(p), "request names the proposal's timelock operation");
        assertEq(fee, HEDERA_CCIP_FEE, "paid the quote, not the cap");

        baseRouter.deliver(hederaRouter, requestId);
        assertEq(params.valueOf(account, FEE_KEY), 30);
        assertEq(usdc.balanceOf(grantee), 100e6);
        assertEq(uint8(executor.statusOf(requestId)), uint8(CrossChainMessages.Status.Executed));

        bytes32 receiptId = baseRouter.lastMessageId();
        vm.expectEmit(address(timelock));
        emit DaoTimelock.CrossChainReceipt(
            requestId, operationId(p), receiptId, CrossChainMessages.Status.Executed, uint64(block.timestamp), ""
        );
        hederaRouter.deliver(baseRouter, receiptId);
        assertEq(uint8(timelock.receiptOf(requestId).status), uint8(CrossChainMessages.Status.Executed));
    }

    function test_accountAddressIsKnownBeforeItExists() public {
        assertEq(account.code.length, 0);
        (, bytes32 requestId) = passAndExecute(crossChainProposal(remoteCalls(), "First request"));
        baseRouter.deliver(hederaRouter, requestId);
        assertGt(account.code.length, 0);
        assertEq(DaoAccount(payable(account)).sourceDao(), address(timelock));
        assertEq(DaoAccount(payable(account)).sourceChainSelector(), HEDERA);
    }

    function test_feeAboveTheVotedCapFailsThenRearmSucceeds() public {
        Proposal memory p = crossChainProposal(remoteCalls(), "Capped fee");
        uint256 id = propose(p);
        everyoneVotesFor(id);
        vm.warp(queueAt(id));
        hss.executeDue();

        hederaRouter.setFee(3 * HBAR);
        vm.warp(executeAt(id));
        vm.recordLogs();
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Queued), "fee spike: not executed");
        assertEq(hederaRouter.sentCount(), 0);

        hederaRouter.setFee(HEDERA_CCIP_FEE);
        vm.warp(block.timestamp + 1);
        nextTx();
        governor.rearm(p.targets, p.values, p.calldatas, descriptionHash(p), DaoGovernor.Action.Execute);
        vm.warp(block.timestamp + 1);
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Executed));
        assertEq(hederaRouter.sentCount(), 1);
    }

    function test_requestDelayedPastItsDeadlineIsNotExecuted() public {
        (, bytes32 requestId) = passAndExecute(crossChainProposal(remoteCalls(), "Stale"));
        vm.warp(block.timestamp + REQUEST_TTL + 1);
        baseRouter.deliver(hederaRouter, requestId);

        assertEq(uint8(executor.statusOf(requestId)), uint8(CrossChainMessages.Status.Expired));
        assertEq(params.valueOf(account, FEE_KEY), 0);
        assertEq(usdc.balanceOf(grantee), 0);

        hederaRouter.deliver(baseRouter, baseRouter.lastMessageId());
        assertEq(uint8(timelock.receiptOf(requestId).status), uint8(CrossChainMessages.Status.Expired));
    }

    function test_failingCallRevertsTheWholeBatchAndReportsATruncatedReason() public {
        Reverter reverter = new Reverter();
        CrossChainMessages.Call[] memory calls = new CrossChainMessages.Call[](2);
        calls[0] = CrossChainMessages.Call(address(params), 0, abi.encodeCall(RemoteParameters.set, (FEE_KEY, 30)));
        calls[1] = CrossChainMessages.Call(address(reverter), 0, abi.encodeCall(Reverter.boom, ()));
        (, bytes32 requestId) = passAndExecute(crossChainProposal(calls, "Half broken"));

        baseRouter.deliver(hederaRouter, requestId);
        assertEq(uint8(executor.statusOf(requestId)), uint8(CrossChainMessages.Status.Failed));
        assertEq(params.valueOf(account, FEE_KEY), 0, "atomic: the first call was rolled back");

        vm.recordLogs();
        hederaRouter.deliver(baseRouter, baseRouter.lastMessageId());
        assertEq(uint8(timelock.receiptOf(requestId).status), uint8(CrossChainMessages.Status.Failed));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory receiptLog = logs[logs.length - 1];
        assertEq(receiptLog.topics[0], DaoTimelock.CrossChainReceipt.selector);
        (,,, bytes memory revertData) = abi.decode(receiptLog.data, (bytes32, uint8, uint64, bytes));
        assertEq(revertData.length, CrossChainMessages.MAX_REVERT_BYTES, "truncated to the receipt limit");
        // forge-lint: disable-next-line(unsafe-typecast) reading the 4-byte error selector
        assertEq(bytes4(revertData), DaoAccount.CallFailed.selector);
    }

    // ---- executor: receipts and funding ----------------------------------------------------------

    function request(address dao, bytes32 messageId, CrossChainMessages.Call[] memory calls)
        internal
        view
        returns (Client.Any2EVMMessage memory)
    {
        CrossChainMessages.Request memory r;
        r.version = CrossChainMessages.VERSION;
        r.validUntil = uint64(block.timestamp + 1 hours);
        r.calls = calls;
        return Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: HEDERA,
            sender: abi.encode(dao),
            data: abi.encode(r),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
    }

    function paramCall(uint256 value) internal view returns (CrossChainMessages.Call[] memory calls) {
        calls = new CrossChainMessages.Call[](1);
        calls[0] = CrossChainMessages.Call(address(params), 0, abi.encodeCall(RemoteParameters.set, (FEE_KEY, value)));
    }

    function test_receiptsFallBackToTheSponsorPoolUpToThePerDaoAllowance() public {
        address dao = makeAddr("unfunded dao");
        (bool ok,) = address(executor).call{ value: 1 ether }("");
        assertTrue(ok);

        for (uint256 i; i < executor.sponsoredReceiptsPerDao(); ++i) {
            vm.expectEmit(true, false, false, false, address(executor));
            emit CrossChainExecutor.ReceiptSent(bytes32(i + 1), 0, 0, CrossChainExecutor.FeePayer.Sponsor);
            baseRouter.deliverRaw(address(executor), request(dao, bytes32(i + 1), paramCall(i)));
        }
        bytes32 next = bytes32(uint256(99));
        vm.expectEmit(true, false, false, false, address(executor));
        emit CrossChainExecutor.ReceiptNotSent(next, 0, "");
        baseRouter.deliverRaw(address(executor), request(dao, next, paramCall(99)));
        assertEq(uint8(executor.statusOf(next)), uint8(CrossChainMessages.Status.Executed), "work still done");
    }

    function test_accountBalancePaysBeforeTheSponsorPool() public {
        address dao = makeAddr("funded dao");
        vm.deal(executor.accountOf(HEDERA, dao), 1 ether);
        (bool ok,) = address(executor).call{ value: 1 ether }("");
        assertTrue(ok);

        vm.expectEmit(true, false, false, false, address(executor));
        emit CrossChainExecutor.ReceiptSent(bytes32(uint256(1)), 0, 0, CrossChainExecutor.FeePayer.Account);
        baseRouter.deliverRaw(address(executor), request(dao, bytes32(uint256(1)), paramCall(1)));
        assertEq(address(executor).balance, 1 ether, "pool untouched");
    }

    function test_failedReceiptSendRefundsTheAccount() public {
        address dao = makeAddr("funded dao");
        address daoAccount = executor.accountOf(HEDERA, dao);
        vm.deal(daoAccount, 1 ether);
        baseRouter.setSendsFail(true);
        baseRouter.deliverRaw(address(executor), request(dao, bytes32(uint256(1)), paramCall(1)));
        assertEq(daoAccount.balance, 1 ether, "fee returned to the DAO's account");
        assertEq(address(executor).balance, 0, "nothing stranded in the pool");
    }

    function test_failedReceiptSendReturnsTheSponsoredSlot() public {
        address dao = makeAddr("dao");
        (bool ok,) = address(executor).call{ value: 1 ether }("");
        assertTrue(ok);
        baseRouter.setSendsFail(true);
        baseRouter.deliverRaw(address(executor), request(dao, bytes32(uint256(1)), paramCall(1)));
        assertEq(executor.sponsoredReceiptsUsed(executor.accountOf(HEDERA, dao)), 0);
    }

    // ---- executor: authentication, replay, isolation ---------------------------------------------

    function test_onlyTheRouterCanDeliver() public {
        vm.expectRevert(abi.encodeWithSelector(CcipReceiverBase.NotRouter.selector, address(this)));
        executor.ccipReceive(request(address(timelock), bytes32(uint256(1)), paramCall(1)));
    }

    function test_aMessageIsProcessedOnce() public {
        Client.Any2EVMMessage memory m = request(address(timelock), bytes32(uint256(7)), paramCall(1));
        baseRouter.deliverRaw(address(executor), m);
        vm.expectRevert(abi.encodeWithSelector(CrossChainExecutor.AlreadyProcessed.selector, bytes32(uint256(7))));
        baseRouter.deliverRaw(address(executor), m);
    }

    function test_malformedPayloadIsRecordedAsFailedNotReverted() public {
        Client.Any2EVMMessage memory m = request(address(timelock), bytes32(uint256(8)), paramCall(1));
        m.data = hex"deadbeef";
        baseRouter.deliverRaw(address(executor), m);
        assertEq(uint8(executor.statusOf(m.messageId)), uint8(CrossChainMessages.Status.Failed));
    }

    function test_nonEvmSenderIsRejected() public {
        Client.Any2EVMMessage memory m = request(address(timelock), bytes32(uint256(9)), paramCall(1));
        m.sender = hex"01";
        vm.expectRevert(abi.encodeWithSelector(CrossChainExecutor.InvalidSender.selector, m.sender));
        baseRouter.deliverRaw(address(executor), m);
    }

    function testFuzz_eachDaoActsOnlyThroughItsOwnAccount(address daoA, address daoB, uint64 chainB) public {
        vm.assume(daoA != daoB);
        address accountA = executor.accountOf(HEDERA, daoA);
        address accountB = executor.accountOf(chainB, daoB);
        assertTrue(accountA != accountB);

        Client.Any2EVMMessage memory m = request(daoB, keccak256(abi.encode(daoB, chainB)), paramCall(42));
        m.sourceChainSelector = chainB;
        baseRouter.deliverRaw(address(executor), m);

        assertEq(params.valueOf(accountB, FEE_KEY), 42, "B wrote through its own account");
        assertEq(params.valueOf(accountA, FEE_KEY), 0, "A's namespace untouched");
        assertEq(DaoAccount(payable(accountB)).sourceDao(), daoB);

        vm.prank(daoB);
        vm.expectRevert(abi.encodeWithSelector(DaoAccount.NotExecutor.selector, daoB));
        DaoAccount(payable(accountB)).executeCalls(paramCall(1));
    }

    function testFuzz_accountCannotBeReinitialised(address attacker) public {
        baseRouter.deliverRaw(address(executor), request(address(timelock), bytes32(uint256(1)), paramCall(1)));
        vm.prank(attacker);
        vm.expectRevert(DaoAccount.AlreadyInitialized.selector);
        DaoAccount(payable(account)).initialize(HEDERA, attacker);
    }

    // ---- timelock: receipt authentication --------------------------------------------------------

    function receiptFrom(address sender, uint64 source, bytes32 requestId)
        internal
        view
        returns (Client.Any2EVMMessage memory)
    {
        return Client.Any2EVMMessage({
            messageId: keccak256(abi.encode("receipt", requestId)),
            sourceChainSelector: source,
            sender: abi.encode(sender),
            data: abi.encode(
                CrossChainMessages.Receipt(requestId, CrossChainMessages.Status.Executed, uint64(block.timestamp), "")
            ),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
    }

    function testFuzz_onlyTheRegisteredExecutorCanReport(address sender) public {
        vm.assume(sender != address(executor));
        (, bytes32 requestId) = passAndExecute(crossChainProposal(remoteCalls(), "Auth"));
        Client.Any2EVMMessage memory m = receiptFrom(sender, BASE, requestId);
        vm.expectRevert(abi.encodeWithSelector(DaoTimelock.UnknownSender.selector, BASE, m.sender));
        hederaRouter.deliverRaw(address(timelock), m);
    }

    function test_receiptsForUnknownOrRepeatedRequestsAreRejected() public {
        bytes32 unknown = keccak256("never sent");
        vm.expectRevert(abi.encodeWithSelector(DaoTimelock.UnknownRequest.selector, unknown));
        hederaRouter.deliverRaw(address(timelock), receiptFrom(address(executor), BASE, unknown));

        (, bytes32 requestId) = passAndExecute(crossChainProposal(remoteCalls(), "Once"));
        hederaRouter.deliverRaw(address(timelock), receiptFrom(address(executor), BASE, requestId));
        vm.expectRevert(abi.encodeWithSelector(DaoTimelock.DuplicateReceipt.selector, requestId));
        hederaRouter.deliverRaw(address(timelock), receiptFrom(address(executor), BASE, requestId));
    }

    function test_sendCrossChainOnlyRunsInsideAnExecutedProposal() public {
        vm.expectRevert(DaoTimelock.OnlySelf.selector);
        timelock.sendCrossChain(BASE, remoteCalls(), DEST_GAS, MAX_FEE);
    }

    function test_unknownDestinationFailsTheExecution() public {
        Proposal memory p = single(
            address(timelock),
            0,
            abi.encodeCall(DaoTimelock.sendCrossChain, (uint64(1), remoteCalls(), DEST_GAS, MAX_FEE)),
            "Nowhere"
        );
        uint256 id = propose(p);
        everyoneVotesFor(id);
        vm.warp(queueAt(id));
        hss.executeDue();
        vm.warp(executeAt(id));
        vm.recordLogs();
        hss.executeDue();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[logs.length - 1].topics[0], DaoGovernor.AutoActionFailed.selector);
    }
}
