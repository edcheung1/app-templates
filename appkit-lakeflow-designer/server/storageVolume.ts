import { createApp, files } from '@databricks/appkit';
import type { AppStorage } from '../shared/storageConfig';

export async function createStorageVolume(storage: AppStorage, directory: 'uploads' | 'exports') {
  // The trusted manifest supplies the optional volume resource. Do not require it in app.yaml:
  // ordinary apps have no volume, and an existing app can enable uploads/exports on republish.
  process.env.DATABRICKS_VOLUME_FILES = `/Volumes/${storage.volume.replaceAll('.', '/')}`;
  // A backend-only AppKit instance has no server plugin, so generic /api/files routes cannot
  // bypass the viewer/parameter checks in the Designer routes.
  const appkit = await createApp({
    plugins: [
      files({
        volumes: {
          files: {
            auth: 'service-principal',
            policy: (_action, resource, user) =>
              user.isServicePrincipal === true && resource.path.startsWith(`${storage.path}/${directory}/`),
          },
        },
      }),
    ],
  });
  return appkit.files('files');
}

// AppKit 0.70 embeds paths directly in upload URLs; encode segments so filenames stay literal.
export const encodeStoragePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function parseStorageFileSize(contentLength: unknown): number | undefined {
  // The Files SDK reads Content-Length from an HTTP header, so it is a string at runtime even
  // though AppKit's FileMetadata type currently declares a number.
  const size = Number(contentLength);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}
