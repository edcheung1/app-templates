import { ApiError, createApp, files } from '@databricks/appkit';
import type { AppUploads } from '../shared/uploadConfig';
import { UploadError, type UploadStore } from './fileUploads';

const VOLUME_KEY = 'files';
let storagePath: string | undefined;
let volumePromise: ReturnType<typeof createUploadVolume> | undefined;

async function createUploadVolume(config: AppUploads) {
  // The trusted manifest supplies the optional volume resource. Do not require it in app.yaml:
  // ordinary apps have no volume, and an existing app can enable uploads on republish.
  process.env.DATABRICKS_VOLUME_FILES = `/Volumes/${config.volume.replaceAll('.', '/')}`;
  // A backend-only AppKit instance deliberately has no server plugin, so generic /api/files
  // routes cannot bypass the viewer/parameter checks in the Designer routes.
  const appkit = await createApp({
    plugins: [
      files({
        volumes: {
          [VOLUME_KEY]: {
            auth: 'service-principal',
            policy: (_action, resource, user) =>
              user.isServicePrincipal === true && resource.path.startsWith(`${config.path}/`),
          },
        },
      }),
    ],
  });
  return appkit.files(VOLUME_KEY);
}

async function uploadVolume(config: AppUploads | undefined) {
  if (!config) throw new UploadError(409, 'File uploads are not configured.');
  if (storagePath !== undefined && storagePath !== config.path)
    throw new UploadError(409, 'Published upload storage cannot be changed.');
  if (!volumePromise) {
    storagePath = config.path;
    volumePromise = createUploadVolume(config).catch((error) => {
      volumePromise = undefined;
      throw error;
    });
  }
  return volumePromise;
}

// AppKit 0.70 embeds paths directly in upload URLs; encode segments so filenames stay literal.
const pluginPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function appKitUploadStore(config: AppUploads | undefined): UploadStore {
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
    mkdir: (path) => access((volume) => volume.createDirectory(pluginPath(path))),
    put: (path, bytes) => access((volume) => volume.upload(pluginPath(path), Buffer.from(bytes), { overwrite: false })),
    read: (path) =>
      access(async (volume) => {
        const contents = await volume.read(pluginPath(path), { maxSize: 16 * 1024 });
        try {
          return JSON.parse(contents);
        } catch {
          throw new UploadError(409, 'The upload record is unreadable.');
        }
      }),
    size: (path) =>
      access(async (volume) => {
        // The Files SDK reads Content-Length from an HTTP header, so it is a string at runtime even
        // though AppKit's FileMetadata type currently declares a number.
        const contentLength: unknown = (await volume.metadata(pluginPath(path))).contentLength;
        if (contentLength === undefined) return undefined;
        const size = typeof contentLength === 'number' ? contentLength : Number(contentLength);
        return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
      }),
    list: async function* (path) {
      for (const entry of await access((volume) => volume.list(pluginPath(path)))) {
        if (!entry.is_directory && entry.name) yield entry.name;
      }
    },
    delete: (path) => access((volume) => volume.delete(pluginPath(path))),
  };
}
