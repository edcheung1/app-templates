export interface AppUploads {
  volume: string;
  path: string;
  maxFileSizeBytes: number;
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_LABEL = '5 GB';
export const UPLOAD_REFERENCE = /^upload:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function parseUploads(value: unknown): AppUploads | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('volume' in value) ||
    !('path' in value) ||
    !('maxFileSizeBytes' in value)
  )
    return undefined;
  if (typeof value.volume !== 'string' || typeof value.path !== 'string') return undefined;
  const names = value.volume.split('.');
  if (names.length !== 3 || !names.every((name) => /^[A-Za-z0-9_-]+$/.test(name))) return undefined;
  const root = `/Volumes/${names.join('/')}`;
  const managedRoot = /^designer_[A-Za-z0-9_-]+$/.test(names[2]) && value.path === root;
  const prefix = `${root}/designer_uploads/`;
  if (
    !managedRoot &&
    (!value.path.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value.path.slice(prefix.length)))
  )
    return undefined;
  if (
    typeof value.maxFileSizeBytes !== 'number' ||
    !Number.isSafeInteger(value.maxFileSizeBytes) ||
    value.maxFileSizeBytes <= 0 ||
    value.maxFileSizeBytes > MAX_UPLOAD_BYTES
  )
    return undefined;
  return { volume: value.volume, path: value.path, maxFileSizeBytes: value.maxFileSizeBytes };
}
