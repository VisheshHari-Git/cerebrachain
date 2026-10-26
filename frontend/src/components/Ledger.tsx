import { useEffect, useState } from 'react';
import { GitBranch, Copy, Check } from 'lucide-react';
import { useTrust } from '../lib/TrustContext';
import { sortedRounds } from '../lib/trust';
import { Button, DemoLabel, Empty, Section, SectionHeading } from './ui';

const short = (v: string | null | undefined) => v ? `${v.slice(0, 10)}…${v.slice(-6)}` : 'Not reported';
const sampleRoots = Array.from({ length: 5 }, (_, i) => `0x${(i + 44).toString(16).padStart(2, '0').repeat(32)}`);
export function Ledger() {
  const { mode, state } = useTrust();
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState<'idle' | 'success' | 'error'>('idle');
  const rounds = state ? sortedRounds(state).slice(-5) : [];
  const blocks = mode === 'demo' ? sampleRoots.map((root, i) => ({ round: 44 + i, block: 1489201 + i, root, status: 'Illustrative anchor' })) : rounds.map(r => ({ round: r.round, block: r.finalizeTx?.block, root: r.newGlobalModelHash, status: r.finalizeTx ? 'Backend-reported transaction' : 'No finalization transaction' }));
  const block = blocks.find(b => b.round === selected) || blocks.at(-1);
  const root = block?.root;
  useEffect(() => { setSelected(null); setCopied('idle'); }, [mode]);
  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    if (!root) return;
    try { await navigator.clipboard.writeText(root); setCopied('success'); }
    catch { setCopied('error'); }
  }
  return <Section id="ledger">
    <SectionHeading eyebrow="DECENTRALIZED MODEL LEDGER" title="Block Explorer & Model Weight Anchors" icon={GitBranch}>{mode === 'demo' ? <DemoLabel>SAMPLE BLOCKS & HASHES</DemoLabel> : <span className="font-label-sm text-xs text-on-surface-variant">{state?.chain.enabled ? `Backend chain ${state.chain.chainId ?? ''}` : 'Blockchain disabled / unavailable'}</span>}</SectionHeading>
    {!blocks.length && <Empty>No recorded rounds or model anchors available.</Empty>}
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">{blocks.map((b, i) => <button key={b.round} onClick={() => { setSelected(b.round); setCopied('idle'); }} aria-pressed={block?.round === b.round} className={`ledger-block ${block?.round === b.round ? 'ledger-block-active' : ''}`}>
      {i === blocks.length - 1 && <span className="latest-label">LATEST</span>}<span className="font-label-sm text-xs font-bold text-primary">{b.block === undefined ? 'NO CHAIN BLOCK' : `BLOCK #${b.block}`}</span><span className="font-label-sm text-[11px] text-on-surface-variant">Round: <strong>#{b.round}</strong></span><span className="font-label-sm text-[10px] text-outline truncate w-full" title={b.root}>Hash: {short(b.root)}</span><span className="font-label-sm text-[10px] text-tertiary-fixed-dim">{b.status}</span>
    </button>)}</div>
    <div className="hash-details"><div className="space-y-2 min-w-0"><p><span className="text-outline">{mode === 'demo' ? 'Sample Model Hash: ' : 'Global Model Hash: '}</span><code className="text-primary select-all break-all" data-testid="model-hash">{root || 'Not available'}</code></p><p><span className="text-outline">Registry Contract: </span><code className="select-all break-all">{mode === 'demo' ? 'Not connected · demonstration ledger' : state?.chain.registry || 'Not reported'}</code></p></div><Button onClick={() => void copy()} disabled={!root}>{copied === 'success' ? <Check size={14} /> : <Copy size={14} />}{copied === 'success' ? 'Hash Copied!' : 'Copy Model Hash'}</Button><p className="w-full" role="status">{copied === 'error' ? 'Clipboard unavailable. Select and copy the full hash above.' : copied === 'success' ? 'The displayed model hash was copied.' : ''}</p></div>
  </Section>;
}
