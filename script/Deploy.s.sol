// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {AgentID} from "../contracts/AgentID.sol";
import {CapabilityToken} from "../contracts/CapabilityToken.sol";
import {Publications} from "../contracts/Publications.sol";
import {ASNPaymaster} from "../contracts/ASNPaymaster.sol";
import {ASNTokenBoundAccount} from "../contracts/ASNTokenBoundAccount.sol";
import {TBAKeyRegistry} from "../contracts/TBAKeyRegistry.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/// @notice Deploys the ASN stack to Base Sepolia (chainId 84532) and wires the paymaster allowlist.
///
/// Uses the canonical, already-deployed infrastructure:
///   - EntryPoint v0.6:                0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
///   - CoinbaseSmartWalletFactory:     0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a (Base Sepolia)
///
/// Run:
///   forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $PK
contract Deploy is Script {
    address internal constant ENTRYPOINT_V06 = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;
    address internal constant COINBASE_FACTORY = 0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        AgentID agentID = new AgentID("https://asn.example/agent/");
        CapabilityToken cap = new CapabilityToken(agentID);
        Publications pubs = new Publications(agentID, cap);
        cap.setPublications(address(pubs));

        // ERC-6551 encryption-identity layer: TBA implementation + key registry. The canonical
        // ERC-6551 registry (0x000000006551c19487814612e58FE06813775758) is used on Base Sepolia;
        // a local instance is deployed here for completeness/testing.
        ERC6551Registry erc6551 = new ERC6551Registry();
        ASNTokenBoundAccount tbaImpl = new ASNTokenBoundAccount();
        TBAKeyRegistry tbaKeys = new TBAKeyRegistry();

        ASNPaymaster paymaster = new ASNPaymaster(IEntryPoint(ENTRYPOINT_V06), deployer);
        // Allowlist the three sponsorable writes (called via wallet.execute(target, 0, data)).
        paymaster.setTargetAllowed(address(pubs), true);
        paymaster.setCallAllowed(address(pubs), Publications.publish.selector, true);
        paymaster.setCallAllowed(address(pubs), Publications.update.selector, true);
        paymaster.setTargetAllowed(address(cap), true);
        paymaster.setCallAllowed(address(cap), CapabilityToken.grant.selector, true);
        paymaster.setCallAllowed(address(cap), CapabilityToken.revoke.selector, true);
        // Conservative default budget/rate (operator tunes post-deploy).
        paymaster.setCaps(0, 16384, 0.01 ether);
        paymaster.setBudgets(1 ether, 0.05 ether);
        paymaster.setRateLimit(20, 3600);

        vm.stopBroadcast();

        console2.log("chainId           ", block.chainid);
        console2.log("AgentID           ", address(agentID));
        console2.log("CapabilityToken   ", address(cap));
        console2.log("Publications      ", address(pubs));
        console2.log("ASNPaymaster      ", address(paymaster));
        console2.log("ERC6551Registry   ", address(erc6551));
        console2.log("ASN TBA impl      ", address(tbaImpl));
        console2.log("TBAKeyRegistry    ", address(tbaKeys));
        console2.log("EntryPoint v0.6   ", ENTRYPOINT_V06);
        console2.log("CoinbaseFactory   ", COINBASE_FACTORY);
        console2.log("Deployer/PM owner ", deployer);
        console2.log("NOTE: fund paymaster via paymaster.deposit{value:..}() and addStake for sponsorship.");
    }
}
