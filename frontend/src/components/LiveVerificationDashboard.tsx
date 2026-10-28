import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVerificationDashboard } from "../lib/fullModelApi";
import "./LiveVerificationDashboard.css";

type DashboardData = Awaited<
  ReturnType<typeof fetchVerificationDashboard>
>;

type VerificationState = {
  phase: "loading" | "verified" | "unavailable";
  data: DashboardData | null;
  checkedAt: string | null;
};

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-IN").format(value);

function shortenHash(value: string): string {
  if (!value || value.length < 20) return value;
  return `${value.slice(0, 12)}...${value.slice(-10)}`;
}

export default function LiveVerificationDashboard() {
  const [state, setState] = useState<VerificationState>({
    phase: "loading",
    data: null,
    checkedAt: null,
  });

  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestVersion.current;

    setState({
      phase: "loading",
      data: null,
      checkedAt: null,
    });

    try {
      const result = await fetchVerificationDashboard();

      if (currentRequest !== requestVersion.current) return;

      if (
        result.fullModel.status !== "anchored_live_verified" ||
        result.hospitalData.status !== "anchored_live_verified" ||
        result.fullModel.blockchain.liveVerified !== true ||
        result.hospitalData.blockchain.liveVerified !== true
      ) {
        throw new Error("Live verification unavailable");
      }

      setState({
        phase: "verified",
        data: result,
        checkedAt: new Date().toLocaleTimeString(),
      });
    } catch {
      if (currentRequest !== requestVersion.current) return;

      // Never display stale data as live verified.
      setState({
        phase: "unavailable",
        data: null,
        checkedAt: new Date().toLocaleTimeString(),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();

    const timer = window.setInterval(() => {
      void refresh();
    }, 30000);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    document.addEventListener(
      "visibilitychange",
      onVisibilityChange
    );

    return () => {
      requestVersion.current++;
      window.clearInterval(timer);
      document.removeEventListener(
        "visibilitychange",
        onVisibilityChange
      );
    };
  }, [refresh]);

  const { phase, data, checkedAt } = state;

  return (
    <section
      className="cc-verify"
      aria-label="CerebraChain Live Verification Dashboard"
    >
      <div className="cc-verify__header">
        <div>
          <div className="cc-verify__eyebrow">
            ZKP-CEREBRACHAIN · RESEARCH PROTOTYPE
          </div>

          <h2>Live Verification Dashboard</h2>

          <p>
            Federated 3D U-Net · Groth16 Proofs · Blockchain
          </p>
        </div>

        <button
          type="button"
          className="cc-verify__refresh"
          onClick={() => void refresh()}
          disabled={phase === "loading"}
        >
          {phase === "loading" ? "Checking..." : "↻ Refresh"}
        </button>
      </div>

      <div className="cc-verify__status" aria-live="polite">
        {phase === "loading" && (
          <span className="cc-verify__checking">
            ◌ Checking live blockchain verification...
          </span>
        )}

        {phase === "verified" && (
          <span className="cc-verify__verified">
            ● LOCAL BLOCKCHAIN ANCHOR VERIFIED
          </span>
        )}

        {phase === "unavailable" && (
          <span className="cc-verify__unavailable">
            ● LIVE VERIFICATION UNAVAILABLE
          </span>
        )}

        {checkedAt && (
          <span className="cc-verify__timestamp">
            Checked: {checkedAt}
          </span>
        )}
      </div>

      {phase === "unavailable" && (
        <div className="cc-verify__alert" role="alert">
          Live verification could not be confirmed. Check the
          backend API and local Hardhat blockchain. No previously
          verified status is being reused.
        </div>
      )}

      {phase === "loading" && (
        <div className="cc-verify__loading">
          Validating the proof-set anchor and hospital records...
        </div>
      )}

      {phase === "verified" && data && (
        <>
          <div className="cc-verify__metrics">
            <div className="cc-verify__card">
              <span>AI Model</span>
              <strong>{data.fullModel.model}</strong>
              <small>
                {formatNumber(
                  data.fullModel.parametersPerHospital
                )} parameters / hospital
              </small>
            </div>

            <div className="cc-verify__card">
              <span>Participating Hospitals</span>
              <strong>{data.fullModel.hospitals}</strong>
              <small>Local research prototype nodes</small>
            </div>

            <div className="cc-verify__card">
              <span>Groth16 Proofs</span>
              <strong>
                {formatNumber(
                  data.fullModel.groth16
                    .historicallyVerifiedOffchain
                )}
              </strong>
              <small>Historically verified off-chain</small>
            </div>

            <div className="cc-verify__card">
              <span>Blockchain Status</span>
              <strong className="cc-verify__green">
                Anchored
              </strong>
              <small>Live-checked local Hardhat chain</small>
            </div>
          </div>

          <div className="cc-verify__section">
            <h3>Hospital Verification</h3>
            <p>Historical Groth16 proof coverage by hospital</p>

            <div className="cc-verify__hospitals">
              {data.hospitalData.hospitals.map((hospital) => (
                <div
                  className="cc-verify__hospital"
                  key={hospital.hospitalId}
                >
                  <div className="cc-verify__hospitalTop">
                    <strong>{hospital.label}</strong>
                    <span className="cc-verify__badge">
                      AUDIT RECORDED
                    </span>
                  </div>

                  <div className="cc-verify__proofCount">
                    {formatNumber(
                      hospital.historicallyVerifiedOffchain
                    )}
                    <small>
                      / {formatNumber(hospital.totalProofRecords)}
                    </small>
                  </div>

                  <p>Groth16 proofs historically verified</p>

                  <div className="cc-verify__progress">
                    <div
                      style={{
                        width: hospital.proofCoverageComplete
                          ? "100%"
                          : "0%",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="cc-verify__section">
            <h3>Blockchain Proof-Set Anchor</h3>

            <div className="cc-verify__details">
              <div>
                <span>Network</span>
                <strong>
                  {data.fullModel.blockchain.network}
                  {" · "}
                  Chain {data.fullModel.blockchain.chainId}
                </strong>
              </div>

              <div>
                <span>Offline Round</span>
                <strong>{data.fullModel.offlineRoundId}</strong>
              </div>

              <div>
                <span>Anchor Block</span>
                <strong>
                  #{data.fullModel.blockchain.blockNumber}
                </strong>
              </div>

              <div>
                <span>Merkle Root</span>
                <code title={data.fullModel.proofSet.merkleRoot}>
                  {shortenHash(
                    data.fullModel.proofSet.merkleRoot
                  )}
                </code>
              </div>

              <div>
                <span>Anchor ID</span>
                <code title={data.fullModel.proofSet.anchorId}>
                  {shortenHash(
                    data.fullModel.proofSet.anchorId
                  )}
                </code>
              </div>

              <div>
                <span>Transaction Hash</span>
                <code
                  title={
                    data.fullModel.blockchain.transactionHash
                  }
                >
                  {shortenHash(
                    data.fullModel.blockchain.transactionHash
                  )}
                </code>
              </div>

              <div>
                <span>Smart Contract</span>
                <code
                  title={
                    data.fullModel.blockchain.contractAddress
                  }
                >
                  {shortenHash(
                    data.fullModel.blockchain.contractAddress
                  )}
                </code>
              </div>
            </div>
          </div>

          <div className="cc-verify__notice">
            <strong>Verification scope:</strong>{" "}
            1,800 proofs were verified during a previous off-chain
            audit. This dashboard live-checks their proof-set
            anchor on a local blockchain; it does not reverify
            every Groth16 proof or prove clinical accuracy,
            authentic MRI training, or independent hospital
            key custody.
          </div>
        </>
      )}

      <div className="cc-verify__footer">
        Local research demonstration · Automatic check every 30 seconds
      </div>
    </section>
  );
}
