import { SyntheticSegmentation } from './SyntheticSegmentation';
import { RealMriUpload } from './RealMriUpload';
import { useId, useState } from 'react';
import { Box, Droplets, TriangleAlert } from 'lucide-react';
import { Button, DemoLabel, Metric, Section, SectionHeading } from './ui';

const modalities = ['T1-weighted', 'T1ce (Contrast)', 'T2', 'FLAIR'];
const planes = ['AXIAL', 'SAGITTAL', 'CORONAL'];
function SlicePane({ plane, opacity, modality }: { plane: number; opacity: number; modality: number }) {
  const id = useId();
  const color = ['#00e5ff', '#d0bcff', '#00e1a4'][plane];
  const slice = [84, 92, 76][plane];
  const shapes = ['M130 36 C65 33 27 92 29 162 C31 222 67 260 130 262 C198 260 228 218 230 158 C232 88 192 37 130 36Z', 'M43 70 C111 17 231 67 237 143 C242 209 170 244 107 221 C96 260 74 245 69 215 C19 203 10 118 43 70Z', 'M127 39 C67 31 20 102 32 181 C37 235 85 261 127 245 C173 261 220 233 225 179 C237 100 188 32 127 39Z'];
  return <div className="slice-pane"><div className="slice-label"><strong style={{ color }}>{planes[plane]}</strong><span>#{slice} / 155</span></div>{plane === 0 && <span className="slice-zoom">ZOOM 1.4x</span>}
    <svg viewBox="0 0 260 300" className="slice-drawing" role="img" aria-label={`${planes[plane]} ${modalities[modality]} schematic, illustrative mask opacity ${opacity}%`}>
      <defs><linearGradient id={id} x2="1" y2="1"><stop stopColor={['#11192d', '#172137', '#132b39', '#28213f'][modality]} /><stop offset="1" stopColor="#0a0f1c" /></linearGradient></defs>
      <path d={shapes[plane]} fill={`url(#${id})`} stroke="#3b494c" strokeOpacity=".5" />
      {plane === 0 ? <ellipse cx="130" cy="150" rx="29" ry="53" fill="none" stroke="#849396" opacity=".2" /> : plane === 1 ? <ellipse cx="70" cy="213" rx="32" ry="24" fill="none" stroke="#849396" opacity=".2" /> : <path d="M127 40V245" stroke="#849396" opacity=".2" />}
      <g opacity={opacity / 100} data-testid={`mask-${plane}`}>
        <rect x={plane === 1 ? 100 : 133} y={plane === 1 ? 103 : 114} width={plane === 0 ? 72 : 58} height={plane === 0 ? 72 : 58} rx="13" fill="#00e5ff" fillOpacity=".25" stroke="#00e5ff" strokeWidth="2" />
        <rect x={plane === 1 ? 111 : 145} y={plane === 1 ? 114 : 126} width={plane === 0 ? 48 : 35} height={plane === 0 ? 48 : 35} rx="11" fill="#fbbf24" fillOpacity=".35" stroke="#fbbf24" />
        {plane !== 1 && <rect x="157" y="138" width="24" height="24" rx="8" fill="#f43f5e" fillOpacity=".55" stroke="#fb7185" />}
      </g>
      <path d="M29 150H231M130 36V262" stroke={color} strokeWidth=".7" opacity=".3" />
      <path d="M8 285H32" stroke="#849396" strokeWidth="2" /><text x="38" y="288" fill="#849396" fontSize="8" fontFamily="monospace">10 mm · schematic scale</text>
    </svg>
    <div className="slice-caption">{plane === 0 ? <><span>Whole Tumor: <b className="text-primary">Cyan</b></span><span>Enhancing: <b className="text-amber-300">Amber</b></span><span>Core: <b className="text-rose-400">Coral</b></span></> : <><span>{plane === 1 ? 'Sagittal Plane Alignment' : 'Coronal Symmetry Metric'}</span><strong style={{ color }}>{plane === 1 ? 'Rot: 0.0°' : 'Demo only'}</strong></>}</div>
  </div>;
}
export function Workstation() {
  const [modality, setModality] = useState(1);
  const [opacity, setOpacity] = useState(85);
  return <Section id="workstation">
    <SectionHeading eyebrow="MULTI-PLANAR RECONSTRUCTION (MPR)" title="Diagnostic Volumetric Workstation" icon={Box}><div role="group" aria-label="MRI modality" className="modality-tabs">{modalities.map((label, index) => <Button key={label} tone={modality === index ? 'primary' : 'default'} aria-pressed={modality === index} onClick={() => setModality(index)}>{label}</Button>)}</div></SectionHeading>
    <RealMriUpload />
    <div className="flex flex-wrap gap-3 items-center"><DemoLabel>SCHEMATIC MRI PANES</DemoLabel><p className="text-xs text-on-surface-variant">Illustrations from the Stitch design · No scan loaded · No AI inference performed</p></div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{planes.map((plane, i) => <SlicePane key={plane} plane={i} opacity={opacity} modality={modality} />)}</div>
    <SyntheticSegmentation opacity={opacity} />
    <div className="workstation-controls"><div className="lg:col-span-5 space-y-3"><label htmlFor="mask-opacity" className="flex items-center justify-between font-label-sm text-xs gap-3"><span className="flex items-center gap-1.5"><Droplets size={14} className="text-primary" />Tumor Mask Opacity Control</span><output htmlFor="mask-opacity" className="text-primary font-bold">{opacity}%</output></label><input id="mask-opacity" type="range" min="0" max="100" value={opacity} onChange={e => setOpacity(Number(e.target.value))} /></div><div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-3 lg:border-l border-outline-variant/30 lg:pl-6"><Metric label="INFERENCE TIME" value="Not run" /><Metric label="MODEL ARCH" value="3D U-Net target" color="text-on-surface" /><Metric label="SAMPLE VOLUME" value="Not measured" /><Metric label="HAUSDORFF95" value="Not measured" color="text-tertiary-fixed-dim" /></div></div>
    <div className="research-notice"><TriangleAlert size={14} className="shrink-0" /><span>RESEARCH USE ONLY · DEMONSTRATION GEOMETRY · NOT A MEDICAL PREDICTION OR VALIDATED CLINICAL WORKSTATION.</span></div>
  </Section>;
}
