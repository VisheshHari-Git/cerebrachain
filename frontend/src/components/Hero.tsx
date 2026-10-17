import { lazy, Suspense, useState, Component, type ReactNode, type ErrorInfo } from 'react';
import { Brain, Box, Play, Hospital, RefreshCw, ShieldCheck, RotateCcw, ZoomIn, ZoomOut, MoveHorizontal, LoaderCircle } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { Button, DemoLabel, Section } from './ui';

const BrainCanvas = lazy(() => import('./BrainCanvas'));
export type BrainMode = 'tumor' | 'synapse' | 'weights';

function FallbackBrain() {
  return <div className="brain-fallback"><svg viewBox="0 0 400 400" role="img" aria-label="Static stylized brain illustration">
    <defs><radialGradient id="fallback-glow"><stop stopColor="#00e5ff" stopOpacity=".15" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0" /></radialGradient></defs>
    <circle cx="200" cy="200" r="180" fill="url(#fallback-glow)" />
    {[0, 1].map(i => <g key={i} transform={`translate(${i ? 202 : 84} 75)`} fill="none" stroke={i ? '#00e5ff' : '#8b5cf6'} strokeWidth="1.5"><path d="M56 0 C5 0 -28 65 -14 147 S27 257 56 242 C93 249 111 205 105 151 S124 25 56 0Z" />{Array.from({ length: 9 }, (_, n) => <path key={n} d={`M5 ${25 + n * 23} Q${n % 2 ? 106 : -25} ${n * 24} 92 ${49 + n * 21}`} opacity=".6" />)}</g>)}
  </svg><p>WebGL unavailable · Static illustration</p></div>;
}
class BrainBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* The accessible static viewer remains usable. */ }
  render() { return this.state.failed ? <FallbackBrain /> : this.props.children; }
}

export function Hero() {
  const [mode, setMode] = useState<BrainMode>('tumor');
  const [reset, setReset] = useState(0);
  const [gesture, setGesture] = useState({ kind: 'reset', sequence: 0 });
  const reduced = !!useReducedMotion();
  const command = (kind: string) => setGesture(g => ({ kind, sequence: g.sequence + 1 }));
  return <Section id="hero-studio" className="hero-panel">
    <div className="flex flex-wrap justify-between gap-4 mb-6"><span className="hero-tag"><Brain size={15} />NEXT-GENERATION FEDERATED NEURO-ONCOLOGY</span><DemoLabel>CONCEPT VISUALIZATION</DemoLabel></div>
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
      <div className="lg:col-span-5 space-y-6 min-w-0">
        <h1 className="font-display-lg text-headline-xl lg:text-display-lg text-primary tracking-tight leading-[1.1]">Intelligence Without Exposure.</h1>
        <p className="text-body-lg text-on-surface-variant leading-relaxed">Collaborative 3D U-Net Brain Tumor Segmentation powered by Federated Averaging, Zero-Knowledge Proofs, and Immutable Blockchain Verification. <span className="text-on-surface font-semibold underline decoration-primary-container underline-offset-4">Designed to keep raw patient MRI data inside hospital firewalls.</span></p>
        <div className="flex flex-wrap gap-4 pt-2"><a className="button button-primary hero-cta" href="#workstation"><Brain size={16} />Explore Diagnostic Studio</a><a className="button button-purple hero-cta" href="#simulator"><Play size={16} />Launch 9-Stage Simulation</a></div>
        <div className="grid grid-cols-3 gap-3 pt-4 border-t border-outline-variant/30">
          {[['LOCAL ENCLAVE', 'Design target'], ['PRIVACY BUDGET', 'Not assessed'], ['ZK CIRCUIT', 'BN254 Groth16']].map(([label, value], i) => <div key={label} className="spec-card"><span>{label}</span><strong className={i === 1 ? 'text-tertiary-fixed-dim' : i === 2 ? 'text-secondary' : 'text-primary'}>{value}</strong></div>)}
        </div>
      </div>
      <div className="lg:col-span-7 min-w-0">
        <div className="brain-viewport">
          <BrainBoundary><Suspense fallback={<div className="brain-loading"><LoaderCircle className="animate-spin" />Loading brain illustration…</div>}><BrainCanvas key={reset} mode={mode} reducedMotion={reduced} command={gesture} /></Suspense></BrainBoundary>
          <div className="brain-hud pointer-events-none"><p className="eyebrow border-b border-outline-variant/30 pb-2"><span className="status-dot" />VOLUMETRIC GLIOMA HUD <span className="text-tertiary-fixed-dim">DEMO</span></p><div className="space-y-1 mt-2">{[['Example core volume', '24.8 cm³'], ['Sample Dice score', '0.914'], ['Confidence', 'Not measured'], ['Voxel spacing', 'Illustrative']].map(([k, v]) => <p key={k} className="flex justify-between gap-4"><span>{k}</span><strong className="text-primary">{v}</strong></p>)}</div></div>
          <div className="brain-gestures"><MoveHorizontal size={12} /><span>Drag to rotate · Scroll / pinch to zoom</span></div>
          <div className="brain-controls">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Brain visualization mode">{([['tumor', 'Tumor Highlight'], ['synapse', 'Synaptic Pathways'], ['weights', 'Federated Weights']] as const).map(([key, label]) => <Button key={key} tone={mode === key ? 'primary' : 'default'} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</Button>)}</div>
            <div className="flex flex-wrap gap-1.5"><Button aria-label="Zoom in on brain" onClick={() => command('in')}><ZoomIn size={14} /></Button><Button aria-label="Zoom out of brain" onClick={() => command('out')}><ZoomOut size={14} /></Button><Button aria-label="Rotate brain right" onClick={() => command('rotate')}><RotateCcw size={14} /></Button><Button onClick={() => setReset(r => r + 1)}><RotateCcw size={12} />Reset Camera Orientation</Button></div>
          </div>
        </div>
      </div>
    </div>
    <div className="hero-counters">{[
      [Hospital, '3 Nodes', 'Sample: Johns Hopkins, Charité, Mayo'], [RefreshCw, 'Round #48', 'Demo FedAvg Global Epochs'],
      [Brain, '3D U-Net', 'Design target · Model integration pending'], [ShieldCheck, '144 Sample Proofs', 'Illustrative verification count'],
    ].map(([Icon, value, caption], i) => { const I = Icon as typeof Box; return <div key={i} className="counter-card"><div className={i === 1 ? 'text-secondary bg-secondary-container/20' : i > 1 ? 'text-tertiary-fixed-dim bg-tertiary-container/10' : 'text-primary-container bg-primary-container/10'}><I size={24} /></div><div><strong className={i === 3 ? 'text-tertiary-fixed-dim' : ''}>{value as string}</strong><p>{caption as string}</p></div></div>; })}</div>
  </Section>;
}
