// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Base} from "../helpers/Base.t.sol";
import {Publications} from "../../contracts/Publications.sol";
import {ASNPaymaster} from "../../contracts/ASNPaymaster.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";

/// @title AT-6 — Paymaster anti-abuse + self-pay fallback.
/// @notice Defends two things: (1) sponsorship is rejected for out-of-policy requests so the gas
///         budget cannot be drained; (2) when sponsorship is denied, the agent can STILL publish by
///         self-paying — there is no "publish only via paymaster" dead end.
///         (adversarial-test-spec AT-6; spec §6.)
contract AT6_PaymasterPolicy is Base {
    uint256 internal constant A_PK = 0xA;
    uint256 internal constant ATK_PK = 0xBAD;
    address internal aOwner;
    address internal atkOwner;
    CoinbaseSmartWallet internal aWallet;
    CoinbaseSmartWallet internal atkWallet;
    uint256 internal aAgent;

    bytes internal publishData;

    function setUp() public override {
        super.setUp();
        vm.deal(address(this), 100 ether);
        aOwner = vm.addr(A_PK);
        atkOwner = vm.addr(ATK_PK);
        aWallet = _createWallet(aOwner, 0);
        atkWallet = _createWallet(atkOwner, 1);
        aAgent = _mint(address(aWallet));
        publishData =
            abi.encodeCall(Publications.publish, (aAgent, "cid", bytes32("body"), Publications.Visibility.PUBLIC));

        // Default permissive policy (individual tests tighten one knob at a time).
        paymaster.setTargetAllowed(address(pubs), true);
        paymaster.setCallAllowed(address(pubs), Publications.publish.selector, true);
        paymaster.setCaps(0, 8192, 0.05 ether);
        paymaster.setBudgets(100 ether, 100 ether);
        paymaster.setRateLimit(100, 60);
        paymaster.deposit{value: 5 ether}();
    }

    function _op(bool withPm) internal view returns (UserOperation memory) {
        return _sign(_buildExecOp(address(aWallet), address(pubs), publishData, withPm), A_PK);
    }

    function _maxCost(UserOperation memory op) internal pure returns (uint256) {
        // v0.6 paymaster multiplier is 3.
        return (op.callGasLimit + op.verificationGasLimit * 3 + op.preVerificationGas) * op.maxFeePerGas;
    }

    function _assertReason(ASNPaymaster.DenyReason want) internal {
        UserOperation memory op = _op(true);
        assertEq(uint8(paymaster.evaluate(op, _maxCost(op))), uint8(want), "deny reason");
        // and the sponsored handleOps reverts (FailedOp from paymaster).
        UserOperation[] memory ops = new UserOperation[](1);
        ops[0] = op;
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(address(0xBEEF)));
        assertEq(pubs.pubCount(aAgent), 0, "nothing sponsored");
    }

    function test_sponsored_ok() public {
        UserOperation memory op = _op(true);
        assertEq(uint8(paymaster.evaluate(op, _maxCost(op))), uint8(ASNPaymaster.DenyReason.OK));
        _handle(op);
        assertEq(pubs.pubCount(aAgent), 1);
    }

    function test_reject_targetNotAllowed() public {
        paymaster.setTargetAllowed(address(pubs), false);
        _assertReason(ASNPaymaster.DenyReason.TARGET_NOT_ALLOWED);
    }

    function test_reject_selectorNotAllowed() public {
        paymaster.setCallAllowed(address(pubs), Publications.publish.selector, false);
        _assertReason(ASNPaymaster.DenyReason.SELECTOR_NOT_ALLOWED);
    }

    function test_reject_costTooHigh() public {
        paymaster.setCaps(0, 8192, 1); // 1 wei cap
        _assertReason(ASNPaymaster.DenyReason.COST_TOO_HIGH);
    }

    function test_reject_calldataTooLong() public {
        paymaster.setCaps(0, 1, 0.05 ether); // 1 byte cap
        _assertReason(ASNPaymaster.DenyReason.CALLDATA_TOO_LONG);
    }

    function test_reject_globalBudget() public {
        paymaster.setBudgets(0, 100 ether);
        _assertReason(ASNPaymaster.DenyReason.GLOBAL_BUDGET_EXCEEDED);
    }

    function test_reject_senderBudget() public {
        paymaster.setBudgets(100 ether, 0);
        _assertReason(ASNPaymaster.DenyReason.SENDER_BUDGET_EXCEEDED);
    }

    function test_reject_valueTooHigh() public {
        // Build an execute op that moves ETH (value=1) — valueCap is 0.
        UserOperation memory op = _buildExecOp(address(aWallet), address(pubs), publishData, true);
        op.callData = abi.encodeCall(CoinbaseSmartWallet.execute, (address(pubs), 1, publishData));
        op = _sign(op, A_PK);
        assertEq(uint8(paymaster.evaluate(op, _maxCost(op))), uint8(ASNPaymaster.DenyReason.VALUE_TOO_HIGH));
    }

    function test_reject_rateLimited() public {
        paymaster.setRateLimit(1, 3600); // 1 op per hour
        UserOperation memory op1 = _op(true);
        _handle(op1); // consumes the single allowance
        assertEq(pubs.pubCount(aAgent), 1);

        UserOperation memory op2 = _op(true);
        assertEq(uint8(paymaster.evaluate(op2, _maxCost(op2))), uint8(ASNPaymaster.DenyReason.RATE_LIMITED));
        UserOperation[] memory ops = new UserOperation[](1);
        ops[0] = op2;
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(address(0xBEEF)));
        assertEq(pubs.pubCount(aAgent), 1, "rate-limited op not sponsored");
    }

    /// Anti-abuse: ATK requests sponsorship for a non-allowlisted target → denied.
    function test_antiAbuse_nonAllowlistedTarget_denied() public {
        address rogue = address(0xDEAD);
        bytes memory rogueData = abi.encodeCall(Publications.publish, (aAgent, "x", bytes32("y"), Publications.Visibility.PUBLIC));
        UserOperation memory op = _sign(_buildExecOp(address(atkWallet), rogue, rogueData, true), ATK_PK);
        assertEq(uint8(paymaster.evaluate(op, _maxCost(op))), uint8(ASNPaymaster.DenyReason.TARGET_NOT_ALLOWED));
    }

    /// Intra-bundle budget race (audit finding): two ops in ONE bundle must not collectively overshoot
    /// the sender budget. With reservation in validate, op2 sees op1's reservation and is rejected.
    function test_intraBundleBudgetNotOvershot() public {
        UserOperation memory op1 = _op(true);
        uint256 maxCost = _maxCost(op1);
        paymaster.setBudgets(100 ether, maxCost); // sender budget fits exactly ONE op

        // build a second op from the same sender with the next nonce
        UserOperation memory op2 = _buildExecOp(address(aWallet), address(pubs), publishData, true);
        op2.nonce = op1.nonce + 1;
        op2 = _sign(op2, A_PK);

        UserOperation[] memory ops = new UserOperation[](2);
        ops[0] = op1;
        ops[1] = op2;
        vm.expectRevert(); // op2 fails validation (sender budget incl. op1 reservation) → bundle reverts
        entryPoint.handleOps(ops, payable(address(0xBEEF)));
        assertEq(pubs.pubCount(aAgent), 0, "no overshoot: whole over-budget bundle rejected");
    }

    /// A bundle that fits the budget settles correctly and releases reservations.
    function test_bundleWithinBudgetSucceedsAndReleasesReservation() public {
        UserOperation memory op1 = _op(true);
        uint256 maxCost = _maxCost(op1);
        paymaster.setBudgets(100 ether, maxCost * 3); // room for both

        UserOperation memory op2 = _buildExecOp(address(aWallet), address(pubs), publishData, true);
        op2.nonce = op1.nonce + 1;
        op2 = _sign(op2, A_PK);

        UserOperation[] memory ops = new UserOperation[](2);
        ops[0] = op1;
        ops[1] = op2;
        entryPoint.handleOps(ops, payable(address(0xBEEF)));
        assertEq(pubs.pubCount(aAgent), 2, "both sponsored");
        assertEq(paymaster.senderReserved(address(aWallet)), 0, "reservation released");
        assertEq(paymaster.globalReserved(), 0, "global reservation released");
    }

    /// THE fallback: paymaster denies → agent self-pays → publication still lands on-chain.
    function test_selfPayFallback_whenSponsorshipDenied() public {
        paymaster.setBudgets(0, 0); // deny all sponsorship

        // Sponsored attempt fails.
        UserOperation memory sponsored = _op(true);
        UserOperation[] memory ops = new UserOperation[](1);
        ops[0] = sponsored;
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(address(0xBEEF)));
        assertEq(pubs.pubCount(aAgent), 0);

        // Self-pay path: fund the wallet, omit the paymaster, publish succeeds.
        vm.deal(address(aWallet), 1 ether);
        UserOperation memory selfPay = _op(false);
        _handle(selfPay);
        assertEq(pubs.pubCount(aAgent), 1, "self-pay publication landed");
    }
}
