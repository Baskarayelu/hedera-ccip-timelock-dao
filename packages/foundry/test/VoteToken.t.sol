// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IGovernor } from "@openzeppelin/contracts/governance/IGovernor.sol";

import { VoteToken } from "../contracts/hedera/VoteToken.sol";
import { FeeOnTransferToken } from "./mocks/MockTokens.sol";
import { DaoFixture } from "./utils/DaoFixture.sol";

contract VoteTokenTest is DaoFixture {
    address internal dave = makeAddr("dave");

    function test_wrapAndUnwrapAreOneToOne() public {
        gov.mint(dave, 50e6);
        vm.startPrank(dave);
        gov.approve(address(votes), 50e6);
        votes.depositFor(dave, 50e6);
        assertEq(votes.balanceOf(dave), 50e6);
        assertEq(gov.balanceOf(address(votes)), 1000e6 + 50e6);

        votes.withdrawTo(dave, 20e6);
        vm.stopPrank();
        assertEq(votes.balanceOf(dave), 30e6);
        assertEq(gov.balanceOf(dave), 20e6);
    }

    function test_clockIsTimestamp() public view {
        assertEq(votes.clock(), vm.getBlockTimestamp());
        assertEq(votes.CLOCK_MODE(), "mode=timestamp");
    }

    function test_decimalsMirrorUnderlying() public view {
        assertEq(votes.decimals(), 6);
    }

    function test_votingWeightNeedsDelegation() public {
        gov.mint(dave, 10e6);
        vm.startPrank(dave);
        gov.approve(address(votes), 10e6);
        votes.depositFor(dave, 10e6);
        vm.stopPrank();
        assertEq(votes.getVotes(dave), 0);

        vm.prank(dave);
        votes.delegate(dave);
        assertEq(votes.getVotes(dave), 10e6);
    }

    /// @dev The core safety property: weight is read at the proposal snapshot, so passing tokens to a
    /// second account after voting cannot vote them twice.
    function test_transferAfterSnapshotCannotVoteTwice() public {
        uint256 id = propose(single(address(params), 0, "", "double vote"));
        vm.warp(governor.proposalSnapshot(id) + 1);

        vm.prank(alice);
        governor.castVote(id, 1);

        vm.prank(alice);
        assertTrue(votes.transfer(dave, 400e6));
        vm.prank(dave);
        votes.delegate(dave);
        assertEq(votes.getVotes(dave), 400e6, "dave holds the votes now");

        vm.prank(dave);
        governor.castVote(id, 1);

        (, uint256 forVotes,) = governor.proposalVotes(id);
        assertEq(forVotes, 400e6, "the same tokens counted once");
    }

    function test_wrappingAfterSnapshotGivesNoWeight() public {
        uint256 id = propose(single(address(params), 0, "", "late wrap"));
        vm.warp(governor.proposalSnapshot(id) + 1);

        giveVotes(dave, 1_000_000e6);
        vm.prank(dave);
        governor.castVote(id, 0);

        (uint256 againstVotes,,) = governor.proposalVotes(id);
        assertEq(againstVotes, 0, "tokens wrapped after the snapshot cannot vote");
    }

    function test_unwrapAfterVotingKeepsCountedWeight() public {
        uint256 id = propose(single(address(params), 0, "", "unwrap"));
        vm.warp(governor.proposalSnapshot(id) + 1);
        vm.prank(bob);
        governor.castVote(id, 1);

        vm.prank(bob);
        votes.withdrawTo(bob, 300e6);
        (, uint256 forVotes,) = governor.proposalVotes(id);
        assertEq(forVotes, 300e6, "a cast vote is final");
        assertEq(votes.getVotes(bob), 0);
    }

    function test_delegatingBeforeSnapshotMovesWeight() public {
        vm.prank(carol);
        votes.delegate(bob);
        uint256 id = propose(single(address(params), 0, "", "delegation"));
        vm.warp(governor.proposalSnapshot(id) + 1);

        vm.prank(bob);
        governor.castVote(id, 1);
        (, uint256 forVotes,) = governor.proposalVotes(id);
        assertEq(forVotes, 600e6);
        assertEq(uint8(governor.state(id)), uint8(IGovernor.ProposalState.Active));
    }

    function test_feeOnTransferUnderlyingIsRejected() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        VoteToken wrapper = new VoteToken(feeToken, "Wrapped Fee", "wFEE");
        feeToken.mint(dave, 100e6);

        vm.startPrank(dave);
        feeToken.approve(address(wrapper), 100e6);
        vm.expectRevert(abi.encodeWithSelector(VoteToken.UnexpectedDeposit.selector, 100e6, 99e6));
        wrapper.depositFor(dave, 100e6);
        vm.stopPrank();
    }

    function testFuzz_totalSupplyMatchesUnderlyingHeld(uint96 wrapIn, uint96 unwrapOut) public {
        wrapIn = uint96(bound(wrapIn, 1, 1e18));
        unwrapOut = uint96(bound(unwrapOut, 0, wrapIn));
        gov.mint(dave, wrapIn);
        vm.startPrank(dave);
        gov.approve(address(votes), wrapIn);
        votes.depositFor(dave, wrapIn);
        votes.withdrawTo(dave, unwrapOut);
        vm.stopPrank();
        assertEq(votes.totalSupply(), gov.balanceOf(address(votes)));
    }
}
