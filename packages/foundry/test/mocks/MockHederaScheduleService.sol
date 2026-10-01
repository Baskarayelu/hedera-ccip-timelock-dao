// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Vm } from "forge-std/Vm.sol";

/// @notice Test double for the Hedera Schedule Service at 0x16b, modelling the behaviour measured on
/// testnet (HAPI 0.77): 15M scheduled gas per second, one `scheduleCall` per transaction (373), busy
/// seconds (370), the 62-day window (306/307), contract payers, and a payer that cannot cover
/// `gasLimit * gasPrice` when the call fires (the schedule is consumed, nothing retries), and a call
/// that reads `block.timestamp` up to 3 s earlier than its due second.
/// @dev Etched at 0x16b, so it keeps no constructor state. Tests mark transaction boundaries with
/// `newTransaction()`; `executeDue()` plays the network firing every due schedule.
contract MockHederaScheduleService {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    int64 public constant SUCCESS = 22;
    int64 public constant INVALID_SIGNATURE = 7;
    int64 public constant INVALID_SCHEDULE_ID = 201;
    int64 public constant SCHEDULE_EXPIRATION_TIME_TOO_FAR_IN_FUTURE = 306;
    int64 public constant SCHEDULE_EXPIRATION_TIME_MUST_BE_HIGHER_THAN_CONSENSUS_TIME = 307;
    int64 public constant SCHEDULE_EXPIRY_IS_BUSY = 370;
    int64 public constant NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION = 373;

    uint256 public constant MAX_GAS_PER_SECOND = 15_000_000;
    uint256 public constant MAX_EXPIRY_SECONDS = 5_356_800; // 62 days
    uint256 public constant GAS_PRICE = 82; // tinybar per gas on testnet
    /// @dev Worst-case gap between a schedule's consensus second and the `block.timestamp` its call reads
    /// (Hedera's block clock is the start of the ~2 s record-file block).
    uint256 public constant BLOCK_CLOCK_LAG = 3;
    uint160 internal constant SCHEDULE_ADDRESS_OFFSET = 0x5c4ed;

    enum Status {
        Pending,
        Executed,
        Reverted,
        InsufficientPayerBalance,
        Deleted
    }

    struct Scheduled {
        address payer;
        address to;
        uint256 at;
        uint256 gasLimit;
        bytes data;
        Status status;
    }

    Scheduled[] internal _schedules;
    mapping(uint256 second => uint256 gas) public gasReservedAt;
    uint256 public transactionNumber;
    mapping(uint256 txNumber => bool scheduled) internal _scheduledIn;

    // ---- system contract surface -----------------------------------------------------------------

    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64, address)
    {
        require(value == 0, "mock: value not modelled");
        if (_scheduledIn[transactionNumber]) return (NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION, address(0));
        if (expirySecond <= block.timestamp) {
            return (SCHEDULE_EXPIRATION_TIME_MUST_BE_HIGHER_THAN_CONSENSUS_TIME, address(0));
        }
        if (expirySecond > block.timestamp + MAX_EXPIRY_SECONDS) {
            return (SCHEDULE_EXPIRATION_TIME_TOO_FAR_IN_FUTURE, address(0));
        }
        if (gasReservedAt[expirySecond] + gasLimit > MAX_GAS_PER_SECOND) return (SCHEDULE_EXPIRY_IS_BUSY, address(0));

        _scheduledIn[transactionNumber] = true;
        gasReservedAt[expirySecond] += gasLimit;
        _schedules.push(
            Scheduled({
                payer: msg.sender, to: to, at: expirySecond, gasLimit: gasLimit, data: callData, status: Status.Pending
            })
        );
        return (SUCCESS, scheduleAddress(_schedules.length - 1));
    }

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool) {
        return expirySecond > block.timestamp && expirySecond <= block.timestamp + MAX_EXPIRY_SECONDS
            && gasReservedAt[expirySecond] + gasLimit <= MAX_GAS_PER_SECOND;
    }

    function deleteSchedule(address schedule) external returns (int64) {
        uint256 index = uint160(schedule) - SCHEDULE_ADDRESS_OFFSET;
        if (index >= _schedules.length || _schedules[index].status != Status.Pending) return INVALID_SCHEDULE_ID;
        Scheduled storage s = _schedules[index];
        if (s.payer != msg.sender) return INVALID_SIGNATURE;
        s.status = Status.Deleted;
        gasReservedAt[s.at] -= s.gasLimit;
        return SUCCESS;
    }

    // ---- test controls ---------------------------------------------------------------------------

    function newTransaction() public {
        ++transactionNumber;
    }

    /// @notice Fills `second` so that nothing else fits (simulates other users' schedules).
    function occupy(uint256 second, uint256 gas) external {
        gasReservedAt[second] += gas;
    }

    /// @notice Fires every schedule due at or before now, in (second, creation) order, each as its own
    /// transaction, including schedules created by earlier executions in the same sweep.
    function executeDue() external returns (uint256 fired) {
        while (true) {
            (bool found, uint256 index) = _nextDue();
            if (!found) return fired;
            _fire(index);
            ++fired;
        }
    }

    function scheduleCount() external view returns (uint256) {
        return _schedules.length;
    }

    function scheduleAt(uint256 index) external view returns (Scheduled memory) {
        return _schedules[index];
    }

    function statusOf(address schedule) external view returns (Status) {
        return _schedules[uint160(schedule) - SCHEDULE_ADDRESS_OFFSET].status;
    }

    function scheduleAddress(uint256 index) public pure returns (address) {
        // forge-lint: disable-next-line(unsafe-typecast) indexes are array positions, far below 2^160
        return address(uint160(index) + SCHEDULE_ADDRESS_OFFSET);
    }

    // ---- internals -------------------------------------------------------------------------------

    function _nextDue() internal view returns (bool found, uint256 index) {
        uint256 best = type(uint256).max;
        for (uint256 i; i < _schedules.length; ++i) {
            Scheduled storage s = _schedules[i];
            if (s.status == Status.Pending && s.at <= VM.getBlockTimestamp() && s.at < best) {
                best = s.at;
                index = i;
                found = true;
            }
        }
    }

    function _fire(uint256 index) internal {
        Scheduled storage s = _schedules[index];
        newTransaction();
        gasReservedAt[s.at] -= s.gasLimit;

        uint256 reserve = s.gasLimit * GAS_PRICE;
        if (s.payer.balance < reserve) {
            s.status = Status.InsufficientPayerBalance;
            return;
        }

        uint256 sweepTime = VM.getBlockTimestamp();
        VM.warp(s.at - BLOCK_CLOCK_LAG);
        uint256 gasBefore = gasleft();
        VM.prank(s.payer);
        (bool ok,) = s.to.call{ gas: s.gasLimit }(s.data);
        uint256 used = gasBefore - gasleft();
        VM.warp(sweepTime);
        s.status = ok ? Status.Executed : Status.Reverted;
        VM.deal(s.payer, s.payer.balance - used * GAS_PRICE);
    }
}
