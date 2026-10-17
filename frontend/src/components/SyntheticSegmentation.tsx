import { useEffect, useState } from 'react';

type Plane = 'AXIAL' | 'CORONAL' | 'SAGITTAL';

type DemoPrediction = {
  status: string;
  mode: string;
  is_real_patient_data: boolean;
  is_trained_model: boolean;
  model: string;
  segmentation_shape: number[];
  segmented_voxels: number;
  slice_index: number;
  segmentation_volume: number[][][];
  mri_volume: number[][][];
  disclaimer: string;
};

export function SyntheticSegmentation({ opacity }: { opacity: number }) {
  const [data, setData] = useState<DemoPrediction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [plane, setPlane] = useState<Plane>('AXIAL');
  const [sliceIndex, setSliceIndex] = useState(4);

  useEffect(() => {
    const controller = new AbortController();

    async function loadPrediction() {
      try {
        const response = await fetch('/mri-api/demo/predict', {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`MRI API returned HTTP ${response.status}`);
        }

        const result: DemoPrediction = await response.json();

        const [depth, height, width] = result.segmentation_shape ?? [];

        const validVolume =
          depth === 8 &&
          height === 16 &&
          width === 16 &&
          Array.isArray(result.segmentation_volume) &&
          result.segmentation_volume.length === depth &&
          result.segmentation_volume.every(
            layer =>
              Array.isArray(layer) &&
              layer.length === height &&
              layer.every(
                row =>
                  Array.isArray(row) &&
                  row.length === width &&
                  row.every(value => value === 0 || value === 1)
              )
          );

        const validMRI =
          Array.isArray(result.mri_volume) &&
          result.mri_volume.length === depth &&
          result.mri_volume.every(
            layer =>
              Array.isArray(layer) &&
              layer.length === height &&
              layer.every(
                row =>
                  Array.isArray(row) &&
                  row.length === width &&
                  row.every(
                    value =>
                      typeof value === 'number' &&
                      Number.isFinite(value) &&
                      value >= 0 &&
                      value <= 1
                  )
              )
          );

        if (
          result.status !== 'success' ||
          result.mode !== 'synthetic_demo' ||
          result.is_real_patient_data !== false ||
          result.is_trained_model !== false ||
          !validVolume ||
          !validMRI
        ) {
          throw new Error('Unexpected synthetic 3D MRI API response');
        }

        if (!controller.signal.aborted) {
          setData(result);
          setSliceIndex(result.slice_index);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Unknown API error');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadPrediction();
    return () => controller.abort();
  }, []);

  const volume = data?.segmentation_volume;

  const [depth, height, width] = data?.segmentation_shape ?? [0, 0, 0];

  const maxIndex =
    plane === 'AXIAL'
      ? depth - 1
      : plane === 'CORONAL'
        ? height - 1
        : width - 1;

  const safeIndex = Math.min(sliceIndex, Math.max(maxIndex, 0));

  const currentSlice: number[][] = volume
    ? plane === 'AXIAL'
      ? volume[safeIndex]
      : plane === 'CORONAL'
        ? volume.map(layer => layer[safeIndex])
        : volume.map(layer => layer.map(row => row[safeIndex]))
    : [];

  const mriVolume = data?.mri_volume;

  const currentMRISlice: number[][] = mriVolume
    ? plane === 'AXIAL'
      ? mriVolume[safeIndex]
      : plane === 'CORONAL'
        ? mriVolume.map(layer => layer[safeIndex])
        : mriVolume.map(layer => layer.map(row => row[safeIndex]))
    : [];

  const rows = currentSlice.length;
  const columns = currentSlice[0]?.length ?? 0;

  function changePlane(nextPlane: Plane) {
    setPlane(nextPlane);

    if (!data) return;

    const dimensions = data.segmentation_shape;
    const size =
      nextPlane === 'AXIAL'
        ? dimensions[0]
        : nextPlane === 'CORONAL'
          ? dimensions[1]
          : dimensions[2];

    setSliceIndex(Math.floor(size / 2));
  }

  return (
    <div className="rounded-xl border border-cyan-500/30 bg-slate-950/70 p-5">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-cyan-300">
          Interactive Synthetic 3D Segmentation
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Live FastAPI response · Synthetic data · Untrained test model
        </p>
      </div>

      {loading && (
        <p role="status" className="text-sm text-slate-300">
          Loading synthetic segmentation...
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-400">
          MRI API Error: {error}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['AXIAL', 'CORONAL', 'SAGITTAL'] as Plane[]).map(item => (
              <button
                key={item}
                type="button"
                onClick={() => changePlane(item)}
                aria-pressed={plane === item}
                className={
                  plane === item
                    ? 'rounded border border-cyan-400 bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950'
                    : 'rounded border border-slate-600 px-3 py-2 text-xs text-slate-300'
                }
              >
                {item}
              </button>
            ))}
          </div>

          <div className="flex flex-col items-start gap-5 sm:flex-row">
            <div
              className="grid w-64 max-w-full border border-slate-700 bg-slate-900"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                aspectRatio: `${columns} / ${rows}`,
              }}
              role="img"
              aria-label={`${plane} synthetic segmentation slice ${safeIndex}`}
            >
              {currentSlice.flat().map((value, index) => {
                const row = Math.floor(index / columns);
                const col = index % columns;
                const intensity = currentMRISlice[row]?.[col] ?? 0;

                // Increase contrast for the synthetic grayscale image.
                const gray = Math.round(
                  Math.min(1, Math.max(0, intensity * 2.4)) * 220
                );

                const maskAlpha = (opacity / 100) * 0.8;

                return (
                  <div
                    key={index}
                    style={{
                      backgroundColor: `rgb(${gray}, ${gray}, ${gray})`,
                      backgroundImage: value === 1
                        ? `linear-gradient(
                            rgba(34, 211, 238, ${maskAlpha}),
                            rgba(34, 211, 238, ${maskAlpha})
                          )`
                        : undefined,
                    }}
                  />
                );
              })}
            </div>

            <div className="space-y-3 text-sm text-slate-300">
              <p><strong>API:</strong> Connected</p>
              <p>
                <strong>Volume:</strong>{' '}
                {data.segmentation_shape.join(' × ')}
              </p>
              <p><strong>Plane:</strong> {plane}</p>
              <p>
                <strong>Slice:</strong> {safeIndex + 1} / {maxIndex + 1}
              </p>
              <p>
                <strong>Segmented voxels:</strong> {data.segmented_voxels}
              </p>
              <p className="text-xs text-amber-300">
                {data.disclaimer}
              </p>
            </div>
          </div>

          <div className="max-w-md space-y-2">
            <label
              htmlFor="synthetic-slice-slider"
              className="block text-xs font-semibold text-cyan-300"
            >
              Slice Navigation: {safeIndex + 1} / {maxIndex + 1}
            </label>
            <input
              id="synthetic-slice-slider"
              type="range"
              min={0}
              max={maxIndex}
              step={1}
              value={safeIndex}
              onChange={event => setSliceIndex(Number(event.target.value))}
              className="w-full"
            />
          </div>

          <p className="text-xs text-slate-400">
            Demo array-axis views only. Anatomical orientation is not validated.
          </p>
        </div>
      )}
    </div>
  );
}
