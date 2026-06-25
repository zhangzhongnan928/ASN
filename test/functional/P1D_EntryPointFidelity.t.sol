// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {AgentID} from "../../contracts/AgentID.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";

/// @title R2 P1-D — EntryPoint test fidelity + counterfactual deployment.
/// @notice The EntryPoint v0.6 AND its SenderCreator are etched from canonical deployed bytecode and
///         pinned by runtime code hash (Base.setUp). This test exercises the full account-abstraction
///         path: a single UserOp with non-empty initCode counterfactually deploys a BRAND-NEW Coinbase
///         Smart Wallet, then registers (mints) and publishes in the SAME flow. (spec v0.3 R2 P1-D.)
contract P1D_EntryPointFidelity is Base {
    uint256 internal constant OWNER_PK = 0xF1DE71;

    function test_pinnedCodeHashes() public view {
        assertEq(keccak256(ENTRYPOINT_V06.code), EP_CODEHASH, "EntryPoint");
        assertEq(keccak256(SENDER_CREATOR_V06.code), SC_CODEHASH, "SenderCreator");
    }

    function test_counterfactualDeploy_thenRegisterAndPublish() public {
        address owner = vm.addr(OWNER_PK);
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(owner);
        uint256 salt = 777;

        // Counterfactual sender address (wallet not yet deployed).
        address sender = factory.getAddress(owners, salt);
        assertEq(sender.code.length, 0, "wallet not yet deployed");

        // initCode = factory ++ createAccount(owners, salt). EntryPoint -> SenderCreator -> factory.
        bytes memory initCode =
            abi.encodePacked(address(factory), abi.encodeCall(CoinbaseSmartWalletFactory.createAccount, (owners, salt)));

        // The agent's first acts (same flow): self-mint identity, then publish under it.
        uint256 predictedAgentId = agentID.totalMinted() + 1;
        CoinbaseSmartWallet.Call[] memory calls = new CoinbaseSmartWallet.Call[](2);
        calls[0] = CoinbaseSmartWallet.Call({target: address(agentID), value: 0, data: abi.encodeCall(AgentID.mint, ())});
        calls[1] = CoinbaseSmartWallet.Call({
            target: address(pubs),
            value: 0,
            data: abi.encodeCall(Publications.publish, (predictedAgentId, "cid-cf", bytes32("body"), Publications.Visibility.PUBLIC))
        });

        UserOperation memory op = _emptyOp(sender);
        op.initCode = initCode;
        op.callData = abi.encodeCall(CoinbaseSmartWallet.executeBatch, (calls));
        op.verificationGasLimit = 2_000_000; // covers account deployment
        op.callGasLimit = 1_000_000;
        op = _sign(op, OWNER_PK);

        // Self-pay: fund the counterfactual sender so it can prefund the EntryPoint.
        vm.deal(sender, 1 ether);

        UserOperation[] memory ops = new UserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(address(0xBEEF)));

        // The wallet now exists, owns the freshly-minted identity, and the publication landed.
        assertGt(sender.code.length, 0, "wallet deployed via initCode");
        assertEq(agentID.ownerOf(predictedAgentId), sender, "identity minted to the new wallet");
        assertEq(pubs.pubCount(predictedAgentId), 1, "published in the same flow");
    }
}
