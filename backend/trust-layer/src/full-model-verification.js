"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(
  ROOT, "runs", "3d_fl_smoke", "zk_full_anchor_stage_v1"
);


const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const EXPECTED_ROOT =
  "0xb649be5a26b61566ec834d01573b511c5a1d74e651fac6c61912d29e49cae98b";

const EXPECTED_ANCHOR =
  "0x7878e7eddf6c399806669f00c51fe53ab3532fd161970ec42b1a1ba9ceb22d0b";

const EXPECTED_MANIFEST =
  "565ed8cacf3a7fc90b26286f11e327d1d2fafad72fc34cff4cd2c6a7ccee5dfd";

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

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

function readJSON(name) {
  const file = path.join(DIR, name);
  const stat = fs.lstatSync(file);

  ensure(stat.isFile() && !stat.isSymbolicLink(),
    "Invalid verification artifact");

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function rpc(method, params = []) {
  const response = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }),
    signal: AbortSignal.timeout(5000)
  });

  ensure(response.ok, "Local blockchain RPC unavailable");

  const result = await response.json();

  ensure(!result.error && result.result !== undefined,
    "Blockchain RPC verification failed");

  return result.result;
}

async function methodSelector(signature) {
  const hash = await rpc("web3_sha3", [
    "0x" + Buffer.from(signature).toString("hex")
  ]);

  return hash.slice(0, 10);
}

function words(hex) {
  ensure(typeof hex === "string" && /^0x[0-9a-f]*$/i.test(hex),
    "Invalid contract response");

  const bytes = Buffer.from(hex.slice(2), "hex");

  ensure(bytes.length % 32 === 0, "Invalid ABI response");

  const result = [];

  for (let i = 0; i < bytes.length; i += 32) {
    result.push(bytes.subarray(i, i + 32));
  }

  return result;
}

function hexWord(word) {
  return "0x" + word.toString("hex");
}

function numWord(word) {
  return Number(BigInt(hexWord(word)));
}

