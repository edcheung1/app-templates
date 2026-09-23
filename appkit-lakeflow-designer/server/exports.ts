import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Application, Request, Response } from 'express';
import {
  APP_REVISION_PARAM,
  EXPORT_REQUEST_PARAM,
  isExportFormat,
  type ExportFormat,
  type ExportStatus,
} from '../shared/exportConfig';
import type { AppStorage } from '../shared/storageConfig';
import { APP_VIEWER_PARAM, canAccessRun } from './fileUploads';
import type { ExportStore } from './exportStore';
import { isReservedParameter } from './runParameters';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const manifestRevision = (manifest: object): string => digest(manifest);
export const runParameters = (run: unknown): Record<string, unknown> => {
  if (!record(run)) return {};
  const task = Array.isArray(run.tasks) && run.tasks.length === 1 ? run.tasks[0] : undefined;
  const base =
    record(task) && record(task.notebook_task) && record(task.notebook_task.base_parameters)
      ? task.notebook_task.base_parameters
      : {};
  const overrides =
    record(run.overriding_parameters) && record(run.overriding_parameters.notebook_params)
      ? run.overriding_parameters.notebook_params
      : {};
  return { ...base, ...overrides };
};
export const isExportRun = (run: unknown): boolean => typeof runParameters(run)[EXPORT_REQUEST_PARAM] === 'string';

interface ExportManifest {
  exports?: boolean;
  storage?: AppStorage;
  blocks: { type: string; id?: string; nodeId?: string; port?: string }[];
  parameters: { name: string }[];
}
interface ExportRequest {
  exportId: string;
  sourceRunId: number;
  outputId: string;
  viewer: string;
  revision: string;
  params: Record<string, string>;
  instruction: { id: string; root: string; nodeId: string; port: string; format: ExportFormat; notebookPath: string };
}
export interface ExportDependencies {
  jobId: string | undefined;
  manifest(): Promise<ExportManifest | undefined>;
  viewer(req: Request): string | undefined;
  notebookPath(): Promise<string | undefined>;
  getRun(id: number): Promise<unknown>;
  start(params: Record<string, string>, idempotencyToken: string): Promise<number>;
  cancel(id: number): Promise<void>;
  store(storage: AppStorage): ExportStore;
  report(error: unknown): void;
}

class ExportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const terminal = new Set(['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR']);
function stateOf(run: unknown) {
  return record(run) && record(run.state) ? run.state : {};
}
function notebookOf(run: unknown): string | undefined {
  if (!record(run) || !Array.isArray(run.tasks) || run.tasks.length !== 1) return undefined;
  const task = run.tasks[0];
  return record(task) && record(task.notebook_task) && typeof task.notebook_task.notebook_path === 'string'
    ? task.notebook_task.notebook_path
    : undefined;
}
function validRequest(value: unknown, id: string, viewer: string, root: string): value is ExportRequest {
  if (
    !record(value) ||
    value.exportId !== id ||
    value.viewer !== viewer ||
    !record(value.instruction) ||
    !record(value.params)
  )
    return false;
  const instruction = value.instruction;
  return (
    instruction.id === id &&
    instruction.root === root &&
    isExportFormat(instruction.format) &&
    typeof instruction.nodeId === 'string' &&
    typeof instruction.port === 'string' &&
    typeof instruction.notebookPath === 'string' &&
    typeof value.revision === 'string' &&
    typeof value.outputId === 'string' &&
    Number.isSafeInteger(value.sourceRunId) &&
    Object.values(value.params).every((entry) => typeof entry === 'string')
  );
}

