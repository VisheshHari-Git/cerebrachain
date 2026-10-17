#!/usr/bin/env node
"use strict";
/**
 * Deploy Groth16Verifier + CerebraChainRegistry to an EVM chain.
 *   RPC_URL      default http://127.0.0.1:8545 (local Hardhat node)
 *   PRIVATE_KEY  default: Hardhat's well-known test account #0 (never use on a real network)
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DIR = path.join(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const HARDHAT_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PRIVATE_KEY = process.env.PRIVATE_KEY || HARDHAT_KEY0;

const artifact = (n) => JSON.parse(fs.readFileSync(path.join(DIR, "artifacts", `${n}.json`), "utf8"));

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  const base = new ethers.Wallet(PRIVATE_KEY, provider);
  const wallet = new ethers.NonceManager(base); // avoids stale nonces between back-to-back deploys
  console.log(`deploying to chain ${net.chainId} at ${RPC_URL} from ${base.address}`);

  const V = artifact("Groth16Verifier");
  const verifier = await new ethers.ContractFactory(V.abi, V.bytecode, wallet).deploy();
  await verifier.waitForDeployment();
  const C = artifact("CerebraChainRegistry");
  const registry = await new ethers.ContractFactory(C.abi, C.bytecode, wallet).deploy(await verifier.getAddress());
  await registry.waitForDeployment();

  const dep = {
    chainId: Number(net.chainId),
    rpcUrl: RPC_URL,
    verifier: await verifier.getAddress(),
    registry: await registry.getAddress(),
    aggregator: base.address,
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(DIR, "deployments"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "deployments", "local.json"), JSON.stringify(dep, null, 2));
  console.log(`  Groth16Verifier      ${dep.verifier}`);
  console.log(`  CerebraChainRegistry ${dep.registry}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
