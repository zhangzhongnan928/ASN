// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title IAgentIdentity
/// @notice Spec v0.3 §3.2 identity adapter. AgentID is an ERC-721 minted to an ERC-4337 smart
///         account. Transfer is the standard ERC-721 transfer with NO extra migration logic:
///         all state (publications / capabilities / social graph / reputation) is keyed by
///         tokenId elsewhere, so an owner change carries everything automatically (§3.3 full
///         inheritance). Metadata is ERC-8004-compatible but kept behind this adapter so we are
///         not locked to a draft standard (§14).
interface IAgentIdentity {
    /// @notice Permissionless self-mint of a fresh AgentID to the caller (§A5, P1-B anti-grief).
    function mint() external returns (uint256 agentId);

    /// @notice Mint to a consenting third party (ERC-1271 acceptance over (to, nonce)).
    function mintTo(address to, uint256 nonce, bytes calldata acceptance) external returns (uint256 agentId);

    /// @notice Current owner (= the controlling ERC-4337 smart account).
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice ERC-8004-compatible metadata URI.
    function tokenURI(uint256 agentId) external view returns (string memory);
    // Standard ERC-721 transfer is open; Transfer events are public for relationship monitoring.
}
