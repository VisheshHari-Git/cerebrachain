"use strict";
/** Thin wrapper over the CerebraChainRegistry contract (ethers v6). */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DIR = path.join(__dirname, "..");
const HARDHAT_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** snarkjs proof -> Solidity calldata (note the swapped G2 coordinates). */
function toSolidityProof(proof, publicSignals) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
    pub: publicSignals.map(String),
  };
}

class Chain {
  constructor() {
    this.enabled = false;
    this.queue = Promise.resolve();
  }

  async connect() {
    const depFile = path.join(DIR, "deployments", "local.json");
    if (!fs.existsSync(depFile)) throw new Error("no deployment found (run npm run contracts:deploy)");
    const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
    const rpc = process.env.RPC_URL || dep.rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    const net = await this.provider.getNetwork();
    const code = await this.provider.getCode(dep.registry);
    if (code === "0x") throw new Error(`no contract at ${dep.registry} on ${rpc} (chain restarted? redeploy)`);
    this.wallet = new ethers.NonceManager(new ethers.Wallet(process.env.PRIVATE_KEY || HARDHAT_KEY0, this.provider));
    const abi = JSON.parse(fs.readFileSync(path.join(DIR, "artifacts", "CerebraChainRegistry.json"), "utf8")).abi;
    this.registry = new ethers.Contract(dep.registry, abi, this.wallet);
    this.info = { ...dep, rpcUrl: rpc, chainId: Number(net.chainId) };
    this.enabled = true;
    return this.info;
  }

  /** Serialise transactions so nonces never race. Returns {txHash, gasUsed, block, receipt}. */
  send(method, ...args) {
    const run = async () => {
      const tx = await this.registry[method](...args);
      const receipt = await tx.wait();
      return { txHash: receipt.hash, gasUsed: Number(receipt.gasUsed), block: receipt.blockNumber, receipt };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  parseEvents(receipt) {
    const out = [];
    for (const log of receipt.logs) {
      try {
        const e = this.registry.interface.parseLog(log);
        if (e) out.push({ name: e.name, args: e.args });
      } catch (_) { /* not ours */ }
    }
    return out;
  }

  registerHospital(id, name, keyHex) {
    return this.send("registerHospital", id, name, "0x" + keyHex.replace(/^0x/, ""));
  }

  openRound(r, globalHash, normBound, numChunks, ids) {
    return this.send("openRound", r, globalHash, normBound, numChunks, ids);
  }

  commit(r, id, root, maskedHash, n) {
    return this.send("commit", r, id, root, maskedHash, n);
  }

  async closeCommits(r) {
    const res = await this.send("closeCommits", r);
    const ev = this.parseEvents(res.receipt).find((e) => e.name === "ChallengeIssued");
    return { ...res, seed: ev ? ev.args.seed : (await this.registry.rounds(r)).seed };
  }

  async submitProofs(r, id, bundle, proofCid) {
    const proofs = bundle.map((p) => toSolidityProof(p.proof, p.publicSignals));
    const res = await this.send("submitProofs", r, id, proofs, proofCid);
    const evs = this.parseEvents(res.receipt);
    const acc = evs.find((e) => e.name === "UpdateAccepted");
    const rej = evs.find((e) => e.name === "UpdateRejected");
    return { ...res, accepted: !!acc, reason: rej ? rej.args.reason : "" };
  }

  markMissing(r, id, reason) {
    return this.send("markMissing", r, id, reason);
  }

  finalizeRound(r, updated, newHash, cid, note) {
    return this.send("finalizeRound", r, updated, newHash, cid, note);
  }
}

module.exports = { Chain, toSolidityProof };
