import { useEffect, useMemo, useRef, useState } from 'react';
import { readNiftiVolume, type NiftiVolume } from '../lib/niftiVolume';

type PlaneAxis = 0 | 1 | 2;

interface RealMriViewerProps {
  mri: Blob;
  mask: Blob;
}

const planes = [
  { key: 'axial', label: 'AXIAL', axis: 2 },
  { key: 'sagittal', label: 'SAGITTAL', axis: 0 },
  { key: 'coronal', label: 'CORONAL', axis: 1 },
] as const;

type PlaneKey = (typeof planes)[number]['key'];

const tumorColors: Record<number, [number, number, number]> = {
  1: [251, 113, 133],
  2: [34, 211, 238],
  4: [250, 204, 21],
};

function calculateWindow(
  volume: NiftiVolume
): [number, number] {
  const [dx, dy, dz] = volume.dims;
  const count = dx * dy * dz;
  const stride = Math.max(1, Math.floor(count / 50000));

  const values: number[] = [];

  for (let index = 0; index < count; index += stride) {
    const z = Math.floor(index / (dx * dy));
    const remainder = index % (dx * dy);
    const y = Math.floor(remainder / dx);
    const x = remainder % dx;

    const value = volume.getVoxel(x, y, z);

    if (Number.isFinite(value) && value !== 0) {
      values.push(value);
    }
  }

  if (values.length === 0) {
    return [0, 1];
  }

  values.sort((a, b) => a - b);

  const low = values[Math.floor(values.length * 0.01)];
  const high = values[Math.floor(values.length * 0.99)];

  return [low, high > low ? high : low + 1];
}

interface SliceCanvasProps {
  mri: NiftiVolume;
  mask: NiftiVolume;
  axis: PlaneAxis;
  slice: number;
  opacity: number;
  window: [number, number];
}

function SliceCanvas({
  mri,
  mask,
  axis,
  slice,
  opacity,
  window,
}: SliceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [dx, dy, dz] = mri.dims;

  const width = axis === 0 ? dy : dx;
  const height = axis === 2 ? dy : dz;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');

    if (!canvas || !context) return;

    const pixels = context.createImageData(width, height);
    const [low, high] = window;
    const range = high - low;
    const overlayAlpha = (opacity / 100) * 0.7;

    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        let x = u;
        let y = u;
        let z = slice;

        if (axis === 2) {
          x = u;
          y = v;
          z = slice;
        } else if (axis === 0) {
          x = slice;
          y = u;
          z = height - 1 - v;
        } else {
          x = u;
          y = slice;
          z = height - 1 - v;
        }

        const intensity = mri.getVoxel(x, y, z);

        const normalized = Number.isFinite(intensity)
          ? (intensity - low) / range
          : 0;

        const gray = Math.round(
          255 * Math.max(0, Math.min(1, normalized))
        );

        const label = mask.getVoxel(x, y, z);
        const color = tumorColors[label];

        const pixelIndex = (v * width + u) * 4;

        if (color) {
          pixels.data[pixelIndex] = Math.round(
            gray * (1 - overlayAlpha) + color[0] * overlayAlpha
          );

          pixels.data[pixelIndex + 1] = Math.round(
            gray * (1 - overlayAlpha) + color[1] * overlayAlpha
          );

          pixels.data[pixelIndex + 2] = Math.round(
            gray * (1 - overlayAlpha) + color[2] * overlayAlpha
          );
        } else {
          pixels.data[pixelIndex] = gray;
          pixels.data[pixelIndex + 1] = gray;
          pixels.data[pixelIndex + 2] = gray;
        }

        pixels.data[pixelIndex + 3] = 255;
      }
    }

    context.putImageData(pixels, 0, 0);
  }, [mri, mask, axis, slice, opacity, window, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="w-full max-h-[300px] rounded-lg object-contain bg-black"
      style={{ imageRendering: 'pixelated' }}
      role="img"
      aria-label="Real MRI slice with predicted tumor segmentation overlay"
    />
  );
}

