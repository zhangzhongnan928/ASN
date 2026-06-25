// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {AgentID} from "../../contracts/AgentID.sol";

/// @title R2 P1-B — mint anti-griefing.
/// @notice Defends: nobody can dump an unsolicited identity NFT onto a victim's address. `mint()`
///         self-mints to the caller; `mintTo` requires the recipient's ERC-1271 acceptance (replay-
///         protected by nonce). (spec v0.3 R2 P1-B.)
contract P1B_MintGrief is Test {
    AgentID internal agentID;
    uint256 internal constant TO_PK = 0xA0;
    uint256 internal constant ATK_PK = 0xBAD;

    function setUp() public {
        agentID = new AgentID("ipfs://asn/agent/");
    }

    function test_selfMint_goesToCaller() public {
        address alice = address(0xA11CE);
        vm.prank(alice);
        uint256 id = agentID.mint();
        assertEq(agentID.ownerOf(id), alice);
    }

    function test_mintTo_requiresConsent() public {
        address to = vm.addr(TO_PK);
        uint256 nonce = 42;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TO_PK, agentID.mintAcceptDigest(to, nonce));
        bytes memory acceptance = abi.encodePacked(r, s, v);

        // anyone can submit the mint, but only with the recipient's signature.
        vm.prank(address(0xCAFE));
        uint256 id = agentID.mintTo(to, nonce, acceptance);
        assertEq(agentID.ownerOf(id), to);
    }

    /// EIP-712 domain binds the acceptance to THIS contract: a signature for one deployment cannot be
    /// replayed against another deployment (different verifyingContract) — defeats cross-deploy grief.
    function test_mintTo_eip712DomainBound() public {
        address to = vm.addr(TO_PK);
        uint256 nonce = 99;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TO_PK, agentID.mintAcceptDigest(to, nonce));
        bytes memory acceptance = abi.encodePacked(r, s, v);

        AgentID other = new AgentID("ipfs://other/");
        // the acceptance signed for `agentID` does not validate on `other` (different domain).
        vm.expectRevert(AgentID.MintAcceptInvalid.selector);
        other.mintTo(to, nonce, acceptance);
        assertEq(other.totalMinted(), 0);
    }

    function test_mintTo_griefBlocked_withoutConsent() public {
        address victim = vm.addr(TO_PK);
        // attacker forges a bogus signature → cannot mint onto the victim.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATK_PK, keccak256("not the accept digest"));
        bytes memory bogus = abi.encodePacked(r, s, v);
        vm.prank(address(0xDEAD));
        vm.expectRevert(AgentID.MintAcceptInvalid.selector);
        agentID.mintTo(victim, 1, bogus);
        assertEq(agentID.totalMinted(), 0);
    }

    function test_mintTo_acceptanceReplayBlocked() public {
        address to = vm.addr(TO_PK);
        uint256 nonce = 7;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TO_PK, agentID.mintAcceptDigest(to, nonce));
        bytes memory acceptance = abi.encodePacked(r, s, v);

        agentID.mintTo(to, nonce, acceptance);
        // replay the same acceptance (same nonce) → revert.
        vm.expectRevert(AgentID.MintAcceptUsed.selector);
        agentID.mintTo(to, nonce, acceptance);
    }
}
