#!/usr/bin/env bash
# Verify ASN contracts on Base Sepolia via the Etherscan V2 API directly (Basescan V1 is deprecated,
# and foundry 1.4.1's verify hits the deprecated path). Reads the dApp's deployments.json.
#
#   ETHERSCAN_API_KEY=xxx bash scripts/verify-v2.sh ~/Documents/asn-deployments.baseSepolia.json
#
# A key from basescan.org works on Etherscan V2. Needs forge + cast + jq + curl.
# NOTE: Etherscan must have indexed each contract's CREATION (getcontractcreation) before it will
# verify. Contracts deployed via CREATE2 inside a complex tx can take a while to index — re-run later
# if it reports "not indexed yet".
set -uo pipefail
cd "$(dirname "$0")/.."
J="${1:?pass the deployments json}"
: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY}"
export ETHERSCAN_API_KEY
API="https://api.etherscan.io/v2/api?chainid=84532"
CHAIN=84532
SOLC="v0.8.23+commit.f704f362"
EP=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
BASEURI="ipfs://asn/agent/"
g() { jq -r ".$1 // empty" "$J"; }
AGENTID=$(g agentID); CAP=$(g capabilityToken); PUBS=$(g publications)
TBA=$(g tbaImpl); TBAKEYS=$(g tbaKeyRegistry); PM=$(g paymaster); OWNER=$(g owner)
enc() { cast abi-encode "$@" | sed 's/^0x//'; }

verify() { # addr  fqn  ctorArgsHexNo0x
  local addr="$1" fqn="$2" args="${3:-}"
  echo "── $fqn @ $addr"
  # precheck: is the creation indexed?
  local cc; cc=$(curl -s "$API&module=contract&action=getcontractcreation&contractaddresses=$addr&apikey=$ETHERSCAN_API_KEY")
  if echo "$cc" | grep -qi "No data found"; then
    echo "   ⏳ not indexed by Etherscan yet — re-run later."
    return
  fi
  local input=/tmp/asn-verify-input.json
  forge verify-contract "$addr" "$fqn" --show-standard-json-input >"$input" 2>/dev/null
  local resp guid
  resp=$(curl -s -X POST "$API" \
    --data-urlencode "module=contract" --data-urlencode "action=verifysourcecode" \
    --data-urlencode "apikey=$ETHERSCAN_API_KEY" --data-urlencode "codeformat=solidity-standard-json-input" \
    --data-urlencode "sourceCode@$input" --data-urlencode "contractaddress=$addr" \
    --data-urlencode "contractname=$fqn" --data-urlencode "compilerversion=$SOLC" \
    --data-urlencode "constructorArguements=$args")
  guid=$(echo "$resp" | jq -r '.result // empty')
  if ! echo "$resp" | grep -q '"status":"1"'; then echo "   submit: $resp"; return; fi
  echo "   submitted (guid $guid), polling…"
  for i in $(seq 1 12); do
    sleep 5
    local st; st=$(curl -s "$API&module=contract&action=checkverifystatus&guid=$guid&apikey=$ETHERSCAN_API_KEY" | jq -r '.result // empty')
    echo "   [$i] $st"
    case "$st" in *Pass*|*verified*) break;; *Fail*) break;; esac
  done
}

verify "$AGENTID" "contracts/AgentID.sol:AgentID"                       "$(enc 'c(string)' "$BASEURI")"
verify "$CAP"     "contracts/CapabilityToken.sol:CapabilityToken"       "$(enc 'c(address,address)' "$AGENTID" "$OWNER")"
verify "$PUBS"    "contracts/Publications.sol:Publications"             "$(enc 'c(address,address)' "$AGENTID" "$CAP")"
verify "$TBA"     "contracts/ASNTokenBoundAccount.sol:ASNTokenBoundAccount" ""
verify "$TBAKEYS" "contracts/TBAKeyRegistry.sol:TBAKeyRegistry"         ""
verify "$PM"      "contracts/ASNPaymaster.sol:ASNPaymaster"            "$(enc 'c(address,address)' "$EP" "$OWNER")"
echo "done. https://sepolia.basescan.org/address/$AGENTID#code"
