import { ApiError } from '@databricks/appkit';
import type { AppStorage } from '../shared/storageConfig';
import { UploadError, type UploadStore } from './fileUploads';
import { createUploadVolume, encodeStoragePath, parseStorageFileSize } from './storageVolume';

let storageVolume: string | undefined;
let cachedVolume: { path: string; promise: ReturnType<typeof createUploadVolume> } | undefined;

async function uploadVolume(config: AppStorage | undefined) {
  if (!config) throw new UploadError(409, 'File uploads are not configured.');
  if (storageVolume !== undefined && storageVolume !== config.volume)
    throw new UploadError(409, 'Published upload storage cannot be changed.');
  if (!cachedVolume || cachedVolume.path !== config.path) {
    storageVolume = config.volume;
    // Keep each policy bound to its request's manifest while republishing changes the prefix.
    const promise = createUploadVolume(config).catch((error) => {
      if (cachedVolume?.promise === promise) cachedVolume = undefined;
      throw error;
    });
    cachedVolume = { path: config.path, promise };
  }
  return cachedVolume.promise;
}

export function appKitUploadStore(config: AppStorage | undefined): UploadStore {
  const access = async <T>(operation: (volume: Awaited<ReturnType<typeof uploadVolume>>) => Promise<T>): Promise<T> => {
    try {
      return await operation(await uploadVolume(config));
    } catch (error) {
      if (error instanceof UploadError) throw error;
      const missing = error instanceof ApiError && error.statusCode === 404;
      throw new UploadError(
        missing ? 404 : 502,
        missing
          ? 'This upload is no longer available.'
          : 'Could not access upload storage. Check the app volume resource and permissions.',
        { cause: error },
      );
    }
  };
  return {
    mkdir: (path) => access((volume) => volume.createDirectory(encodeStoragePath(path))),
    put: (path, bytes) => access((volume) => volume.upload(encodeStoragePath(path), Buffer.from(bytes), { overwrite: false })),
    putStream: (path, stream) => access((volume) => volume.upload(encodeStoragePath(path), stream, { overwrite: false })),
    read: (path) =>
      access(async (volume) => {
        const contents = await volume.read(encodeStoragePath(path), { maxSize: 16 * 1024 });
        try {
          return JSON.parse(contents);
        } catch {
          throw new UploadError(409, 'The upload record is unreadable.');
        }
      }),
    size: (path) =>
      access(async (volume) => {
        const metadata = await volume.metadata(encodeStoragePath(path));
        return parseStorageFileSize(metadata.contentLength);
      }),
    delete: (path) => access((volume) => volume.delete(encodeStoragePath(path))),
  };
}
