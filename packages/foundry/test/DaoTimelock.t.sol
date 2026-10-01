// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { htsSetup } from "hedera-forking/htsSetup.sol";
import { IHRC719 } from "hedera-forking/IHRC719.sol";

import { GovTokenFaucet } from "../contracts/hedera/GovTokenFaucet.sol";
import { DaoTimelock } from "../contracts/hedera/DaoTimelock.sol";
import { OfflineMirrorNode } from "./mocks/OfflineMirrorNode.sol";
import { DaoFixture } from "./utils/DaoFixture.sol";

contract DaoTimelockTest is DaoFixture {
    function test_adminIsRenouncedAfterWiring() public view {
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), address(governor)));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "execution is permissionless");
    }

    function test_settingsChangeOnlyThroughGovernance() public {
        vm.expectRevert(DaoTimelock.OnlySelf.selector);
        timelock.setRequestTtl(1);
        vm.expectRevert(DaoTimelock.OnlySelfOrAdmin.selector);
        timelock.setRemoteExecutor(BASE, address(1));
        vm.expectRevert(DaoTimelock.OnlySelfOrAdmin.selector);
        timelock.associateToken(address(gov));
    }

    function test_governanceCanRetargetTheRemoteExecutor() public {
        address newExecutor = makeAddr("new executor");
        Proposal memory p = single(
            address(timelock), 0, abi.encodeCall(DaoTimelock.setRemoteExecutor, (BASE, newExecutor)), "Move executor"
        );
        uint256 id = propose(p);
        everyoneVotesFor(id);
        runToExecution(id);
        assertEq(timelock.remoteExecutors(BASE), newExecutor);
    }

    function test_treasuryAssociatesWithAnHtsTokenOnce() public {
        htsSetup(new OfflineMirrorNode());
        GovTokenFaucet faucet = new GovTokenFaucet(1e6, 1 days);
        address token = faucet.createToken{ value: 50e8 }("DAO Governance", "HGOV");

        address[] memory none = new address[](0);
        DaoTimelock fresh = new DaoTimelock(MIN_DELAY, none, none, address(this), address(hederaRouter), 1 days);
        fresh.associateToken(token);
        fresh.associateToken(token); // idempotent

        vm.prank(address(fresh));
        assertTrue(IHRC719(token).isAssociated());
    }

    function test_advertisesCcipReceiverAndTimelockInterfaces() public view {
        assertTrue(timelock.supportsInterface(0x85572ffb), "IAny2EVMMessageReceiver");
        assertTrue(timelock.supportsInterface(0x01ffc9a7), "IERC165");
        assertTrue(timelock.supportsInterface(0x4e2312e0), "IERC1155Receiver");
        assertTrue(executor.supportsInterface(0x85572ffb), "executor is a CCIP receiver too");
    }

    function test_treasuryAcceptsHbar() public {
        (bool ok,) = address(timelock).call{ value: 1 * HBAR }("");
        assertTrue(ok);
    }
}
