import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { UPLOAD_REFERENCE } from '../shared/uploadConfig';
import type { AppUploads } from '../shared/uploadConfig';

export const APP_VIEWER_PARAM = '_lb_app_viewer';

export class UploadError extends Error {
  status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Databricks Apps supplies this header at its authenticated ingress. Never take identity from a body/query.
export function viewerKey(forwardedUser: string | undefined, jobId: string | undefined): string | undefined {
  return forwardedUser?.trim() && jobId ? hash(JSON.stringify([jobId, forwardedUser.trim()])) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function canAccessRun(run: unknown, viewer: string | undefined, privateApp: boolean): boolean {
  if (!isRecord(run) || !isRecord(run.overriding_parameters) || !isRecord(run.overriding_parameters.notebook_params)) {
    // Callers must hydrate list entries with getRun first; a missing parameter map cannot prove ownership.
    return !privateApp;
  }
  const owner = run.overriding_parameters.notebook_params[APP_VIEWER_PARAM];
  if (owner === undefined) return !privateApp;
  return viewer !== undefined && owner === viewer;
}

export interface StoredUpload {
  reference: string;
  filename: string;
  size: number;
  createdAt: number;
}

// Keep storage operations behind a small boundary so failures/partial writes can be exercised without UC.
export interface UploadStore {
  mkdir(path: string): Promise<void>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<unknown>;
  size(path: string): Promise<number | undefined>;
  delete(path: string): Promise<void>;
}

function uploadFolder(config: AppUploads, viewer: string, parameterName: string): string {
  return `${config.path}/${viewer}/${hash(parameterName)}`;
}

function uploadId(reference: string): string {
  const id = UPLOAD_REFERENCE.exec(reference)?.[1];
  if (!id) throw new UploadError(400, 'Choose an uploaded file before running.');
  return id;
}

function isValidFilename(filename: string): boolean {
  return (
    filename.trim() !== '' &&
    filename !== '.' &&
    filename !== '..' &&
    Buffer.byteLength(filename, 'utf8') <= 255 &&
    !/[/\\\x00-\x1f\x7f]/.test(filename)
  );
}

function parseStoredUpload(raw: unknown, reference: string, maxBytes: number): StoredUpload {
  if (
    !isRecord(raw) ||
    raw.reference !== reference ||
    typeof raw.filename !== 'string' ||
    !isValidFilename(raw.filename) ||
    typeof raw.size !== 'number' ||
    !Number.isSafeInteger(raw.size) ||
    raw.size <= 0 ||
    raw.size > maxBytes ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt)
  ) {
    throw new UploadError(409, 'This upload is incomplete or unreadable. Upload the file again.');
  }
  return { reference, filename: raw.filename, size: raw.size, createdAt: raw.createdAt };
}

export async function resolveUpload(
  store: UploadStore,
  config: AppUploads,
  viewer: string,
  parameterName: string,
  reference: string,
) {
  const id = uploadId(reference);
  const folder = uploadFolder(config, viewer, parameterName);
  const upload = parseStoredUpload(await store.read(`${folder}/${id}.json`), reference, config.maxFileSizeBytes);
  const path = `${folder}/${id}/${upload.filename}`;
  if ((await store.size(path)) !== upload.size)
    throw new UploadError(409, 'The uploaded file is missing or has changed. Upload it again.');
  return { path, upload };
}

// Buffer only a bounded file, with a process-wide admission limit, before writing immutable bytes to UC.
export async function readUploadBytes(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes)
      throw new UploadError(413, `Files must be at most ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  if (size === 0) throw new UploadError(400, 'Choose a non-empty file.');
  return Buffer.concat(chunks, size);
}

export async function saveUpload(
  store: UploadStore,
  config: AppUploads,
  viewer: string,
  parameterName: string,
  filename: string,
  bytes: Uint8Array,
): Promise<StoredUpload> {
  if (!isValidFilename(filename)) throw new UploadError(400, 'Choose a file with a valid filename.');
  if (bytes.byteLength === 0 || bytes.byteLength > config.maxFileSizeBytes)
    throw new UploadError(413, 'The file is empty or exceeds the upload limit.');
  const folder = uploadFolder(config, viewer, parameterName);
  const id = randomUUID();
  const upload: StoredUpload = { reference: `upload:${id}`, filename, size: bytes.byteLength, createdAt: Date.now() };
  // Isolate each upload so its original extension survives and JSON data cannot collide with its sidecar.
  const path = `${folder}/${id}/${filename}`;
  await store.mkdir(`${folder}/${id}`);
  await store.put(path, bytes);
  try {
    // The sidecar is the completion marker; partially written files can never be selected for a run.
    await store.put(`${folder}/${id}.json`, Buffer.from(JSON.stringify(upload)));
  } catch (error) {
    await store.delete(path).catch(() => undefined);
    throw error;
  }
  return upload;
}
