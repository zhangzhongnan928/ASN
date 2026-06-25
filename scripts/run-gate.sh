#!/usr/bin/env bash
# ASN completion gate.
#
# The ONLY definition of "done" (spec v0.3 §12 + adversarial-test-spec "执行要求"):
#   /test/functional ALL GREEN  AND  /test/adversarial ALL GREEN.
# Functional and adversarial suites are reported SEPARATELY.
# Any adversarial test that does NOT block its attack => gate FAILS => not done.
#
# bash 3.2-safe (macOS default): no associative arrays.
#
# Usage: bash scripts/run-gate.sh
set -uo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }

# parallel arrays: name -> result
NAMES=()
RESULTS=()

run() {
  local name="$1"; shift
  bold "──────────────────────────────────────────────────────────────"
  bold "▶ $name"
  bold "  \$ $*"
  if "$@"; then
    NAMES+=("$name"); RESULTS+=("PASS"); grn "  [PASS] $name"
  else
    NAMES+=("$name"); RESULTS+=("FAIL"); red "  [FAIL] $name"
  fi
}

bold "╔══════════════════════════════════════════════════════════════╗"
bold "║  ASN GATE — functional + adversarial (both must be green)     ║"
bold "╚══════════════════════════════════════════════════════════════╝"

run "FUNCTIONAL-contracts-forge"   forge test --match-path 'test/functional/*.t.sol'
run "FUNCTIONAL-services-vitest"   npx vitest run test/functional
run "ADVERSARIAL-contracts-forge"  forge test --match-path 'test/adversarial/*.t.sol'
run "ADVERSARIAL-services-vitest"  npx vitest run test/adversarial

echo
bold "════════════════════════ GATE SUMMARY ════════════════════════"
gate_ok=1
i=0
while [ "$i" -lt "${#NAMES[@]}" ]; do
  n="${NAMES[$i]}"; r="${RESULTS[$i]}"
  if [ "$r" = "PASS" ]; then grn "  PASS  $n"; else red "  FAIL  $n"; gate_ok=0; fi
  i=$((i+1))
done
# require exactly the 4 expected suites to have run and passed
if [ "${#NAMES[@]}" -ne 4 ]; then
  red "  expected 4 suites, ran ${#NAMES[@]}"; gate_ok=0
fi
echo
if [ "$gate_ok" = "1" ]; then
  grn "GATE: GREEN — functional AND adversarial all pass. Completion criteria met."
  exit 0
else
  red  "GATE: RED — completion criteria NOT met. Loop must continue. Do NOT declare done."
  exit 1
fi
