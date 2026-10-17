import { useEffect, useState } from 'react';
import { Building2, Cpu, Diff, LockKeyhole, Merge, Globe, ShieldCheck, Stethoscope, PlayCircle, Workflow as WorkflowIcon } from 'lucide-react';
import { Button, DemoLabel, Section, SectionHeading } from './ui';

const steps = [
  [Building2, 'Hospital Nodes', 'Decentralized PACS clusters'], [Cpu, 'Local 3D U-Net', 'On-premise design target'],
  [Diff, 'Gradient ΔW', 'Weight delta vectors'], [LockKeyhole, 'ZK Generation', 'Groth16 SNARK prover'],
  [Merge, 'FedAvg Engine', 'Weighted aggregation'], [Globe, 'Global Model', 'Consensus weights'],
  [ShieldCheck, 'On-Chain Audit', 'Model hash ledger anchor'], [Stethoscope, 'Clinician DICOM', 'Integration planned'],
] as const;

export function Workflow() {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (step < 0) return;
    const timer = setTimeout(() => setStep(v => v === 7 ? -1 : v + 1), 650);
    return () => clearTimeout(timer);
  }, [step]);
  return <Section id="workflow">
    <SectionHeading eyebrow="END-TO-END CRYPTOGRAPHIC PIPELINE" title="System Architecture & Protocol Workflow" icon={WorkflowIcon}><Button disabled={step !== -1} onClick={() => setStep(0)}><PlayCircle size={15} />{step === -1 ? 'Simulate Protocol Workflow' : `Demo step ${step + 1} / 8`}</Button></SectionHeading>
    <div className="privacy-callout"><ShieldCheck size={18} className="text-primary-container shrink-0" /><p><strong>Privacy design:</strong> Patient MRI stays on hospital storage. This frontend preview does not upload or process patient scans; the workflow below is illustrative.</p><DemoLabel>COMPLIANCE NOT ASSESSED</DemoLabel></div>
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 pt-2" aria-label="Illustrative protocol workflow">{steps.map(([Icon, title, description], index) => <div key={title} className={`workflow-node ${step === index ? 'workflow-node-active' : ''}`} aria-current={step === index ? 'step' : undefined}><span className="eyebrow text-outline text-[10px]">NODE {String(index + 1).padStart(2, '0')}</span><p className={index === 3 ? 'text-secondary' : index > 4 ? 'text-tertiary-fixed-dim' : 'text-primary'}><Icon size={13} />{title}</p><small>{description}</small></div>)}</div>
    <span className="sr-only" role="status">{step < 0 ? 'Workflow simulation idle' : `Illustrative step ${step + 1}: ${steps[step][1]}`}</span>
  </Section>;
}
