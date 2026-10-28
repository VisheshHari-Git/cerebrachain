/**
 * CerebraChain research-prototype verification API.
 *
 * Uses the existing Vite /api proxy.
 * No private MRI scans, model weights, salts or witnesses.
 */

const BASE = "/api/full-model";

export interface FullModelVerification {
  status: string;
  project: string;
  researchPrototype: boolean;
  model: string;
  hospitals: number;
  parametersPerHospital: number;
  offlineRoundId: number;

  groth16: {
    totalProofs: number;
    historicallyVerifiedOffchain: number;
    reverifiedOnThisRequest: number;
    priorEvmReadOnlySamples: number;
    allProofsVerifiedOnchain: boolean;
  };

  proofSet: {
    merkleRoot: string;
    transcriptHash: string;
    anchorId: string;
    manifestSha256: string;
    treeDepth: number;
  };

  blockchain: {
    network: string;
    chainId: number;
    liveVerified: boolean;
    anchored: boolean;
    contractAddress: string;
    transactionHash: string;
    blockNumber: number;
    anchoringGasUsed: number;
    allProofsVerifiedOnchain: boolean;
  };

  verificationScope: string;
  limitations: string;
}

export interface HospitalVerification {
  hospitalId: number;
  label: string;
  nodeType: string;
  model: string;
  parametersPerHospital: number;
  totalProofRecords: number;
  historicallyVerifiedOffchain: number;
  reverifiedOnThisRequest: number;
  proofCoverageComplete: boolean;
  allProofsVerifiedOnchain: boolean;
}

export interface HospitalVerificationResponse {
  status: string;
  project: string;
  researchPrototype: boolean;
  offlineRoundId: number;

  totals: {
    hospitals: number;
    proofRecords: number;
    historicallyVerifiedOffchain: number;
    reverifiedOnThisRequest: number;
  };

  hospitals: HospitalVerification[];

  blockchain: {
    network: string;
    chainId: number;
    liveVerified: boolean;
    anchored: boolean;
    contractAddress: string;
    transactionHash: string;
    anchorId: string;
  };

  verificationScope: string;
  limitations: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

async function requestJSON(
  endpoint: string,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(`${BASE}${endpoint}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error(
      `Verification API unavailable (HTTP ${response.status})`
    );
  }

  return response.json();
}

export async function fetchFullModelVerification(
  signal?: AbortSignal
): Promise<FullModelVerification> {
  const data = await requestJSON("/verification", signal);

  if (
    !isObject(data) ||
    data.status !== "anchored_live_verified" ||
    !isObject(data.groth16) ||
    !isObject(data.blockchain) ||
    !isObject(data.proofSet) ||
    data.blockchain.liveVerified !== true ||
    data.blockchain.anchored !== true ||
    data.groth16.totalProofs !== 1800 ||
    data.groth16.allProofsVerifiedOnchain !== false
  ) {
    throw new Error("Full-model verification is not currently valid");
  }

  return data as unknown as FullModelVerification;
}

export async function fetchHospitalVerification(
  signal?: AbortSignal
): Promise<HospitalVerificationResponse> {
  const data = await requestJSON("/hospitals", signal);

  if (
    !isObject(data) ||
    data.status !== "anchored_live_verified" ||
    !isObject(data.blockchain) ||
    data.blockchain.liveVerified !== true ||
    !Array.isArray(data.hospitals) ||
    data.hospitals.length !== 3 ||
    !data.hospitals.every(
      (hospital: unknown, index: number) =>
        isObject(hospital) &&
        hospital.hospitalId === index &&
        hospital.totalProofRecords === 600 &&
        hospital.historicallyVerifiedOffchain === 600
    )
  ) {
    throw new Error("Hospital verification is not currently valid");
  }

  return data as unknown as HospitalVerificationResponse;
}

export async function fetchVerificationDashboard(
  signal?: AbortSignal
): Promise<{
  fullModel: FullModelVerification;
  hospitalData: HospitalVerificationResponse;
}> {
  const [fullModel, hospitalData] = await Promise.all([
    fetchFullModelVerification(signal),
    fetchHospitalVerification(signal)
  ]);

  if (
    fullModel.proofSet.anchorId !==
      hospitalData.blockchain.anchorId ||
    fullModel.blockchain.transactionHash.toLowerCase() !==
      hospitalData.blockchain.transactionHash.toLowerCase()
  ) {
    throw new Error("Verification API results disagree");
  }

  return { fullModel, hospitalData };
}
