// Hardhat is only used as a local EVM node (`npm run chain`).
// Contracts are compiled with solc-js by trust-layer/scripts/compile.js.
module.exports = {
  paths: { sources: "./trust-layer/hardhat-empty", cache: "./trust-layer/.hardhat-cache", artifacts: "./trust-layer/.hardhat-artifacts" },
  networks: {
    hardhat: {
      chainId: 31337,
      blockGasLimit: 60_000_000,
      mining: { auto: true },
    },
  },
};
