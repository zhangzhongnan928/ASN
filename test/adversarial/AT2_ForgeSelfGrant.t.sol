// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {CapabilityToken} from "../../contracts/CapabilityToken.sol";
import {ICapabilityToken} from "../../contracts/interfaces/ICapabilityToken.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";

/// @title AT-2 — forge / self-grant capability MUST fail.
/// @notice Defends: a capability can ONLY be granted by the resource owner; no self-grant, no
///         forgery, no internal-write, no replay. (adversarial-test-spec AT-2; P0 #1.)
contract AT2_ForgeSelfGrant is Base {
    uint256 internal constant A_PK = 0xA;
    uint256 internal constant ATK_PK = 0xBAD;

    address internal aOwner;
    address internal atkOwner;
    CoinbaseSmartWallet internal aWallet;
    CoinbaseSmartWallet internal atkWallet;

    uint256 internal aAgent;
    uint256 internal atkAgent;
    bytes32 internal resourceId;

    function setUp() public override {
        super.setUp();
        aOwner = vm.addr(A_PK);
        atkOwner = vm.addr(ATK_PK);
        aWallet = _createWallet(aOwner, 0);
        atkWallet = _createWallet(atkOwner, 1);

        aAgent = _mint(address(aWallet));
        atkAgent = _mint(address(atkWallet));

        // A publishes a capability-gated publication P (resource registered to A's agent).
        _exec(
            aWallet,
            aOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (aAgent, "cidP", bytes32("bodyP"), Publications.Visibility.CAPABILITY_GATED))
        );
        resourceId = pubs.resourceIdOf(aAgent, 1);
        assertEq(cap.resourceController(resourceId), aAgent, "resource controlled by A");
    }

    /// (a) ATK calls grant directly — ATK is not the resource owner.
    function test_a_directGrantByAttacker_reverts() public {
        vm.prank(address(atkWallet));
        vm.expectRevert(abi.encodeWithSelector(CapabilityToken.NotResourceOwner.selector, resourceId, address(atkWallet)));
        cap.grant(ICapabilityToken.CapType.VIEW, atkAgent, resourceId, 0);
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, atkAgent, resourceId));
    }

    /// (b) ATK routes the grant through its OWN smart account (a "forged authorization" attempt):
    ///     msg.sender becomes ATK's wallet, still != owner of the resource controller → revert.
    function test_b_grantViaAttackerWallet_reverts() public {
        _execExpectRevert(
            atkWallet,
            atkOwner,
            address(cap),
            abi.encodeCall(CapabilityToken.grant, (ICapabilityToken.CapType.VIEW, atkAgent, resourceId, 0))
        );
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, atkAgent, resourceId));
    }

    /// (c) ATK tries to hijack control by re-registering the resource to itself.
    function test_c_reRegisterResource_reverts() public {
        // direct
        vm.prank(address(atkWallet));
        vm.expectRevert(abi.encodeWithSelector(CapabilityToken.OnlyPublications.selector, address(atkWallet)));
        cap.registerResource(resourceId, atkAgent);

        // even the real Publications cannot re-bind an existing resource (first-writer-wins):
        vm.prank(address(pubs));
        cap.registerResource(resourceId, atkAgent);
        assertEq(cap.resourceController(resourceId), aAgent, "controller unchanged");
    }

    /// (d) "Replay" a capability: there is no signed capability blob to replay — capability is pure
    ///     on-chain state written only by an authorized grant. ATK copying B's grant params and
    ///     submitting them changes nothing for ATK.
    function test_d_replayWithSwappedGrantee_reverts() public {
        // A legitimately grants to B (agent 99 owned by someone else) — sanity that grant works.
        uint256 bAgent = _mint(address(0xB0B));
        vm.prank(address(aWallet));
        cap.grant(ICapabilityToken.CapType.VIEW, bAgent, resourceId, 0);
        assertTrue(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, resourceId));

        // ATK "replays" by submitting the same call but with its own agentId as grantee.
        vm.prank(address(atkWallet));
        vm.expectRevert();
        cap.grant(ICapabilityToken.CapType.VIEW, atkAgent, resourceId, 0);
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, atkAgent, resourceId));
    }

    /// Positive control: only A (the resource owner) can grant, and it works.
    function test_onlyOwnerGrantWorks() public {
        vm.prank(address(aWallet));
        cap.grant(ICapabilityToken.CapType.VIEW, atkAgent, resourceId, 0);
        assertTrue(cap.hasCapability(ICapabilityToken.CapType.VIEW, atkAgent, resourceId));
    }
}
