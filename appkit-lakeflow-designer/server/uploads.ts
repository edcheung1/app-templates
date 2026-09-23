import { Readable } from 'node:stream';
import type { Application, Request } from 'express';
import { MAX_UPLOAD_SIZE_LABEL, type AppStorage } from '../shared/storageConfig';
import { UploadError, saveUploadStream, type UploadStore } from './fileUploads';

export interface UploadDependencies {
  manifest(): Promise<{ storage?: AppStorage; parameters: { name: string; type: string }[] } | undefined>;
  viewer(req: Request): string | undefined;
  store(storage: AppStorage): UploadStore;
}

export function registerUploadRoutes(app: Pick<Application, 'post'>, deps: UploadDependencies) {
  let activeUploads = 0;

  app.post('/api/designer/uploads/:parameterName', async (req, res) => {
    let admitted = false;
    try {
      const manifest = await deps.manifest();
      const parameter = manifest?.parameters.find(
        ({ name, type }) => name === req.params.parameterName && type === 'file',
      );
      if (!parameter || !manifest?.storage) {
        res.status(404).json({ error: 'This app has no such file parameter.' });
        return;
      }
      const viewer = deps.viewer(req);
      if (!viewer) {
        res.status(401).json({ error: 'Sign in through Databricks Apps to upload files.' });
        return;
      }
      const store = deps.store(manifest.storage);
      if (req.get('content-type') !== 'application/octet-stream')
        throw new UploadError(415, 'Upload the file as an octet stream.');
      if (activeUploads >= 4) throw new UploadError(429, 'Uploads are busy. Try again shortly.');
      const contentLength = req.get('content-length');
      if (contentLength !== undefined && !/^\d+$/.test(contentLength))
        throw new UploadError(400, 'The Content-Length header is invalid.');
      const declaredSize = contentLength === undefined ? undefined : Number(contentLength);
      if (declaredSize !== undefined && declaredSize > manifest.storage.maxUploadFileSizeBytes)
        throw new UploadError(413, `The file exceeds the ${MAX_UPLOAD_SIZE_LABEL} upload limit.`);
      let filename: string;
      try {
        filename = decodeURIComponent(req.get('x-file-name') ?? '');
      } catch {
        throw new UploadError(400, 'The filename is invalid.');
      }
      activeUploads += 1;
      admitted = true;
      res.status(201).json({
        upload: await saveUploadStream(
          store,
          manifest.storage,
          viewer,
          parameter.name,
          filename,
          Readable.toWeb(req) as ReadableStream<Uint8Array>,
          declaredSize,
        ),
      });
    } catch (error) {
      req.resume();
      res.status(error instanceof UploadError ? error.status : 502).json({
        error:
          error instanceof UploadError
            ? error.message
            : 'Could not store the upload. Check the app volume resource and permissions.',
      });
    } finally {
      if (admitted) activeUploads -= 1;
    }
  });
}
