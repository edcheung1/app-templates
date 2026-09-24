export const EXPORT_REQUEST_PARAM = '_lb_export_request';
export const APP_REVISION_PARAM = '_lb_app_revision';
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportPhase = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'consumed';

export interface ExportStatus {
  exportId: string;
  phase: ExportPhase;
  runPageUrl?: string;
  message?: string;
  format?: ExportFormat;
  rowCount?: number;
  size?: number;
}

export const isExportFormat = (value: unknown): value is ExportFormat => value === 'csv' || value === 'xlsx';

export const isExecutionPlan = (value: unknown, nodeId: string): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((node) => typeof node === 'string' && node.trim() !== '') &&
  new Set(value).size === value.length &&
  value.includes(nodeId);
