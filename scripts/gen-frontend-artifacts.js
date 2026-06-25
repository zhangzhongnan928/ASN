#!/usr/bin/env node
// Generate frontend/lib/artifacts.ts (ABIs + creation bytecode) from forge artifacts.
// Run after `forge build`:  node scripts/gen-frontend-artifacts.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (sol, name) => JSON.parse(fs.readFileSync(path.join(root, `out/${sol}/${name}.json`), "utf8"));

const deployable = [
  ["AgentID.sol", "AgentID"],
  ["CapabilityToken.sol", "CapabilityToken"],
  ["Publications.sol", "Publications"],
  ["ASNTokenBoundAccount.sol", "ASNTokenBoundAccount"],
  ["TBAKeyRegistry.sol", "TBAKeyRegistry"],
  ["ASNPaymaster.sol", "ASNPaymaster"],
];
const abiOnly = [["ERC6551Registry.sol", "ERC6551Registry"]];

let ts = `// AUTO-GENERATED from forge artifacts (out/). Do not edit by hand.\n// Regenerate: node scripts/gen-frontend-artifacts.js\n\n`;
const emit = (sol, name, withBytecode) => {
  const a = out(sol, name);
  ts += `export const ${name}Abi = ${JSON.stringify(a.abi)} as const;\n`;
  if (withBytecode) ts += `export const ${name}Bytecode = "${a.bytecode.object}" as const;\n`;
  ts += `\n`;
};
deployable.forEach(([s, n]) => emit(s, n, true));
abiOnly.forEach(([s, n]) => emit(s, n, false));
fs.writeFileSync(path.join(root, "frontend/lib/artifacts.ts"), ts);
console.log("wrote frontend/lib/artifacts.ts");
