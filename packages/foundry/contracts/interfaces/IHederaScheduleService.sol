// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The subset of the Hedera Schedule Service system contract (0x16b) used by this template.
/// @dev HIP-1215. A contract that calls `scheduleCall` becomes the schedule's payer and admin, and the
/// network executes the call at `expirySecond` with `msg.sender == that contract`. None of these
/// functions take `msg.value`: sending value to 0x16b fails the whole transaction.
interface IHederaScheduleService {
    /// @param to Contract to call when the schedule fires.
    /// @param expirySecond Consensus second at which the call executes (must be in the future, at most 62 days out).
    /// @param gasLimit Gas for the scheduled call. The payer must hold `gasLimit * gasPrice` when it fires.
    /// @param value Tinybar to send with the scheduled call, taken from the payer at execution.
    /// @return responseCode 22 on success; 370 when the second is full; 373 after an earlier schedule in the same transaction.
    /// @return scheduleAddress Address of the created schedule entity (zero on failure).
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    /// @notice Whether `expirySecond` can still take a schedule with `gasLimit`.
    /// @dev Only authoritative inside a transaction; the JSON-RPC relay simulates view calls without throttles.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);

    /// @notice Deletes a schedule this contract created (it holds the schedule's admin key).
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