export function RealMriViewer({
  mri,
  mask,
}: RealMriViewerProps) {
  const [volumes, setVolumes] = useState<{
    mri: NiftiVolume;
    mask: NiftiVolume;
  } | null>(null);

  const [error, setError] = useState('');
  const [opacity, setOpacity] = useState(65);

  const [slices, setSlices] = useState<Record<PlaneKey, number>>({
    axial: 0,
    sagittal: 0,
    coronal: 0,
  });

  useEffect(() => {
    let cancelled = false;

    setVolumes(null);
    setError('');

    async function loadVolumes() {
      try {
        const [mriVolume, maskVolume] = await Promise.all([
          readNiftiVolume(mri),
          readNiftiVolume(mask),
        ]);

        const sameDimensions = mriVolume.dims.every(
          (dimension, index) =>
            dimension === maskVolume.dims[index]
        );

        if (!sameDimensions) {
          throw new Error(
            'MRI and segmentation dimensions do not match.'
          );
        }

        if (cancelled) return;

        const [dx, dy, dz] = mriVolume.dims;

        setSlices({
          axial: Math.floor(dz / 2),
          sagittal: Math.floor(dx / 2),
          coronal: Math.floor(dy / 2),
        });

        setVolumes({
          mri: mriVolume,
          mask: maskVolume,
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Unable to load MRI volumes.'
          );
        }
      }
    }

    void loadVolumes();

    return () => {
      cancelled = true;
    };
  }, [mri, mask]);

  const window = useMemo(
    () => volumes ? calculateWindow(volumes.mri) : [0, 1] as [number, number],
    [volumes]
  );

  // Calculate tumor regions from the actual predicted segmentation.
  const tumorStats = useMemo(() => {
    if (!volumes) return null;

    const maskVolume = volumes.mask;
    const [dx, dy, dz] = maskVolume.dims;

    let wholeTumor = 0;
    let tumorCore = 0;
    let enhancingTumor = 0;

    for (let z = 0; z < dz; z++) {
      for (let y = 0; y < dy; y++) {
        for (let x = 0; x < dx; x++) {
          const label = maskVolume.getVoxel(x, y, z);

          if (label === 1 || label === 2 || label === 4) {
            wholeTumor++;
          }

          if (label === 1 || label === 4) {
            tumorCore++;
          }

          if (label === 4) {
            enhancingTumor++;
          }
        }
      }
    }

    return {
      wholeTumor,
      tumorCore,
      enhancingTumor,
      voxelVolumeMm3: maskVolume.voxelVolumeMm3,
    };
  }, [volumes]);

  if (error) {
    return (
      <p role="alert" className="text-red-400 text-sm">
        MRI Viewer Error: {error}
      </p>
    );
  }

  if (!volumes) {
    return (
      <p role="status" className="text-sm text-on-surface-variant">
        Loading real MRI volumes...
      </p>
    );
  }

  return (
    <div className="space-y-5 rounded-xl border border-cyan-500/30 p-5">

      <div className="space-y-2">
        <h3 className="text-xl font-bold text-on-surface">
          Real MRI Tumor Visualization
        </h3>

        <p className="text-xs text-on-surface-variant">
          Volume dimensions: {volumes.mri.dims.join(' × ')} voxels
        </p>
      </div>

      {/* Dynamic AI-predicted tumor volume statistics */}
      {tumorStats && (
        <div className="space-y-3">

          <h4 className="text-sm font-semibold text-on-surface">
            AI-Predicted Tumor Statistics
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                label: 'WHOLE TUMOR (WT)',
                voxels: tumorStats.wholeTumor,
                color: 'text-cyan-400',
              },
              {
                label: 'TUMOR CORE (TC)',
                voxels: tumorStats.tumorCore,
                color: 'text-rose-400',
              },
              {
                label: 'ENHANCING TUMOR (ET)',
                voxels: tumorStats.enhancingTumor,
                color: 'text-amber-300',
              },
            ].map(metric => (
              <div
                key={metric.label}
                className="rounded-xl border border-outline-variant/30 bg-slate-900/40 p-4"
              >
                <p className="text-xs text-on-surface-variant">
                  {metric.label}
                </p>

                <p className={`mt-2 text-2xl font-bold ${metric.color}`}>
                  {tumorStats.voxelVolumeMm3 === null
                    ? 'Unavailable'
                    : `${(
                        metric.voxels *
                        tumorStats.voxelVolumeMm3 /
                        1000
                      ).toFixed(3)} cm³`}
                </p>

                <p className="mt-2 text-xs text-on-surface-variant">
                  {metric.voxels.toLocaleString()} voxels
                </p>
              </div>
            ))}
          </div>

          <p className="text-xs text-on-surface-variant">
            Volumes are calculated from the AI-predicted segmentation.
            Measurements are for research use only.
          </p>

        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {planes.map(plane => {
          const maximum = volumes.mri.dims[plane.axis] - 1;
          const slice = Math.min(slices[plane.key], maximum);

          return (
            <div key={plane.key} className="space-y-3">

              <div className="flex justify-between text-sm">
                <strong className="text-cyan-400">
                  {plane.label}
                </strong>

                <span className="text-on-surface-variant">
                  Slice {slice + 1} / {maximum + 1}
                </span>
              </div>

              <SliceCanvas
                mri={volumes.mri}
                mask={volumes.mask}
                axis={plane.axis}
                slice={slice}
                opacity={opacity}
                window={window}
              />

              <input
                type="range"
                min={0}
                max={maximum}
                value={slice}
                aria-label={`${plane.label} slice`}
                onChange={event => {
                  const value = Number(event.target.value);

                  setSlices(previous => ({
                    ...previous,
                    [plane.key]: value,
                  }));
                }}
                className="w-full"
              />

            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <label htmlFor="real-mask-opacity">
            Predicted Tumor Mask Opacity
          </label>

          <span>{opacity}%</span>
        </div>

        <input
          id="real-mask-opacity"
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={event => setOpacity(Number(event.target.value))}
          className="w-full"
        />
      </div>

      <div className="flex flex-wrap gap-4 text-xs">
        <span className="text-rose-400">
          ● Label 1: Necrotic / Non-enhancing Core
        </span>

        <span className="text-cyan-400">
          ● Label 2: Edema
        </span>

        <span className="text-amber-300">
          ● Label 4: Enhancing Tumor
        </span>
      </div>

      <p className="text-xs text-on-surface-variant">
        RESEARCH USE ONLY — Voxel-axis visualization.
        Anatomical orientation and spatial alignment require
        additional affine validation. Not for clinical diagnosis.
      </p>

    </div>
  );
}
