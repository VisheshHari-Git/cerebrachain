"use strict";
/**
 * Hashing conventions — must match cerebrachain/fields.py and CerebraChainRegistry.sol.
 * SHA-256 over Solidity abi.encodePacked bytes; values entering the circuit are
 * reduced modulo the BN254 scalar field R.
 */
const crypto = require("crypto");

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TAG_CTX = Buffer.from("CerebraChain/ctx");
const TAG_SEED = Buffer.from("CerebraChain/seed");
const TAG_X = Buffer.from("CerebraChain/x");

function u256(v) {
  const b = BigInt(v);
  if (b < 0n || b >= 1n << 256n) throw new Error("value does not fit in uint256");
  return Buffer.from(b.toString(16).padStart(64, "0"), "hex");
}

function b32(hex) {
  const s = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error(`expected 32-byte hex, got ${hex}`);
  return Buffer.from(s, "hex");
}

function sha256(...parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

const toBig = (buf) => BigInt("0x" + buf.toString("hex"));
const hex = (buf) => "0x" + buf.toString("hex");

function ctxFor(round, hospitalId, globalModelHash) {
  return toBig(sha256(TAG_CTX, u256(round), u256(hospitalId), b32(globalModelHash))) % R;
}

/** entries: [{hospitalId, commitmentRoot, maskedHash, numSamples}] in participant order */
function challengeSeed(round, globalModelHash, entries) {
  const parts = [TAG_SEED, u256(round), b32(globalModelHash)];
  for (const e of entries) {
    parts.push(u256(e.hospitalId), b32(e.commitmentRoot), b32(e.maskedHash), u256(e.numSamples));
  }
  return hex(sha256(...parts));
}

function xFor(seed, k) {
  return toBig(sha256(TAG_X, b32(seed), u256(k))) % R;
}

function commitmentRoot(chunkCommitments) {
  return hex(sha256(...chunkCommitments.map(u256)));
}

module.exports = { R, u256, b32, sha256, ctxFor, challengeSeed, xFor, commitmentRoot, hex };
