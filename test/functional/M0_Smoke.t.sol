// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";

/// @notice Harness smoke test — validates the full ERC-4337 v0.6 path before adversarial tests:
///         owner-direct execute, self-pay handleOps, and sponsored handleOps all publish on-chain.
contract M0Smoke is Base {
    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    CoinbaseSmartWallet internal wallet;
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        vm.deal(address(this), 100 ether);
        owner = vm.addr(OWNER_PK);
        wallet = _createWallet(owner, 0);
        // Permissionless mint of an identity to the smart account.
        agentId = _mint(address(wallet));
    }

    function _publishDataFor(uint256 id, string memory cid, bytes32 body) internal pure returns (bytes memory) {
        return abi.encodeCall(Publications.publish, (id, cid, body, Publications.Visibility.PUBLIC));
    }

    function test_ownerDirectPublish() public {
        _exec(wallet, owner, address(pubs), _publishDataFor(agentId, "cid", bytes32("body")));
        Publications.Publication memory p = pubs.getPublication(agentId, 1);
        assertEq(p.agentId, agentId);
        assertEq(uint8(p.visibility), 0);
        assertEq(p.revision, 1);
        assertEq(pubs.pubCount(agentId), 1);
    }

    function test_selfPayHandleOps() public {
        vm.deal(address(wallet), 1 ether);
        UserOperation memory op =
            _buildExecOp(address(wallet), address(pubs), _publishDataFor(agentId, "c2", bytes32("b2")), false);
        op = _sign(op, OWNER_PK);
        _handle(op);
        assertEq(pubs.pubCount(agentId), 1);
    }

    function test_sponsoredHandleOps() public {
        paymaster.setTargetAllowed(address(pubs), true);
        paymaster.setCallAllowed(address(pubs), Publications.publish.selector, true);
        paymaster.setCaps(0, 8192, 0.05 ether);
        paymaster.setBudgets(10 ether, 10 ether);
        paymaster.deposit{value: 2 ether}();

        UserOperation memory op =
            _buildExecOp(address(wallet), address(pubs), _publishDataFor(agentId, "c3", bytes32("b3")), true);
        op = _sign(op, OWNER_PK);
        _handle(op);
        assertEq(pubs.pubCount(agentId), 1);
        assertGt(paymaster.senderSpent(address(wallet)), 0);
    }
}
