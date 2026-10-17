#!/usr/bin/env node
"use strict";
/**
 * CerebraChain trust layer.
 *
 * Sits between the federated aggregator and the blockchain:
 *   - verifies every hospital's Groth16 proofs off-chain (snarkjs) AND on-chain
 *     (CerebraChainRegistry -> Groth16Verifier), applying identical rules
 *   - derives the Fiat-Shamir challenge from all commitments
 *   - stores proof bundles and global models in content-addressed (IPFS CID) storage
 *   - serves the dashboard and a read API the hospitals use to audit the aggregator
 *
 * Env: PORT (8787), CHAIN=auto|off|required, RPC_URL, PRIVATE_KEY, IPFS_API, STORAGE_DIR
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const snarkjs = require("snarkjs");

const P = require("./protocol");
const { ContentStore } = require("./ipfs");
const { Chain } = require("./chain");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.PORT || 8787);
const CHAIN_MODE = (process.env.CHAIN || "auto").toLowerCase();
const STORAGE = process.env.STORAGE_DIR || path.join(ROOT, "storage");
const BUILD = process.env.CEREBRA_ZK_BUILD || path.join(ROOT, "zk", "build");

const vkey = JSON.parse(fs.readFileSync(path.join(BUILD, "verification_key.json"), "utf8"));
const zkMeta = JSON.parse(fs.readFileSync(path.join(BUILD, "meta.json"), "utf8"));
const ipfs = new ContentStore(path.join(STORAGE, "ipfs"), process.env.IPFS_API);
const chain = new Chain();

// ----------------------------------------------------------------------------- state
const STATE_FILE = path.join(STORAGE, "state.json");
fs.mkdirSync(STORAGE, { recursive: true });
let state = { hospitals: {}, rounds: {}, events: [], chain: { enabled: false }, zk: zkMeta, startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
function log(msg, level = "info", extra = {}) {
  const e = { t: new Date().toISOString(), level, msg, ...extra };
  state.events.push(e);
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
  console.log(`[${e.t.slice(11, 19)}] ${level === "info" ? "" : level.toUpperCase() + " "}${msg}`);
}
const strip = (res) => (res ? { txHash: res.txHash, gasUsed: res.gasUsed, block: res.block } : null);
const getRound = (r) => {
  const rd = state.rounds[String(r)];
  if (!rd) throw httpErr(404, `round ${r} not open`);
  return rd;
};
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log(`${req.method} ${req.path}: ${e.message}`, "error");
    res.status(e.status || 500).json({ error: e.message });
  });

// ----------------------------------------------------------------------------- verification
/** Same rules as CerebraChainRegistry._check, plus the cryptographic check with snarkjs. */
async function verifyBundle(rd, hospitalId, root, bundle) {
  const t0 = Date.now();
  const out = { ok: false, reason: "", sumSq: "0", evals: [], chunkCommitments: [] };
  if (!Array.isArray(bundle) || bundle.length !== rd.numChunks) return { ...out, reason: "wrong number of chunk proofs" };
  const ctx = P.ctxFor(rd.round, hospitalId, rd.globalModelHash);
  let total = 0n;
  for (let k = 0; k < bundle.length; k++) {
    const s = bundle[k].publicSignals.map(BigInt);
    if (s.length !== 5) return { ...out, reason: "malformed public signals" };
    if (s[3] !== ctx) return { ...out, reason: "proof bound to another round, hospital or model" };
    if (s[4] !== P.xFor(rd.seed, k)) return { ...out, reason: "proof not made for this round's challenge" };
    out.chunkCommitments.push(s[0].toString());
    out.evals.push(s[1].toString());
    total += s[2];
  }
  out.sumSq = total.toString();
  if (P.commitmentRoot(out.chunkCommitments) !== root) return { ...out, reason: "proof does not match the committed update" };
  if (total > BigInt(rd.normBound)) return { ...out, reason: "update norm exceeds bound (possible poisoning)" };
  for (const { proof, publicSignals } of bundle) {
    if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) return { ...out, reason: "invalid zk-SNARK proof" };
  }
  return { ...out, ok: true, verifyMs: Date.now() - t0 };
}

// ----------------------------------------------------------------------------- app
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (req, res) => res.json({ ok: true, chain: state.chain, zk: zkMeta }));
app.get("/api/state", (req, res) => res.json(state));
app.get("/api/rounds/:r", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  res.json({ ...rd, submissions: Object.values(rd.submissions) });
}));
app.get("/ipfs/:cid", (req, res) => {
  const data = ipfs.get(req.params.cid);
  if (!data) return res.status(404).json({ error: "not found" });
  res.type("application/octet-stream").send(data);
});