async function getFullModelVerification() {

  // Read public proof-set metadata only.
  // Never read private witnesses, salts, model deltas or keys.

  const manifest = readJSON("proofset_merkle_v1.json");
  const deployment = readJSON(process.env.CEREBRACHAIN_RECOVERY_DEPLOYMENT || "deployment_local31337_recovery_v2.json");
  const anchoring = readJSON(process.env.CEREBRACHAIN_RECOVERY_ANCHORING || "anchoring_local31337_recovery_v2.json");
  const CONTRACT = deployment.contractAddress;

  const {manifestSha256, ...unsigned} = manifest;

  ensure(
    sha256(stableJSON(unsigned)) === EXPECTED_MANIFEST &&
    manifestSha256 === EXPECTED_MANIFEST,
    "Proof-set manifest integrity mismatch"
  );

  ensure(
    manifest.kind === "CEREBRACHAIN_OFFLINE_PROOFSET_ANCHOR_V1" &&
    manifest.totalProofs === 1800 &&
    manifest.offlineRoundId === 2305 &&
    Array.isArray(manifest.leaves) &&
    manifest.leaves.length === 1800 &&
    manifest.proofMerkleRoot === EXPECTED_ROOT &&
    manifest.anchorId === EXPECTED_ANCHOR,
    "Unexpected proof-set metadata"
  );

  const transcript = manifest.transcriptHash;

  const recalculatedAnchor = sha256(Buffer.concat([
    Buffer.from([2]),
    Buffer.from(EXPECTED_ROOT.slice(2), "hex"),
    Buffer.from(transcript.slice(2), "hex")
  ]));

  ensure(
    "0x" + recalculatedAnchor === EXPECTED_ANCHOR,
    "Anchor calculation mismatch"
  );

  ensure(
    deployment.status === "DEPLOYED_VERIFIED" &&
    deployment.contractAddress.toLowerCase() === CONTRACT.toLowerCase() &&
    deployment.deployer.toLowerCase() === OWNER.toLowerCase() &&
    deployment.anchorManifestSha256 === EXPECTED_MANIFEST,
    "Deployment record mismatch"
  );

  ensure(
    anchoring.status === "ANCHORED_VERIFIED" &&
    anchoring.contractAddress.toLowerCase() === CONTRACT.toLowerCase() &&
    anchoring.anchorId === EXPECTED_ANCHOR &&
    anchoring.manifestSha256 === EXPECTED_MANIFEST,
    "Anchoring journal mismatch"
  );

  // Independently check the live local blockchain.

  const [chain, genesis, code, transaction, receipt] =
    await Promise.all([
      rpc("eth_chainId"),
      rpc("eth_getBlockByNumber", ["0x0", false]),
      rpc("eth_getCode", [CONTRACT, "latest"]),
      rpc("eth_getTransactionByHash", [anchoring.transactionHash]),
      rpc("eth_getTransactionReceipt", [anchoring.transactionHash])
    ]);

  ensure(Number(BigInt(chain)) === 31337,
    "Unexpected blockchain network");

  ensure(
    genesis &&
    deployment.genesisHash === genesis.hash &&
    anchoring.genesisHash === genesis.hash,
    "Blockchain identity mismatch"
  );

  ensure(
    code && code !== "0x" &&
    sha256(Buffer.from(code.slice(2), "hex")) ===
      deployment.runtimeCodeSha256,
    "Deployed contract bytecode mismatch"
  );

  ensure(
    transaction && receipt &&
    Number(BigInt(receipt.status)) === 1 &&
    transaction.to.toLowerCase() === CONTRACT.toLowerCase() &&
    transaction.from.toLowerCase() === OWNER.toLowerCase() &&
    Number(BigInt(receipt.blockNumber)) === anchoring.anchoringBlock &&
    Number(BigInt(receipt.gasUsed)) === anchoring.anchoringGasUsed,
    "Anchoring transaction mismatch"
  );

  const anchorSignature =
    "anchorProofSet(bytes32,bytes32,bytes32,bytes32,uint256,uint256)";

  const [anchorSelector, checkSelector, getSelector, eventTopic] =
    await Promise.all([
      methodSelector(anchorSignature),
      methodSelector("isAnchored(bytes32)"),
      methodSelector("getAnchor(bytes32)"),
      rpc("web3_sha3", [
        "0x" + Buffer.from(
          "ProofSetAnchored(bytes32,bytes32,bytes32,bytes32,uint256,uint256,address)"
        ).toString("hex")
      ])
    ]);

  const txInput = transaction.input.toLowerCase();

  ensure(
    txInput.slice(0, 10) === anchorSelector.toLowerCase(),
    "Anchoring function mismatch"
  );

  const txArgs = words("0x" + txInput.slice(10));

  ensure(
    txArgs.length === 6 &&
    hexWord(txArgs[0]) === EXPECTED_ANCHOR &&
    hexWord(txArgs[1]) === EXPECTED_ROOT &&
    hexWord(txArgs[2]) === transcript &&
    hexWord(txArgs[3]) === "0x" + EXPECTED_MANIFEST &&
    numWord(txArgs[4]) === 1800 &&
    numWord(txArgs[5]) === 2305,
    "Anchoring transaction arguments mismatch"
  );

  const callArgument = EXPECTED_ANCHOR.slice(2);

  const [anchored, stored] = await Promise.all([
    rpc("eth_call", [{
      to: CONTRACT,
      data: checkSelector + callArgument
    }, "latest"]),
    rpc("eth_call", [{
      to: CONTRACT,
      data: getSelector + callArgument
    }, "latest"])
  ]);

  ensure(BigInt(anchored) === 1n,
    "Proof-set is not anchored on the current chain");

  const record = words(stored);

  ensure(
    record.length === 7 &&
    hexWord(record[0]) === EXPECTED_ROOT &&
    hexWord(record[1]) === transcript &&
    hexWord(record[2]) === "0x" + EXPECTED_MANIFEST &&
    numWord(record[3]) === 1800 &&
    numWord(record[4]) === 2305 &&
    numWord(record[5]) > 0 &&
    ("0x" + record[6].subarray(12).toString("hex")) === OWNER,
    "On-chain proof-set storage mismatch"
  );

  const matchingEvents = (receipt.logs || []).filter(log =>
    log.address.toLowerCase() === CONTRACT.toLowerCase() &&
    log.topics.length === 4 &&
    log.topics[0].toLowerCase() === eventTopic.toLowerCase() &&
    log.topics[1].toLowerCase() === EXPECTED_ANCHOR &&
    log.topics[2].toLowerCase() === EXPECTED_ROOT &&
    log.topics[3].toLowerCase() === transcript
  );

  ensure(matchingEvents.length === 1,
    "Anchoring event mismatch");

  const eventData = words(matchingEvents[0].data);

  ensure(
    eventData.length === 4 &&
    hexWord(eventData[0]) === "0x" + EXPECTED_MANIFEST &&
    numWord(eventData[1]) === 1800 &&
    numWord(eventData[2]) === 2305 &&
    ("0x" + eventData[3].subarray(12).toString("hex")) === OWNER,
    "Anchoring event payload mismatch"
  );

  // Return an explicit, limited, frontend-safe object.

  return {
    status: "anchored_live_verified",
    project: "ZKP-CerebraChain",
    researchPrototype: true,
    model: "3D U-Net",
    hospitals: 3,
    parametersPerHospital: 2453636,
    offlineRoundId: 2305,

    groth16: {
      totalProofs: 1800,
      historicallyVerifiedOffchain: 1800,
      reverifiedOnThisRequest: 0,
      priorEvmReadOnlySamples: 3,
      allProofsVerifiedOnchain: false
    },

    secureAggregation: {
      previousLocalReplayAudit: "PASS",
      independentHospitalKeyCustodyProven: false,
      publicMaskBindingProven: false
    },

    proofSet: {
      merkleRoot: EXPECTED_ROOT,
      transcriptHash: transcript,
      anchorId: EXPECTED_ANCHOR,
      manifestSha256: EXPECTED_MANIFEST,
      treeDepth: manifest.treeDepth
    },

    blockchain: {
      network: "Hardhat Local",
      chainId: 31337,
      liveVerified: true,
      anchored: true,
      contractAddress: CONTRACT,
      transactionHash: anchoring.transactionHash,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      anchoringGasUsed: Number(BigInt(receipt.gasUsed)),
      allProofsVerifiedOnchain: false
    },

    verificationScope:
      "Historical off-chain proof audit plus live local blockchain anchor verification",

    limitations:
      "Does not establish clinical validity, authentic MRI training, or distributed hospital key custody"
  };
}

module.exports = {getFullModelVerification};
