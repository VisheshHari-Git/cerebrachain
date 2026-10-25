import { jsPDF } from 'jspdf';

export interface TumorReportData {
  dimensions: readonly [number, number, number];
  voxelVolumeMm3: number | null;
  wholeTumor: number;
  tumorCore: number;
  enhancingTumor: number;
}

export function downloadAnalysisReport(data: TumorReportData): void {
  const {
    dimensions,
    voxelVolumeMm3,
    wholeTumor,
    tumorCore,
    enhancingTumor,
  } = data;

  const counts = [wholeTumor, tumorCore, enhancingTumor];

  if (
    counts.some(value => !Number.isSafeInteger(value) || value < 0) ||
    !(enhancingTumor <= tumorCore && tumorCore <= wholeTumor)
  ) {
    throw new Error('Invalid segmentation statistics.');
  }

  if (dimensions.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('Invalid MRI volume dimensions.');
  }

  const validVoxelVolume =
    voxelVolumeMm3 !== null &&
    Number.isFinite(voxelVolumeMm3) &&
    voxelVolumeMm3 > 0
      ? voxelVolumeMm3
      : null;

  const volumeText = (voxels: number): string =>
    validVoxelVolume === null
      ? 'Unavailable'
      : `${(voxels * validVoxelVolume / 1000).toFixed(3)} cm3`;

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const now = new Date();

  // Header
  doc.setFillColor(12, 22, 38);
  doc.rect(0, 0, 210, 49, 'F');

  doc.setTextColor(65, 220, 235);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('ZKP-CEREBRACHAIN', 16, 20);

  doc.setFontSize(12);
  doc.setTextColor(255, 255, 255);
  doc.text('AI Brain Tumor Analysis Report', 16, 30);

  doc.setFontSize(9);
  doc.setTextColor(255, 205, 110);
  doc.text('RESEARCH USE ONLY - NOT FOR CLINICAL DIAGNOSIS', 16, 40);

  // General information
  doc.setTextColor(35, 45, 60);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('1. Analysis Information', 16, 65);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  const info = [
    ['Model', 'Trained MONAI 3D U-Net'],
    ['MRI Modalities', 'FLAIR, T1, T1ce, T2'],
    ['Scan Dimensions', dimensions.join(' x ') + ' voxels'],
    [
      'Voxel Volume',
      validVoxelVolume === null
        ? 'Unavailable'
        : `${validVoxelVolume.toFixed(4)} mm3`,
    ],
    ['Generated', now.toLocaleString('en-IN')],
  ];

  let y = 75;

  for (const [label, value] of info) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, 17, y);

    doc.setFont('helvetica', 'normal');
    doc.text(value, 62, y);

    y += 9;
  }

  // Tumor statistics
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('2. AI-Predicted Tumor Statistics', 16, y);

  y += 12;

  const metrics = [
    {
      label: 'WHOLE TUMOR (WT)',
      count: wholeTumor,
      color: [6, 160, 185],
    },
    {
      label: 'TUMOR CORE (TC)',
      count: tumorCore,
      color: [215, 70, 95],
    },
    {
      label: 'ENHANCING TUMOR (ET)',
      count: enhancingTumor,
      color: [195, 140, 25],
    },
  ] as const;

  metrics.forEach((metric, index) => {
    const x = 16 + index * 61;

    doc.setFillColor(245, 248, 251);
    doc.setDrawColor(220, 228, 236);
    doc.roundedRect(x, y, 57, 40, 3, 3, 'FD');

    doc.setTextColor(metric.color[0], metric.color[1], metric.color[2]);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(metric.label, x + 4, y + 9);

    doc.setFontSize(12);
    doc.text(volumeText(metric.count), x + 4, y + 21);

    doc.setTextColor(90, 105, 120);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(
      `${metric.count.toLocaleString('en-IN')} voxels`,
      x + 4,
      y + 32
    );
  });

  y += 52;

  // Segmentation definitions
  doc.setTextColor(35, 45, 60);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('3. Segmentation Labels', 16, y);

  y += 11;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  [
    'Label 1: Necrotic / Non-enhancing Tumor',
    'Label 2: Peritumoral Edema',
    'Label 4: Enhancing Tumor',
    '',
    'Whole Tumor = Labels 1 + 2 + 4',
    'Tumor Core = Labels 1 + 4',
    'Enhancing Tumor = Label 4',
  ].forEach(line => {
    if (line) doc.text(line, 17, y);
    y += 6;
  });

  // Research disclaimer

  doc.setFillColor(255, 247, 228);
  doc.roundedRect(16, y, 178, 28, 3, 3, 'F');

  doc.setTextColor(130, 82, 25);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('IMPORTANT RESEARCH DISCLAIMER', 20, y + 8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  const disclaimer =
    'These measurements are derived from an AI-predicted segmentation. ' +
    'They are not independently clinically validated and must not be used ' +
    'for diagnosis or treatment decisions.';

  doc.text(doc.splitTextToSize(disclaimer, 166), 20, y + 15);

  // Footer
  doc.setDrawColor(210, 220, 230);
  doc.line(16, 282, 194, 282);

  doc.setFontSize(8);
  doc.setTextColor(115, 125, 140);
  doc.text('ZKP-CerebraChain | Research Prototype', 16, 288);
  doc.text('Page 1 of 1', 175, 288);

  // No patient names or original MRI images are embedded.
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '_');

  doc.save(`cerebrachain_analysis_${timestamp}.pdf`);
}
