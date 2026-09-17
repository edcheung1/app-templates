
import { CONFIG_ROUTE } from './routes';

export const APP_MANIFEST_VERSION = 3;

export const TARGET_NODE_PARAM = 'target_node';

export type AppParameterType = 'text' | 'number' | 'dropdown';

export type AppParameter = {
  name: string;
  label: string;
  type: AppParameterType;
  defaultValue: string;
  choices?: string[];
  help?: string;
};

export type AppTarget = {
  nodeId: string;
  label: string;
};

export type AppChartSpec = {
  widgetType: string;
  [key: string]: unknown;
};

export type AppProvenance = {
  publishedAt: number;
  generatorVersion?: string;
  [key: string]: unknown;
};

export type AppOutputBlock = {
  type: 'output';
  id: string;

  label: string;
  nodeId: string;

  port: string;

  chartSpec?: AppChartSpec;
};

export type AppMarkdownBlock = {
  type: 'markdown';
  id?: string;
  text: string;
};

export type AppManifestBlock = AppMarkdownBlock | AppOutputBlock;

export type AppManifest = {
  version: number;
  appName: string;
  subtitle?: string;
  provenance?: AppProvenance;
  target?: AppTarget;

  blocks: AppManifestBlock[];
  parameters: AppParameter[];
};

export type NotRunnableReason = 'noManifest' | 'noJob';

export type AppConfigState =
  | { status: 'loading' }

  | { status: 'ready'; manifest: AppManifest; runnable: boolean; notRunnableReason?: NotRunnableReason }

  | { status: 'unavailable'; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isParameterType = (value: unknown): value is AppParameterType =>
  value === 'text' || value === 'number' || value === 'dropdown';

function parseProvenance(raw: unknown): AppProvenance | undefined {
  if (!isRecord(raw) || typeof raw.publishedAt !== 'number' || !Number.isFinite(raw.publishedAt) || raw.publishedAt <= 0) {
    return undefined;
  }
  return { ...raw, publishedAt: raw.publishedAt };
}

export function parseAppManifest(raw: unknown): AppManifest | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.version !== APP_MANIFEST_VERSION) {
    return undefined;
  }
  if (typeof raw.appName !== 'string' || raw.appName === '') {
    return undefined;
  }
  const target = parseTarget(raw.target);
  const provenance = parseProvenance(raw.provenance);
  const blocks = parseBlocks(raw.blocks);
  if (!blocks.some((block) => block.type === 'output')) {
    return undefined;
  }
  if (!Array.isArray(raw.parameters)) {
    return undefined;
  }
  return {
    version: raw.version,
    appName: raw.appName,
    ...(typeof raw.subtitle === 'string' && raw.subtitle !== '' ? { subtitle: raw.subtitle } : {}),
    // Keep provenance opaque so new fields cross projections without per-field edits.
    ...(provenance === undefined ? {} : { provenance }),
    ...(target === undefined ? {} : { target }),
    blocks,
    parameters: raw.parameters.filter(isRecord).flatMap(parseParameter),
  };
}

function parseTarget(raw: unknown): AppTarget | undefined {
  if (!isRecord(raw) || typeof raw.nodeId !== 'string' || raw.nodeId === '') {
    return undefined;
  }
  return { nodeId: raw.nodeId, label: typeof raw.label === 'string' ? raw.label : '' };
}

function parseBlocks(raw: unknown): AppManifestBlock[] {
  const seen = new Set<string>();
  const blocks: AppManifestBlock[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (isRecord(entry) && entry.type === 'markdown' && typeof entry.text === 'string') {
      blocks.push({
        type: 'markdown',
        ...(typeof entry.id === 'string' && entry.id !== '' ? { id: entry.id } : {}),
        text: entry.text,
      });
      continue;
    }
    if (
      !isRecord(entry) ||
      entry.type !== 'output' ||
      typeof entry.id !== 'string' ||
      entry.id === '' ||
      seen.has(entry.id)
    ) {
      continue;
    }
    seen.add(entry.id);
    const chartSpec = parseChartSpec(entry.chartSpec);
    blocks.push({
      type: 'output',
      id: entry.id,
      label: typeof entry.label === 'string' ? entry.label : '',
      nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : '',
      port: typeof entry.port === 'string' ? entry.port : '',
      ...(chartSpec === undefined ? {} : { chartSpec }),
    });
  }
  return blocks;
}

function parseChartSpec(raw: unknown): AppChartSpec | undefined {
  if (!isRecord(raw) || typeof raw.widgetType !== 'string' || raw.widgetType === '') {
    return undefined;
  }
  return { ...raw, widgetType: raw.widgetType };
}

function parseParameter(entry: Record<string, unknown>): AppParameter[] {
  if (typeof entry.name !== 'string' || entry.name === '' || typeof entry.label !== 'string') {
    return [];
  }
  if (entry.name === TARGET_NODE_PARAM) {
    return [];
  }
  const declared = isParameterType(entry.type) ? entry.type : 'text';
  const choices =
    Array.isArray(entry.choices) && entry.choices.length > 0 && entry.choices.every((choice): choice is string => typeof choice === 'string')
      ? entry.choices
      : undefined;

  const type: AppParameterType = declared === 'dropdown' && choices === undefined ? 'text' : declared;
  return [
    {
      name: entry.name,
      label: entry.label,
      type,
      defaultValue: typeof entry.defaultValue === 'string' ? entry.defaultValue : '',
      ...(type === 'dropdown' && choices !== undefined ? { choices } : {}),
      ...(typeof entry.help === 'string' && entry.help !== '' ? { help: entry.help } : {}),
    },
  ];
}

export function initialValuesFor(
  manifest: AppManifest,
  lastRunParameters?: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const parameter of manifest.parameters) {
    const recorded = lastRunParameters?.[parameter.name];
    values[parameter.name] = recorded === undefined || recorded === '' ? parameter.defaultValue : recorded;
  }
  return values;
}

export async function fetchAppConfig(): Promise<AppConfigState> {
  try {
    const response = await fetch(CONFIG_ROUTE);
    if (!response.ok) {
      return { status: 'unavailable', detail: `the server returned ${response.status}` };
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      return { status: 'unavailable', detail: 'the server returned an unreadable response' };
    }
    const manifest = parseAppManifest(body.manifest);
    if (manifest === undefined) {
      return { status: 'unavailable', detail: 'this app has no readable configuration' };
    }
    const reason = body.notRunnableReason;
    return {
      status: 'ready',
      manifest,
      runnable: body.runnable === true,
      ...(reason === 'noManifest' || reason === 'noJob' ? { notRunnableReason: reason } : {}),
    };
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
}
