// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { IGovernor } from "@openzeppelin/contracts/governance/IGovernor.sol";

import { DaoGovernor } from "../../contracts/hedera/DaoGovernor.sol";
import { DaoTimelock } from "../../contracts/hedera/DaoTimelock.sol";
import { VoteToken } from "../../contracts/hedera/VoteToken.sol";
import { CrossChainExecutor } from "../../contracts/remote/CrossChainExecutor.sol";
import { RemoteParameters } from "../../contracts/remote/RemoteParameters.sol";
import { MockCcipRouter } from "../mocks/MockCcipRouter.sol";
import { MockHederaScheduleService } from "../mocks/MockHederaScheduleService.sol";
import { MockERC20 } from "../mocks/MockTokens.sol";

/// @notice The whole system on one EVM: the DAO on "Hedera" (mock HSS at 0x16b, mock router) and the
/// executor on "Base Sepolia" (second mock router). Amounts on the Hedera side are tinybar.
abstract contract DaoFixture is Test {
    uint64 internal constant HEDERA = 222_782_988_166_878_823;
    uint64 internal constant BASE = 10_344_971_235_874_465_080;

    uint256 internal constant HBAR = 1e8; // tinybar
    uint256 internal constant HEDERA_CCIP_FEE = 107_369_438; // measured Hedera -> Base Sepolia quote
    uint256 internal constant BASE_CCIP_FEE = 55_891_404_299_253; // measured Base Sepolia -> Hedera quote

    uint48 internal constant VOTING_DELAY = 60;
    uint32 internal constant VOTING_PERIOD = 300;
    uint256 internal constant MIN_DELAY = 120;
    uint256 internal constant AUTO_QUEUE_GAS = 3_000_000;
    uint256 internal constant AUTO_EXECUTE_GAS = 1_500_000;
    uint64 internal constant REQUEST_TTL = 1 days;

    MockHederaScheduleService internal hss = MockHederaScheduleService(address(0x16b));
    MockCcipRouter internal hederaRouter;
    MockCcipRouter internal baseRouter;

    MockERC20 internal gov; // stands in for the HTS token's ERC-20 facade
    VoteToken internal votes;
    DaoTimelock internal timelock;
    DaoGovernor internal governor;

    CrossChainExecutor internal executor;
    RemoteParameters internal params;
    MockERC20 internal usdc;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal grantee = makeAddr("grantee");

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        etchHss();

        hederaRouter = new MockCcipRouter(HEDERA, HEDERA_CCIP_FEE);
        baseRouter = new MockCcipRouter(BASE, BASE_CCIP_FEE);

        gov = new MockERC20("Governance", "GOV", 6);
        votes = new VoteToken(gov, "Voting GOV", "vGOV");

        address[] memory openExecutor = new address[](1); // address(0): anyone may execute a ready operation
        timelock = new DaoTimelock(
            MIN_DELAY, new address[](0), openExecutor, address(this), address(hederaRouter), REQUEST_TTL
        );
        governor = new DaoGovernor(votes, timelock, VOTING_DELAY, VOTING_PERIOD, 0, 4, AUTO_QUEUE_GAS, AUTO_EXECUTE_GAS);

        executor = new CrossChainExecutor(address(baseRouter), 200_000, 3);
        params = new RemoteParameters();
        usdc = new MockERC20("USD Coin", "USDC", 6);

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
        timelock.setRemoteExecutor(BASE, address(executor));
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));

        vm.deal(address(timelock), 100 * HBAR);
        vm.deal(address(governor), 20 * HBAR);

        giveVotes(alice, 400e6);
        giveVotes(bob, 300e6);
        giveVotes(carol, 300e6);
        vm.warp(block.timestamp + 1);
    }

    function etchHss() internal {
        vm.etch(address(0x16b), type(MockHederaScheduleService).runtimeCode);
    }

    /// @dev Mints GOV, wraps it and self-delegates, the three steps a voter takes in the UI.
    function giveVotes(address voter, uint256 amount) internal {
        gov.mint(voter, amount);
        vm.startPrank(voter);
        gov.approve(address(votes), amount);
        votes.depositFor(voter, amount);
        votes.delegate(voter);
        vm.stopPrank();
    }

    /// @dev Marks a new Hedera transaction (HSS allows one `scheduleCall` per transaction).
    function nextTx() internal {
        hss.newTransaction();
    }

    struct Proposal {
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
        string description;
    }

    function single(address target, uint256 value, bytes memory data, string memory description)
        internal
        pure
        returns (Proposal memory p)
    {
        p.targets = new address[](1);
        p.values = new uint256[](1);
        p.calldatas = new bytes[](1);
        p.targets[0] = target;
        p.values[0] = value;
        p.calldatas[0] = data;
        p.description = description;
    }

    function propose(Proposal memory p) internal returns (uint256 id) {
        nextTx();
        vm.prank(alice);
        id = governor.propose(p.targets, p.values, p.calldatas, p.description);
    }

    function voteFor(uint256 id, address[] memory voters) internal {
        vm.warp(governor.proposalSnapshot(id) + 1);
        for (uint256 i; i < voters.length; ++i) {
            nextTx();
            vm.prank(voters[i]);
            governor.castVote(id, 1);
        }
    }

    function everyoneVotesFor(uint256 id) internal {
        address[] memory voters = new address[](3);
        voters[0] = alice;
        voters[1] = bob;
        voters[2] = carol;
        voteFor(id, voters);
    }

    /// @dev Second the network's auto-queue call is due.
    function queueAt(uint256 id) internal view returns (uint256) {
        return governor.proposalDeadline(id) + 1 + governor.BLOCK_CLOCK_MARGIN();
    }

    /// @dev Second the network's auto-execute call is due.
    function executeAt(uint256 id) internal view returns (uint256) {
        return governor.proposalEta(id) + governor.BLOCK_CLOCK_MARGIN();
    }

    /// @dev Lets the network do the rest: auto-queue after voting, auto-execute after the timelock.
    function runToExecution(uint256 id) internal {
        vm.warp(queueAt(id));
        hss.executeDue();
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Queued), "not auto-queued");
        vm.warp(executeAt(id));
        hss.executeDue();
    }

    function descriptionHash(Proposal memory p) internal pure returns (bytes32) {
        return keccak256(bytes(p.description));
    }

    function operationId(Proposal memory p) internal view returns (bytes32) {
        return timelock.hashOperationBatch(p.targets, p.values, p.calldatas, 0, governorSalt(p));
    }

    /// @dev GovernorTimelockControl's salt: the governor address xor'ed into the description hash.
    function governorSalt(Proposal memory p) internal view returns (bytes32) {
        return bytes20(address(governor)) ^ descriptionHash(p);
    }
}
