import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Application, Request, Response } from 'express';
import {
  APP_REVISION_PARAM,
  EXPORT_REQUEST_PARAM,
  isExportFormat,
  isExecutionPlan,
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
const EXPORT_REVISION_PREFIX = 'execution-v1:';

export function manifestRevision(manifest: ExportManifest): string {
  // Notebook identity is checked separately. Replay uses recorded parameter values, so
  // labels, defaults, chart settings, publication timestamps and layout are not execution changes.
  const outputs = manifest.blocks
    .filter((block) => block.type === 'output')
    .map((block) => ({
      id: block.id ?? '',
      nodeId: block.nodeId,
      port: block.port,
      executionNodeIds: block.executionNodeIds,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return EXPORT_REVISION_PREFIX + digest({
    exports: manifest.exports === true,
    storage: manifest.storage && { volume: manifest.storage.volume, path: manifest.storage.path },
    parameters: manifest.parameters.map((parameter) => parameter.name).sort(),
    outputs,
  });
}
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
  blocks: { type: string; id?: string; nodeId?: string; port?: string; executionNodeIds?: string[] }[];
  parameters: { name: string }[];
}
interface ExportRequest {
  exportId: string;
  cacheKey?: string;
  sourceRunId: number;
  outputId: string;
  viewer: string;
  revision: string;
  params: Record<string, string>;
  instruction: {
    id: string;
    root: string;
    nodeId: string;
    port: string;
    format: ExportFormat;
    notebookPath: string;
    executionNodeIds: string[];
  };
}
export interface ExportDependencies {
  jobId: string | undefined;
  manifest(): Promise<ExportManifest | undefined>;
  viewer(req: Request): string | undefined;
  notebookPath(): Promise<string | undefined>;
  notebookSource(path: string): Promise<string | undefined>;
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
    (value.cacheKey !== undefined && (typeof value.cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.cacheKey))) ||
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
    isExecutionPlan(instruction.executionNodeIds, instruction.nodeId) &&
    typeof instruction.port === 'string' &&
    typeof instruction.notebookPath === 'string' &&
    typeof value.revision === 'string' &&
    typeof value.outputId === 'string' &&
    Number.isSafeInteger(value.sourceRunId) &&
    Object.values(value.params).every((entry) => typeof entry === 'string')
  );
}

export function registerExportRoutes(app: Pick<Application, 'get' | 'post'>, deps: ExportDependencies) {
  const pending = new Map<string, Promise<ExportStatus>>();
  const shareGeneration = async (key: string, generate: () => Promise<ExportStatus>) => {
    const active = pending.get(key);
    if (active) return active;
    const operation = generate();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
    }
  };
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
  const existingAt = async (ctx: Awaited<ReturnType<typeof context>>, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new ExportError(404, 'Export not found.');
    const root = `${ctx.base}/${id}`;
    const request = await ctx.store.read(`${root}/request.json`);
    if (!validRequest(request, id, ctx.viewer, root)) throw new ExportError(404, 'Export not found.');
    return { ...ctx, request, root, id };
  };
  const existing = async (req: Request) => existingAt(await context(req), req.params.exportId);
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
    const { run } = await exportRun(ctx);
    const runPageUrl =
      typeof run.run_page_url === 'string' && run.run_page_url.startsWith('https://') ? run.run_page_url : undefined;
    const identity = { exportId: ctx.id, ...(runPageUrl ? { runPageUrl } : {}) };
    const state = stateOf(run);
    if (!terminal.has(String(state.life_cycle_state)))
      return { ...identity, phase: state.life_cycle_state === 'RUNNING' ? 'running' : 'queued' };
    if (state.result_state !== 'SUCCESS')
      return {
        ...identity,
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
        ...identity,
        phase: 'failed',
        message: 'The export artifact is missing or incomplete. Generate it again.',
      };
    return { ...identity, phase: 'ready', format, rowCount: complete.rowCount, size: complete.size };
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
      if (!isExecutionPlan(block.executionNodeIds, block.nodeId))
        throw new ExportError(409, 'This output has no valid export execution plan. Republish the app.');
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
      if (!notebookPath || !/\/runner-[a-f0-9]{64}\.designer\.py$/.test(notebookPath))
        throw new ExportError(409, 'This runner does not support exports. Republish the app and run it again.');
      if (notebookOf(source) !== notebookPath)
        throw new ExportError(
          409,
          'The runner notebook has changed since this run. Run the app again before exporting.',
        );
      const sourceRevision = sourceParams[APP_REVISION_PARAM];
      if (sourceRevision !== revision) {
        const legacyRevision = typeof sourceRevision !== 'string' || !sourceRevision.startsWith(EXPORT_REVISION_PREFIX);
        throw new ExportError(
          409,
          legacyRevision
            ? 'This run uses an older export configuration. Run the app again once before generating exports.'
            : 'The published outputs, execution plans, parameters, or storage have changed since this run. Run the app again before exporting.',
        );
      }
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
      const recordedParams = Object.fromEntries(
        Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
      // Include the bytes as well as the content-addressed path: its owner can still edit it.
      const notebookSource = await deps.notebookSource(notebookPath);
      const cacheKey = digest([
        'export-cache-v1',
        deps.jobId,
        ctx.viewer,
        body.sourceRunId,
        body.outputId,
        body.format,
        revision,
        notebookPath,
        notebookSource,
        recordedParams,
      ]);
      const cachePath = `${ctx.base}/cache/${cacheKey}.json`;
      const outputId = body.outputId;
      const format = body.format;
      const { nodeId, port, executionNodeIds } = block;
      const prepare = (exportId: string) => {
        const root = `${ctx.base}/${exportId}`;
        const instruction = { id: exportId, root, nodeId, port, format, notebookPath, executionNodeIds };
        const request: ExportRequest = {
          exportId,
          cacheKey,
          sourceRunId: Number(body.sourceRunId),
          outputId,
          viewer: ctx.viewer,
          revision,
          params: recordedParams,
          instruction,
        };
        if (Buffer.byteLength(JSON.stringify(request)) > 48 * 1024)
          throw new ExportError(400, 'The recorded run parameters are too large to export.');
        const notebookParams = {
          ...recordedParams,
          [APP_VIEWER_PARAM]: ctx.viewer,
          [APP_REVISION_PARAM]: revision,
          ld_display_outputs: 'false',
          ld_display_outputs_for: '',
          _lb_collect_row_counts: 'false',
          [EXPORT_REQUEST_PARAM]: JSON.stringify(instruction),
        };
        // Jobs run-now limits notebook_params to 10,000 serialized bytes.
        if (Buffer.byteLength(JSON.stringify(notebookParams)) > 10_000)
          throw new ExportError(400, 'The execution plan and recorded parameters are too large to export.');
        return { root, request, notebookParams };
      };
      const first = prepare(cacheKey);
      const targetHook = `_lb_app_runtime.on_output(${JSON.stringify(nodeId)},`;
      if (
        !notebookSource?.split('\n').some((line) => line.trimStart().startsWith(targetHook)) ||
        !executionNodeIds.every((node) => notebookSource.includes(`.should_run(${JSON.stringify(node)})`))
      )
        throw new ExportError(
          409,
          'The runner notebook has outdated or modified export code. Republish the app, run it again, then retry the export.',
        );
      const result = await shareGeneration(cachePath, async () => {
        const cached = await ctx.store.read(cachePath);
        let previousExport = false;
        if (record(cached) && typeof cached.exportId === 'string' && /^[a-f0-9]{64}$/.test(cached.exportId)) {
          previousExport = true;
          try {
            const saved = await existingAt(ctx, cached.exportId);
            if (saved.request.cacheKey === cacheKey) {
              const current = await status(saved);
              if (['ready', 'queued', 'running'].includes(current.phase)) return current;
            }
          } catch (error) {
            // Missing cache records/runs can be rebuilt; service failures must not start duplicate compute.
            if (!(error instanceof ExportError) || ![404, 409].includes(error.status)) throw error;
          }
        }
        // Concurrent first requests, including across server instances, share a Jobs idempotency token.
        // A new request ID allows a failed/cancelled generation or a manually removed file to be replaced.
        const exportId = previousExport ? digest([cacheKey, body.requestId]) : cacheKey;
        const { root, request, notebookParams } = previousExport ? prepare(exportId) : first;
        await ctx.store.create(`${root}/request.json`, request);
        const saved = await ctx.store.read(`${root}/request.json`);
        if (!validRequest(saved, exportId, ctx.viewer, root) || JSON.stringify(saved) !== JSON.stringify(request))
          throw new ExportError(409, 'This request changed. Generate a new export.');
        if (!(await ctx.store.read(`${root}/submission.json`))) {
          const runId = await deps.start(notebookParams, exportId);
          await ctx.store.create(`${root}/submission.json`, { runId });
        }
        // Persist pending as well as completed generations, so abandoning the page does not lose reuse.
        await ctx.store.write(cachePath, { exportId });
        return { exportId, phase: 'queued' };
      });
      res.status(result.phase === 'ready' ? 200 : 202).json(result);
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
    try {
      if (req.method !== 'GET') throw new ExportError(405, 'Use GET to download the export.');
      if (req.get('range')) throw new ExportError(416, 'Partial downloads are not supported. Retry the full download.');
      const ctx = await existing(req);
      const current = await status(ctx);
      if (current.phase !== 'ready')
        throw new ExportError(409, 'The export is not ready.');
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
    } catch (error) {
      handleError(res, error);
    }
  });
}
