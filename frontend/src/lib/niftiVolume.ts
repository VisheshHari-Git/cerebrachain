import * as nifti from 'nifti-reader-js';

export type VolumeDimensions = [number, number, number];

export interface NiftiVolume {
  dims: VolumeDimensions;
  datatype: number;
  voxelVolumeMm3: number | null;
  getVoxel: (x: number, y: number, z: number) => number;
}

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

const BYTE_SIZES: Record<number, number> = {
  2: 1,    // uint8
  4: 2,    // int16
  8: 4,    // int32
  16: 4,   // float32
  64: 8,   // float64
  256: 1,  // int8
  512: 2,  // uint16
  768: 4,  // uint32
};

export async function readNiftiVolume(
  file: Blob
): Promise<NiftiVolume> {

  if (file.size === 0 || file.size > MAX_COMPRESSED_BYTES) {
    throw new Error('NIfTI file size must be between 1 byte and 64 MiB.');
  }

  const compressed = await file.arrayBuffer();

  const decompressed = nifti.isCompressed(compressed)
    ? nifti.decompress(compressed)
    : compressed;

  // Ensure compatibility with APIs requiring ArrayBuffer.
  let buffer: ArrayBuffer;

  if (decompressed instanceof ArrayBuffer) {
    buffer = decompressed;
  } else {
    buffer = new ArrayBuffer(decompressed.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(decompressed));
  }

  if (buffer.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new Error('Decompressed NIfTI volume is too large.');
  }

  if (!nifti.isNIFTI(buffer)) {
    throw new Error('Invalid NIfTI file.');
  }

  const header = nifti.readHeader(buffer);

  // Physical voxel volume from the NIfTI affine matrix.
  const a = header.affine;

  const determinant =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);

  const spatialUnits = Number(header.xyzt_units) & 0x07;

  // Convert spatial coordinates into millimeters.
  const millimetersPerUnit =
    spatialUnits === 2 ? 1 :
    spatialUnits === 1 ? 1000 :
    spatialUnits === 3 ? 0.001 :
    null;

  const computedVolume =
    millimetersPerUnit === null
      ? null
      : Math.abs(determinant) * millimetersPerUnit ** 3;

  const voxelVolumeMm3 =
    computedVolume !== null &&
    Number.isFinite(computedVolume) &&
    computedVolume > 0
      ? computedVolume
      : null;

  const dims = header.dims.slice(1, 4).map(Number) as VolumeDimensions;

  if (
    dims.length !== 3 ||
    dims.some(d => !Number.isSafeInteger(d) || d <= 0)
  ) {
    throw new Error('Invalid 3D MRI dimensions.');
  }

  const datatype = Number(header.datatypeCode);
  const bytesPerVoxel = BYTE_SIZES[datatype];

  if (!bytesPerVoxel) {
    throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  const voxelCount = dims[0] * dims[1] * dims[2];

  if (!Number.isSafeInteger(voxelCount)) {
    throw new Error('Invalid MRI volume size.');
  }

  const image = nifti.readImage(header, buffer);
  const data = new DataView(image);

  if (voxelCount * bytesPerVoxel > data.byteLength) {
    throw new Error('MRI image data is incomplete.');
  }

  const littleEndian = header.littleEndian;

  const slope = Number(header.scl_slope);
  const intercept = Number(header.scl_inter);

  function getVoxel(x: number, y: number, z: number): number {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(z) ||
      x < 0 || y < 0 || z < 0 ||
      x >= dims[0] ||
      y >= dims[1] ||
      z >= dims[2]
    ) {
      return 0;
    }

    const index = x + dims[0] * (y + dims[1] * z);
    const offset = index * bytesPerVoxel;

    let value: number;

    switch (datatype) {
      case 2:
        value = data.getUint8(offset);
        break;
      case 4:
        value = data.getInt16(offset, littleEndian);
        break;
      case 8:
        value = data.getInt32(offset, littleEndian);
        break;
      case 16:
        value = data.getFloat32(offset, littleEndian);
        break;
      case 64:
        value = data.getFloat64(offset, littleEndian);
        break;
      case 256:
        value = data.getInt8(offset);
        break;
      case 512:
        value = data.getUint16(offset, littleEndian);
        break;
      case 768:
        value = data.getUint32(offset, littleEndian);
        break;
      default:
        return 0;
    }

    if (Number.isFinite(slope) && slope !== 0) {
      value = value * slope + (Number.isFinite(intercept) ? intercept : 0);
    }

    return value;
  }

  return {
    dims,
    datatype,
    voxelVolumeMm3,
    getVoxel,
  };
}
