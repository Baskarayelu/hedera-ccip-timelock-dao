// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IGovernor } from "@openzeppelin/contracts/governance/IGovernor.sol";
import { GovernorSettings } from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";

import { DaoGovernor } from "../contracts/hedera/DaoGovernor.sol";
import { MockHederaScheduleService } from "./mocks/MockHederaScheduleService.sol";
import { Reverter } from "./mocks/MockTokens.sol";
import { DaoFixture } from "./utils/DaoFixture.sol";

/// @notice The keeperless proposal lifecycle: users propose and vote; the network queues and executes.
contract DaoGovernorTest is DaoFixture {
    address internal payee = makeAddr("payee");

    function payment() internal view returns (Proposal memory) {
        return single(payee, 5 * HBAR, "", "Pay 5 HBAR to the payee");
    }

    function armedAt(uint256 id, DaoGovernor.Action action) internal view returns (uint64 at) {
        (, at) = governor.autoSchedules(id, action);
    }

    function armedSchedule(uint256 id, DaoGovernor.Action action) internal view returns (address schedule) {
        (schedule,) = governor.autoSchedules(id, action);
    }

    // ---- happy path ------------------------------------------------------------------------------

    function test_proposeArmsAutoQueueOneSecondAfterVotingEnds() public {
        uint256 id = propose(payment());
        assertEq(armedAt(id, DaoGovernor.Action.Queue), governor.proposalDeadline(id) + 1);
        assertEq(armedSchedule(id, DaoGovernor.Action.Queue), hss.scheduleAddress(0));
        assertEq(hss.scheduleAt(0).payer, address(governor), "the governor's float pays");
        assertEq(hss.scheduleAt(0).gasLimit, AUTO_QUEUE_GAS);
    }

    function test_proposeVoteAndTheNetworkDoesTheRest() public {
        uint256 id = propose(payment());
        everyoneVotesFor(id);

        vm.warp(governor.proposalDeadline(id) + 1);
        assertEq(hss.executeDue(), 1);
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Queued));
        assertEq(armedAt(id, DaoGovernor.Action.Execute), governor.proposalEta(id), "queueing armed execution");

        vm.warp(governor.proposalEta(id));
        vm.expectEmit(address(governor));
        emit IGovernor.ProposalExecuted(id);
        assertEq(hss.executeDue(), 1);
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Executed));
        assertEq(payee.balance, 5 * HBAR);
    }

    function test_callbacksAreChargedToTheFloatNotTheTreasury() public {
        uint256 id = propose(payment());
        everyoneVotesFor(id);
        uint256 floatBefore = address(governor).balance;
        runToExecution(id);
        assertLt(address(governor).balance, floatBefore);
        assertEq(address(timelock).balance, 95 * HBAR, "treasury only paid the 5 HBAR the proposal moved");
    }

    /// @dev The reason auto-execution goes through Governor.execute: OpenZeppelin only lets an
    /// executed proposal reach `onlyGovernance` functions via that path.
    function test_onlyGovernanceTargetsWorkWhenAutoExecuted() public {
        Proposal memory p =
            single(address(governor), 0, abi.encodeCall(GovernorSettings.setVotingPeriod, (600)), "Longer votes");
        uint256 id = propose(p);
        everyoneVotesFor(id);
        runToExecution(id);
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Executed));
        assertEq(governor.votingPeriod(), 600);
    }

    function test_governanceCanTuneCallbackGas() public {
        Proposal memory p = single(
            address(governor),
            0,
            abi.encodeCall(DaoGovernor.setAutoGasLimit, (DaoGovernor.Action.Execute, 900_000)),
            "Tune gas"
        );
        uint256 id = propose(p);
        everyoneVotesFor(id);
        runToExecution(id);
        assertEq(governor.autoGasLimit(DaoGovernor.Action.Execute), 900_000);
    }

    // ---- proposals that should not run -----------------------------------------------------------

    function test_defeatedProposalIsSkippedNotQueued() public {
        uint256 id = propose(payment());
        vm.warp(governor.proposalSnapshot(id) + 1);
        vm.prank(alice);
        governor.castVote(id, 0);

        vm.warp(governor.proposalDeadline(id) + 1);
        vm.expectEmit(address(governor));
        emit DaoGovernor.AutoActionSkipped(id, DaoGovernor.Action.Queue, IGovernor.ProposalState.Defeated);
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Defeated));
    }

    function test_quorumIsMeasuredAgainstWrappedSupply() public {
        // 4% of 1,000 vGOV is 40; a 30 vGOV voter alone cannot pass a proposal.
        address small = makeAddr("small");
        giveVotes(small, 30e6);
        vm.warp(block.timestamp + 1);
        uint256 id = propose(payment());
        address[] memory voters = new address[](1);
        voters[0] = small;
        voteFor(id, voters);

        vm.warp(governor.proposalDeadline(id) + 1);
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Defeated));
    }

    function test_proposerCancelDeletesThePendingCallback() public {
        Proposal memory p = payment();
        uint256 id = propose(p);
        address schedule = hss.scheduleAddress(0);

        vm.expectEmit(address(governor));
        emit DaoGovernor.AutoActionCancelled(id, DaoGovernor.Action.Queue, schedule, 22);
        vm.prank(alice);
        governor.cancel(p.targets, p.values, p.calldatas, descriptionHash(p));

        assertEq(uint8(hss.statusOf(schedule)), uint8(MockHederaScheduleService.Status.Deleted));
        assertEq(hss.gasReservedAt(governor.proposalDeadline(id) + 1), 0, "capacity released");
    }

    // ---- network edge cases ----------------------------------------------------------------------

    function test_busySecondsMoveTheCallbackToTheNextFreeOne() public {
        uint256 deadline = block.timestamp + VOTING_DELAY + VOTING_PERIOD;
        hss.occupy(deadline + 1, 15_000_000);
        hss.occupy(deadline + 2, 13_000_000); // 2M left, auto-queue needs 3M
        uint256 id = propose(payment());
        assertEq(armedAt(id, DaoGovernor.Action.Queue), deadline + 3);
    }

    function test_noCapacityInWindowNeverBlocksTheProposal() public {
        uint256 deadline = block.timestamp + VOTING_DELAY + VOTING_PERIOD;
        for (uint256 i; i < governor.SLOT_SEARCH_WINDOW(); ++i) {
            hss.occupy(deadline + 1 + i, 15_000_000);
        }
        vm.recordLogs();
        uint256 id = propose(payment());
        assertEq(armedSchedule(id, DaoGovernor.Action.Queue), address(0));
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Pending), "proposal exists anyway");
    }

    function test_rearmAfterTheBusyWindowRecoversAutoQueue() public {
        Proposal memory p = payment();
        uint256 deadline = block.timestamp + VOTING_DELAY + VOTING_PERIOD;
        for (uint256 i; i < governor.SLOT_SEARCH_WINDOW(); ++i) {
            hss.occupy(deadline + 1 + i, 15_000_000);
        }
        uint256 id = propose(p);
        everyoneVotesFor(id);

        vm.warp(deadline + governor.SLOT_SEARCH_WINDOW() + 1);
        nextTx();
        vm.prank(makeAddr("anyone"));
        governor.rearm(p.targets, p.values, p.calldatas, descriptionHash(p), DaoGovernor.Action.Queue);
        assertEq(armedAt(id, DaoGovernor.Action.Queue), block.timestamp + 1);

        vm.warp(block.timestamp + 1);
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Queued));
    }

    function test_emptyFloatConsumesTheScheduleThenPermissionlessQueueStillWorks() public {
        Proposal memory p = payment();
        uint256 id = propose(p);
        everyoneVotesFor(id);
        vm.deal(address(governor), 0);

        vm.warp(governor.proposalDeadline(id) + 1);
        hss.executeDue();
        assertEq(
            uint8(hss.statusOf(hss.scheduleAddress(0))),
            uint8(MockHederaScheduleService.Status.InsufficientPayerBalance),
            "consumed silently, as on testnet"
        );
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Succeeded));

        vm.deal(address(governor), 20 * HBAR);
        nextTx();
        vm.prank(makeAddr("anyone"));
        governor.queue(p.targets, p.values, p.calldatas, descriptionHash(p));

        vm.warp(governor.proposalEta(id));
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Executed), "execution stayed keeperless");
    }

    function test_failedExecutionIsRecordedAndCanBeRearmedOrExecutedByAnyone() public {
        Reverter reverter = new Reverter();
        Proposal memory p = single(address(reverter), 0, abi.encodeCall(Reverter.boom, ()), "Doomed");
        uint256 id = propose(p);
        everyoneVotesFor(id);
        vm.warp(governor.proposalDeadline(id) + 1);
        hss.executeDue();
        vm.warp(governor.proposalEta(id));

        vm.recordLogs();
        hss.executeDue();
        assertEq(vm.getRecordedLogs()[0].topics[0], DaoGovernor.AutoActionFailed.selector);
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Queued), "still executable");

        vm.warp(block.timestamp + 1);
        nextTx();
        governor.rearm(p.targets, p.values, p.calldatas, descriptionHash(p), DaoGovernor.Action.Execute);
        assertEq(armedAt(id, DaoGovernor.Action.Execute), block.timestamp + 1);
    }

    function test_rearmIsRefusedWhileArmedOrWhenTheStepNoLongerApplies() public {
        Proposal memory p = payment();
        uint256 id = propose(p);
        uint256 at = armedAt(id, DaoGovernor.Action.Queue);
        vm.expectRevert(abi.encodeWithSelector(DaoGovernor.AlreadyArmed.selector, id, DaoGovernor.Action.Queue, at));
        governor.rearm(p.targets, p.values, p.calldatas, descriptionHash(p), DaoGovernor.Action.Queue);

        vm.expectRevert(
            abi.encodeWithSelector(
                DaoGovernor.NotRearmable.selector, id, DaoGovernor.Action.Execute, IGovernor.ProposalState.Pending
            )
        );
        governor.rearm(p.targets, p.values, p.calldatas, descriptionHash(p), DaoGovernor.Action.Execute);

        everyoneVotesFor(id);
        runToExecution(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                DaoGovernor.NotRearmable.selector, id, DaoGovernor.Action.Queue, IGovernor.ProposalState.Executed
            )
        );
        governor.rearm(p.targets, p.values, p.calldatas, descriptionHash(p), DaoGovernor.Action.Queue);
    }

    function test_twoQueuesInOneTransactionArmOnlyTheFirst() public {
        Proposal memory p1 = payment();
        Proposal memory p2 = single(payee, 1 * HBAR, "", "Second payment");
        uint256 id1 = propose(p1);
        uint256 id2 = propose(p2);
        everyoneVotesFor(id1);
        address[] memory voters = new address[](1);
        voters[0] = alice;
        voteFor(id2, voters);

        vm.deal(address(governor), 0); // let both auto-queues fail so queueing is manual
        vm.warp(governor.proposalDeadline(id2) + 1);
        hss.executeDue();
        vm.deal(address(governor), 20 * HBAR);

        nextTx(); // one transaction, two queues: the network answers 373 to the second scheduleCall
        governor.queue(p1.targets, p1.values, p1.calldatas, descriptionHash(p1));
        governor.queue(p2.targets, p2.values, p2.calldatas, descriptionHash(p2));
        assertGt(armedAt(id1, DaoGovernor.Action.Execute), 0);
        assertEq(armedAt(id2, DaoGovernor.Action.Execute), 0, "373: second one not armed");

        vm.warp(block.timestamp + 1);
        nextTx();
        governor.rearm(p2.targets, p2.values, p2.calldatas, descriptionHash(p2), DaoGovernor.Action.Execute);
        vm.warp(governor.proposalEta(id2));
        hss.executeDue();
        assertEq(uint8(governor.state(id1)), uint8(IGovernor.ProposalState.Executed));
        assertEq(uint8(governor.state(id2)), uint8(IGovernor.ProposalState.Executed));
    }

    function test_withoutTheSystemContractEverythingStillWorksManually() public {
        vm.etch(address(0x16b), "");
        Proposal memory p = payment();
        vm.prank(alice);
        uint256 id = governor.propose(p.targets, p.values, p.calldatas, p.description);
        assertEq(armedSchedule(id, DaoGovernor.Action.Queue), address(0));

        vm.warp(governor.proposalSnapshot(id) + 1);
        vm.prank(alice);
        governor.castVote(id, 1);

        vm.warp(governor.proposalDeadline(id) + 1);
        governor.queue(p.targets, p.values, p.calldatas, descriptionHash(p));
        vm.warp(governor.proposalEta(id));
        governor.execute(p.targets, p.values, p.calldatas, descriptionHash(p));
        assertEq(payee.balance, 5 * HBAR);
    }

    // ---- access ----------------------------------------------------------------------------------

    function test_callbacksAreOnlyCallableByTheNetworkAsSelf() public {
        Proposal memory p = payment();
        vm.expectRevert(DaoGovernor.OnlySelf.selector);
        governor.autoQueue(p.targets, p.values, p.calldatas, descriptionHash(p));
        vm.expectRevert(DaoGovernor.OnlySelf.selector);
        governor.autoExecute(p.targets, p.values, p.calldatas, descriptionHash(p));
    }

    function test_floatAcceptsHbarAndOnlyGovernanceWithdrawsOrRetunes() public {
        (bool ok,) = address(governor).call{ value: 1 * HBAR }("");
        assertTrue(ok);
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, address(this)));
        governor.withdrawFloat(payable(address(this)), 1);
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, address(this)));
        governor.setAutoGasLimit(DaoGovernor.Action.Queue, 1);
    }
}
