// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AgentID} from "./AgentID.sol";
import {ICapabilityToken} from "./interfaces/ICapabilityToken.sol";

/// @title CapabilityToken
/// @notice Spec v0.3 §4.2 — the single generic capability contract. P0 #1: capability authorization
///         correctness. Only the resource controller's *current owner* can grant/revoke; nobody can
///         self-grant, forge, or replay a capability (AT-2). The grantee is an AgentId, so a received
///         capability follows the grantee's NFT transfer, and grant authority follows the publisher's
///         NFT transfer — the §3.3 full-inheritance model, with zero per-transfer migration code.
///
/// @dev Resources are registered ONLY by the trusted `Publications` contract, which derives the
///      controller from its own verified state. This closes the front-running/hijack vector that an
///      opaque, externally-registerable resourceId would otherwise open (docs/ASSUMPTIONS.md §A2).
contract CapabilityToken is ICapabilityToken {
    /// @dev Sentinel stored for a grant that has no expiry. `0` means "no capability".
    uint64 private constant NO_EXPIRY = type(uint64).max;

    AgentID public immutable agentID;

    /// @dev resourceId => controlling AgentId (0 == unregistered).
    mapping(bytes32 => uint256) private _controller;

    /// @dev resourceId => capType => granteeAgentId => expiry (0 none, NO_EXPIRY = perpetual).
    mapping(bytes32 => mapping(CapType => mapping(uint256 => uint64))) private _cap;

    /// @dev One-time wiring of the Publications contract (the only resource registrar).
    address public publications;
    address private immutable _wirer;

    error NotResourceOwner(bytes32 resourceId, address caller);
    error ResourceNotRegistered(bytes32 resourceId);
    error OnlyPublications(address caller);
    error AlreadyWired();
    error UnimplementedCapType(CapType t);

    /// @param wirer_ the address allowed to perform the one-time `setPublications` wiring. Passed
    ///        explicitly (not `msg.sender`) so the contract can be deployed via a CREATE2 factory
    ///        (where `msg.sender` would be the factory) while keeping the deployer in control.
    constructor(AgentID _agentID, address wirer_) {
        agentID = _agentID;
        _wirer = wirer_;
    }

    /// @notice One-time wiring (avoids the CapabilityToken<->Publications constructor cycle).
    function setPublications(address _publications) external {
        if (msg.sender != _wirer) revert OnlyPublications(msg.sender);
        if (publications != address(0)) revert AlreadyWired();
        publications = _publications;
    }

    /// @inheritdoc ICapabilityToken
    /// @dev Idempotent + first-writer-wins, but ONLY callable by Publications, which always passes
    ///      the true controller. So an attacker can neither register a foreign resource nor re-bind
    ///      an existing one (AT-2).
    function registerResource(bytes32 resourceId, uint256 controllerAgentId) external {
        if (msg.sender != publications) revert OnlyPublications(msg.sender);
        if (_controller[resourceId] == 0) {
            _controller[resourceId] = controllerAgentId;
            emit ResourceRegistered(resourceId, controllerAgentId);
        }
        // else: already registered — keep the original controller (first-writer-wins).
    }

    /// @inheritdoc ICapabilityToken
    function grant(CapType t, uint256 granteeAgentId, bytes32 resourceId, uint64 expiry) external {
        if (t != CapType.VIEW) revert UnimplementedCapType(t); // MVP: VIEW only
        uint256 controllerAgentId = _requireController(resourceId);
        _requireResourceOwner(controllerAgentId, resourceId);

        uint64 stored = expiry == 0 ? NO_EXPIRY : expiry;
        _cap[resourceId][t][granteeAgentId] = stored;
        emit CapabilityGranted(resourceId, t, granteeAgentId, expiry, controllerAgentId);
    }

    /// @inheritdoc ICapabilityToken
    function revoke(CapType t, uint256 granteeAgentId, bytes32 resourceId) external {
        uint256 controllerAgentId = _requireController(resourceId);
        _requireResourceOwner(controllerAgentId, resourceId);

        delete _cap[resourceId][t][granteeAgentId];
        emit CapabilityRevoked(resourceId, t, granteeAgentId, controllerAgentId);
    }

    /// @inheritdoc ICapabilityToken
    function hasCapability(CapType t, uint256 granteeAgentId, bytes32 resourceId) public view returns (bool) {
        uint64 e = _cap[resourceId][t][granteeAgentId];
        if (e == 0) return false; // not granted / revoked
        if (e == NO_EXPIRY) return true; // perpetual grant
        return block.timestamp < e; // expiry auto-fail (AT-3 boundary)
    }

    /// @inheritdoc ICapabilityToken
    function hasCapabilityForHolder(CapType t, address holder, uint256 granteeAgentId, bytes32 resourceId)
        external
        view
        returns (bool)
    {
        if (!hasCapability(t, granteeAgentId, resourceId)) return false;
        return _safeOwnerOf(granteeAgentId) == holder;
    }

    /// @inheritdoc ICapabilityToken
    function resourceController(bytes32 resourceId) external view returns (uint256) {
        return _controller[resourceId];
    }

    /// @notice Raw stored expiry (0 none, NO_EXPIRY perpetual) — used by indexers/key-services.
    function capabilityExpiry(CapType t, uint256 granteeAgentId, bytes32 resourceId) external view returns (uint64) {
        return _cap[resourceId][t][granteeAgentId];
    }

    function _requireController(bytes32 resourceId) internal view returns (uint256 controllerAgentId) {
        controllerAgentId = _controller[resourceId];
        if (controllerAgentId == 0) revert ResourceNotRegistered(resourceId);
    }

    function _requireResourceOwner(uint256 controllerAgentId, bytes32 resourceId) internal view {
        if (msg.sender != agentID.ownerOf(controllerAgentId)) revert NotResourceOwner(resourceId, msg.sender);
    }

    function _safeOwnerOf(uint256 agentId) internal view returns (address) {
        try agentID.ownerOf(agentId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
