"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  getFullModelVerification
} = require("./full-model-verification");

const ROOT = path.resolve(__dirname, "..", "..");

const MANIFEST = path.join(
  ROOT,
  "runs/3d_fl_smoke/zk_full_anchor_stage_v1",
  "proofset_merkle_v1.json"
);

const EXPECTED_SHA =
  "565ed8cacf3a7fc90b26286f11e327d1d2fafad72fc34cff4cd2c6a7ccee5dfd";

function stableJSON(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(stableJSON).join(",") + "]";
  }

  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(
      key => JSON.stringify(key) + ":" + stableJSON(value[key])
    ).join(",") + "}";
  }

  return JSON.stringify(value);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function getHospitalVerification() {

  // Reuse the existing LIVE blockchain verification.
  const verification = await getFullModelVerification();

  ensure(
    verification.status === "anchored_live_verified" &&
    verification.blockchain.liveVerified === true &&
    verification.blockchain.anchored === true,
    "Live blockchain verification unavailable"
  );

  // Read only the public proof-set manifest.
  const fileStat = fs.lstatSync(MANIFEST);

  ensure(
    fileStat.isFile() && !fileStat.isSymbolicLink(),
    "Invalid proof-set manifest"
  );

  const manifest = JSON.parse(
    fs.readFileSync(MANIFEST, "utf8")
  );

  const {manifestSha256, ...unsigned} = manifest;

  const actualSHA = crypto
    .createHash("sha256")
    .update(stableJSON(unsigned))
    .digest("hex");

  ensure(
    actualSHA === EXPECTED_SHA &&
    manifestSha256 === EXPECTED_SHA,
    "Proof-set manifest integrity mismatch"
  );

  ensure(
    manifest.anchorId === verification.proofSet.anchorId &&
    manifest.proofMerkleRoot === verification.proofSet.merkleRoot &&
    manifest.offlineRoundId === 2305 &&
    manifest.totalProofs === 1800 &&
    Array.isArray(manifest.leaves) &&
    manifest.leaves.length === 1800,
    "Proof-set and blockchain verification mismatch"
  );

  // Check all expected 600 chunk records per hospital.
  // No witness, proof payload, salt or model weight is loaded.
  const counts = [0, 0, 0];

  for (let position = 0; position < 1800; position++) {
    const hospitalId = position % 3;
    const chunkIndex = Math.floor(position / 3);
    const leaf = manifest.leaves[position];

    const expectedJob =
      "hospital_" + hospitalId +
      "_chunk_" + String(chunkIndex).padStart(3, "0");

    ensure(
      leaf.leafIndex === position &&
      leaf.hospitalId === hospitalId &&
      leaf.chunkIndex === chunkIndex &&
      leaf.job === expectedJob,
      "Hospital proof coverage or ordering mismatch"
    );

    counts[hospitalId]++;
  }

  ensure(
    counts.every(count => count === 600),
    "Incomplete hospital proof coverage"
  );

  const hospitals = counts.map((count, id) => ({
    hospitalId: id,
    label: "Hospital " + ["A", "B", "C"][id],
    nodeType: "Research Prototype",
    model: "3D U-Net",
    parametersPerHospital: 2453636,
    totalProofRecords: count,
    historicallyVerifiedOffchain: count,
    reverifiedOnThisRequest: 0,
    proofCoverageComplete: true,
    allProofsVerifiedOnchain: false
  }));

  return {
    status: "anchored_live_verified",
    project: "ZKP-CerebraChain",
    researchPrototype: true,
    offlineRoundId: 2305,

    totals: {
      hospitals: 3,
      proofRecords: 1800,
      historicallyVerifiedOffchain: 1800,
      reverifiedOnThisRequest: 0
    },

    hospitals,

    blockchain: {
      network: verification.blockchain.network,
      chainId: verification.blockchain.chainId,
      liveVerified: verification.blockchain.liveVerified,
      anchored: verification.blockchain.anchored,
      contractAddress:
        verification.blockchain.contractAddress,
      transactionHash:
        verification.blockchain.transactionHash,
      anchorId: verification.proofSet.anchorId
    },

    verificationScope:
      "Historical off-chain Groth16 audit and live local anchor check",

    limitations:
      "Does not prove authentic MRI training, clinical accuracy, or independent hospital key custody"
  };
}

module.exports = {getHospitalVerification};
