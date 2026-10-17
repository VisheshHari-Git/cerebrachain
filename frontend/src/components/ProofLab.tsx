import { useEffect, useState } from 'react';
import { LockKeyhole, Hash, Cpu, ShieldCheck, CircleCheck, LoaderCircle } from 'lucide-react';
import { useTrust } from '../lib/TrustContext';
import { sortedRounds } from '../lib/trust';
import { Button, DemoLabel, Empty, Modal, Section, SectionHeading } from './ui';

const proofSteps = [
  [Hash, 'Poseidon Delta Commitment', 'Commitments bind each model update to a round, hospital and model context.'],
  [Cpu, 'Groth16 Proof Circuit', 'The existing UpdateChunk circuit checks bounded quantized update chunks. This does not establish clinical accuracy or absence of poisoning.'],
  [ShieldCheck, 'On-Chain Pairing Verification', 'The existing backend can submit proof bundles to its registry. This UI reads recorded outcomes and never submits a transaction.'],
] as const;

export function ProofLab() {
  const { mode, state } = useTrust();
  const [demo, setDemo] = useState<'idle' | 'generating' | 'generated' | 'verifying' | 'verified'>('idle');
  const [inspect, setInspect] = useState(false);
  useEffect(() => {
    if (demo !== 'generating' && demo !== 'verifying') return;
    const timer = setTimeout(() => setDemo(d => d === 'generating' ? 'generated' : 'verified'), 1200);
    return () => clearTimeout(timer);
  }, [demo]);
  useEffect(() => { setDemo('idle'); }, [mode]);
  const busy = demo === 'generating' || demo === 'verifying';
  const latest = state ? sortedRounds(state).at(-1) : undefined;
  const submissions = latest ? Object.values(latest.submissions) : [];
  return <Section id="zk-lab">
    <SectionHeading eyebrow="NON-INTERACTIVE ZERO-KNOWLEDGE PROOF (NIZKP) ENGINE" title="Zero-Knowledge Verification Lab" icon={LockKeyhole} green><div className="flex flex-wrap gap-2"><Button tone="purple" disabled={mode !== 'demo' || busy} onClick={() => setDemo('generating')}>Simulate Proof Generation</Button><Button tone="green" disabled={mode !== 'demo' || busy || !['generated', 'verified'].includes(demo)} onClick={() => setDemo('verifying')}>Simulate On-Chain Check</Button><Button onClick={() => setInspect(true)}>Inspect Circom Constraints</Button></div></SectionHeading>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{proofSteps.map(([Icon, title, description], i) => <article key={title} className="proof-step"><div className="flex justify-between items-center"><span className={`font-label-sm text-xs font-bold ${i === 1 ? 'text-secondary' : i === 2 ? 'text-tertiary-fixed-dim' : 'text-primary'}`}>STEP 0{i + 1}</span><Icon size={16} /></div><h3>{title}</h3><p>{description}</p><div className="proof-meta">{mode === 'demo' ? ['Demo commitment · not a proof', 'Circuit metadata: not connected', 'Simulation · no gas spent'][i] : i === 1 ? `Reported constraints: ${state?.zk.constraints?.toLocaleString() ?? '—'}` : i === 0 ? `Round: ${latest?.round ?? '—'}` : `Blockchain: ${state?.chain.enabled ? 'backend connected' : 'disabled / unavailable'}`}</div></article>)}</div>
    <div className="proof-status" role="status">
      {mode === 'demo' ? <><div className="flex gap-3 items-center"><span className="proof-status-icon">{busy ? <LoaderCircle size={24} className="animate-spin" /> : <CircleCheck size={24} />}</span><div><p className="font-headline-sm font-bold text-sm text-tertiary-fixed-dim">{({ idle: 'DEMO READY · No proof generated or verified', generating: 'DEMO · Illustrating constraint evaluation…', generated: 'DEMO · Proof generation animation complete', verifying: 'DEMO · Illustrating pairing verification…', verified: 'DEMO · Verification animation complete' })[demo]}</p><p className="font-label-sm text-xs text-on-surface-variant mt-1">No cryptographic proof, smart contract call, or blockchain transaction is produced.</p></div></div><DemoLabel>SIMULATION ONLY</DemoLabel></> : <div className="w-full"><p className="eyebrow text-tertiary-fixed-dim mb-3">BACKEND-REPORTED PROOF OUTCOMES {latest ? `· ROUND ${latest.round}` : ''}</p>{!submissions.length ? <Empty>No proof submissions reported.</Empty> : <ul className="space-y-2">{submissions.map(s => <li className="font-label-sm text-xs break-words" key={s.hospitalId}>Hospital {s.hospitalId} · off-chain: <strong>{s.offchain || 'not reported'}</strong> · on-chain: <strong>{s.onchain || 'not reported'}</strong>{s.reason ? ` · ${s.reason}` : ''}</li>)}</ul>}<p className="text-xs text-outline mt-3">These are API-reported statuses; this browser does not independently verify proofs.</p></div>}
    </div>
    {inspect && <Modal title="Circom constraints" onClose={() => setInspect(false)}><p>The existing circuit is <code>zk/circuits/update_chunk.circom</code>. It binds update chunks to the protocol context and checks public polynomial evaluations and squared-norm bounds.</p><dl className="detail-list"><dt>Source</dt><dd>{mode === 'live' ? 'Live trust-layer metadata' : 'Design demo; API not selected'}</dd><dt>Chunk size</dt><dd>{mode === 'live' ? state?.zk.chunkSize ?? 'Unavailable' : 'Not connected'}</dd><dt>Constraints</dt><dd>{mode === 'live' ? state?.zk.constraints?.toLocaleString() ?? 'Unavailable' : 'Not connected'}</dd></dl><p className="text-xs text-outline">An accepted bounded update does not prove model convergence, diagnostic quality, differential privacy, or resistance to every poisoning attack.</p></Modal>}
  </Section>;
}
