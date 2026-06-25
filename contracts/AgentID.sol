// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";

/// @title AgentID
/// @notice Spec v0.3 §3 — the agent identity. An ERC-721 minted (permissionlessly) to an ERC-4337
///         smart account. Standard, open transfer with NO migration logic: every piece of state
///         (publications, capabilities, social graph, reputation) lives keyed by tokenId in other
///         contracts, so changing `ownerOf` carries the entire asset package to the new owner
///         (§3.3 full inheritance, §A5 permissionless).
///
/// @dev We deliberately do NOT implement `signerOf` / key rotation / recovery here — key management
///      is the smart account's job (ERC-6900 / 7579 modules), §3.1.
contract AgentID is ERC721, IAgentIdentity {
    using Strings for uint256;

    /// @dev Monotonic id counter; ids start at 1 so that 0 is an explicit "none".
    uint256 private _nextId = 1;

    /// @dev Optional per-token metadata URI set by the current owner (ERC-8004-compatible payload).
    ///      If empty, `tokenURI` falls back to `_baseURI + tokenId`.
    mapping(uint256 => string) private _tokenURIOverride;

    string private _base;

    /// @dev EIP-712 accept typehash for `mintTo` (recipient consent, replay-protected by nonce).
    bytes32 public constant MINT_ACCEPT_TYPEHASH = keccak256("ASNMintAccept(address to,uint256 nonce)");
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev recipient => nonce => used (prevents acceptance-signature replay).
    mapping(address => mapping(uint256 => bool)) public mintAcceptUsed;

    event AgentMinted(uint256 indexed agentId, address indexed smartAccount);
    event AgentMetadataSet(uint256 indexed agentId, string uri);

    error NotOwner(uint256 agentId, address caller);
    error ZeroSmartAccount();
    error MintAcceptInvalid();
    error MintAcceptUsed();

    constructor(string memory baseURI) ERC721("ASN Agent Identity", "ASNID") {
        _base = baseURI;
    }

    /// @notice Permissionless self-mint: the caller (an agent's smart account, in one tool call)
    ///         receives a fresh identity. Minting to `msg.sender` removes the griefing vector where
    ///         anyone could spray unsolicited NFTs onto a victim's address (P1-B). No gatekeeper (§A5).
    function mint() external returns (uint256 agentId) {
        agentId = _nextId++;
        _safeMint(msg.sender, agentId);
        emit AgentMinted(agentId, msg.sender);
    }

    /// @notice Mint to a third party only with that party's explicit consent: `to` (an EOA or
    ///         ERC-1271 smart account) must sign `ASNMintAccept(to, nonce)`. This keeps minting
    ///         permissionless while making it impossible to dump an identity on an unwilling address.
    function mintTo(address to, uint256 nonce, bytes calldata acceptance) external returns (uint256 agentId) {
        if (to == address(0)) revert ZeroSmartAccount();
        if (mintAcceptUsed[to][nonce]) revert MintAcceptUsed();
        if (!SignatureChecker.isValidSignatureNow(to, mintAcceptDigest(to, nonce), acceptance)) revert MintAcceptInvalid();
        mintAcceptUsed[to][nonce] = true;
        agentId = _nextId++;
        _safeMint(to, agentId);
        emit AgentMinted(agentId, to);
    }

    /// @notice EIP-712 domain separator (recomputed each call for fork safety: binds chainId +
    ///         this contract address, preventing cross-chain / cross-deployment acceptance replay).
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("ASN AgentID"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice The EIP-712 digest a recipient must sign to consent to `mintTo(to, nonce)`.
    function mintAcceptDigest(address to, uint256 nonce) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(MINT_ACCEPT_TYPEHASH, to, nonce));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// @inheritdoc IAgentIdentity
    function ownerOf(uint256 agentId) public view override(ERC721, IAgentIdentity) returns (address) {
        return super.ownerOf(agentId);
    }

    /// @notice Set ERC-8004-compatible metadata. Only the current owner — i.e. every identity write
    ///         is gated on `msg.sender == ownerOf` (§AT-4, the "身份的一切写操作只能由当前 owner" rule).
    function setTokenURI(uint256 agentId, string calldata uri) external {
        if (msg.sender != ownerOf(agentId)) revert NotOwner(agentId, msg.sender);
        _tokenURIOverride[agentId] = uri;
        emit AgentMetadataSet(agentId, uri);
    }

    /// @inheritdoc IAgentIdentity
    function tokenURI(uint256 agentId) public view override(ERC721, IAgentIdentity) returns (string memory) {
        _requireOwned(agentId);
        string memory ov = _tokenURIOverride[agentId];
        if (bytes(ov).length != 0) return ov;
        return bytes(_base).length != 0 ? string.concat(_base, agentId.toString()) : "";
    }

    /// @notice Total number of identities minted so far (also the last assigned id).
    function totalMinted() external view returns (uint256) {
        return _nextId - 1;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IAgentIdentity).interfaceId || super.supportsInterface(interfaceId);
    }
}
