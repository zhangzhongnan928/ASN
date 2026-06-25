// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AgentID} from "./AgentID.sol";
import {CapabilityToken} from "./CapabilityToken.sol";

/// @title Publications
/// @notice Spec v0.3 §5.1 — on-chain commitment anchor for posts. The body lives off-chain on IPFS;
///         the chain stores `cidDigest` (anchor of the CID) + `bodyHash` (keccak of stored bytes:
///         ciphertext for gated, plaintext for public) + `revision` + `keyEpoch` + `visibility`.
///
/// @dev P0: every write is gated on `msg.sender == agentID.ownerOf(agentId)` — only the current
///      owner may publish/update for an AgentId (AT-4, §10 "身份的一切写操作只能由当前 owner").
///      History follows the NFT automatically (state keyed by agentId), so transfer needs no
///      migration (§3.3). On-chain content is immutable history; "edits" are new revisions (§11.2).
contract Publications {
    enum Visibility {
        PUBLIC, // 0
        CAPABILITY_GATED // 1

    }

    struct Publication {
        uint256 agentId;
        bytes32 cidDigest;
        bytes32 bodyHash;
        uint32 revision;
        uint32 keyEpoch;
        Visibility visibility;
        bool exists;
    }

    AgentID public immutable agentID;
    CapabilityToken public immutable capabilityToken;

    /// @dev agentId => pubId => Publication. pubIds start at 1 per publisher.
    mapping(uint256 => mapping(uint256 => Publication)) private _pubs;
    /// @dev agentId => number of publications (also the last assigned pubId).
    mapping(uint256 => uint256) public pubCount;

    event Published(
        uint256 indexed agentId,
        uint256 indexed pubId,
        string cid,
        bytes32 cidDigest,
        bytes32 bodyHash,
        Visibility visibility,
        uint32 revision,
        uint32 keyEpoch,
        address owner
    );
    event Updated(
        uint256 indexed agentId,
        uint256 indexed pubId,
        string cid,
        bytes32 cidDigest,
        bytes32 bodyHash,
        uint32 revision,
        uint32 keyEpoch,
        bool epochRotated
    );

    error NotOwner(uint256 agentId, address caller);
    error NoSuchPublication(uint256 agentId, uint256 pubId);

    constructor(AgentID _agentID, CapabilityToken _capabilityToken) {
        agentID = _agentID;
        capabilityToken = _capabilityToken;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (msg.sender != agentID.ownerOf(agentId)) revert NotOwner(agentId, msg.sender);
        _;
    }

    /// @notice Anchor a new publication for `agentId`. For gated posts, atomically registers the
    ///         resource with CapabilityToken so the publisher controls grants/revokes (§A2).
    function publish(uint256 agentId, string calldata cid, bytes32 bodyHash, Visibility visibility)
        external
        onlyAgentOwner(agentId)
        returns (uint256 pubId)
    {
        bytes32 cidDigest = keccak256(bytes(cid));
        pubId = ++pubCount[agentId];
        _pubs[agentId][pubId] = Publication({
            agentId: agentId,
            cidDigest: cidDigest,
            bodyHash: bodyHash,
            revision: 1,
            keyEpoch: 0,
            visibility: visibility,
            exists: true
        });

        if (visibility == Visibility.CAPABILITY_GATED) {
            capabilityToken.registerResource(resourceIdOf(agentId, pubId), agentId);
        }

        emit Published(agentId, pubId, cid, cidDigest, bodyHash, visibility, 1, 0, msg.sender);
    }

    /// @notice Publish a new revision. `rotateEpoch=true` bumps `keyEpoch` (key rotation, §5.2):
    ///         the new revision is encrypted under the new epoch's CEK off-chain. Combined with a
    ///         prior revoke, this is the AT-3 path (revoked party cannot obtain the new epoch key).
    function update(uint256 agentId, uint256 pubId, string calldata cid, bytes32 bodyHash, bool rotateEpoch)
        external
        onlyAgentOwner(agentId)
    {
        Publication storage p = _pubs[agentId][pubId];
        if (!p.exists) revert NoSuchPublication(agentId, pubId);

        bytes32 cidDigest = keccak256(bytes(cid));
        p.cidDigest = cidDigest;
        p.bodyHash = bodyHash;
        p.revision += 1;
        if (rotateEpoch) p.keyEpoch += 1;

        emit Updated(agentId, pubId, cid, cidDigest, bodyHash, p.revision, p.keyEpoch, rotateEpoch);
    }

    /// @notice Canonical resourceId for capability scoping (§A2).
    function resourceIdOf(uint256 agentId, uint256 pubId) public pure returns (bytes32) {
        return keccak256(abi.encode(agentId, pubId));
    }

    function getPublication(uint256 agentId, uint256 pubId) external view returns (Publication memory) {
        Publication memory p = _pubs[agentId][pubId];
        if (!p.exists) revert NoSuchPublication(agentId, pubId);
        return p;
    }
}
