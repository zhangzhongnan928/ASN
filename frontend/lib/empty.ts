// Empty stub for browser-only builds. wagmi's bundled MetaMask connector imports
// `@react-native-async-storage/async-storage`, which only exists in React Native. We alias that
// import to this no-op (the code path is never executed in a web build).
const empty = {} as Record<string, never>;
export default empty;
