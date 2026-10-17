import { useEffect, useState } from 'react';
import { Box, Network, LockKeyhole, GitBranch, FastForward, RefreshCw, ShieldCheck, Terminal, Menu, X, FlaskConical } from 'lucide-react';
import { useTrust } from '../lib/TrustContext';
import { sortedRounds } from '../lib/trust';
import { Button } from './ui';

const links = [
  ['hero-studio', '3D Diagnostic', Box], ['fl-command', 'FL Command', Network],
  ['zk-lab', 'ZK Lab', LockKeyhole], ['ledger', 'Ledger', GitBranch], ['simulator', 'Simulator', FastForward],
] as const;

export function Header({ onInfo }: { onInfo: (kind: 'status' | 'terminal') => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState('hero-studio');
  const { mode, setMode, state, error, loading, updated, refresh } = useTrust();
  const round = state ? sortedRounds(state).at(-1)?.round : undefined;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: '-100px 0px -45% 0px', threshold: [0, 0.1, 0.5] });
    links.forEach(([id]) => { const target = document.getElementById(id); if (target) observer.observe(target); });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  return <>
    <a href="#main" className="skip-link">Skip to dashboard</a>
    <aside className="telemetry-bar">
      <div className="flex flex-wrap items-center gap-3">
        <span className="status-pill text-primary"><span className="status-dot" />{mode === 'demo' ? 'DESIGN DEMO' : state?.chain.enabled ? `CHAIN ${state.chain.chainId ?? 'CONNECTED'}` : 'CHAIN OFFLINE'}</span>
        <span className="status-pill text-tertiary-fixed-dim"><ShieldCheck size={13} />{mode === 'demo' ? 'ZK VERIFIER: SIMULATED' : state ? 'TRUST API: CONNECTED' : 'TRUST API: UNAVAILABLE'}</span>
        <span className="status-pill hidden md:inline-flex"><RefreshCw size={12} className="text-secondary" />{mode === 'demo' ? 'DEMO ROUND #48' : `ROUND ${round === undefined ? '—' : `#${round}`}`}</span>
      </div>
      <span className="research-tag">RESEARCH USE ONLY (RUO)</span>
    </aside>
    <header className="site-header">
      <div className="header-row">
        <a href="#hero-studio" aria-label="ZKP-CerebraChain home" className="brand"><span className="brand-icon"><Network size={21} /></span><span>ZKP-CerebraChain</span><small className="hidden xl:inline-block">STITCH PREVIEW</small></a>
        <nav className="desktop-nav" aria-label="Main navigation">{links.map(([id, name, Icon]) => <a key={id} href={`#${id}`} aria-current={active === id ? 'location' : undefined} onClick={() => setActive(id)}><Icon size={13} />{name}</a>)}</nav>
        <div className="flex items-center gap-2">
          <Button tone="primary" className="hidden sm:inline-flex" disabled={mode === 'demo' || loading} onClick={refresh} title={mode === 'demo' ? 'Select Live trust layer to refresh real telemetry' : 'Read trust-layer telemetry'}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />Refresh Telemetry</Button>
          <div className="profile-pill hidden sm:flex" title="Sample Stitch profile; authentication is not connected"><span>VC</span><div className="hidden xl:block"><p>Dr. V. Chen</p><small>Sample profile</small></div></div>
          <Button aria-label="Connection status" title="Connection status" className="icon-button" onClick={() => onInfo('status')}><ShieldCheck size={17} /></Button>
          <Button aria-label="CLI instructions" title="CLI instructions" className="icon-button hidden sm:inline-flex" onClick={() => onInfo('terminal')}><Terminal size={17} /></Button>
          <Button aria-label={open ? 'Close navigation' : 'Open navigation'} aria-controls="mobile-navigation" aria-expanded={open} className="mobile-toggle icon-button" onClick={() => setOpen(!open)}>{open ? <X size={20} /> : <Menu size={20} />}</Button>
        </div>
      </div>
      {open && <nav id="mobile-navigation" className="mobile-nav" aria-label="Mobile navigation">{links.map(([id, name, Icon]) => <a key={id} href={`#${id}`} onClick={() => { setActive(id); setOpen(false); }} aria-current={active === id ? 'location' : undefined}><Icon size={16} />{name}</a>)}</nav>}
    </header>
    <div className="connection-bar">
      <p className="flex items-center gap-2"><FlaskConical size={14} className="shrink-0 text-amber-300" /><span>{mode === 'demo' ? 'Demo data throughout · Illustrations, not patient scans or AI predictions.' : 'Live hospital, proof and ledger telemetry · Brain, MRI panes and simulator remain illustrations.'}</span></p>
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <label htmlFor="data-source" className="sr-only">Telemetry data source</label>
        <select id="data-source" value={mode} onChange={e => setMode(e.target.value as 'demo' | 'live')}><option value="demo">Design demo</option><option value="live">Live trust layer</option></select>
        {mode === 'live' && <span className={error ? 'text-error' : 'text-tertiary-fixed-dim'} role="status">{loading ? 'Connecting…' : error ? 'API unavailable' : updated ? `Read ${updated}` : 'Waiting…'}</span>}
      </div>
      {mode === 'live' && error && <p className="w-full text-error" role="alert">{error} Start your existing trust layer or check the proxy target. <button className="underline" onClick={refresh}>Retry connection</button></p>}
    </div>
  </>;
}
