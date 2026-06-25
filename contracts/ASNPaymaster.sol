// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ASNPaymaster
/// @notice Spec v0.3 §6 — the sponsoring paymaster *proxy* (on-chain half). Sponsorship is a
///         convenience, never the only path: a publish is just `wallet.execute(Publications,0,..)`,
///         which works self-paid too, so there is no "publish only via paymaster" dead end (AT-6).
///         This contract enforces the anti-abuse guards that stop the gas budget from being drained:
///         contract+function allowlist, value cap, calldata cap, per-op cost cap, per-sender + global
///         budget, and per-sender rate limit.
///
/// @dev ERC-4337 **v0.6** paymaster (matches Coinbase Smart Wallet v1.1.0). Implements `IPaymaster`
///      directly (not BasePaymaster) so we stay on OZ v5. Policy is evaluated in
///      `validatePaymasterUserOp`; a violation REVERTS, which makes the sponsored UserOp fail in the
///      EntryPoint and lets the agent fall back to self-pay.
contract ASNPaymaster is IPaymaster, Ownable {
    /// @dev selector of CoinbaseSmartWallet.execute(address,uint256,bytes)
    bytes4 public constant EXECUTE_SELECTOR = bytes4(keccak256("execute(address,uint256,bytes)"));

    enum DenyReason {
        OK,
        NOT_EXECUTE,
        TARGET_NOT_ALLOWED,
        SELECTOR_NOT_ALLOWED,
        VALUE_TOO_HIGH,
        CALLDATA_TOO_LONG,
        COST_TOO_HIGH,
        GLOBAL_BUDGET_EXCEEDED,
        SENDER_BUDGET_EXCEEDED,
        RATE_LIMITED
    }

    IEntryPoint public immutable entryPoint;

    // ── policy config ───────────────────────────────────────────────────────────────────────
    mapping(address => bool) public allowedTarget;
    mapping(address => mapping(bytes4 => bool)) public allowedCall; // target => innerSelector => ok
    uint256 public valueCap; // max inner-call value (default 0: no ETH-moving sponsorship)
    uint256 public maxCalldataLen = 8192;
    uint256 public perOpCostCap = 0.05 ether;
    uint256 public globalBudget; // max cumulative actualGasCost sponsored
    uint256 public senderBudget; // max cumulative per smart account
    uint32 public maxOpsPerWindow = 5;
    uint64 public rateWindowSecs = 60;

    // ── accounting ──────────────────────────────────────────────────────────────────────────
    // `*Spent` is settled in postOp; `*Reserved` is held between validate and postOp so that
    // multiple ops in the SAME bundle cannot each pass the budget check against stale spent state
    // (EntryPoint v0.6 runs all validations before any postOp). Budget check uses spent+reserved.
    uint256 public globalSpent;
    uint256 public globalReserved;
    mapping(address => uint256) public senderSpent;
    mapping(address => uint256) public senderReserved;

    struct Rate {
        uint64 windowStart;
        uint32 count;
    }

    mapping(address => Rate) public rate;

    event Sponsored(address indexed sender, address indexed target, bytes4 innerSelector, uint256 actualGasCost);
    event PolicyDenied(address indexed sender, DenyReason reason);

    error OnlyEntryPoint();
    error SponsorshipDenied(DenyReason reason);

    constructor(IEntryPoint _entryPoint, address owner_) Ownable(owner_) {
        entryPoint = _entryPoint;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // ERC-4337 v0.6 paymaster hooks
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPaymaster
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        override
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        (address target, bytes4 innerSelector, uint256 value) = _parseExecute(userOp.callData);
        DenyReason r = _evaluate(userOp.sender, target, innerSelector, value, userOp.callData.length, maxCost);
        if (r != DenyReason.OK) {
            emit PolicyDenied(userOp.sender, r);
            revert SponsorshipDenied(r);
        }

        // commit rate-limit + RESERVE maxCost (released/settled in postOp) so the next op in this
        // bundle sees this op's reservation.
        _consumeRate(userOp.sender);
        globalReserved += maxCost;
        senderReserved[userOp.sender] += maxCost;
        context = abi.encode(userOp.sender, target, innerSelector, maxCost);
        validationData = 0; // valid, no time bounds
    }

    /// @inheritdoc IPaymaster
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost) external override onlyEntryPoint {
        (address sender, address target, bytes4 innerSelector, uint256 reserved) =
            abi.decode(context, (address, address, bytes4, uint256));
        // release the reservation, settle actual cost. v0.6's canonical EntryPoint always calls
        // postOp (incl. opReverted / postOpReverted), so this release is unconditional.
        globalReserved -= reserved;
        senderReserved[sender] -= reserved;
        globalSpent += actualGasCost;
        senderSpent[sender] += actualGasCost;
        emit Sponsored(sender, target, innerSelector, actualGasCost);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Non-reverting policy view — used by the off-chain proxy (/paymaster) and tests.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    function evaluate(UserOperation calldata userOp, uint256 maxCost) external view returns (DenyReason) {
        (address target, bytes4 innerSelector, uint256 value) = _parseExecute(userOp.callData);
        return _evaluate(userOp.sender, target, innerSelector, value, userOp.callData.length, maxCost);
    }

    /// @notice Direct policy check for the off-chain proxy (no UserOp construction needed).
    function evaluateCall(
        address sender,
        address target,
        bytes4 innerSelector,
        uint256 value,
        uint256 calldataLen,
        uint256 maxCost
    ) external view returns (DenyReason) {
        return _evaluate(sender, target, innerSelector, value, calldataLen, maxCost);
    }

    function _evaluate(
        address sender,
        address target,
        bytes4 innerSelector,
        uint256 value,
        uint256 calldataLen,
        uint256 maxCost
    ) internal view returns (DenyReason) {
        if (innerSelector == bytes4(0) && target == address(0)) return DenyReason.NOT_EXECUTE;
        if (!allowedTarget[target]) return DenyReason.TARGET_NOT_ALLOWED;
        if (!allowedCall[target][innerSelector]) return DenyReason.SELECTOR_NOT_ALLOWED;
        if (value > valueCap) return DenyReason.VALUE_TOO_HIGH;
        if (calldataLen > maxCalldataLen) return DenyReason.CALLDATA_TOO_LONG;
        if (maxCost > perOpCostCap) return DenyReason.COST_TOO_HIGH;
        // include outstanding reservations so concurrent ops in one bundle cannot collectively overshoot.
        if (globalSpent + globalReserved + maxCost > globalBudget) return DenyReason.GLOBAL_BUDGET_EXCEEDED;
        if (senderSpent[sender] + senderReserved[sender] + maxCost > senderBudget) {
            return DenyReason.SENDER_BUDGET_EXCEEDED;
        }
        if (_rateExceeded(sender)) return DenyReason.RATE_LIMITED;
        return DenyReason.OK;
    }

    /// @dev Decode `execute(address,uint256,bytes)`; returns (0,0,0) sentinel if not an execute call.
    function _parseExecute(bytes calldata callData)
        internal
        pure
        returns (address target, bytes4 innerSelector, uint256 value)
    {
        if (callData.length < 4 || bytes4(callData[:4]) != EXECUTE_SELECTOR) {
            return (address(0), bytes4(0), 0);
        }
        bytes memory inner;
        (target, value, inner) = abi.decode(callData[4:], (address, uint256, bytes));
        innerSelector = inner.length >= 4 ? bytes4(inner) : bytes4(0);
    }

    function _rateExceeded(address sender) internal view returns (bool) {
        Rate memory rt = rate[sender];
        if (block.timestamp >= rt.windowStart + rateWindowSecs) return false; // window rolled over
        return rt.count >= maxOpsPerWindow;
    }

    function _consumeRate(address sender) internal {
        Rate storage rt = rate[sender];
        if (block.timestamp >= rt.windowStart + rateWindowSecs) {
            rt.windowStart = uint64(block.timestamp);
            rt.count = 1;
        } else {
            rt.count += 1;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Admin (owner) + EntryPoint deposit/stake plumbing
    // ─────────────────────────────────────────────────────────────────────────────────────────

    function setTargetAllowed(address target, bool ok) external onlyOwner {
        allowedTarget[target] = ok;
    }

    function setCallAllowed(address target, bytes4 innerSelector, bool ok) external onlyOwner {
        allowedCall[target][innerSelector] = ok;
    }

    function setCaps(uint256 value_, uint256 calldata_, uint256 perOp_) external onlyOwner {
        valueCap = value_;
        maxCalldataLen = calldata_;
        perOpCostCap = perOp_;
    }

    function setBudgets(uint256 global_, uint256 sender_) external onlyOwner {
        globalBudget = global_;
        senderBudget = sender_;
    }

    function setRateLimit(uint32 maxOps_, uint64 windowSecs_) external onlyOwner {
        maxOpsPerWindow = maxOps_;
        rateWindowSecs = windowSecs_;
    }

    /// @notice Fund the paymaster's EntryPoint deposit (pays for sponsored gas).
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    function depositBalance() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    receive() external payable {}
}
