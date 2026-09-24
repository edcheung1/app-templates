import { ApiError } from '@databricks/appkit';
import type { AppStorage } from '../shared/storageConfig';
import { createStorageVolume, encodeStoragePath, parseStorageFileSize } from './storageVolume';

export interface ExportStore {
  create(path: string, value: object): Promise<boolean>;
  write(path: string, value: object): Promise<void>;
  read(path: string): Promise<unknown>;
  size(path: string): Promise<number | undefined>;
  download(path: string): Promise<ReadableStream<Uint8Array>>;
}

const handles = new Map<string, ReturnType<typeof createStorageVolume>>();
let boundVolume: string | undefined;

const hasStatus = (error: unknown, status: number) => error instanceof ApiError && error.statusCode === status;

export function appKitExportStore(storage: AppStorage): ExportStore {
  const volume = async () => {
    if (boundVolume !== undefined && boundVolume !== storage.volume) throw new Error('The bound volume changed.');
    boundVolume = storage.volume;
    let handle = handles.get(storage.path);
    if (!handle) {
      handle = createStorageVolume(storage, 'exports').catch((error) => {
        handles.delete(storage.path);
        throw error;
      });
      handles.set(storage.path, handle);
    }
    return handle;
  };
  return {
    async create(path, value) {
      const handle = await volume();
      await handle.createDirectory(encodeStoragePath(path.slice(0, path.lastIndexOf('/'))));
      try {
        await handle.upload(encodeStoragePath(path), Buffer.from(JSON.stringify(value)), { overwrite: false });
        return true;
      } catch (error) {
        if (hasStatus(error, 409)) return false;
        throw error;
      }
    },
    async write(path, value) {
      const handle = await volume();
      await handle.createDirectory(encodeStoragePath(path.slice(0, path.lastIndexOf('/'))));
      await handle.upload(encodeStoragePath(path), Buffer.from(JSON.stringify(value)), { overwrite: true });
    },
    async read(path) {
      try {
        return JSON.parse(await (await volume()).read(encodeStoragePath(path), { maxSize: 64 * 1024 }));
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async size(path) {
      try {
        const metadata = await (await volume()).metadata(encodeStoragePath(path));
        return parseStorageFileSize(metadata.contentLength);
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async download(path) {
      const result = await (await volume()).download(encodeStoragePath(path));
      if (!result.contents) throw new Error('The export file has no readable contents.');
      return result.contents;
    },
  };
}
