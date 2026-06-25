// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC6551Account} from "erc6551/interfaces/IERC6551Account.sol";

/// @title TBAKeyRegistry
/// @notice On-chain registration + rotation of the encryption public key bound to an AgentID's
///         Token Bound Account (spec v0.3 R2). Key envelopes for private content are sealed (at rest)
///         to a TBA's registered encryption pubkey; the key service releases a CEK only to a proven
///         controller of that TBA (ERC-1271). Rotation lets the controller replace the key (e.g. if
///         the key-service operator's key is suspected compromised).
///
/// @dev Registration/rotation is gated on CURRENT control of the TBA: the caller must be a valid
///      signer of the TBA (`isValidSigner` returns the magic selector), which resolves to the current
///      NFT owner. So the right to set the key follows the identity — consistent with full inheritance.
contract TBAKeyRegistry {
    bytes4 private constant VALID_SIGNER = IERC6551Account.isValidSigner.selector;

    /// @dev tba => registered encryption public key (e.g. 32-byte X25519). Empty == unregistered.
    mapping(address => bytes) private _encPubkey;
    /// @dev tba => rotation count (version). Lets the key service pick the current key + audit history.
    mapping(address => uint256) public keyVersion;

    event KeyRegistered(address indexed tba, bytes pubkey, uint256 version);

    error NotTBAController(address tba, address caller);
    error EmptyKey();

    /// @notice Register or rotate the encryption pubkey for `tba`. Caller must currently control `tba`.
    function registerKey(address tba, bytes calldata pubkey) external {
        if (pubkey.length == 0) revert EmptyKey();
        if (IERC6551Account(payable(tba)).isValidSigner(msg.sender, "") != VALID_SIGNER) {
            revert NotTBAController(tba, msg.sender);
        }
        _encPubkey[tba] = pubkey;
        uint256 v = keyVersion[tba] + 1;
        keyVersion[tba] = v;
        emit KeyRegistered(tba, pubkey, v);
    }

    function encryptionKey(address tba) external view returns (bytes memory) {
        return _encPubkey[tba];
    }
}
