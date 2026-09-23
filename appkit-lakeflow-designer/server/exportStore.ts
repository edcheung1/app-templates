import { ApiError, createApp, files } from '@databricks/appkit';
import type { AppStorage } from '../shared/storageConfig';

export interface ExportStore {
  create(path: string, value: object): Promise<boolean>;
  read(path: string): Promise<unknown>;
  remove(path: string): Promise<void>;
  size(path: string): Promise<number | undefined>;
  download(path: string): Promise<ReadableStream<Uint8Array>>;
}

const handles = new Map<string, ReturnType<typeof createExportVolume>>();
let boundVolume: string | undefined;

async function createExportVolume(storage: AppStorage) {
  process.env.DATABRICKS_VOLUME_FILES = `/Volumes/${storage.volume.replaceAll('.', '/')}`;
  const appkit = await createApp({
    plugins: [
      files({
        volumes: {
          files: {
            auth: 'service-principal',
            policy: (_action, resource, user) =>
              user.isServicePrincipal === true && resource.path.startsWith(`${storage.path}/exports/`),
          },
        },
      }),
    ],
  });
  return appkit.files('files');
}

const encoded = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const hasStatus = (error: unknown, status: number) => error instanceof ApiError && error.statusCode === status;

export function appKitExportStore(storage: AppStorage): ExportStore {
  const volume = async () => {
    if (boundVolume !== undefined && boundVolume !== storage.volume) throw new Error('The bound volume changed.');
    boundVolume = storage.volume;
    let handle = handles.get(storage.path);
    if (!handle) {
      handle = createExportVolume(storage).catch((error) => {
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
      await handle.createDirectory(encoded(path.slice(0, path.lastIndexOf('/'))));
      try {
        await handle.upload(encoded(path), Buffer.from(JSON.stringify(value)), { overwrite: false });
        return true;
      } catch (error) {
        if (hasStatus(error, 409)) return false;
        throw error;
      }
    },
    async read(path) {
      try {
        return JSON.parse(await (await volume()).read(encoded(path), { maxSize: 64 * 1024 }));
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async remove(path) {
      try {
        await (await volume()).delete(encoded(path));
      } catch (error) {
        if (!hasStatus(error, 404)) throw error;
      }
    },
    async size(path) {
      try {
        const metadata = await (await volume()).metadata(encoded(path));
        const size = Number(metadata.contentLength);
        return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async download(path) {
      const result = await (await volume()).download(encoded(path));
      if (!result.contents) throw new Error('The export file has no readable contents.');
      return result.contents;
    },
  };
}
