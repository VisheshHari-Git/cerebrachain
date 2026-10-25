import { RealMriViewer } from './RealMriViewer';
import { useEffect, useState, type FormEvent } from 'react';

const modalities = [
  { key: 'flair', label: 'FLAIR MRI' },
  { key: 't1', label: 'T1 MRI' },
  { key: 't1ce', label: 'T1ce MRI' },
  { key: 't2', label: 'T2 MRI' },
] as const;

type Modality = (typeof modalities)[number]['key'];
type MRIFileMap = Record<Modality, File | null>;

const MAX_SIZE = 64 * 1024 * 1024;

export function RealMriUpload() {
  const [files, setFiles] = useState<MRIFileMap>({
    flair: null,
    t1: null,
    t1ce: null,
    t2: null,
  });

  const [viewModality, setViewModality] = useState<Modality>('flair');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [prediction, setPrediction] = useState<Blob | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!prediction) {
      setDownloadUrl(null);
      return;
    }

    const url = URL.createObjectURL(prediction);
    setDownloadUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [prediction]);

  function selectFile(modality: Modality, file: File | null) {
    setError('');
    setPrediction(null);

    if (file) {
      if (!file.name.toLowerCase().endsWith('.nii.gz')) {
        setError(`${modality.toUpperCase()}: Only .nii.gz files are supported.`);
        return;
      }

      if (file.size === 0 || file.size > MAX_SIZE) {
        setError(`${modality.toUpperCase()}: File must be between 1 byte and 64 MiB.`);
        return;
      }
    }

    setFiles(previous => ({
      ...previous,
      [modality]: file,
    }));
  }

  async function runPrediction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (loading) return;

    setError('');
    setPrediction(null);

    const formData = new FormData();

    for (const modality of modalities) {
      const file = files[modality.key];

      if (!file) {
        setError(`Please select ${modality.label}.`);
        return;
      }

      formData.append(modality.key, file);
    }

    setLoading(true);

    try {
      const response = await fetch('/mri-api/real/predict', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);

        const detail =
          typeof body?.detail === 'string'
            ? body.detail
            : `API request failed: HTTP ${response.status}`;

        throw new Error(detail);
      }

      const result = await response.blob();

      const signature = new Uint8Array(
        await result.slice(0, 2).arrayBuffer()
      );

      if (signature[0] !== 0x1f || signature[1] !== 0x8b) {
        throw new Error('Server did not return a valid gzip file.');
      }

      setPrediction(result);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'MRI prediction failed.'
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-outline-variant/30 p-5 space-y-5">

      <div>
        <h3 className="text-xl font-bold text-on-surface">
          Real MRI Analysis
        </h3>

        <p className="text-sm text-on-surface-variant mt-2">
          Upload four aligned BraTS MRI modalities to run
          the trained 3D U-Net segmentation model.
        </p>
      </div>

      <form onSubmit={runPrediction} className="space-y-5">

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {modalities.map(modality => (
            <div key={modality.key} className="space-y-2">

              <label
                htmlFor={`real-mri-${modality.key}`}
                className="block font-semibold text-sm"
              >
                {modality.label}
              </label>

              <input
                id={`real-mri-${modality.key}`}
                type="file"
                accept=".nii.gz"
                disabled={loading}
                onChange={event =>
                  selectFile(
                    modality.key,
                    event.target.files?.[0] ?? null
                  )
                }
                className="block w-full text-sm"
              />

              {files[modality.key] && (
                <p className="text-xs text-on-surface-variant break-all">
                  Selected: {files[modality.key]?.name}
                </p>
              )}

            </div>
          ))}

        </div>

        <button
          type="submit"
          disabled={
            loading ||
            modalities.some(modality => !files[modality.key])
          }
          className="rounded-lg bg-cyan-600 px-5 py-3 text-white font-semibold disabled:opacity-50"
        >
          {loading ? 'Running 3D U-Net...' : 'Run MRI Segmentation'}
        </button>

      </form>

      {loading && (
        <p role="status" className="text-sm">
          Processing MRI volumes. Keep this page open.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      {downloadUrl && (
        <div className="space-y-3">
          <p role="status" className="text-green-400 font-semibold">
            Segmentation completed successfully.
          </p>

          <a
            href={downloadUrl}
            download="tumor_mask.nii.gz"
            className="inline-block rounded-lg bg-green-700 px-5 py-3 text-white"
          >
            Download Tumor Segmentation
          </a>
        </div>
      )}

      {prediction && files[viewModality] && (
        <div className="mt-6 space-y-4">

          <div className="space-y-2">
            <label
              htmlFor="real-mri-view-modality"
              className="block text-sm font-semibold text-on-surface"
            >
              MRI Viewing Modality
            </label>

            <select
              id="real-mri-view-modality"
              value={viewModality}
              onChange={event =>
                setViewModality(event.target.value as Modality)
              }
              className="rounded-lg border border-cyan-500/40 bg-slate-900 px-4 py-3 text-white"
            >
              {modalities.map(modality => (
                <option key={modality.key} value={modality.key}>
                  {modality.label}
                </option>
              ))}
            </select>

            <p className="text-xs text-on-surface-variant">
              Switching modalities keeps the same predicted segmentation.
            </p>
          </div>

          <RealMriViewer
            mri={files[viewModality]!}
            mask={prediction}
          />

        </div>
      )}

      <p className="text-xs text-on-surface-variant">
        RESEARCH USE ONLY. Not intended for clinical diagnosis.
        Do not upload identifiable patient records.
      </p>

    </div>
  );
}