app.post("/api/reset", wrap(async (req, res) => {
  // Round numbers are global on-chain, so a new federation run continues after the last one.
  const roundBase = chain.enabled ? Number(await chain.registry.latestRound()) : 0;
  state = { ...state, hospitals: {}, rounds: {}, events: [], initialMetrics: {}, roundBase };
  log(`new federation run; first round will be ${roundBase + 1}`);
  save();
  res.json({ ok: true, firstRound: roundBase + 1 });
}));

app.post("/api/hospitals", wrap(async (req, res) => {
  const { id, name, pubkey, numSamples, device } = req.body;
  if (!/^[0-9a-f]{64}$/i.test(pubkey || "")) throw httpErr(400, "pubkey must be 32-byte hex");
  const h = { id: Number(id), name, pubkey, numSamples, device, registeredAt: new Date().toISOString() };
  if (chain.enabled) h.tx = strip(await chain.registerHospital(h.id, name, pubkey));
  state.hospitals[String(id)] = h;
  log(`registered ${name} (X25519 key ${pubkey.slice(0, 12)}…)${h.tx ? " on-chain" : ""}`);
  save();
  res.json(h);
}));

app.post("/api/rounds", wrap(async (req, res) => {
  const b = req.body;
  const r = Number(b.round);
  if (state.rounds[String(r)]) throw httpErr(409, `round ${r} already exists`);
  const rd = {
    round: r, globalModelHash: b.globalModelHash, normBound: String(b.normBound), numChunks: Number(b.numChunks),
    chunkSize: Number(b.chunkSize), scale: b.scale, clipNorm: b.clipNorm, dim: b.dim,
    participants: b.participants.map(Number), phase: "commit", seed: null, openedAt: new Date().toISOString(),
    submissions: {}, metrics: {}, outcome: null,
  };
  if (rd.chunkSize !== zkMeta.chunkSize) throw httpErr(400, `chunk size ${rd.chunkSize} != circuit ${zkMeta.chunkSize}`);
  for (const id of rd.participants) {
    rd.submissions[String(id)] = { hospitalId: id, name: state.hospitals[String(id)]?.name, status: "invited" };
  }
  if (chain.enabled) rd.openTx = strip(await chain.openRound(r, rd.globalModelHash, rd.normBound, rd.numChunks, rd.participants));
  state.rounds[String(r)] = rd;
  log(`round ${r} opened: ${rd.participants.length} hospitals, ${rd.numChunks} chunks × ${rd.chunkSize}, norm bound ${rd.normBound}`);
  save();
  res.json(rd);
}));

app.post("/api/rounds/:r/commits", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  const { hospitalId, commitmentRoot, maskedHash, numSamples } = req.body;
  const s = rd.submissions[String(hospitalId)];
  if (rd.phase !== "commit") throw httpErr(409, "round not in commit phase");
  if (!s || s.status !== "invited") throw httpErr(409, `hospital ${hospitalId} not invited or already committed`);
  P.b32(commitmentRoot); P.b32(maskedHash);
  Object.assign(s, { status: "committed", commitmentRoot, maskedHash, numSamples: Number(numSamples), committedAt: new Date().toISOString() });
  if (chain.enabled) s.commitTx = strip(await chain.commit(rd.round, Number(hospitalId), commitmentRoot, maskedHash, Number(numSamples)));
  log(`round ${rd.round}: ${s.name} committed ${commitmentRoot.slice(0, 14)}…`);
  save();
  res.json(s);
}));

app.post("/api/rounds/:r/close-commits", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  if (rd.phase !== "commit") throw httpErr(409, "round not in commit phase");
  const entries = rd.participants
    .map((id) => rd.submissions[String(id)])
    .filter((s) => s.status === "committed")
    .map((s) => ({ hospitalId: s.hospitalId, commitmentRoot: s.commitmentRoot, maskedHash: s.maskedHash, numSamples: s.numSamples }));
  rd.seed = P.challengeSeed(rd.round, rd.globalModelHash, entries);
  for (const s of Object.values(rd.submissions)) {
    if (s.status === "invited") Object.assign(s, { status: "missing", reason: "no commitment" });
  }
  if (chain.enabled) {
    const c = await chain.closeCommits(rd.round);
    rd.closeTx = strip(c);
    if (c.seed !== rd.seed) throw httpErr(500, `on-chain seed ${c.seed} != off-chain ${rd.seed}`);
  }
  rd.phase = "prove";
  log(`round ${rd.round}: commitments closed, challenge seed ${rd.seed.slice(0, 14)}…${chain.enabled ? " (matches on-chain)" : ""}`);
  save();
  res.json({ seed: rd.seed });
}));

