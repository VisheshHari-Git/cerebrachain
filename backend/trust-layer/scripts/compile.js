#!/usr/bin/env node
"use strict";
/** Compile the contracts with solc-js (no compiler download needed). */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const DIR = path.join(__dirname, "..");
const SOURCES = ["Groth16Verifier.sol", "CerebraChainRegistry.sol"];

function main() {
  const sources = {};
  for (const f of SOURCES) {
    const p = path.join(DIR, "contracts", f);
    if (!fs.existsSync(p)) {
      console.error(`missing ${p} (run scripts/zk_setup.sh first to generate the verifier)`);
      process.exit(1);
    }
    sources[f] = { content: fs.readFileSync(p, "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  console.log(`compiling with solc ${solc.version()} ...`);
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  for (const e of out.errors || []) if (e.severity !== "error") console.warn(e.formattedMessage.split("\n")[0]);
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  const outDir = path.join(DIR, "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, name] of [["Groth16Verifier.sol", "Groth16Verifier"], ["CerebraChainRegistry.sol", "CerebraChainRegistry"]]) {
    const c = out.contracts[file][name];
    fs.writeFileSync(path.join(outDir, `${name}.json`),
      JSON.stringify({ contractName: name, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
    console.log(`  ${name}: ${c.evm.bytecode.object.length / 2} bytes`);
  }
}

main();
