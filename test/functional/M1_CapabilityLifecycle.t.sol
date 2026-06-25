// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {ICapabilityToken} from "../../contracts/interfaces/ICapabilityToken.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";

/// @notice M1 on-chain capability semantics (backs the contract side of AT-1/AT-3): no-cap=false,
///         grant=true, expiry auto-fail, revoke=false, and capability follows grantee NFT transfer.
contract M1CapabilityLifecycle is Base {
    uint256 internal constant A_PK = 0xA;
    address internal aOwner;
    CoinbaseSmartWallet internal aWallet;
    uint256 internal aAgent;
    uint256 internal bAgent;
    uint256 internal cAgent;
    bytes32 internal rid;

    function setUp() public override {
        super.setUp();
        aOwner = vm.addr(A_PK);
        aWallet = _createWallet(aOwner, 0);
        aAgent = _mint(address(aWallet));
        bAgent = _mint(address(0xB0B));
        cAgent = _mint(address(0xCCC));
        _exec(
            aWallet,
            aOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (aAgent, "cidGated", bytes32("body"), Publications.Visibility.CAPABILITY_GATED))
        );
        rid = pubs.resourceIdOf(aAgent, 1);
    }

    function _grant(uint256 grantee, uint64 expiry) internal {
        vm.prank(address(aWallet));
        cap.grant(ICapabilityToken.CapType.VIEW, grantee, rid, expiry);
    }

    function test_noCapabilityIsFalse() public view {
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, cAgent, rid));
    }

    function test_grantThenRevoke() public {
        _grant(bAgent, 0);
        assertTrue(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, rid));
        vm.prank(address(aWallet));
        cap.revoke(ICapabilityToken.CapType.VIEW, bAgent, rid);
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, rid));
    }

    function test_expiryAutoFails() public {
        uint64 exp = uint64(block.timestamp + 100);
        _grant(bAgent, exp);
        assertTrue(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, rid));
        vm.warp(block.timestamp + 101);
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, rid), "expired");
    }

    function test_hasCapabilityForHolderTracksOwner() public {
        _grant(bAgent, 0);
        assertTrue(cap.hasCapabilityForHolder(ICapabilityToken.CapType.VIEW, address(0xB0B), bAgent, rid));
        // grantee transfers its AgentID -> capability follows the new owner (full inheritance).
        vm.prank(address(0xB0B));
        agentID.transferFrom(address(0xB0B), address(0xD0D), bAgent);
        assertTrue(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, rid), "still active");
        assertFalse(cap.hasCapabilityForHolder(ICapabilityToken.CapType.VIEW, address(0xB0B), bAgent, rid), "old owner");
        assertTrue(cap.hasCapabilityForHolder(ICapabilityToken.CapType.VIEW, address(0xD0D), bAgent, rid), "new owner");
    }
}