export function registerExportRoutes(app: Pick<Application, 'get' | 'post'>, deps: ExportDependencies) {
  const context = async (req: Request) => {
    const viewer = deps.viewer(req);
    if (!viewer) throw new ExportError(401, 'Sign in through Databricks Apps to export data.');
    const manifest = await deps.manifest();
    if (!manifest?.exports || !manifest.storage || !deps.jobId)
      throw new ExportError(409, 'Full-data exports are not enabled for this app.');
    return {
      viewer,
      manifest,
      store: deps.store(manifest.storage),
      base: `${manifest.storage.path}/exports/${viewer}`,
    };
  };
  const existing = async (req: Request) => {
    const ctx = await context(req);
    const id = req.params.exportId;
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new ExportError(404, 'Export not found.');
    const root = `${ctx.base}/${id}`;
    const request = await ctx.store.read(`${root}/request.json`);
    if (!validRequest(request, id, ctx.viewer, root)) throw new ExportError(404, 'Export not found.');
    return { ...ctx, request, root, id };
  };
  const exportRun = async (ctx: Awaited<ReturnType<typeof existing>>) => {
    const submitted = await ctx.store.read(`${ctx.root}/submission.json`);
    if (!record(submitted) || typeof submitted.runId !== 'number' || !Number.isSafeInteger(submitted.runId))
      throw new ExportError(409, 'Export submission is incomplete. Retry generating with the same request.');
    const run = await deps.getRun(submitted.runId);
    if (
      !record(run) ||
      String(run.job_id) !== deps.jobId ||
      !canAccessRun(run, ctx.viewer, true) ||
      runParameters(run)[EXPORT_REQUEST_PARAM] !== JSON.stringify(ctx.request.instruction)
    )
      throw new ExportError(404, 'Export run not found.');
    return { run, runId: submitted.runId };
  };
  const status = async (ctx: Awaited<ReturnType<typeof existing>>): Promise<ExportStatus> => {
    if (await ctx.store.read(`${ctx.root}/consumed.json`)) return { exportId: ctx.id, phase: 'consumed' };
    const { run } = await exportRun(ctx);
    const state = stateOf(run);
    if (!terminal.has(String(state.life_cycle_state)))
      return { exportId: ctx.id, phase: state.life_cycle_state === 'RUNNING' ? 'running' : 'queued' };
    if (state.result_state !== 'SUCCESS')
      return {
        exportId: ctx.id,
        phase: state.result_state === 'CANCELED' ? 'cancelled' : 'failed',
        message:
          typeof state.state_message === 'string'
            ? state.state_message
            : 'Export generation failed. Check the job run for details.',
      };
    const complete = await ctx.store.read(`${ctx.root}/completion.json`);
    const format = ctx.request.instruction.format;
    if (
      !record(complete) ||
      complete.id !== ctx.id ||
      complete.format !== format ||
      typeof complete.size !== 'number' ||
      !Number.isSafeInteger(complete.size) ||
      complete.size <= 0 ||
      typeof complete.rowCount !== 'number' ||
      !Number.isSafeInteger(complete.rowCount) ||
      complete.rowCount < 0 ||
      (await ctx.store.size(`${ctx.root}/result.${format}`)) !== complete.size
    )
      return {
        exportId: ctx.id,
        phase: 'failed',
        message: 'The export artifact is missing or incomplete. Generate it again.',
      };
    return { exportId: ctx.id, phase: 'ready', format, rowCount: complete.rowCount, size: complete.size };
  };
  const handleError = (res: Response, error: unknown) => {
    if (!(error instanceof ExportError)) deps.report(error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res
      .status(error instanceof ExportError ? error.status : 502)
      .json({
        error: error instanceof ExportError ? error.message : 'Could not complete the export request. Try again.',
      });
  };

  app.post('/api/designer/exports', async (req, res) => {
    try {
      const ctx = await context(req);
      const body = record(req.body) ? req.body : {};
      if (
        typeof body.sourceRunId !== 'string' ||
        !/^[1-9][0-9]*$/.test(body.sourceRunId) ||
        !Number.isSafeInteger(Number(body.sourceRunId)) ||
        typeof body.outputId !== 'string' ||
        !isExportFormat(body.format) ||
        typeof body.requestId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(body.requestId)
      )
        throw new ExportError(400, 'Choose a run, published output, and CSV or Excel format.');
      const block = ctx.manifest.blocks.find((entry) => entry.type === 'output' && entry.id === body.outputId);
      if (!block?.nodeId || !block.port) throw new ExportError(400, 'This output is not published by the app.');
      const source = await deps.getRun(Number(body.sourceRunId));
      if (
        !record(source) ||
        String(source.job_id) !== deps.jobId ||
        !canAccessRun(source, ctx.viewer, true) ||
        isExportRun(source)
      )
        throw new ExportError(404, 'Source run not found.');
      if (stateOf(source).result_state !== 'SUCCESS') throw new ExportError(409, 'Choose a successful run to export.');
      const sourceParams = runParameters(source);
      const revision = manifestRevision(ctx.manifest);
      const notebookPath = await deps.notebookPath();
      if (
        !notebookPath ||
        !/\/runner-[a-f0-9]{64}\.designer\.py$/.test(notebookPath) ||
        notebookOf(source) !== notebookPath ||
        sourceParams[APP_REVISION_PARAM] !== revision
      )
        throw new ExportError(
          409,
          'The app has been republished or this run predates exports. Run the app again before exporting.',
        );
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(sourceParams)) {
        if (!isReservedParameter(name) && typeof value === 'string') params[name] = value;
      }
      for (const parameter of ctx.manifest.parameters) {
        const value = sourceParams[parameter.name];
        if (typeof value !== 'string')
          throw new ExportError(409, 'This run is missing recorded parameters. Run the app again.');
        params[parameter.name] = value;
      }
      const exportId = digest([ctx.viewer, body.sourceRunId, body.outputId, body.format, body.requestId]);
      const root = `${ctx.base}/${exportId}`;
      const instruction = {
        id: exportId,
        root,
        nodeId: block.nodeId,
        port: block.port,
        format: body.format,
        notebookPath,
      };
      const request: ExportRequest = {
        exportId,
        sourceRunId: Number(body.sourceRunId),
        outputId: body.outputId,
        viewer: ctx.viewer,
        revision,
        params,
        instruction,
      };
      if (Buffer.byteLength(JSON.stringify(request)) > 48 * 1024)
        throw new ExportError(400, 'The recorded run parameters are too large to export.');
      await ctx.store.create(`${root}/request.json`, request);
      const saved = await ctx.store.read(`${root}/request.json`);
      if (!validRequest(saved, exportId, ctx.viewer, root) || JSON.stringify(saved) !== JSON.stringify(request))
        throw new ExportError(409, 'This request changed. Generate a new export.');
      if (!(await ctx.store.read(`${root}/submission.json`))) {
        const runId = await deps.start(
          {
            ...params,
            [APP_VIEWER_PARAM]: ctx.viewer,
            [APP_REVISION_PARAM]: revision,
            ld_display_outputs: 'false',
            ld_display_outputs_for: '',
            _lb_collect_row_counts: 'false',
            [EXPORT_REQUEST_PARAM]: JSON.stringify(instruction),
          },
          exportId,
        );
        await ctx.store.create(`${root}/submission.json`, { runId });
      }
      res.status(202).json({ exportId, phase: 'queued' });
    } catch (error) {
      handleError(res, error);
    }
  });
  app.get('/api/designer/exports/:exportId', async (req, res) => {
    try {
      res.json(await status(await existing(req)));
    } catch (error) {
      handleError(res, error);
    }
  });
  app.post('/api/designer/exports/:exportId/cancel', async (req, res) => {
    try {
      const { run, runId } = await exportRun(await existing(req));
      if (!terminal.has(String(stateOf(run).life_cycle_state))) await deps.cancel(runId);
      res.json({ cancelling: true });
    } catch (error) {
      handleError(res, error);
    }
  });
  app.get('/api/designer/exports/:exportId/download', async (req, res) => {
    let locked: Awaited<ReturnType<typeof existing>> | undefined;
    try {
      if (req.method !== 'GET') throw new ExportError(405, 'Use GET to download the export.');
      if (req.get('range')) throw new ExportError(416, 'Partial downloads are not supported. Retry the full download.');
      const ctx = await existing(req);
      if (!(await ctx.store.create(`${ctx.root}/download.lock`, { startedAt: Date.now() })))
        throw new ExportError(
          409,
          'This export is already downloading. If that download was abandoned, generate a new export.',
        );
      locked = ctx;
      const current = await status(ctx);
      if (current.phase !== 'ready')
        throw new ExportError(
          409,
          current.phase === 'consumed'
            ? 'This export was downloaded and removed. Generate it again.'
            : 'The export is not ready.',
        );
      const path = `${ctx.root}/result.${current.format}`;
      const stream = await ctx.store.download(path);
      res.setHeader(
        'Content-Type',
        current.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      );
      res.setHeader('Content-Disposition', `attachment; filename="result.${current.format}"`);
      res.setHeader('Content-Length', String(current.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const reader = stream.getReader();
      const cancelRead = () => {
        void reader.cancel().catch(deps.report);
      };
      res.once('close', cancelRead);
      async function* bytes() {
        let size = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > (current.size ?? 0)) throw new Error('Export size changed during transfer.');
            yield next.value;
          }
          if (size !== current.size) throw new Error('Export transfer was incomplete.');
        } finally {
          res.off('close', cancelRead);
          await reader.cancel().catch(deps.report);
          reader.releaseLock();
        }
      }
      await pipeline(Readable.from(bytes()), res);
      if (res.writableFinished) {
        // Completion means bytes were handed to the transport, not proof the browser saved them.
        try {
          await ctx.store.create(`${ctx.root}/consumed.json`, { consumedAt: Date.now() });
          await ctx.store.remove(path);
        } catch (error) {
          deps.report(error);
        }
      }
    } catch (error) {
      handleError(res, error);
    } finally {
      if (locked) await locked.store.remove(`${locked.root}/download.lock`).catch(deps.report);
    }
  });
}
