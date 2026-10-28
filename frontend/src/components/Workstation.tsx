import { RealMriUpload } from './RealMriUpload';
import { Box, TriangleAlert } from 'lucide-react';
import { Section, SectionHeading } from './ui';

export function Workstation() {
  return (
    <Section id="workstation">
      <SectionHeading
        eyebrow="MRI ANALYSIS · RESEARCH PROTOTYPE"
        title="Diagnostic Volumetric Workstation"
        icon={Box}
      >
        <span className="text-xs text-on-surface-variant">
          MRI upload and research analysis
        </span>
      </SectionHeading>

      <RealMriUpload />

      <div className="research-notice">
        <TriangleAlert size={14} className="shrink-0" />
        <span>
          RESEARCH USE ONLY · NOT A MEDICAL PREDICTION
          OR VALIDATED CLINICAL WORKSTATION.
        </span>
      </div>
    </Section>
  );
}
