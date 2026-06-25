import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    // This app lives in a subdirectory of a monorepo with multiple lockfiles; pin the root.
    root: dir,
    resolveAlias: {
      // wagmi's bundled MetaMask connector imports a React-Native-only storage module that doesn't
      // exist in web builds — alias it to a no-op so resolution succeeds.
      "@react-native-async-storage/async-storage": "./lib/empty.ts",
    },
  },
};

export default nextConfig;
