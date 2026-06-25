// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title ICapabilityToken
/// @notice Spec v0.3 §4.2 — ONE generic capability contract (not seven). Only true access-rights
///         flow through here. MVP implements VIEW only; DM / GROUP_CREATE / DATA_ACCESS are
///         reserved in the enum but unimplemented.
///
/// @dev DEVIATION FROM §4.2 SIGNATURE (documented in docs/ASSUMPTIONS.md §A1): the grantee is a
///      grantee **AgentId** (uint256), not a raw address, so that a *received* capability follows
///      the AgentID-NFT transfer (§3.3). The grant authority is the current owner of the AgentId
///      that controls the resource (the publisher). `hasCapabilityForHolder` recovers the
///      address-oriented spirit of §4.2.
interface ICapabilityToken {
    enum CapType {
        VIEW, // MVP
        DM, // reserved
        GROUP_CREATE, // reserved
        DATA_ACCESS // reserved
    }

    event ResourceRegistered(bytes32 indexed resourceId, uint256 indexed controllerAgentId);
    event CapabilityGranted(
        bytes32 indexed resourceId,
        CapType indexed t,
        uint256 indexed granteeAgentId,
        uint64 expiry,
        uint256 controllerAgentId
    );
    event CapabilityRevoked(
        bytes32 indexed resourceId, CapType indexed t, uint256 indexed granteeAgentId, uint256 controllerAgentId
    );

    /// @notice Bind `resourceId` to its controlling AgentId. Idempotent, first-writer-wins (§A2).
    function registerResource(bytes32 resourceId, uint256 controllerAgentId) external;

    /// @notice Grant capability `t` over `resourceId` to `granteeAgentId` until `expiry`
    ///         (0 == no expiry). Only the resource controller's current owner may call (§A1).
    function grant(CapType t, uint256 granteeAgentId, bytes32 resourceId, uint64 expiry) external;

    /// @notice Revoke capability `t` over `resourceId` from `granteeAgentId`. Same authority as grant.
    function revoke(CapType t, uint256 granteeAgentId, bytes32 resourceId) external;

    /// @notice Canonical, AgentId-keyed check used by the key-service. Active == granted, not
    ///         revoked, and not past expiry.
    function hasCapability(CapType t, uint256 granteeAgentId, bytes32 resourceId) external view returns (bool);

    /// @notice §4.2 address-oriented convenience: active AND `ownerOf(granteeAgentId) == holder`.
    function hasCapabilityForHolder(CapType t, address holder, uint256 granteeAgentId, bytes32 resourceId)
        external
        view
        returns (bool);

    /// @notice The AgentId that controls grants/revokes for `resourceId` (0 if unregistered).
    function resourceController(bytes32 resourceId) external view returns (uint256);
}
