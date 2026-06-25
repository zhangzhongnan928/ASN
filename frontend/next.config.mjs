import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives in a subdirectory of a monorepo; pin the tracing root so Next doesn't infer a
  // parent lockfile as the workspace root.
  outputFileTracingRoot: dir,
  // wagmi/viem pull optional deps that aren't needed in the browser bundle (built with --webpack).
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // MetaMask SDK imports a React-Native-only storage module that doesn't exist in web builds.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
    };
    // benign dynamic-require warning from viem/ox internals.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { message: /Critical dependency: the request of a dependency is an expression/ },
    ];
    return config;
  },
};

export default nextConfig;
