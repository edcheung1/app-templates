import { MAX_UPLOAD_BYTES, UPLOAD_REFERENCE } from '../../shared/uploadConfig';
import { uploadsRoute } from './routes';

interface UploadChoice {
  reference: string;
  filename: string;
}

function isUpload(value: unknown): value is UploadChoice {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reference' in value &&
    'filename' in value &&
    typeof value.reference === 'string' &&
    UPLOAD_REFERENCE.test(value.reference) &&
    typeof value.filename === 'string'
  );
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null) {
    throw new Error('The upload server returned an unreadable response.');
  }
  if (!response.ok) {
    throw new Error('error' in value && typeof value.error === 'string' ? value.error : 'The upload request failed.');
  }
  return value as Record<string, unknown>;
}

export function validateUpload(file: File): string | undefined {
  return file.size === 0 || file.size > MAX_UPLOAD_BYTES ? 'Choose a non-empty file up to 25 MB.' : undefined;
}

export async function uploadFile(parameterName: string, file: File): Promise<string> {
  const validationError = validateUpload(file);
  if (validationError !== undefined) throw new Error(validationError);

  const body = await readResponse(
    await fetch(uploadsRoute(parameterName), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
  );
  if (!isUpload(body.upload)) throw new Error('The server did not confirm the completed upload.');
  return body.upload.reference;
}
