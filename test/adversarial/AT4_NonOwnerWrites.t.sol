// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {CapabilityToken} from "../../contracts/CapabilityToken.sol";
import {ICapabilityToken} from "../../contracts/interfaces/ICapabilityToken.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";

/// @title AT-4 — non-owner publish/grant/revoke for an AgentId MUST fail.
/// @notice Defends: every identity write is authorized only by the current owner (smart account).
///         Includes a forged UserOp claiming to come from N's smart account, rejected by the REAL
///         EntryPoint v0.6 at the signature layer. (adversarial-test-spec AT-4; P0 #1.)
contract AT4_NonOwnerWrites is Base {
    uint256 internal constant A_PK = 0xA;
    uint256 internal constant ATK_PK = 0xBAD;

    address internal aOwner;
    address internal atkOwner;
    CoinbaseSmartWallet internal aWallet; // owns agent N
    CoinbaseSmartWallet internal atkWallet;

    uint256 internal N;
    uint256 internal atkAgent;
    bytes32 internal resourceOfN;

    function setUp() public override {
        super.setUp();
        vm.deal(address(this), 100 ether);
        aOwner = vm.addr(A_PK);
        atkOwner = vm.addr(ATK_PK);
        aWallet = _createWallet(aOwner, 0);
        atkWallet = _createWallet(atkOwner, 1);

        N = _mint(address(aWallet));
        atkAgent = _mint(address(atkWallet));

        // A publishes a gated pub so a resource of N exists.
        _exec(
            aWallet,
            aOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (N, "cid", bytes32("body"), Publications.Visibility.CAPABILITY_GATED))
        );
        resourceOfN = pubs.resourceIdOf(N, 1);
    }

    /// (a) ATK impersonates N to publish — direct and via ATK's own wallet.
    function test_a_publishAsN_reverts() public {
        vm.prank(atkOwner);
        vm.expectRevert(abi.encodeWithSelector(Publications.NotOwner.selector, N, atkOwner));
        pubs.publish(N, "x", bytes32("y"), Publications.Visibility.PUBLIC);

        _execExpectRevert(
            atkWallet,
            atkOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (N, "x", bytes32("y"), Publications.Visibility.PUBLIC))
        );
        assertEq(pubs.pubCount(N), 1, "no ATK publication under N");
    }

    /// (b) ATK grants itself a capability on N's resource.
    function test_b_grantOnNsResource_reverts() public {
        vm.prank(address(atkWallet));
        vm.expectRevert();
        cap.grant(ICapabilityToken.CapType.VIEW, atkAgent, resourceOfN, 0);
        assertFalse(cap.hasCapability(ICapabilityToken.CapType.VIEW, atkAgent, resourceOfN));
    }

    /// (c) ATK revokes a capability on N's resource (impersonating N).
    function test_c_revokeOnNsResource_reverts() public {
        // A grants B first.
        uint256 bAgent = _mint(address(0xB0B));
        vm.prank(address(aWallet));
        cap.grant(ICapabilityToken.CapType.VIEW, bAgent, resourceOfN, 0);

        vm.prank(address(atkWallet));
        vm.expectRevert();
        cap.revoke(ICapabilityToken.CapType.VIEW, bAgent, resourceOfN);
        assertTrue(cap.hasCapability(ICapabilityToken.CapType.VIEW, bAgent, resourceOfN), "B still authorized");
    }

    /// (d) Forged UserOp: sender = N's smart account, but signed by ATK's key. The REAL EntryPoint
    ///     v0.6 rejects it at signature validation (AA24), so nothing is written under N.
    function test_d_forgedUserOp_reverts() public {
        UserOperation memory op = _buildExecOp(
            address(aWallet),
            address(pubs),
            abi.encodeCall(Publications.publish, (N, "forge", bytes32("forge"), Publications.Visibility.PUBLIC)),
            false
        );
        op = _sign(op, ATK_PK); // WRONG signer

        UserOperation[] memory ops = new UserOperation[](1);
        ops[0] = op;
        vm.expectRevert(); // FailedOp: AA24 signature error
        entryPoint.handleOps(ops, payable(address(0xBEEF)));

        assertEq(pubs.pubCount(N), 1, "forged op wrote nothing under N");
    }

    /// Positive control: the true owner can do all three.
    function test_ownerCanWrite() public {
        _exec(
            aWallet,
            aOwner,
            address(pubs),
            abi.encodeCall(Publications.publish, (N, "ok", bytes32("ok"), Publications.Visibility.PUBLIC))
        );
        assertEq(pubs.pubCount(N), 2);
    }
}
