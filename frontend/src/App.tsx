import { useState } from 'react';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Workflow } from './components/Workflow';
import { Federation } from './components/Federation';
import { Workstation } from './components/Workstation';
import { ProofLab } from './components/ProofLab';
import { Ledger } from './components/Ledger';
import { Simulator } from './components/Simulator';
import { Modal } from './components/ui';
import { useTrust } from './lib/TrustContext';

export default function App() {
  const [dialog, setDialog] = useState<'status' | 'terminal' | 'docs' | null>(null);
  const { mode, state, error } = useTrust();
  return <>
    <div className="background-grid" aria-hidden="true" />
    <Header onInfo={setDialog} />
    <main id="main" className="dashboard-main" tabIndex={-1}>
      <Hero /><Workflow /><Federation /><Workstation /><ProofLab /><Ledger /><Simulator />
      <footer className="dashboard-footer"><p><span className="status-dot" />ZKP-CerebraChain Multi-Center Federation · Stitch React Preview</p><nav aria-label="Footer navigation"><button onClick={() => setDialog('docs')}>Documentation</button><a href="#zk-lab">Circom Circuits</a><a href="#ledger">Smart Contracts</a><a href="#fl-command">Hospital Network</a></nav></footer>
    </main>
    {dialog && <Modal title={dialog === 'terminal' ? 'Local development commands' : dialog === 'status' ? 'Connection status' : 'Frontend documentation'} onClose={() => setDialog(null)}>
      {dialog === 'terminal' ? <><p>Run from the project directory on Ubuntu with Node.js 22.12 or newer:</p><pre><code>{'cd frontend\nnpm install\nnpm run dev'}</code></pre><p>Development URL: <code>http://127.0.0.1:5173</code></p><p className="text-xs text-outline">Commands are shown for reference; this button does not execute a shell or start training.</p></> : dialog === 'status' ? <><dl className="detail-list"><dt>Data source</dt><dd>{mode === 'demo' ? 'Design demo · no API requests' : 'Existing trust-layer read API'}</dd><dt>API</dt><dd>{mode === 'demo' ? 'Not selected' : error || (state ? 'Connected' : 'Connecting')}</dd><dt>Blockchain</dt><dd>{mode === 'demo' ? 'Simulated' : state?.chain.enabled ? 'Backend reports connected' : state?.chain.error || 'Unavailable'}</dd><dt>MRI / 3D model</dt><dd>Not connected · illustrations only</dd></dl><p>Live mode polls <code>GET /api/state</code> through Vite’s proxy to <code>127.0.0.1:8787</code>. Configure a different existing backend with <code>TRUST_LAYER_URL</code>.</p></> : <><p>The original Stitch export is preserved in <code>stitch/</code>. This frontend reproduces its single-page sections using React and local font assets.</p><ul className="list-disc pl-5 my-4 space-y-2"><li>Use the navigation to jump between the exported sections.</li><li>Drag or pinch the illustrative brain, or use its camera buttons.</li><li>Switch modalities and adjust all three schematic mask opacities.</li><li>Select Live trust layer for backend-reported telemetry.</li><li>Proof animations and the workflow tour never run backend jobs.</li></ul><p>See <code>frontend/README.md</code> for setup, integration boundaries, and verification details.</p></>}
    </Modal>}
  </>;
}