app.post("/api/rounds/:r/proofs", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  const { hospitalId, proofs, proveSeconds } = req.body;
  const s = rd.submissions[String(hospitalId)];
  if (rd.phase !== "prove") throw httpErr(409, "round not in prove phase");
  if (!s || s.status !== "committed") throw httpErr(409, `hospital ${hospitalId} has no open commitment`);

  const v = await verifyBundle(rd, Number(hospitalId), s.commitmentRoot, proofs);
  const stored = await ipfs.put(JSON.stringify({ round: rd.round, hospitalId, proofs }), `proofs-r${rd.round}-h${hospitalId}.json`);
  Object.assign(s, {
    sumSq: v.sumSq, evals: v.evals, chunkCommitments: v.chunkCommitments, proofCid: stored.cid,
    verifyMs: v.verifyMs, proveSeconds, offchain: v.ok ? "accepted" : "rejected",
  });
  let ok = v.ok;
  let reason = v.reason;
  if (chain.enabled) {
    const c = await chain.submitProofs(rd.round, Number(hospitalId), proofs, stored.cid);
    s.proofTx = strip(c);
    s.onchain = c.accepted ? "accepted" : "rejected";
    if (c.accepted !== v.ok) {
      log(`round ${rd.round}: on-chain and off-chain verification disagree for hospital ${hospitalId}`, "error");
    }
    ok = ok && c.accepted;
    reason = reason || c.reason;
  }
  s.status = ok ? "accepted" : "rejected";
  s.reason = reason;
  if (!ok) s.evals = [];
  log(`round ${rd.round}: ${s.name} ${ok ? "ACCEPTED" : "REJECTED — " + reason} (sum q² = ${v.sumSq} / bound ${rd.normBound})`,
    ok ? "info" : "warn");
  save();
  res.json(s);
}));

app.post("/api/rounds/:r/missing", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  const { hospitalId, reason } = req.body;
  const s = rd.submissions[String(hospitalId)];
  if (!s || !["invited", "committed"].includes(s.status)) throw httpErr(409, "cannot mark this hospital missing");
  if (chain.enabled) s.missingTx = strip(await chain.markMissing(rd.round, Number(hospitalId), reason));
  Object.assign(s, { status: "missing", reason });
  log(`round ${rd.round}: ${s.name} marked missing (${reason})`, "warn");
  save();
  res.json(s);
}));

app.post("/api/rounds/:r/finalize", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  if (rd.outcome) throw httpErr(409, "round already finalized");
  const { updated, newGlobalModelHash, modelB64, note, aggregateCheck, accepted, timings } = req.body;
  let model = null;
  if (updated && modelB64) model = await ipfs.put(Buffer.from(modelB64, "base64"), `global-r${rd.round}.f32`);
  const zero = "0x" + "00".repeat(32);
  Object.assign(rd, {
    outcome: updated ? "updated" : "aborted", note, aggregateCheck, accepted, timings,
    newGlobalModelHash: updated ? newGlobalModelHash : null, modelCid: model ? model.cid : null,
    finalizedAt: new Date().toISOString(), phase: "finalized",
  });
  if (chain.enabled) {
    rd.finalizeTx = strip(await chain.finalizeRound(rd.round, !!updated, updated ? newGlobalModelHash : zero, rd.modelCid || "", note || ""));
  }
  log(`round ${rd.round} finalized: ${updated ? "global model updated" : "ABORTED"} — ${note}`, updated ? "info" : "warn");
  save();
  res.json(rd);
}));

app.post("/api/rounds/:r/metrics", wrap(async (req, res) => {
  const rd = getRound(req.params.r);
  const { hospitalId } = req.body;
  rd.metrics[String(hospitalId)] = req.body;
  save();
  res.json({ ok: true });
}));

app.post("/api/initial-metrics", wrap(async (req, res) => {
  state.initialMetrics = state.initialMetrics || {};
  state.initialMetrics[String(req.body.hospitalId)] = req.body;
  save();
  res.json({ ok: true });
}));

// ----------------------------------------------------------------------------- start
async function start() {
  if (CHAIN_MODE !== "off") {
    try {
      const info = await chain.connect();
      state.chain = { enabled: true, ...info };
      log(`connected to chain ${info.chainId} at ${info.rpcUrl}; registry ${info.registry}`);
    } catch (e) {
      if (CHAIN_MODE === "required") {
        console.error(`blockchain required but unavailable: ${e.message}`);
        process.exit(1);
      }
      state.chain = { enabled: false, error: e.message };
      log(`blockchain disabled: ${e.message}`, "warn");
    }
  } else {
    state.chain = { enabled: false, error: "CHAIN=off" };
  }
  // warm up the pairing engine so the first verification is not slow
  await snarkjs.groth16.verify(vkey, ["0", "0", "0", "0", "0"], {
    pi_a: ["1", "2", "1"], pi_b: [["1", "0"], ["0", "1"], ["1", "0"]], pi_c: ["1", "2", "1"], protocol: "groth16", curve: "bn128",
  }).catch(() => {});
  save();
  app.listen(PORT, "127.0.0.1", () => log(`trust layer listening on http://127.0.0.1:${PORT}`));
}

if (require.main === module) start();
module.exports = { verifyBundle };
