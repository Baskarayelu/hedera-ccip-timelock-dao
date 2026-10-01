// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Demo target on the remote chain: a parameter store namespaced by caller.
/// @dev Stands in for "a protocol setting the DAO controls". Each caller writes only its own namespace,
/// so any DAO's account can use the shared deployment without setup or an owner.
contract RemoteParameters {
    mapping(address owner => mapping(bytes32 key => uint256 value)) public valueOf;
    mapping(address owner => mapping(bytes32 key => uint256 timestamp)) public updatedAt;

    event ParameterSet(address indexed owner, bytes32 indexed key, uint256 value, uint256 previous);

    function set(bytes32 key, uint256 value) external {
        uint256 previous = valueOf[msg.sender][key];
        valueOf[msg.sender][key] = value;
        updatedAt[msg.sender][key] = block.timestamp;
        emit ParameterSet(msg.sender, key, value, previous);
    }
}
