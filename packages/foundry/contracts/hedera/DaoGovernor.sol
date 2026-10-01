// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Governor } from "@openzeppelin/contracts/governance/Governor.sol";
import { GovernorCountingSimple } from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import { GovernorSettings } from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import { GovernorTimelockControl } from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import { GovernorVotes } from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {
    GovernorVotesQuorumFraction
} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import { IVotes } from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { HssScheduler } from "./HssScheduler.sol";

/// @notice OpenZeppelin Governor whose proposals queue and execute themselves, with no keeper.
/// @dev Two network callbacks through the Hedera Schedule Service (HIP-1215):
/// 1. Creating a proposal schedules `autoQueue` one second after voting ends. If the proposal passed,
///    that call queues it in the timelock.
/// 2. Queueing (by the network or by anyone) schedules `autoExecute` at the timelock's ETA, which calls
///    this contract's own `execute`, so `onlyGovernance` targets work exactly as with a manual execute.
/// Each step makes one `scheduleCall`, the network's per-transaction limit. Both callbacks are paid
/// from this contract's HBAR float. `queue` and `execute` stay permissionless as the fallback, and
/// `rearm` schedules a callback again if it could not be scheduled or failed when it fired.
contract DaoGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl,
    HssScheduler
{
    /// @notice Consecutive seconds probed for HSS capacity when scheduling a callback.
    uint256 public constant SLOT_SEARCH_WINDOW = 8;

    enum Action {
        Queue,
        Execute
    }

    struct AutoSchedule {
        address schedule; // HSS schedule entity
        uint64 at; // consensus second it fires
    }

    /// @notice Gas the network gets for each callback. The float must hold `gas * gasPrice` when it fires.
    mapping(Action action => uint256 gasLimit) public autoGasLimit;
    mapping(uint256 proposalId => mapping(Action action => AutoSchedule)) public autoSchedules;

    event AutoActionArmed(uint256 indexed proposalId, Action indexed action, address schedule, uint256 at);
    event AutoActionUnavailable(uint256 indexed proposalId, Action indexed action, int64 responseCode);
    event AutoActionDone(uint256 indexed proposalId, Action indexed action);
    event AutoActionSkipped(uint256 indexed proposalId, Action indexed action, ProposalState state);
    event AutoActionFailed(uint256 indexed proposalId, Action indexed action, bytes reason);
    event AutoActionCancelled(uint256 indexed proposalId, Action indexed action, address schedule, int64 responseCode);
    event AutoGasLimitChanged(Action indexed action, uint256 gasLimit);
    event FloatWithdrawn(address indexed to, uint256 amount);

    error OnlySelf();
    error NotRearmable(uint256 proposalId, Action action, ProposalState state);
    error AlreadyArmed(uint256 proposalId, Action action, uint256 at);

    constructor(
        IVotes token,
        TimelockController timelock,
        uint48 votingDelaySeconds,
        uint32 votingPeriodSeconds,
        uint256 proposalThresholdVotes,
        uint256 quorumPercent,
        uint256 autoQueueGasLimit,
        uint256 autoExecuteGasLimit
    )
        Governor("Hedera CCIP Timelock DAO")
        GovernorSettings(votingDelaySeconds, votingPeriodSeconds, proposalThresholdVotes)
        GovernorVotes(token)
        GovernorVotesQuorumFraction(quorumPercent)
        GovernorTimelockControl(timelock)
    {
        autoGasLimit[Action.Queue] = autoQueueGasLimit;
        autoGasLimit[Action.Execute] = autoExecuteGasLimit;
    }

    // ---------------------------------------------------------------------------------------------
    // Network callbacks
    // ---------------------------------------------------------------------------------------------

    /// @notice Called by the network one second after voting ends: queues the proposal if it passed.
    function autoQueue(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) external {
        uint256 proposalId = _startCallback(targets, values, calldatas, descriptionHash, Action.Queue);
        if (proposalId == 0) return;
        try this.queue(targets, values, calldatas, descriptionHash) {
            emit AutoActionDone(proposalId, Action.Queue);
        } catch (bytes memory reason) {
            emit AutoActionFailed(proposalId, Action.Queue, reason);
        }
    }

    /// @notice Called by the network at the timelock ETA: executes the queued proposal.
    function autoExecute(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) external {
        uint256 proposalId = _startCallback(targets, values, calldatas, descriptionHash, Action.Execute);
        if (proposalId == 0) return;
        try this.execute(targets, values, calldatas, descriptionHash) {
            emit AutoActionDone(proposalId, Action.Execute);
        } catch (bytes memory reason) {
            emit AutoActionFailed(proposalId, Action.Execute, reason);
        }
    }

    /// @notice Schedules a callback again after it could not be scheduled or failed when it fired.
    /// @dev Permissionless: the caller pays for scheduling, the float pays for the callback. Refused
    /// while an earlier schedule for the same step is still waiting, or when the step no longer applies.
    function rearm(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash,
        Action action
    ) external {
        uint256 proposalId = getProposalId(targets, values, calldatas, descriptionHash);
        _arm(proposalId, action, _rearmFrom(proposalId, action), targets, values, calldatas, descriptionHash);
    }

    // ---------------------------------------------------------------------------------------------
    // Governance-controlled settings
    // ---------------------------------------------------------------------------------------------

    function setAutoGasLimit(Action action, uint256 gasLimit) external onlyGovernance {
        autoGasLimit[action] = gasLimit;
        emit AutoGasLimitChanged(action, gasLimit);
    }

    /// @notice Moves HBAR out of the callback float.
    function withdrawFloat(address payable to, uint256 amount) external onlyGovernance {
        Address.sendValue(to, amount);
        emit FloatWithdrawn(to, amount);
    }

    /// @notice Accepts HBAR for the callback float (OpenZeppelin's default rejects deposits when a
    /// timelock is the executor).
    receive() external payable override { }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        address proposer
    ) internal override returns (uint256 proposalId) {
        proposalId = super._propose(targets, values, calldatas, description, proposer);
        _arm(
            proposalId,
            Action.Queue,
            proposalDeadline(proposalId) + 1,
            targets,
            values,
            calldatas,
            keccak256(bytes(description))
        );
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48 eta) {
        eta = super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
        _arm(proposalId, Action.Execute, eta, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256 proposalId) {
        proposalId = super._cancel(targets, values, calldatas, descriptionHash);
        _disarm(proposalId, Action.Queue);
        _disarm(proposalId, Action.Execute);
    }

    /// @dev Validates a rearm and returns the first second the callback may fire.
    function _rearmFrom(uint256 proposalId, Action action) internal view returns (uint256 notBefore) {
        ProposalState current = state(proposalId);
        bool applies = action == Action.Queue
            ? current == ProposalState.Pending || current == ProposalState.Active || current == ProposalState.Succeeded
            : current == ProposalState.Queued;
        if (!applies) revert NotRearmable(proposalId, action, current);

        uint256 armedAt = autoSchedules[proposalId][action].at;
        if (armedAt >= block.timestamp) revert AlreadyArmed(proposalId, action, armedAt);

        notBefore = action == Action.Queue ? proposalDeadline(proposalId) + 1 : proposalEta(proposalId);
        if (notBefore <= block.timestamp) notBefore = block.timestamp + 1;
    }

    /// @dev Checks a callback really comes from the network and still applies; returns 0 to stop.
    function _startCallback(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash,
        Action action
    ) internal returns (uint256 proposalId) {
        if (msg.sender != address(this)) revert OnlySelf();
        proposalId = getProposalId(targets, values, calldatas, descriptionHash);
        ProposalState current = state(proposalId);
        ProposalState expected = action == Action.Queue ? ProposalState.Succeeded : ProposalState.Queued;
        if (current != expected) {
            emit AutoActionSkipped(proposalId, action, current);
            return 0;
        }
    }

    function _arm(
        uint256 proposalId,
        Action action,
        uint256 notBefore,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal {
        bytes memory callData = action == Action.Queue
            ? abi.encodeCall(this.autoQueue, (targets, values, calldatas, descriptionHash))
            : abi.encodeCall(this.autoExecute, (targets, values, calldatas, descriptionHash));
        (int64 rc, address scheduleAddress, uint256 at) =
            _scheduleSelfCall(notBefore, autoGasLimit[action], callData, SLOT_SEARCH_WINDOW);
        if (rc != HSS_SUCCESS) {
            emit AutoActionUnavailable(proposalId, action, rc);
            return;
        }
        autoSchedules[proposalId][action] = AutoSchedule({ schedule: scheduleAddress, at: SafeCast.toUint64(at) });
        emit AutoActionArmed(proposalId, action, scheduleAddress, at);
    }

    /// @dev Deletes a callback that has not fired yet, so the float does not pay for a no-op.
    function _disarm(uint256 proposalId, Action action) internal {
        AutoSchedule memory pending = autoSchedules[proposalId][action];
        delete autoSchedules[proposalId][action];
        if (pending.schedule != address(0) && pending.at > block.timestamp) {
            emit AutoActionCancelled(proposalId, action, pending.schedule, _deleteSchedule(pending.schedule));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Required overrides
    // ---------------------------------------------------------------------------------------------

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }

    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
