// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaTokenService } from "hedera-forking/IHederaTokenService.sol";

/// @notice Creates the DAO's HTS governance token and hands out demo amounts on testnet.
/// @dev The token is a native HTS fungible token with this contract as treasury and supply key and
/// no admin, freeze, wipe, KYC, pause or fee keys, so nothing can block holders from wrapping or
/// unwrapping. A production DAO would mint a fixed supply instead of using a faucet.
contract GovTokenFaucet {
    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant TOKEN_NOT_ASSOCIATED = 184;
    uint256 internal constant SUPPLY_KEY = 16;
    int64 internal constant AUTO_RENEW_PERIOD = 7_890_000; // ~91 days, the network minimum

    int32 public constant DECIMALS = 6;

    address public immutable deployer;
    /// @notice Amount each claim sends, in the token's smallest unit.
    int64 public immutable claimAmount;
    /// @notice Seconds an account waits between claims.
    uint256 public immutable claimCooldown;

    address public token;
    mapping(address account => uint256 timestamp) public lastClaimAt;

    event TokenCreated(address indexed token, string name, string symbol);
    event Claimed(address indexed account, int64 amount);

    error NotDeployer();
    error TokenAlreadyCreated();
    error TokenNotCreated();
    error ClaimTooSoon(uint256 nextClaimAt);
    error NotAssociated(address account);
    error HtsFailed(int64 responseCode);
    error RefundFailed();

    constructor(int64 claimAmount_, uint256 claimCooldown_) {
        deployer = msg.sender;
        claimAmount = claimAmount_;
        claimCooldown = claimCooldown_;
    }

    /// @notice Creates the HTS token. `msg.value` pays the network's token-creation fee; whatever the
    /// network does not charge is returned to the deployer.
    function createToken(string calldata name, string calldata symbol) external payable returns (address created) {
        if (msg.sender != deployer) revert NotDeployer();
        if (token != address(0)) revert TokenAlreadyCreated();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: SUPPLY_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });

        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: name,
            symbol: symbol,
            treasury: address(this),
            memo: "hedera-ccip-timelock-dao governance token",
            tokenSupplyType: false, // infinite: the faucet mints on demand
            maxSupply: 0,
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0, autoRenewAccount: address(this), autoRenewPeriod: AUTO_RENEW_PERIOD
            })
        });

        int64 rc;
        (rc, created) = IHederaTokenService(HTS).createFungibleToken{ value: msg.value }(spec, 0, DECIMALS);
        if (rc != HTS_SUCCESS) revert HtsFailed(rc);

        token = created;
        emit TokenCreated(created, name, symbol);

        uint256 unused = address(this).balance;
        if (unused != 0) {
            (bool ok,) = deployer.call{ value: unused }("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Mints `claimAmount` and sends it to the caller, at most once per `claimCooldown`.
    /// @dev The caller must already be associated with the token (or have a free auto-association slot);
    /// the frontend calls the token's HIP-719 `associate()` first.
    function claim() external {
        if (token == address(0)) revert TokenNotCreated();
        uint256 next = lastClaimAt[msg.sender] + claimCooldown;
        if (lastClaimAt[msg.sender] != 0 && block.timestamp < next) revert ClaimTooSoon(next);
        lastClaimAt[msg.sender] = block.timestamp;

        (int64 rc,,) = IHederaTokenService(HTS).mintToken(token, claimAmount, new bytes[](0));
        if (rc != HTS_SUCCESS) revert HtsFailed(rc);

        rc = IHederaTokenService(HTS).transferToken(token, address(this), msg.sender, claimAmount);
        if (rc == TOKEN_NOT_ASSOCIATED) revert NotAssociated(msg.sender);
        if (rc != HTS_SUCCESS) revert HtsFailed(rc);

        emit Claimed(msg.sender, claimAmount);
    }
}
