/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // wagmi/viem pull optional deps that aren't needed in the browser bundle.
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
