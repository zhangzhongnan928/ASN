// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC6551Account} from "erc6551/interfaces/IERC6551Account.sol";
import {IERC6551Executable} from "erc6551/interfaces/IERC6551Executable.sol";

/// @title ASNTokenBoundAccount
/// @notice ERC-6551 Token Bound Account for an AgentID NFT (spec v0.3 R2 architecture). This is the
///         AGENT'S ENCRYPTION IDENTITY: a deterministic account whose address is fixed by the NFT and
///         does NOT change with ownership. Control of this account == current ownership of the NFT.
///
/// @dev The decisive property for full-inheritance encryption: `isValidSignature` (ERC-1271) delegates
///      to the CURRENT owner via `SignatureChecker`, so a key service can prove "requester controls
///      this TBA" purely from on-chain ownership — which transfers with the NFT. No key migration,
///      no re-seal: the new owner can prove control of the same TBA and unlock everything sealed to it.
///      Based on the ERC-6551 reference `ERC6551Account` (audited reference implementation).
contract ASNTokenBoundAccount is IERC165, IERC1271, IERC6551Account, IERC6551Executable {
    /// @notice Monotonic op counter (ERC-6551 anti-replay nonce for the account's own actions).
    uint256 public state;

    receive() external payable {}

    /// @notice Execute a call from this account. Only the current controller (the NFT owner) may call.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        virtual
        returns (bytes memory result)
    {
        require(_isValidSigner(msg.sender), "Invalid signer");
        require(operation == 0, "Only call operations are supported");
        ++state;
        bool success;
        (success, result) = to.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @inheritdoc IERC6551Account
    function isValidSigner(address signer, bytes calldata) external view virtual returns (bytes4) {
        return _isValidSigner(signer) ? IERC6551Account.isValidSigner.selector : bytes4(0);
    }

    /// @notice ERC-1271. Returns the magic value iff `signature` is valid for the CURRENT owner. The
    ///         owner may be an EOA or a smart account (e.g. Coinbase Smart Wallet) — `SignatureChecker`
    ///         handles ECDSA and ERC-1271 chaining. This is how a key service proves TBA control.
    function isValidSignature(bytes32 hash, bytes memory signature) external view virtual returns (bytes4) {
        if (SignatureChecker.isValidSignatureNow(owner(), hash, signature)) {
            return IERC1271.isValidSignature.selector; // 0x1626ba7e
        }
        return bytes4(0xffffffff);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC6551Account).interfaceId
            || interfaceId == type(IERC6551Executable).interfaceId || interfaceId == type(IERC1271).interfaceId;
    }

    /// @inheritdoc IERC6551Account
    function token() public view virtual returns (uint256, address, uint256) {
        bytes memory footer = new bytes(0x60);
        assembly {
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// @notice The current controller of this account = the current owner of the bound NFT.
    function owner() public view virtual returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        return IERC721(tokenContract).ownerOf(tokenId);
    }

    function _isValidSigner(address signer) internal view virtual returns (bool) {
        return signer == owner();
    }
}
