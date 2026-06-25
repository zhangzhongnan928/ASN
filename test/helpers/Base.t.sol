// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {AgentID} from "../../contracts/AgentID.sol";
import {CapabilityToken} from "../../contracts/CapabilityToken.sol";
import {Publications} from "../../contracts/Publications.sol";
import {ASNPaymaster} from "../../contracts/ASNPaymaster.sol";

import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";

/// @notice Shared harness: deploys the ASN stack on a local EVM, etches the REAL canonical
///         EntryPoint v0.6 bytecode, and provides helpers to drive a Coinbase Smart Wallet both
///         owner-directly (for authorization tests) and via full ERC-4337 `handleOps`
///         (for paymaster / forged-UserOp tests).
abstract contract Base is Test {
    // Canonical ERC-4337 v0.6 EntryPoint + its SenderCreator (same addresses on every chain).
    address internal constant ENTRYPOINT_V06 = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;
    address internal constant SENDER_CREATOR_V06 = 0x7fc98430eAEdbb6070B35B39D798725049088348;
    // Pinned runtime code hashes of the canonical deployed contracts (constructor-faithful check).
    bytes32 internal constant EP_CODEHASH = 0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70;
    bytes32 internal constant SC_CODEHASH = 0xae818091eaaf1b6175ee41472359a689f3823d0908a41e2e5c4ad508f2fc04a3;

    AgentID internal agentID;
    CapabilityToken internal cap;
    Publications internal pubs;
    ASNPaymaster internal paymaster;
    IEntryPoint internal entryPoint;
    CoinbaseSmartWalletFactory internal factory;

    function setUp() public virtual {
        // Real EntryPoint v0.6 + SenderCreator via etched canonical runtime bytecode (deterministic,
        // offline). Etching the SenderCreator at its baked-in immutable address makes initCode-based
        // counterfactual account deployment work faithfully (P1-D).
        bytes memory epCode = vm.parseBytes(vm.readFile("test/fixtures/entrypoint_v06.hex"));
        vm.etch(ENTRYPOINT_V06, epCode);
        bytes memory scCode = vm.parseBytes(vm.readFile("test/fixtures/sendercreator_v06.hex"));
        vm.etch(SENDER_CREATOR_V06, scCode);
        // constructor-faithful: the etched runtime code must match the canonical deployed code.
        require(keccak256(ENTRYPOINT_V06.code) == EP_CODEHASH, "EntryPoint runtime code hash mismatch");
        require(keccak256(SENDER_CREATOR_V06.code) == SC_CODEHASH, "SenderCreator runtime code hash mismatch");
        entryPoint = IEntryPoint(ENTRYPOINT_V06);

        // Core ASN contracts.
        agentID = new AgentID("ipfs://asn/agent/");
        cap = new CapabilityToken(agentID);
        pubs = new Publications(agentID, cap);
        cap.setPublications(address(pubs));

        // Paymaster (this test contract is the owner/admin).
        paymaster = new ASNPaymaster(entryPoint, address(this));

        // Coinbase Smart Wallet factory + implementation.
        CoinbaseSmartWallet impl = new CoinbaseSmartWallet();
        factory = new CoinbaseSmartWalletFactory(address(impl));
    }

    /// @notice Mint an identity TO `recipient` via self-mint (recipient is msg.sender). Mirrors the
    ///         agent-native path where a smart account mints its own identity (P1-B anti-grief).
    function _mint(address recipient) internal returns (uint256 agentId) {
        vm.prank(recipient);
        agentId = agentID.mint();
    }

    // ── wallet helpers ────────────────────────────────────────────────────────────────────────

    /// @notice Deploy a Coinbase Smart Wallet owned by EOA `owner`.
    function _createWallet(address owner, uint256 salt) internal returns (CoinbaseSmartWallet w) {
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(owner);
        w = factory.createAccount(owners, salt);
    }

    /// @notice Owner-direct execution: the owner EOA calls `wallet.execute`, which CBSW allows
    ///         (onlyEntryPointOrOwner). The wallet becomes `msg.sender` to ASN contracts — faithful
    ///         to "only the smart account acts as the agent" without needing a bundler.
    function _exec(CoinbaseSmartWallet w, address owner, address target, bytes memory data) internal {
        vm.prank(owner);
        w.execute(target, 0, data);
    }

    function _execExpectRevert(CoinbaseSmartWallet w, address owner, address target, bytes memory data) internal {
        vm.prank(owner);
        vm.expectRevert();
        w.execute(target, 0, data);
    }

    // ── full ERC-4337 UserOp helpers ───────────────────────────────────────────────────────────

    function _emptyOp(address sender) internal view returns (UserOperation memory op) {
        op = UserOperation({
            sender: sender,
            nonce: entryPoint.getNonce(sender, 0),
            initCode: hex"",
            callData: hex"",
            callGasLimit: 600_000,
            verificationGasLimit: 600_000,
            preVerificationGas: 60_000,
            maxFeePerGas: 1 gwei,
            maxPriorityFeePerGas: 1 gwei,
            paymasterAndData: hex"",
            signature: hex""
        });
    }

    /// @notice Build a UserOp that calls `wallet.execute(target, 0, innerData)`.
    function _buildExecOp(address sender, address target, bytes memory innerData, bool withPaymaster)
        internal
        view
        returns (UserOperation memory op)
    {
        op = _emptyOp(sender);
        op.callData = abi.encodeCall(CoinbaseSmartWallet.execute, (target, 0, innerData));
        if (withPaymaster) {
            op.paymasterAndData = abi.encodePacked(address(paymaster));
        }
    }

    /// @notice Sign a UserOp with the owner key and wrap it in CBSW's SignatureWrapper.
    function _sign(UserOperation memory op, uint256 ownerPk) internal view returns (UserOperation memory) {
        bytes32 h = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, h);
        bytes memory sig = abi.encodePacked(r, s, v);
        op.signature = abi.encode(CoinbaseSmartWallet.SignatureWrapper({ownerIndex: 0, signatureData: sig}));
        return op;
    }

    function _handle(UserOperation memory op) internal {
        UserOperation[] memory ops = new UserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(address(0xBEEF)));
    }
}
