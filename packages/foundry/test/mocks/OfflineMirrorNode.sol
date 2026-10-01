// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { MirrorNode } from "hedera-forking/MirrorNode.sol";

/// @notice Mirror node provider for hedera-forking's HTS emulation that never touches the network.
/// @dev Every EVM address exists as an account (number derived from the address) and nothing else is
/// known remotely, so tokens and balances come only from what the test creates. This keeps the HTS
/// tests deterministic and runnable in CI without `--fork-url` or mirror node access.
contract OfflineMirrorNode is MirrorNode {
    function fetchAccount(string memory account) external pure override returns (string memory) {
        uint256 num = 1_000 + (uint256(keccak256(bytes(account))) % 4_000_000_000);
        return string.concat('{"account":"0.0.', _toString(num), '","evm_address":"', account, '"}');
    }

    function fetchTokenData(address) external pure override returns (string memory) {
        return "{}";
    }

    function fetchBalance(address, uint32) external pure override returns (string memory) {
        return "{}";
    }

    function fetchAllowance(address, uint32, uint32) external pure override returns (string memory) {
        return "{}";
    }

    function fetchNftAllowance(address, uint32, uint32) external pure override returns (string memory) {
        return "{}";
    }

    function fetchTokenRelationshipOfAccount(string memory, address) external pure override returns (string memory) {
        return "{}";
    }

    function fetchNonFungibleToken(address, uint32) external pure override returns (string memory) {
        return "{}";
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory out = new bytes(digits);
        for (; value != 0; value /= 10) {
            // forge-lint: disable-next-line(unsafe-typecast) a decimal digit is 48..57
            out[--digits] = bytes1(uint8(48 + value % 10));
        }
        return string(out);
    }
}
