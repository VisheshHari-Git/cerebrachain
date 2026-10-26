// Only the existing read API is used. No training, proof submission, or chain writes.
export interface Metrics { dice?: number; val_loss?: number; n?: number }
export interface Transaction { txHash?: string; gasUsed?: number; block?: number }
export interface Submission {
  hospitalId: number; status?: string; offchain?: string; onchain?: string;
  reason?: string; proofTx?: Transaction; verifyMs?: number;
}
export interface Hospital { id: number; name?: string; device?: string; numSamples?: number }
export interface Round {
  round: number; phase?: string; outcome?: string | null; globalModelHash?: string;
  newGlobalModelHash?: string; finalizedAt?: string; finalizeTx?: Transaction;
  submissions: Record<string, Submission>; metrics?: Record<string, Metrics>;
}
export interface TrustState {
  hospitals: Record<string, Hospital>; rounds: Record<string, Round>;
  chain: { enabled: boolean; chainId?: number; registry?: string; error?: string };
  zk: { chunkSize?: number; constraints?: number; ptauSource?: string };
  events: { t: string; level: string; msg: string }[];
  initialMetrics?: Record<string, Metrics>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optionalNumber = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));

export function parseState(value: unknown): TrustState {
  if (!record(value) || !record(value.hospitals) || !record(value.rounds) ||
      !record(value.chain) || typeof value.chain.enabled !== 'boolean' || !record(value.zk) || !Array.isArray(value.events)) {
    throw new Error('Unexpected trust-layer response. Check TRUST_LAYER_URL.');
  }
  for (const h of Object.values(value.hospitals)) {
    if (!record(h) || !Number.isInteger(h.id) || (h.name !== undefined && typeof h.name !== 'string') ||
        (h.device !== undefined && typeof h.device !== 'string') || !optionalNumber(h.numSamples)) throw new Error('Invalid hospital telemetry.');
  }
  for (const r of Object.values(value.rounds)) {
    if (!record(r) || !Number.isInteger(r.round) || !record(r.submissions)) throw new Error('Invalid round telemetry.');
    for (const s of Object.values(r.submissions)) {
      if (!record(s) || typeof s.hospitalId !== 'number' ||
          ['status', 'offchain', 'onchain', 'reason'].some(k => s[k] !== undefined && typeof s[k] !== 'string')) throw new Error('Invalid proof telemetry.');
    }
    if (r.metrics !== undefined && !record(r.metrics)) throw new Error('Invalid metric telemetry.');
    for (const m of Object.values((r.metrics || {}) as Record<string, unknown>)) {
      if (!record(m) || !optionalNumber(m.dice) || !optionalNumber(m.val_loss) || !optionalNumber(m.n) ||
          (typeof m.dice === 'number' && (m.dice < 0 || m.dice > 1))) throw new Error('Invalid metric telemetry.');
    }
    for (const key of ['phase', 'outcome', 'globalModelHash', 'newGlobalModelHash', 'finalizedAt']) {
      if (r[key] !== undefined && r[key] !== null && typeof r[key] !== 'string') throw new Error('Invalid round metadata.');
    }
    if (r.finalizeTx !== undefined && r.finalizeTx !== null && (!record(r.finalizeTx) || !optionalNumber(r.finalizeTx.block))) throw new Error('Invalid chain metadata.');
  }
  if (value.events.some(e => !record(e) || typeof e.t !== 'string' || typeof e.msg !== 'string' || typeof e.level !== 'string')) throw new Error('Invalid event telemetry.');
  if (['registry', 'error'].some(k => value.chain && record(value.chain) && value.chain[k] !== undefined && typeof value.chain[k] !== 'string')) throw new Error('Invalid chain telemetry.');
  if (!optionalNumber(value.zk.constraints) || !optionalNumber(value.zk.chunkSize)) throw new Error('Invalid circuit metadata.');
  return value as unknown as TrustState;
}

export async function fetchState(signal: AbortSignal): Promise<TrustState> {
  const response = await fetch('/api/state', { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Trust layer returned HTTP ${response.status}.`);
  try { return parseState(await response.json()); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Trust layer did not return JSON. Check the API proxy.');
    throw error;
  }
}

export const sortedRounds = (state: TrustState) => Object.values(state.rounds).sort((a, b) => a.round - b.round);
export const formatMetric = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';

// Hospital-reported values are kept separate; never invent a global metric by
// averaging patient/slice Dice values with unknown validation sample weights.
export function hospitalSeries(state: TrustState, hospitalId: number, key: 'dice' | 'val_loss') {
  return sortedRounds(state).map(r => ({ round: r.round, value: r.metrics?.[String(hospitalId)]?.[key] }));
}
