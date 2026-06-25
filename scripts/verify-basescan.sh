#!/usr/bin/env bash
# Verify ASN contracts on Basescan (Base Sepolia) after deploying via the /deploy dApp.
#
# Usage:
#   BASESCAN_API_KEY=xxxx bash scripts/verify-basescan.sh path/to/asn-deployments.baseSepolia.json
#
# The JSON is the file the /deploy dApp downloads (has owner + all addresses). Requires `forge` + `jq`.
# The ERC-6551 registry is canonical/already-verified; AgentID baseURI matches the deploy script.
set -euo pipefail
cd "$(dirname "$0")/.."

JSON="${1:?pass the deployments json (downloaded from the /deploy dApp)}"
: "${BASESCAN_API_KEY:?set BASESCAN_API_KEY (free key from basescan.org)}"
CHAIN=base-sepolia
ENTRYPOINT=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
BASEURI="ipfs://asn/agent/"

get() { jq -r ".$1 // empty" "$JSON"; }
AGENTID=$(get agentID);   CAP=$(get capabilityToken); PUBS=$(get publications)
TBA=$(get tbaImpl);       TBAKEYS=$(get tbaKeyRegistry); PM=$(get paymaster); OWNER=$(get owner)

verify() { # addr  path:name  [encoded-constructor-args]
  local addr="$1" fqn="$2" args="${3:-}"
  echo "── verifying $fqn @ $addr"
  forge verify-contract "$addr" "$fqn" \
    --chain "$CHAIN" --etherscan-api-key "$BASESCAN_API_KEY" --watch \
    ${args:+--constructor-args "$args"} || echo "  (verify failed/already verified for $fqn)"
}

[ -n "$AGENTID" ] && verify "$AGENTID" "contracts/AgentID.sol:AgentID" "$(cast abi-encode 'c(string)' "$BASEURI")"
[ -n "$CAP" ]     && verify "$CAP" "contracts/CapabilityToken.sol:CapabilityToken" "$(cast abi-encode 'c(address,address)' "$AGENTID" "$OWNER")"
[ -n "$PUBS" ]    && verify "$PUBS" "contracts/Publications.sol:Publications" "$(cast abi-encode 'c(address,address)' "$AGENTID" "$CAP")"
[ -n "$TBA" ]     && verify "$TBA" "contracts/ASNTokenBoundAccount.sol:ASNTokenBoundAccount"
[ -n "$TBAKEYS" ] && verify "$TBAKEYS" "contracts/TBAKeyRegistry.sol:TBAKeyRegistry"
[ -n "$PM" ]      && verify "$PM" "contracts/ASNPaymaster.sol:ASNPaymaster" "$(cast abi-encode 'c(address,address)' "$ENTRYPOINT" "$OWNER")"

echo "done. View at https://sepolia.basescan.org/address/$AGENTID"
