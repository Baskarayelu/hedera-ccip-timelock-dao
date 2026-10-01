// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaScheduleService } from "../interfaces/IHederaScheduleService.sol";

/// @notice Lets a contract ask the Hedera network to call it back later, with no keeper.
/// @dev Every helper here is non-reverting on purpose: a busy network second or a missing system
/// contract must never block the governance action that tried to schedule. Callers keep a
/// permissionless manual path for anything that fails to schedule.
abstract contract HssScheduler {
    /// @dev Hedera Schedule Service system contract.
    address internal constant HSS = address(0x16b);

    int64 internal constant HSS_SUCCESS = 22;
    /// @dev Local sentinel: no second in the search window reported capacity.
    int64 internal constant HSS_NO_CAPACITY = -1;
    /// @dev Local sentinel: the system contract did not answer (not on a Hedera network).
    int64 internal constant HSS_UNAVAILABLE = -2;

    /// @notice Schedules `callData` as a call from this contract to itself.
    /// @dev Probes up to `searchWindow` consecutive seconds starting at `notBefore` and schedules in the
    /// first one with capacity. Only the in-transaction capacity probe is authoritative, so the probe
    /// runs here rather than off-chain. At most one `scheduleCall` is made, because the network allows
    /// one per transaction (a second returns 373).
    /// @return rc 22 on success, the network's response code, or one of the local sentinels.
    /// @return schedule The schedule entity address, zero unless `rc == 22`.
    /// @return at The second the call was scheduled for, zero unless `rc == 22`.
    function _scheduleSelfCall(uint256 notBefore, uint256 gasLimit, bytes memory callData, uint256 searchWindow)
        internal
        returns (int64 rc, address schedule, uint256 at)
    {
        for (uint256 i; i < searchWindow; ++i) {
            (bool answered, bool hasCapacity) = _hasCapacity(notBefore + i, gasLimit);
            if (!answered) return (HSS_UNAVAILABLE, address(0), 0);
            if (!hasCapacity) continue;

            (bool ok, bytes memory ret) = HSS.call(
                abi.encodeCall(
                    IHederaScheduleService.scheduleCall, (address(this), notBefore + i, gasLimit, 0, callData)
                )
            );
            if (!ok || ret.length < 64) return (HSS_UNAVAILABLE, address(0), 0);
            (rc, schedule) = abi.decode(ret, (int64, address));
            if (rc != HSS_SUCCESS) return (rc, address(0), 0);
            return (rc, schedule, notBefore + i);
        }
        return (HSS_NO_CAPACITY, address(0), 0);
    }

    /// @notice Deletes a schedule this contract created. Never reverts.
    function _deleteSchedule(address schedule) internal returns (int64 rc) {
        (bool ok, bytes memory ret) = HSS.call(abi.encodeCall(IHederaScheduleService.deleteSchedule, (schedule)));
        if (!ok || ret.length < 32) return HSS_UNAVAILABLE;
        return abi.decode(ret, (int64));
    }

    function _hasCapacity(uint256 second, uint256 gasLimit) private view returns (bool answered, bool hasCapacity) {
        (bool ok, bytes memory ret) =
            HSS.staticcall(abi.encodeCall(IHederaScheduleService.hasScheduleCapacity, (second, gasLimit)));
        if (!ok || ret.length < 32) return (false, false);
        return (true, abi.decode(ret, (bool)));
    }
}
