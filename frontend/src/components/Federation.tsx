import { useEffect, useState } from 'react';
import { Network, Play, Pause, Redo, Circle } from 'lucide-react';
import { useTrust } from '../lib/TrustContext';
import { formatMetric, hospitalSeries, sortedRounds, type TrustState } from '../lib/trust';
import { Button, DemoLabel, Empty, Metric } from './ui';

const samples = [
  { id: 0, name: 'Johns Hopkins Medical Center', initials: 'JH', device: 'US-EAST-01 · 8x NVIDIA A100 80GB', dice: 0.918, loss: 0.038, batch: '32 BraTS vol', status: 'Training (Round 48)', progress: 88 },
  { id: 1, name: 'Charité Universitätsmedizin Berlin', initials: 'CB', device: 'EU-CENTRAL-02 · 4x NVIDIA H100 80GB', dice: 0.909, loss: 0.042, batch: '48 BraTS vol', status: 'Generating ZK Proof', progress: 72 },
  { id: 2, name: 'Mayo Clinic Neuro-Oncology', initials: 'MC', device: 'US-MIDWEST-03 · 8x NVIDIA A100 80GB', dice: 0.915, loss: 0.041, batch: '36 BraTS vol', status: 'Syncing Weights', progress: 94 },
];
const colors = ['#00e5ff', '#d0bcff', '#00e1a4'];
function HospitalCards({ state }: { state: TrustState | null }) {
  const latest = state ? sortedRounds(state).at(-1) : undefined;
  const hospitals = state ? Object.values(state.hospitals).map(h => {
    const metric = latest?.metrics?.[h.id];
    return { id: h.id, name: h.name || `Hospital ${h.id}`, initials: `H${h.id}`, device: h.device || 'Device not reported', dice: metric?.dice, loss: metric?.val_loss, batch: h.numSamples === undefined ? '—' : `${h.numSamples} slices`, status: latest?.submissions[h.id]?.status || 'Registered', progress: null };
  }) : samples;
  return <div className="space-y-3">{hospitals.length === 0 && <Empty>No hospitals registered in the trust layer.</Empty>}{hospitals.map((h, i) => <article key={h.id} className="hospital-card" style={{ '--node-color': colors[i % colors.length] } as React.CSSProperties}>
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-3 min-w-0"><span className="hospital-avatar">{h.initials}</span><div className="min-w-0"><h3 className="font-headline-sm text-sm font-semibold">{h.name}</h3><p className="font-label-sm text-[11px] text-outline break-words">{h.device}</p></div></div><span className="hospital-status"><Circle size={6} fill="currentColor" />{state ? h.status : `Demo: ${h.status}`}</span></div>
    <div className="grid grid-cols-3 gap-2"><Metric label={state ? 'VAL LOSS' : 'LOCAL LOSS'} value={formatMetric(h.loss)} /><Metric label="DICE SCORE" value={formatMetric(h.dice)} color="text-tertiary-fixed-dim" /><Metric label={state ? 'TRAIN SLICES' : 'BATCH SIZE'} value={h.batch} color="text-on-surface" /></div>
    {h.progress !== null && <div className="hospital-progress" aria-hidden="true"><div style={{ width: `${h.progress}%` }} /></div>}
  </article>)}</div>;
}

