import { useEffect, useRef, useState } from 'react';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
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
  if (typeof value !== 'object' || value === null)
    throw new Error('The upload server returned an unreadable response.');
  if (!response.ok)
    throw new Error('error' in value && typeof value.error === 'string' ? value.error : 'The upload request failed.');
  return value as Record<string, unknown>;
}

export interface FileParameterControlProps {
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}

export function FileParameterControl({
  name,
  value,
  onValueChange,
  onBusyChange,
  disabled,
}: FileParameterControlProps) {
  const [uploads, setUploads] = useState<UploadChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const uploadRequest = useRef<AbortController | undefined>(undefined);
  const callbacks = useRef({ onValueChange, onBusyChange });
  callbacks.current = { onValueChange, onBusyChange };

  useEffect(() => {
    const controller = new AbortController();
    void fetch(uploadsRoute(name), { signal: controller.signal })
      .then(readResponse)
      .then((body) => {
        if (!controller.signal.aborted && Array.isArray(body.uploads)) {
          const listed = body.uploads.filter(isUpload);
          setUploads((current) => [
            ...current,
            ...listed.filter((item) => !current.some(({ reference }) => reference === item.reference)),
          ]);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not list saved uploads.');
      });
    return () => {
      controller.abort();
      uploadRequest.current?.abort();
      callbacks.current.onBusyChange(false);
    };
  }, [name]);

  const upload = async (file: File) => {
    uploadRequest.current?.abort();
    const controller = new AbortController();
    uploadRequest.current = controller;
    setError(undefined);
    callbacks.current.onValueChange('');
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      setError('Choose a non-empty file up to 25 MB.');
      setBusy(false);
      callbacks.current.onBusyChange(false);
      return;
    }
    setBusy(true);
    callbacks.current.onBusyChange(true);
    try {
      const body = await readResponse(
        await fetch(uploadsRoute(name), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
          signal: controller.signal,
        }),
      );
      if (!isUpload(body.upload)) throw new Error('The server did not confirm the completed upload.');
      if (controller.signal.aborted) return;
      const saved = body.upload;
      setUploads((current) => [saved, ...current.filter(({ reference }) => reference !== saved.reference)]);
      callbacks.current.onValueChange(saved.reference);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        callbacks.current.onBusyChange(false);
      }
    }
  };

  return (
    <div className="grid gap-2">
      <Input
        id={name}
        type="file"
        disabled={disabled}
        aria-describedby={`${name}-upload-help`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
      {uploads.length > 0 || value ? (
        <Select value={value} disabled={disabled || busy} onValueChange={onValueChange}>
          <SelectTrigger aria-label={`Saved uploads for ${name}`} className="w-full">
            <SelectValue placeholder="Choose a saved upload" />
          </SelectTrigger>
          <SelectContent>
            {value && !uploads.some(({ reference }) => reference === value) ? (
              <SelectItem value={value}>Previously uploaded file</SelectItem>
            ) : null}
            {uploads.map((entry) => (
              <SelectItem key={entry.reference} value={entry.reference}>
                {entry.filename}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <p id={`${name}-upload-help`} className="text-muted-foreground text-xs">
        Up to 25 MB. Use the format and read options configured in the source operator. Files are retained in the
        app’s volume until deleted by its owner. Saved uploads are private to you within this app.
      </p>
      {busy ? (
        <p role="status" className="text-xs">
          Uploading…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
