import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@asn/encryption": r("./encryption/index.ts"),
      "@asn/indexer": r("./indexer/index.ts"),
      "@asn/mcp": r("./mcp/index.ts"),
      "@asn/labeler": r("./labeler/index.ts"),
      "@asn/account": r("./account/index.ts"),
      "@asn/paymaster": r("./paymaster/index.ts"),
      "@asn/web": r("./web/index.ts"),
      "@asn/shared": r("./shared/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Chain-integration tests spin up anvil; give them room and run files serially
    // to avoid port/process contention. Pure-logic adversarial tests are fast.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    reporters: ["default"],
  },
});
