// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { htsSetup } from "hedera-forking/htsSetup.sol";
import { IHRC719 } from "hedera-forking/IHRC719.sol";

import { GovTokenFaucet } from "../contracts/hedera/GovTokenFaucet.sol";
import { VoteToken } from "../contracts/hedera/VoteToken.sol";
import { OfflineMirrorNode } from "./mocks/OfflineMirrorNode.sol";

/// @notice The HTS path end to end against hedera-forking's HTS emulation at 0x167: create the token from
/// a contract, associate, claim, then wrap the real HTS token into voting weight. Runs offline.
contract GovTokenFaucetTest is Test {
    int64 internal constant CLAIM = 1_000e6;
    uint256 internal constant CLAIMED = 1_000e6; // CLAIM as a balance
    uint256 internal constant COOLDOWN = 1 days;

    GovTokenFaucet internal faucet;
    address internal token;
    address internal voter = makeAddr("voter");

    function setUp() public {
        vm.warp(1_790_000_000);
        htsSetup(new OfflineMirrorNode());
        faucet = new GovTokenFaucet(CLAIM, COOLDOWN);
        vm.deal(address(this), 100e8);
        token = faucet.createToken{ value: 50e8 }("DAO Governance", "HGOV");
    }

    function associate(address account) internal {
        vm.prank(account);
        IHRC719(token).associate();
    }

    function test_createsAnHtsTokenWithTheFaucetAsTreasury() public view {
        assertTrue(token != address(0));
        assertEq(IERC20(token).totalSupply(), 0);
        assertEq(faucet.token(), token);
    }

    function test_unchargedCreationValueReturnsToTheDeployer() public view {
        assertEq(address(faucet).balance, 0, "nothing stranded in the faucet");
    }

    function test_tokenCanOnlyBeCreatedOnceByTheDeployer() public {
        vm.expectRevert(GovTokenFaucet.TokenAlreadyCreated.selector);
        faucet.createToken{ value: 1e8 }("Again", "AGN");

        GovTokenFaucet other = new GovTokenFaucet(CLAIM, COOLDOWN);
        vm.prank(voter);
        vm.expectRevert(GovTokenFaucet.NotDeployer.selector);
        other.createToken("X", "X");
    }

    /// @dev The emulator does not enforce association; the live network answers 184
    /// (TOKEN_NOT_ASSOCIATED_TO_ACCOUNT), which is mocked here to test the mapping to a readable error.
    function test_claimWithoutAssociationRevertsReadably() public {
        vm.mockCall(
            address(0x167),
            abi.encodeWithSignature("transferToken(address,address,address,int64)"),
            abi.encode(int64(184))
        );
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(GovTokenFaucet.NotAssociated.selector, voter));
        faucet.claim();
    }

    function test_otherHtsFailuresSurfaceTheirResponseCode() public {
        vm.mockCall(
            address(0x167),
            abi.encodeWithSignature("transferToken(address,address,address,int64)"),
            abi.encode(int64(165))
        );
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(GovTokenFaucet.HtsFailed.selector, int64(165)));
        faucet.claim();
    }

    function test_associatedAccountClaimsOncePerCooldown() public {
        associate(voter);
        vm.prank(voter);
        faucet.claim();
        assertEq(IERC20(token).balanceOf(voter), CLAIMED);

        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(GovTokenFaucet.ClaimTooSoon.selector, vm.getBlockTimestamp() + COOLDOWN));
        faucet.claim();

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(voter);
        faucet.claim();
        assertEq(IERC20(token).balanceOf(voter), 2 * CLAIMED);
    }

    function test_htsTokenWrapsIntoVotingWeight() public {
        VoteToken votes = new VoteToken(IERC20(token), "Voting HGOV", "vHGOV");
        votes.associateUnderlying();
        votes.associateUnderlying(); // idempotent
        assertEq(votes.decimals(), 6, "decimals read through the HTS facade");

        associate(voter);
        vm.startPrank(voter);
        faucet.claim();
        IERC20(token).approve(address(votes), 600e6);
        votes.depositFor(voter, 600e6);
        votes.delegate(voter);
        vm.stopPrank();

        assertEq(votes.getVotes(voter), 600e6);
        assertEq(IERC20(token).balanceOf(address(votes)), 600e6);

        vm.prank(voter);
        votes.withdrawTo(voter, 600e6);
        assertEq(IERC20(token).balanceOf(voter), CLAIMED);
        assertEq(votes.getVotes(voter), 0);
    }
}
