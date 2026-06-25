// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {CapabilityToken} from "../../contracts/CapabilityToken.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";

/// @title R2 P0-B — registerResource access control.
/// @notice Defends: capability-resource registration is NOT an open "first-writer-wins" race. Only the
///         canonical Publications contract may register a resource, and it always binds the resource to
///         the TRUE publisher. An attacker who predicts A's next resourceId cannot front-run it.
///         (spec v0.3 R2 P0-B.)
contract P0B_RegisterResource is Base {
    uint256 internal constant A_PK = 0xA;
    uint256 internal constant ATK_PK = 0xBAD;
    address internal aOwner;
    address internal atkOwner;
    CoinbaseSmartWallet internal aWallet;
    CoinbaseSmartWallet internal atkWallet;
    uint256 internal aAgent;
    uint256 internal atkAgent;

    function setUp() public override {
        super.setUp();
        aOwner = vm.addr(A_PK);
        atkOwner = vm.addr(ATK_PK);
        aWallet = _createWallet(aOwner, 0);
        atkWallet = _createWallet(atkOwner, 1);
        aAgent = _mint(address(aWallet));
        atkAgent = _mint(address(atkWallet));
    }

    /// registerResource is callable ONLY by Publications — any direct/external caller reverts.
    function test_registerResource_onlyPublications() public {
        bytes32 predicted = pubs.resourceIdOf(aAgent, 1); // A's NEXT gated publication's resourceId

        // ATK tries to front-run-register A's predicted resourceId to ITS own agent, directly.
        vm.prank(address(atkWallet));
        vm.expectRevert(abi.encodeWithSelector(CapabilityToken.OnlyPublications.selector, address(atkWallet)));
        cap.registerResource(predicted, atkAgent);

        // ATK routes it through its own smart account — still not Publications → revert.
        _execExpectRevert(
            atkWallet,
            atkOwner,
            address(cap),
            abi.encodeCall(CapabilityToken.registerResource, (predicted, atkAgent))
        );

        // resource remains unregistered (no hijack).
        assertEq(cap.resourceController(predicted), 0, "not registered by attacker");

        // A's atomic publish registers the resource to A's agent and succeeds.
        _exec(
            aWallet,
            aOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (aAgent, "cidP", bytes32("body"), Publications.Visibility.CAPABILITY_GATED))
        );
        assertEq(cap.resourceController(predicted), aAgent, "registered to A by Publications");
    }

    /// Even Publications cannot re-bind an already-registered resource (defense in depth).
    function test_publications_cannotRebind() public {
        _exec(
            aWallet,
            aOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (aAgent, "cidP", bytes32("body"), Publications.Visibility.CAPABILITY_GATED))
        );
        bytes32 rid = pubs.resourceIdOf(aAgent, 1);
        assertEq(cap.resourceController(rid), aAgent);

        vm.prank(address(pubs));
        cap.registerResource(rid, atkAgent); // attempt to re-bind
        assertEq(cap.resourceController(rid), aAgent, "first-binding preserved");
    }
}