function Chart({ series, kind }: { series: { name: string; values: (number | undefined)[] }[]; kind: 'dice' | 'loss' }) {
  const max = kind === 'dice' ? 1 : Math.max(0.1, ...series.flatMap(s => s.values.filter((v): v is number => typeof v === 'number')));
  const n = Math.max(2, ...series.map(s => s.values.length));
  const lineColor = (index: number) => kind === 'loss' && series.length === 1 ? '#d0bcff' : colors[index % 3];
  const y = (v: number) => 75 - (v / max) * 65;
  return <div className={`chart chart-${kind}`}><svg viewBox="0 0 300 85" preserveAspectRatio="none" role="img" aria-label={`${kind === 'dice' ? 'Dice' : 'Loss'} values by round; gaps indicate missing metrics`}>
    <defs><linearGradient id={`chart-${kind}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={kind === 'dice' ? '#00e5ff' : '#d0bcff'} stopOpacity=".25" /><stop offset="100%" stopColor="transparent" /></linearGradient></defs>
    {[10, 42, 75].map(v => <line key={v} x1="0" x2="300" y1={v} y2={v} stroke="#3b494c" strokeOpacity=".25" />)}
    {series.map((s, index) => {
      // Start a fresh path after a missing value, rather than inventing continuity.
      let previous = false;
      const d = s.values.map((value, i) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) { previous = false; return ''; }
        const command = previous ? 'L' : 'M'; previous = true;
        return `${command}${(i / (n - 1)) * 300},${y(value)}`;
      }).join(' ');
      return <g key={s.name}><path d={d} fill="none" stroke={lineColor(index)} strokeWidth="2" />{s.values.map((value, i) => typeof value === 'number' ? <circle key={i} cx={(i / (n - 1)) * 300} cy={y(value)} r="1.8" fill={lineColor(index)}><title>{s.name}: {formatMetric(value)}</title></circle> : null)}</g>;
    })}
  </svg><div className="chart-axis"><span>{max.toFixed(kind === 'dice' ? 0 : 2)}</span><span>0</span></div></div>;
}

export function Federation() {
  const { mode, state } = useTrust();
  const [running, setRunning] = useState(false);
  const [round, setRound] = useState(48);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    if (mode !== 'demo') setRunning(false);
  }, [mode]);
  useEffect(() => {
    if (!running || mode !== 'demo') return;
    const timer = setInterval(() => setRound(r => r >= 48 ? 40 : r + 1), 2000 / speed);
    return () => clearInterval(timer);
  }, [running, speed, mode]);
  const hospitals = state ? Object.values(state.hospitals) : [];
  const selectedId = hospitals.some(h => String(h.id) === selected) ? Number(selected) : hospitals[0]?.id;
  const liveValues = (key: 'dice' | 'val_loss') => state && selectedId !== undefined ? hospitalSeries(state, selectedId, key).map(p => p.value) : [];
  const demoDice = [0.72, 0.745, 0.79, 0.838, 0.868, 0.88, 0.886, 0.898, 0.914];
  const demoLoss = [0.482, 0.35, 0.24, 0.16, 0.1, 0.07, 0.058, 0.045, 0.04];
  const dice = mode === 'demo' ? demoDice.slice(0, 1 + Math.min(8, round - 40)) : liveValues('dice');
  const loss = mode === 'demo' ? demoLoss.slice(0, 1 + Math.min(8, round - 40)) : liveValues('val_loss');
  const seriesName = mode === 'demo' ? 'Sample global metric' : hospitals.find(h => h.id === selectedId)?.name || 'Hospital';
  return <section id="fl-command" className="grid grid-cols-1 lg:grid-cols-12 gap-6 scroll-mt-28">
    <div className="panel lg:col-span-7 min-w-0"><div className="section-heading"><div><p className="eyebrow text-primary"><span className="status-dot" />FEDERATED COHORT TELEMETRY</p><h2 className="text-headline-md">Participating Hospital Enclaves</h2></div>{mode === 'demo' ? <DemoLabel>3 SAMPLE NODES</DemoLabel> : <span className="status-pill">{state ? hospitals.length : '—'} Registered Nodes</span>}</div>
      {mode === 'live' && !state ? <Empty>No live hospital telemetry available.</Empty> : <HospitalCards state={mode === 'live' ? state : null} />}
    </div>
    <div className="panel lg:col-span-5 flex flex-col justify-between gap-6 min-w-0"><div><div className="section-heading"><div><p className="eyebrow text-primary"><Network size={14} />CENTRAL AGGREGATOR ENGINE</p><h2 className="text-headline-md">FedAvg Consensus State</h2></div>{mode === 'demo' && <div className="flex gap-1 items-center text-xs font-label-sm"><span className="text-outline">Speed:</span>{[1, 2, 5].map(s => <button key={s} className={`speed-button ${speed === s ? 'speed-active' : ''}`} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}x</button>)}</div>}</div>
      {mode === 'demo' ? <div className="flex items-center justify-between gap-2 mb-4"><DemoLabel>SAMPLE CURVES</DemoLabel><span className="font-label-sm text-xs text-primary" role="status">Demo round #{round}{running ? ' · Running' : ' · Paused'}</span></div> : <div className="mb-4"><label htmlFor="chart-hospital" className="eyebrow text-outline mb-2">Hospital-reported validation metrics</label><select id="chart-hospital" value={selectedId ?? ''} onChange={e => setSelected(e.target.value)} disabled={!hospitals.length}>{!hospitals.length && <option value="">No hospitals</option>}{hospitals.map(h => <option key={h.id} value={h.id}>{h.name || `Hospital ${h.id}`}</option>)}</select><p className="font-label-sm text-[10px] text-outline mt-2">Per hospital, per round. No global Dice is inferred.</p></div>}
      <div className="space-y-4">{([['dice', dice], ['loss', loss]] as const).map(([key, values]) => <div key={key}><div className="flex justify-between gap-2 font-label-sm text-xs mb-2"><span>{key === 'dice' ? mode === 'demo' ? 'Sample Global Dice vs Epochs' : 'Reported Dice vs Rounds' : 'Validation Loss vs Rounds'}</span><strong className={key === 'dice' ? 'text-tertiary-fixed-dim' : 'text-secondary'}>{formatMetric(values.at(-1))}</strong></div>{values.some(v => typeof v === 'number') ? <Chart kind={key} series={[{ name: seriesName, values: [...values] }]} /> : <Empty>No {key} measurements reported.</Empty>}</div>)}</div>
    </div><div className="pt-4 border-t border-outline-variant/30 flex flex-wrap justify-between gap-3"><div className="flex gap-2"><Button tone="primary" disabled={mode !== 'demo'} onClick={() => setRunning(true)}><Play size={13} />Start Simulation</Button><Button disabled={mode !== 'demo'} onClick={() => setRunning(false)}><Pause size={13} />Pause</Button></div><Button disabled={mode !== 'demo'} onClick={() => setRound(r => r >= 48 ? 40 : r + 1)}>Next Round (+1)<Redo size={13} /></Button>{mode === 'live' && <p className="font-label-sm text-[10px] text-outline">Read-only connection. Training is controlled by the existing backend CLI.</p>}</div></div>
  </section>;
}
