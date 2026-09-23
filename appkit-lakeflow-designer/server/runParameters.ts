import type { AppStorage } from '../shared/storageConfig';
import { APP_VIEWER_PARAM, UploadError, resolveUpload, type UploadStore } from './fileUploads';

export function isReservedParameter(name: string): boolean {
  return name === 'target_node' || name === 'ld_display_outputs' || name === 'ld_display_outputs_for' || name.startsWith('_lb_');
}

interface ParameterManifest {
  storage?: AppStorage;
  blocks?: { type: string; nodeId?: string }[];
  parameters: { name: string; label: string; type: string; defaultValue: string; choices?: string[] }[];
}

const DISPLAY_OUTPUTS_FOR_PARAM = 'ld_display_outputs_for';
const COLLECT_ROW_COUNTS_PARAM = '_lb_collect_row_counts';

function displayOutputsFor(manifest: ParameterManifest): string {
  return Array.from(
    new Set(
      (manifest.blocks ?? []).flatMap((block) =>
        block.type === 'output' && typeof block.nodeId === 'string' && block.nodeId !== '' ? [block.nodeId] : [],
      ),
    ),
  ).join(',');
}

export async function resolveRunParameters(
  manifest: ParameterManifest,
  submitted: Record<string, unknown>,
  viewer: string | undefined,
  store: UploadStore,
): Promise<{ ok: true; params: Record<string, string> } | { ok: false; error: string }> {
  const params: Record<string, string> = {};
  if (manifest.storage && !viewer)
    return { ok: false, error: 'Sign in through Databricks Apps to run an app with uploads.' };
  for (const parameter of manifest.parameters) {
    if (isReservedParameter(parameter.name)) continue;
    const raw = submitted[parameter.name];
    const value = raw === undefined || raw === null ? '' : String(raw);
    const resolved = value.trim() === '' ? parameter.defaultValue : value;
    if (parameter.type === 'file') {
      if (!manifest.storage || !viewer) return { ok: false, error: 'File uploads are not configured.' };
      try {
        params[parameter.name] = (await resolveUpload(store, manifest.storage, viewer, parameter.name, resolved)).path;
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof UploadError
              ? error.message
              : 'Could not verify the uploaded file. Try uploading it again.',
        };
      }
      continue;
    }
    if (parameter.type === 'dropdown' && Array.isArray(parameter.choices) && !parameter.choices.includes(resolved)) {
      return { ok: false, error: `"${parameter.label}" must be one of the offered choices.` };
    }
    params[parameter.name] = resolved;
  }
  // Supplying notebook_params on run-now can replace the runner job's base parameters. Always
  // carry the server-owned display controls with the viewer's values so selected source operators
  // (and every other published output) render for parameterized runs as well.
  const displayedNodes = displayOutputsFor(manifest);
  if (displayedNodes !== '') {
    params[DISPLAY_OUTPUTS_FOR_PARAM] = displayedNodes;
    params[COLLECT_ROW_COUNTS_PARAM] = 'true';
  }
  if (manifest.storage && viewer) params[APP_VIEWER_PARAM] = viewer;
  return { ok: true, params };
}
