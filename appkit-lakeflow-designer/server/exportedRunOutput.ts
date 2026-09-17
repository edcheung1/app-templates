import { DISPLAY_ROW_LIMIT, summarizeResultPreview } from '../shared/resultPreview';

const RUNNER_PAYLOAD_VERSION = 2;
const NOTEBOOK_MODEL_ASSIGNMENT = /__DATABRICKS_NOTEBOOK_MODEL = '([^']*)'/;
// Each cell's display(ctx["<node>.<port>"]) lines name the ports it renders, in source order.
const DISPLAY_CTX_KEY = /display\(ctx\["([^"]+)"\]\)/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function findNotebookModelValue(exportedHtml: unknown): string | undefined {
  if (typeof exportedHtml !== 'string') {
    return undefined;
  }
  const direct = exportedHtml.match(NOTEBOOK_MODEL_ASSIGNMENT);
  if (direct !== null) {
    return direct[1];
  }
  try {
    const nested = Buffer.from(exportedHtml, 'base64').toString().match(NOTEBOOK_MODEL_ASSIGNMENT);
    return nested !== null ? nested[1] : undefined;
  } catch {
    return undefined;
  }
}

function decodeNotebookModel(exportedHtml: unknown): Record<string, unknown> | undefined {
  const value = findNotebookModelValue(exportedHtml);
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(Buffer.from(value, 'base64').toString()));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function displayedCtxKeys(source: unknown): string[] {
  if (typeof source !== 'string') {
    return [];
  }
  return Array.from(source.matchAll(DISPLAY_CTX_KEY), (match) => match[1]);
}

// Node names carry no dots, so the last dot separates node and port.
function splitCtxKey(key: string): { node: string; port: string } {
  const dot = key.lastIndexOf('.');
  return dot === -1 ? { node: key, port: '' } : { node: key.slice(0, dot), port: key.slice(dot + 1) };
}

function simpleType(rawType: unknown): string {
  if (typeof rawType !== 'string') {
    return 'string';
  }
  try {
    const parsed = JSON.parse(rawType);
    return typeof parsed === 'string' ? parsed : rawType;
  } catch {
    return rawType;
  }
}

function toDisplayTable(entry: unknown) {
  if (!isRecord(entry) || entry.type !== 'table' || !Array.isArray(entry.schema) || !Array.isArray(entry.data)) {
    return undefined;
  }
  const schema = entry.schema.filter(isRecord).map((field) => ({
    name: typeof field.name === 'string' ? field.name : '',
    type: simpleType(field.type),
    nullable: typeof field.nullable === 'boolean' ? field.nullable : true,
  }));
  const columnNames = schema.map((field) => field.name);
  const data = entry.data.filter((row) => Array.isArray(row));
  const rows = data
    .slice(0, DISPLAY_ROW_LIMIT)
    .map((row) => Object.fromEntries(columnNames.map((name, index) => [name, row[index] ?? null])));
  // Notebook overflow does not distinguish row and byte limits or carry an exact total.
  // Preserve unknown overflow instead of interpreting absent metadata as a complete result.
  return { schema, rows, ...summarizeResultPreview(data.length, entry.overflow) };
}

function resultEntries(results: unknown): unknown[] {
  return isRecord(results) && Array.isArray(results.data) ? results.data : [];
}

// A cell that displayed has one result entry per display() call, in order, so pairing those with the
// cell's display(ctx["<node>.<port>"]) keys yields one output entry per rendered port, keyed by
// (node, port). A cell that did not display contributes no entries and no outputs.
export function exportedModelToRunPayload(exportedHtml: unknown): string | undefined {
  const model = decodeNotebookModel(exportedHtml);
  if (model === undefined || !Array.isArray(model.commands)) {
    return undefined;
  }
  const outputs: Record<string, unknown>[] = [];
  for (const command of model.commands) {
    if (!isRecord(command)) {
      continue;
    }
    const keys = displayedCtxKeys(command.command);
    resultEntries(command.results).forEach((entry, index) => {
      const key = keys[index];
      if (key === undefined) {
        return;
      }
      const parts = splitCtxKey(key);
      const table = toDisplayTable(entry);
      if (table === undefined) return;
      outputs.push({
        status: 'ok',
        target_node: parts.node,
        target_port: parts.port,
        ...table,
      });
    });
  }
  return JSON.stringify({ version: RUNNER_PAYLOAD_VERSION, outputs });
}
