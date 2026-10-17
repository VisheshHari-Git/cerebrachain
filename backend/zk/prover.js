#!/usr/bin/env node
/**
 * Hospital-side prover for the UpdateChunk circuit.
 *
 *   node zk/prover.js commit <input.json> <output.json>
 *       input  { ctx, chunks: [[q...], ...], salts: [...] }
 *       output { commitments: [...] }          (decimal strings)
 *
 *   node zk/prover.js prove <input.json> <output.json>
 *       input  { ctx, xs: [...], chunks, salts }
 *       output { proofs: [{ proof, publicSignals }, ...], ms }
 *
 * "commit" runs only the witness generator (no proof) with x = 0: the commitment
 * output does not depend on x, so the hospital can commit before the challenge
 * exists, and the later proof is guaranteed to reproduce the same commitment.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");

const BUILD = process.env.CEREBRA_ZK_BUILD || path.join(__dirname, "build");
const WASM = path.join(BUILD, "update_chunk_js", "update_chunk.wasm");
const ZKEY = path.join(BUILD, "update_chunk.zkey");
const builder = require(path.join(BUILD, "update_chunk_js", "witness_calculator.js"));

function circuitInput(ctx, x, chunk, salt) {
  return { ctx: String(ctx), x: String(x), q: chunk.map((v) => String(v)), salt: String(salt) };
}

async function main() {
  const [cmd, inFile, outFile] = process.argv.slice(2);
  if (!cmd || !inFile || !outFile) {
    console.error("usage: prover.js <commit|prove> <input.json> <output.json>");
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(inFile, "utf8"));
  const wc = await builder(fs.readFileSync(WASM));
  const n = input.chunks.length;
  const t0 = Date.now();

  if (cmd === "commit") {
    const commitments = [];
    for (let k = 0; k < n; k++) {
      const w = await wc.calculateWitness(circuitInput(input.ctx, 0, input.chunks[k], input.salts[k]), true);
      commitments.push(w[1].toString()); // witness[1] = first output = commitment
    }
    fs.writeFileSync(outFile, JSON.stringify({ commitments, ms: Date.now() - t0 }));
  } else if (cmd === "prove") {
    const zkey = { type: "mem", data: new Uint8Array(fs.readFileSync(ZKEY)) };
    const proofs = [];
    for (let k = 0; k < n; k++) {
      const wtns = await wc.calculateWTNSBin(circuitInput(input.ctx, input.xs[k], input.chunks[k], input.salts[k]), true);
      const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, { type: "mem", data: wtns });
      proofs.push({ proof, publicSignals });
    }
    fs.writeFileSync(outFile, JSON.stringify({ proofs, ms: Date.now() - t0 }));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
);
