import type { LiHTMLAttributes, SetStateAction } from 'react';
import { Suspense, useEffect, useRef, useState } from 'react';
import type { Components, Options } from 'react-markdown';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card } from '@databricks/appkit-ui/react';

import { ActiveRunBanner } from './ActiveRunBanner';
import type {
  AppChartSpec,
  AppConfigState,
  AppManifestBlock,
  AppMarkdownBlock,
  AppOutputBlock,
  AppParameter,
  NotRunnableReason,
} from './appConfig';
import { fetchAppConfig, initialValuesFor } from './appConfig';
import type { PublishedChartRefusal } from './chartTranslation';
import { describePublishedChartRefusal, translatePublishedChart } from './chartTranslation';
import type { LandingSection } from './landingPlan';
import { FOLLOWED_RESULT_AVAILABLE_OFFER, planLandingArea } from './landingPlan';
import type { ActiveRun, LastRunState, LastRunSummary } from './lastRun';
import { fetchLastRun } from './lastRun';
import type { LastRunVariant } from './LastRunLabel';
import { LastRunLabel, relative } from './LastRunLabel';
import { ParameterForm } from './ParameterForm';
import { LazyOutputChart, preloadOutputChart } from './renderersLazy';
import { RunHistorySelect } from './RunHistoryList';
import type { RunHistoryEntry, RunHistoryState, SelectedRunState } from './runHistory';
import {
  RUN_HISTORY_FIRST_WINDOW,
  fetchRunHistory,
  fetchRunResult,
  hasNewerUnsuccessfulRun,
  isSuccessfulResultState,
} from './runHistory';
import { ResultFooter } from './ResultFooter';
import { ResultGrid } from './ResultGrid';
import { ComputeError, EmptyResult, MalformedOutput, MissingOutput, NoPayload } from './ResultStates';
import { RunStatus } from './RunStatus';
import { ThemeToggle } from './ThemeToggle';
import { useDesignerRun } from './useDesignerRun';
import { useFollowedRun } from './useFollowedRun';
import type { MatchedOutput, OkPayload, RunOutcome, RunSnapshot } from './payload';

const EMPTY_LANDING_MESSAGES = {
  loading: 'Looking for the last run…',
  unavailable: 'The last run could not be loaded. Run the operator to compute a fresh result.',
} as const;

const NOT_RUNNABLE_MESSAGES: Record<NotRunnableReason, string> = {

  noManifest: 'This app has no published outputs, so there is nothing to run. It may need republishing.',
  noJob: 'This app is not connected to a job yet, so it cannot run. Its publisher needs to finish setting it up.',
};

const remarkPlugins = [remarkGfm];

// The publisher's Lexical editor emits rich markdown with embedded HTML (blank line as `<p>&nbsp;</p>`,
// font color as `<span style>`, images as data URIs). rehype-raw renders it; rehype-sanitize (which MUST
// follow rehype-raw) is the XSS gate, tightened to just the editor's output. This mirrors the authoring
// preview's sanitizer in universe (appMarkdownSanitize.ts) so the app renders what the author saw.
const IMAGE_MIME_SUFFIXES = ['png', 'jpeg', 'jpg', 'gif', 'webp', 'svg\\+xml'].join('|');
const IMG_SRC_REGEX = new RegExp(
  `^(https://[^\\s]+|data:image/(${IMAGE_MIME_SUFFIXES});base64,[A-Za-z0-9+/=\\s]+)$`,
);

const ALLOWED_SPAN_STYLE_PROPERTIES = new Set([
  'color',
  'background-color',
  'text-decoration',
  'text-decoration-line',
  'font-weight',
  'font-style',
  'text-align',
  'display',
  'line-height',
]);

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
  attributes: {
    ...defaultSchema.attributes,
    span: [['style']],
    a: ['href', ['target', /^(?:_self|_blank)$/]],
    img: ['alt', ['src', IMG_SRC_REGEX]],
    ol: [...(defaultSchema.attributes?.ol ?? []), 'start', 'reversed'],
    // Preserve remark-gfm's task-list class hooks (only those two values) so checkbox lists keep styling.
    ul: [...(defaultSchema.attributes?.ul ?? []), ['className', 'contains-task-list']],
    li: [...(defaultSchema.attributes?.li ?? []), 'value', ['className', 'task-list-item']],
  },
};

interface StyleTreeNode {
  type: string;
  tagName?: string;
  properties?: { style?: unknown; [key: string]: unknown };
  children?: StyleTreeNode[];
}

function filterSpanStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => {
      const separator = declaration.indexOf(':');
      if (separator === -1) {
        return undefined;
      }
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();
      if (property === '' || value === '' || !ALLOWED_SPAN_STYLE_PROPERTIES.has(property)) {
        return undefined;
      }
      return `${property}:${value}`;
    })
    .filter((declaration): declaration is string => declaration !== undefined)
    .join(';');
}

// Filters each sanitizer-allowed `<span style>` down to the approved properties. Runs after sanitize.
function sanitizeStyles(): (tree: StyleTreeNode) => void {
  const visit = (node: StyleTreeNode): void => {
    if (
      node.type === 'element' &&
      node.tagName === 'span' &&
      node.properties &&
      typeof node.properties.style === 'string'
    ) {
      node.properties.style = filterSpanStyle(node.properties.style);
    }
    node.children?.forEach(visit);
  };
  return visit;
}

// Annotated so the inner [rehypeSanitize, sanitizeSchema] is a [plugin, options] tuple, not an array
// of a union; without this react-markdown v10 rejects it as an invalid Pluggable at build time.
const rehypePlugins: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  sanitizeStyles,
];

// react-markdown drops non-allowlisted URL protocols (incl. data:) before render; keep an approved
// image source so embedded images survive, and defer to the default transform for every other URL.
function transformUrl(url: string, key: string, node: { tagName?: string }): string {
  if (key === 'src' && node.tagName === 'img' && IMG_SRC_REGEX.test(url)) {
    return url;
  }
  return defaultUrlTransform(url);
}

function MarkdownCode({ children, className }: { children?: React.ReactNode; className?: string }) {
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  return (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.875em]" data-language={language}>
      {String(children).replace(/\n$/, '')}
    </code>
  );
}

function MarkdownListItem({ children, className, ...props }: LiHTMLAttributes<HTMLLIElement>) {
  const isTaskListItem = className?.includes('task-list-item') ?? false;
  return (
    <li
      {...props}
      className={
        isTaskListItem
          ? `${className ?? ''} flex list-none items-start gap-2`
          : `${className ?? ''} marker:text-muted-foreground`
      }
    >
      {children}
    </li>
  );
}

const markdownComponents: Components = {
  a: ({ href, children }) =>
    href?.startsWith('.') ? (
      <span className="text-muted-foreground">{children}</span>
    ) : (
      <a className="text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  code: MarkdownCode,
  pre: ({ children }) => <pre className="bg-muted my-3 overflow-x-auto rounded-md p-4">{children}</pre>,
  p: ({ children }) => <p className="my-3 leading-6 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mt-6 mb-3 text-2xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-6 mb-3 text-xl font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h5>,
  // appkit-ui's Tailwind base resets list-style, so restore markers + indent explicitly (a task list
  // keeps no marker; its items already carry list-none).
  ul: ({ children, className }) => (
    <ul className={`my-3 pl-6 ${className?.includes('contains-task-list') ? 'list-none' : 'list-disc'}`}>{children}</ul>
  ),
  ol: ({ children, start, reversed }) => (
    <ol className="my-3 list-decimal pl-6" start={start} reversed={reversed}>
      {children}
    </ol>
  ),
  li: MarkdownListItem,
  input: ({ checked }) => (
    <input
      className="border-border mt-1 size-4 shrink-0 accent-current"
      type="checkbox"
      checked={checked}
      disabled
      readOnly
      aria-label={checked ? 'Completed task' : 'Incomplete task'}
    />
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="border-border w-full border-collapse border text-left text-sm">{children}</table>
    </div>
  ),
  tr: ({ children }) => <tr className="border-border border-b last:border-b-0">{children}</tr>,
  th: ({ children }) => <th className="bg-muted border-border border-r px-3 py-2 font-medium last:border-r-0">{children}</th>,
  td: ({ children }) => <td className="border-border border-r px-3 py-2 align-top last:border-r-0">{children}</td>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  img: ({ src, alt }) => <img className="max-w-full" src={src} alt={alt} />,
};

type UnmatchedOutputState = 'beforeRun' | 'running' | 'omitted' | 'loading';

type PublishedBlockMatch =
  | { key: string; kind: 'markdown'; block: AppMarkdownBlock }
  | { key: string; kind: 'output'; block: AppOutputBlock; output?: MatchedOutput };

export function matchPublishedBlocks(
  blocks: AppManifestBlock[],
  outputs: MatchedOutput[],
): PublishedBlockMatch[] {
  const outputsById = new Map<string, MatchedOutput>();
  for (const output of outputs) {
    if (!output.undeclared && output.id !== undefined && !outputsById.has(output.id)) {
      outputsById.set(output.id, output);
    }
  }
  return blocks.map((block, index) =>
    block.type === 'markdown'
      ? { key: `markdown:${block.id ?? index}:${index}`, kind: 'markdown', block }
      : { key: `output:${block.id}:${index}`, kind: 'output', block, output: outputsById.get(block.id) },
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfigState>({ status: 'loading' });
  const [lastRun, setLastRun] = useState<LastRunState>({ status: 'loading' });
  const [values, setValues] = useState<Record<string, string>>({});

  const formUntouched = useRef(true);
  const { state, start, cancel, reset } = useDesignerRun();
  const [history, setHistory] = useState<RunHistoryState>({ status: 'loading' });

  const [selectedEntry, setSelectedEntry] = useState<RunHistoryEntry | undefined>(undefined);
  const [selectedRun, setSelectedRun] = useState<SelectedRunState | undefined>(undefined);

  const followed = useFollowedRun(activeRunOf(lastRun), state.phase);
  const ownFinishedRunId = state.phase === 'settled' ? state.snapshot?.jobRunId : undefined;
  const followedFinishedRunId = followed.settled ? followed.active?.run.jobRunId : undefined;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchAppConfig();
      if (cancelled) {
        return;
      }
      setConfig(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (config.status === 'ready') {
      document.title = config.manifest.appName;
    }
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchLastRun();
      if (!cancelled) {
        setLastRun(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownFinishedRunId, followedFinishedRunId]);

  const historyEnabled = config.status === 'ready' && config.runnable;

  useEffect(() => {
    if (!historyEnabled) {
      return undefined;
    }
    let cancelled = false;

    setHistory((prev) => (prev.status === 'found' ? prev : { status: 'loading' }));
    void (async () => {
      const next = await fetchRunHistory(RUN_HISTORY_FIRST_WINDOW);
      if (!cancelled) {
        setHistory(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyEnabled, ownFinishedRunId, followedFinishedRunId]);

  useEffect(() => {
    const jobRunId = selectedEntry?.jobRunId;
    if (jobRunId === undefined) {
      return undefined;
    }
    let cancelled = false;
    setSelectedRun({ status: 'loading' });
    void (async () => {
      const next = await fetchRunResult(jobRunId);
      if (!cancelled) {
        setSelectedRun(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedEntry?.jobRunId]);

  useEffect(() => {
    if (!formUntouched.current || config.status !== 'ready') {
      return;
    }
    setValues(initialValuesFor(config.manifest, lastRunValuesOf(lastRun)));
  }, [config, lastRun]);

  if (config.status === 'loading') {
    return (
      <Shell>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </Shell>
    );
  }

  if (config.status === 'unavailable') {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTitle>This app could not be loaded</AlertTitle>
          <AlertDescription>
            <p>Publishing may not have finished, or the app is missing its configuration ({config.detail}).</p>
          </AlertDescription>
        </Alert>
      </Shell>
    );
  }

  const { manifest, runnable, notRunnableReason } = config;
  const outputsLabel = describeOutputs(manifest.blocks);
  const changeValues = (next: SetStateAction<Record<string, string>>) => {
    formUntouched.current = false;
    setValues(next);
  };
  const clearSelection = () => {
    setSelectedEntry(undefined);
    setSelectedRun(undefined);
  };
  const run = () => {

    formUntouched.current = false;

    clearSelection();

    if (manifest.blocks.some((block) => block.type === 'output' && block.chartSpec !== undefined)) {
      preloadOutputChart();
    }
    void start(values);
  };
  const selectRun = (entry: RunHistoryEntry) => {

    if (state.phase === 'settled') {
      reset();
    }
    setSelectedRun({ status: 'loading' });
    setSelectedEntry(entry);
  };

  const viewFollowedResult = () => clearSelection();
  const result = state.snapshot?.result;
  const ownRunSucceeded = state.phase === 'settled' && isSuccessfulResultState(state.snapshot?.resultState);
  const ownFinishedAt = state.startedAt === undefined ? undefined : state.startedAt + state.elapsedMs;
  const followedRunSucceeded = followed.settled && isSuccessfulResultState(followed.snapshot?.resultState);
  const lastSuccessfulEntry =
    lastRun.status === 'found' ? runHistoryEntry(lastRun.run, lastRun.parameters) : undefined;
  const defaultDisplayedRun =
    state.phase === 'settled'
      ? ownRunSucceeded && state.snapshot !== undefined
        ? runHistoryEntryFromSnapshot(state.snapshot, state.startedAt)
        : lastSuccessfulEntry
      : state.phase === 'running'
        ? lastSuccessfulEntry
        : followedRunSucceeded && followed.active !== undefined
          ? runHistoryEntry(
              followed.active.run,
              followed.active.parameters,
              followed.snapshot?.resultState,
              followed.snapshot?.lifeCycleState,
            )
          : lastSuccessfulEntry;
  const displayedRun = selectedEntry ?? defaultDisplayedRun;
  const newerRunDidNotSucceed =
    selectedEntry === undefined &&
    lastRun.status === 'found' &&
    history.status === 'found' &&
    hasNewerUnsuccessfulRun(history.runs, lastRun.run.endTime);
  const historyState: RunHistoryState =
    !runnable && notRunnableReason === 'noJob' ? { status: 'noJob' } : history;
  let displayedOutputs: MatchedOutput[] = [];
  let unmatchedOutputState: UnmatchedOutputState = 'beforeRun';

  if (selectedEntry !== undefined) {
    // A run is explicitly selected: show only its outputs, never fall back to the last/followed run
    // (which would render a different run's data under the selected-run header). While it loads show
    // a loading placeholder; if it is unavailable the selected-run section above surfaces the error.
    if (selectedRun?.status === 'found') {
      displayedOutputs = outputsFrom(selectedRun.outcome);
      unmatchedOutputState = 'omitted';
    } else {
      unmatchedOutputState = selectedRun?.status === 'unavailable' ? 'omitted' : 'loading';
    }
  } else if (state.phase === 'running') {
    unmatchedOutputState = 'running';
  } else if (ownRunSucceeded) {
    displayedOutputs = outputsFrom(result);
    unmatchedOutputState = 'omitted';
  } else if (state.phase === 'settled' && lastRun.status === 'found') {
    displayedOutputs = outputsFrom(lastRun.result);
    unmatchedOutputState = 'omitted';
  } else if (followedRunSucceeded && followed.outcome !== undefined) {
    displayedOutputs = outputsFrom(followed.outcome);
    unmatchedOutputState = 'omitted';
  } else if (lastRun.status === 'found') {
    displayedOutputs = outputsFrom(lastRun.result);
    unmatchedOutputState = 'omitted';
  } else if (followed.following && !followed.settled) {
    unmatchedOutputState = 'running';
  } else if (followed.following && followed.settled) {
    // The followed run has finished without a result we can show (it failed or returned no
    // payload); surface that instead of leaving the outputs on the 'still running' placeholder.
    displayedOutputs = outputsFrom(followed.outcome);
    unmatchedOutputState = 'omitted';
  }

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{manifest.appName}</h1>
          {manifest.subtitle === undefined ? null : (
            <p className="text-muted-foreground mt-1 text-sm">{manifest.subtitle}</p>
          )}
          {}
          {manifest.provenance === undefined ? null : (
            <p
              className="text-muted-foreground mt-1 text-xs"
              title={
                manifest.provenance.generatorVersion === undefined
                  ? undefined
                  : `Generated by Designer app generator v${manifest.provenance.generatorVersion}`
              }
            >
              {`Flow published ${relative(manifest.provenance.publishedAt, Date.now())}, ${new Date(
                manifest.provenance.publishedAt,
              ).toLocaleString()}.`}
            </p>
          )}
        </div>
        <div className="flex max-w-full flex-wrap items-start justify-end gap-2">
          {runnable || notRunnableReason === 'noJob' ? (
            <RunHistorySelect state={historyState} displayedRun={displayedRun} onSelect={selectRun} />
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      <div className="grid gap-6">
        <Card className="overflow-hidden p-0">
          <ParameterForm
            parameters={manifest.parameters}
            values={values}
            onChange={changeValues}
            onRun={run}
            running={state.phase === 'running'}
            runnable={runnable}
          />

          {
}
          {!runnable && notRunnableReason !== undefined ? (
            <div className="border-border border-t px-6 py-4">
              <Alert>
                <AlertTitle>Not ready to run</AlertTitle>
                <AlertDescription>{NOT_RUNNABLE_MESSAGES[notRunnableReason]}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          {

}
          {state.phase === 'idle' || (state.phase === 'settled' && !ownRunSucceeded)
            ? planLandingArea({
                lastRun: lastRun.status,
                following: followed.following && (!followed.settled || followedRunSucceeded),
                followedSettled: followedRunSucceeded,
                selectedRun: selectedEntry !== undefined,
              }).map((section) => (
                <LandingBlock
                  key={section.kind === 'lastRun' ? `lastRun-${section.superseded}` : section.kind}
                  section={section}
                  lastRun={lastRun}
                  followedActive={followed.active}
                  followedOutcome={followed.outcome}
                  followedFinishedAt={followed.finishedAt}
                  selectedEntry={selectedEntry}
                  selectedRun={selectedRun}
                  onViewFollowedResult={viewFollowedResult}
                  declared={manifest.parameters}
                  runnable={runnable}
                  newerRunDidNotSucceed={newerRunDidNotSucceed}
                />
              ))
            : null}

          {state.phase === 'settled' && ownRunSucceeded && state.snapshot !== undefined ? (
            <LastRunLabel
              run={runHistoryEntryFromSnapshot(state.snapshot, state.startedAt)}
              parameters={state.params}
              declared={manifest.parameters}
              variant="justFinished"
              finishedAt={ownFinishedAt}
            />
          ) : null}

          {state.phase === 'running' && state.startedAt != null ? (
            <RunStatus
              snapshot={state.snapshot}
              computingLabel={outputsLabel}
              startedAt={state.startedAt}
              elapsedMs={state.elapsedMs}
              onCancel={() => void cancel()}
              cancelling={state.cancelling}
            />
          ) : null}

          {

}
          {state.phase === 'running' ? (
            <SelectedRunSection
              selectedEntry={selectedEntry}
              selectedRun={selectedRun}
              declared={manifest.parameters}
            />
          ) : null}

          {state.phase === 'settled' && state.requestError != null ? (
            <div className="border-border border-t p-6">
              <Alert variant="destructive">
                <AlertTitle>Could not reach the job</AlertTitle>
                <AlertDescription>{state.requestError}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          {state.phase === 'settled' && ownRunSucceeded && result?.outcome === 'noPayload' ? (
            <NoPayload reason={result.reason} runPageUrl={state.snapshot?.runPageUrl} />
          ) : null}
        </Card>

        <Card className="overflow-hidden p-0 [&>*:first-child]:border-t-0">
          <PublishedBlocks
            blocks={manifest.blocks}
            outputs={displayedOutputs}
            unmatchedState={unmatchedOutputState}
            onRetry={run}
          />
        </Card>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="mx-auto max-w-6xl p-6">{children}</div>
    </div>
  );
}

function activeRunOf(lastRun: LastRunState): ActiveRun | undefined {
  return lastRun.status === 'found' || lastRun.status === 'none' ? lastRun.active : undefined;
}

function outputsFrom(result: RunOutcome | undefined): MatchedOutput[] {
  return result?.outcome === 'outputs' ? result.outputs : [];
}

function runHistoryEntry(
  run: LastRunSummary,
  parameters?: Record<string, string>,
  resultState?: string,
  lifeCycleState?: string,
): RunHistoryEntry {
  return {
    ...run,
    ...(parameters === undefined ? {} : { parameters }),
    ...(resultState === undefined ? {} : { resultState }),
    ...(lifeCycleState === undefined ? {} : { lifeCycleState }),
  };
}

function runHistoryEntryFromSnapshot(snapshot: RunSnapshot, startedAt: number | undefined): RunHistoryEntry {
  return {
    jobRunId: snapshot.jobRunId,
    ...(startedAt === undefined ? {} : { startTime: startedAt }),
    ...(snapshot.setupDurationMs === undefined ? {} : { setupDurationMs: snapshot.setupDurationMs }),
    ...(snapshot.executionDurationMs === undefined ? {} : { executionDurationMs: snapshot.executionDurationMs }),
    ...(snapshot.runPageUrl === undefined ? {} : { runPageUrl: snapshot.runPageUrl }),
    ...(snapshot.resultState === undefined ? {} : { resultState: snapshot.resultState }),
    ...(snapshot.lifeCycleState === undefined ? {} : { lifeCycleState: snapshot.lifeCycleState }),
  };
}

// Missing recorded parameters stay absent; published defaults would misstate what actually ran.
function lastRunValuesOf(lastRun: LastRunState): Record<string, string> | undefined {
  const active = activeRunOf(lastRun);
  if (active?.parameters !== undefined) {
    return active.parameters;
  }
  return lastRun.status === 'found' ? lastRun.parameters : undefined;
}

function LandingBlock({
  section,
  lastRun,
  followedActive,
  followedOutcome,
  followedFinishedAt,
  selectedEntry,
  selectedRun,
  onViewFollowedResult,
  declared,
  runnable,
  newerRunDidNotSucceed,
}: {
  section: LandingSection;
  lastRun: LastRunState;
  followedActive?: ActiveRun;
  followedOutcome?: RunOutcome;
  followedFinishedAt?: number;
  selectedEntry?: RunHistoryEntry;
  selectedRun?: SelectedRunState;
  onViewFollowedResult: () => void;
  declared: AppParameter[];
  runnable: boolean;
  newerRunDidNotSucceed: boolean;
}) {
  if (section.kind === 'activeRun') {
    return followedActive === undefined ? null : <ActiveRunBanner active={followedActive} declared={declared} />;
  }

  if (section.kind === 'followedResult') {

    return followedActive === undefined || followedOutcome === undefined ? null : (
      <RunResult
        run={followedActive.run}
        parameters={followedActive.parameters}
        result={followedOutcome}
        declared={declared}
        variant="justFinished"
        finishedAt={followedFinishedAt}
      />
    );
  }

  if (section.kind === 'selectedRun') {
    return (
      <SelectedRunSection
        selectedEntry={selectedEntry}
        selectedRun={selectedRun}
        declared={declared}
      />
    );
  }

  if (section.kind === 'followedResultAvailable') {

    return followedActive === undefined || followedOutcome === undefined ? null : (
      <div className="border-border bg-muted/40 border-t px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant="secondary" className="font-normal">
            Run finished
          </Badge>
          <p className="text-muted-foreground flex-1 text-xs">{FOLLOWED_RESULT_AVAILABLE_OFFER}</p>
          <Button variant="outline" size="sm" onClick={onViewFollowedResult}>
            View the finished run
          </Button>
        </div>
      </div>
    );
  }

  if (section.kind === 'lastRun') {
    return lastRun.status !== 'found' ? null : (
      <RunResult
        run={lastRun.run}
        parameters={lastRun.parameters}
        result={lastRun.result}
        declared={declared}
        variant={section.superseded ? 'superseded' : 'last'}
        newerRunDidNotSucceed={newerRunDidNotSucceed}
      />
    );
  }

  if (section.reason === 'never') {
    return null;
  }

  return runnable ? (
    <div className="border-border text-muted-foreground border-t px-6 py-12 text-center text-sm">
      {EMPTY_LANDING_MESSAGES[section.reason]}
    </div>
  ) : null;
}

function SelectedRunSection({
  selectedEntry,
  selectedRun,
  declared,
}: {
  selectedEntry?: RunHistoryEntry;
  selectedRun?: SelectedRunState;
  declared: AppParameter[];
}) {
  if (selectedEntry === undefined || selectedRun === undefined) {
    return null;
  }
  if (selectedRun.status === 'loading') {
    return (
      <div className="border-border text-muted-foreground border-t px-6 py-12 text-center text-sm">
        Loading run {selectedEntry.jobRunId}…
      </div>
    );
  }
  if (selectedRun.status === 'unavailable') {

    return (
      <div className="border-border border-t p-6">
        <Alert variant="destructive">
          <AlertTitle>That run could not be loaded</AlertTitle>
          <AlertDescription>{selectedRun.reason}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <RunResult
      run={{
        jobRunId: selectedEntry.jobRunId,
        ...(selectedEntry.endTime === undefined ? {} : { endTime: selectedEntry.endTime }),
        ...(selectedEntry.startTime === undefined ? {} : { startTime: selectedEntry.startTime }),
        ...(selectedEntry.runPageUrl === undefined ? {} : { runPageUrl: selectedEntry.runPageUrl }),
      }}
      parameters={selectedEntry.parameters}
      result={selectedRun.outcome}
      declared={declared}
      variant="historical"
    />
  );
}

function RunResult({
  run,
  parameters,
  result,
  declared,
  variant,
  finishedAt,
  newerRunDidNotSucceed = false,
}: {
  run: LastRunSummary;
  parameters?: Record<string, string>;
  result: RunOutcome;
  declared: AppParameter[];
  variant: LastRunVariant;
  finishedAt?: number;
  newerRunDidNotSucceed?: boolean;
}) {
  return (
    <>
      <LastRunLabel
        run={run}
        parameters={parameters}
        declared={declared}
        variant={variant}
        finishedAt={finishedAt}
        newerRunDidNotSucceed={newerRunDidNotSucceed}
      />
      {result.outcome === 'noPayload' ? <NoPayload reason={result.reason} runPageUrl={run.runPageUrl} /> : null}
    </>
  );
}

function PublishedBlocks({
  blocks,
  outputs,
  unmatchedState,
  onRetry,
}: {
  blocks: AppManifestBlock[];
  outputs: MatchedOutput[];
  unmatchedState: UnmatchedOutputState;
  onRetry: () => void;
}) {
  const matchedBlocks = matchPublishedBlocks(blocks, outputs);
  const undeclaredOutputs = outputs.filter((output) => output.undeclared);
  return (
    <>
      {matchedBlocks.map((match) =>
        match.kind === 'markdown' ? (
          <MarkdownBlock key={match.key} block={match.block} />
        ) : (
          <PublishedOutputBlock
            key={match.key}
            block={match.block}
            output={match.output}
            unmatchedState={unmatchedState}
            onRetry={onRetry}
          />
        ),
      )}
      {undeclaredOutputs.map((output) => (
        <OutputSection key={output.key} output={output} onRetry={onRetry} />
      ))}
    </>
  );
}

function MarkdownBlock({ block }: { block: AppMarkdownBlock }) {
  return (
    <section className="border-border border-t px-6 py-5">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={transformUrl}
      >
        {block.text}
      </ReactMarkdown>
    </section>
  );
}

function PublishedOutputBlock({
  block,
  output,
  unmatchedState,
  onRetry,
}: {
  block: AppOutputBlock;
  output?: MatchedOutput;
  unmatchedState: UnmatchedOutputState;
  onRetry: () => void;
}) {
  if (output === undefined) {
    return (
      <section className="border-border border-t [&>*]:border-t-0">
        <OutputHeading title={outputTitle(block)} undeclared={false} />
        <UnmatchedOutput state={unmatchedState} />
      </section>
    );
  }
  return (
    <OutputSection
      output={{
        ...output,
        title: outputTitle(block),
        ...(block.chartSpec === undefined ? { chartSpec: undefined } : { chartSpec: block.chartSpec }),
        undeclared: false,
      }}
      onRetry={onRetry}
    />
  );
}

function UnmatchedOutput({ state }: { state: UnmatchedOutputState }) {
  if (state === 'omitted') {
    return <MissingOutput reason="The run finished without returning a result for this published output." />;
  }
  return (
    <div className="border-border text-muted-foreground border-t px-6 py-8 text-left text-sm">
      {state === 'running'
        ? 'This output will appear when the current run finishes.'
        : state === 'loading'
          ? 'Loading this output…'
          : 'Run the app to populate this output.'}
    </div>
  );
}

function outputTitle(block: AppOutputBlock): string {
  return block.label !== '' ? block.label : block.nodeId !== '' ? block.nodeId : block.id;
}

function OutputHeading({
  title,
  undeclared,
}: {
  title: string;
  undeclared: boolean;
}) {
  return (
    <div className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t px-6 pt-5 pb-1">
      <h2 className="text-sm font-medium">{title}</h2>
      {undeclared ? (
        <span className="text-muted-foreground text-xs">
          Returned by the run but not among this app&apos;s published outputs. It may need republishing.
        </span>
      ) : null}
    </div>
  );
}

function OutputSection({ output, onRetry }: { output: MatchedOutput; onRetry: () => void }) {
  const { outcome } = output;
  return (
    <section className="border-border border-t [&>*]:border-t-0">
      <OutputHeading title={output.title} undeclared={output.undeclared} />
      {outcome.outcome === 'result' ? (
        <ResultSection payload={outcome.payload} chartSpec={output.chartSpec} />
      ) : null}
      {outcome.outcome === 'computeError' ? <ComputeError payload={outcome.payload} onRetry={onRetry} /> : null}
      {outcome.outcome === 'malformed' ? <MalformedOutput reason={outcome.reason} /> : null}
      {outcome.outcome === 'missing' ? <MissingOutput reason={outcome.reason} /> : null}
    </section>
  );
}

function ResultSection({ payload, chartSpec }: { payload: OkPayload; chartSpec?: AppChartSpec }) {
  if (payload.rows.length === 0) {
    return (
      <>
        <EmptyResult />
        <ResultFooter payload={payload} />
      </>
    );
  }
  const chart =
    chartSpec === undefined
      ? undefined
      : translatePublishedChart({ chartSpec, schema: payload.schema });
  if (chart !== undefined && chart.ok) {
    return (
      <>
        <TruncatedChartWarning payload={payload} />
        <div className="px-6 py-4">
          <Suspense fallback={<p className="text-muted-foreground py-8 text-center text-sm">Loading chart…</p>}>
            <LazyOutputChart plan={chart.plan} rows={payload.rows} fallback={<ResultGrid payload={payload} />} />
          </Suspense>
        </div>
        <ResultFooter payload={payload} />
      </>
    );
  }
  return (
    <>
      {chart === undefined ? null : <ChartRefusedNote refusal={chart.refusal} />}
      <ResultGrid payload={payload} />
      <ResultFooter payload={payload} />
    </>
  );
}

function TruncatedChartWarning({ payload }: { payload: OkPayload }) {
  if (payload.truncated !== true) {
    return null;
  }
  return (
    <div className="border-border border-t px-6 pt-4">
      <Alert>
        <AlertTitle>This chart is drawn from part of the result</AlertTitle>
        <AlertDescription>
          {`This chart uses only the ${payload.rows.length.toLocaleString()} rows shown in this preview. There may be categories, peaks and totals it does not show.`}
        </AlertDescription>
      </Alert>
    </div>
  );
}

function ChartRefusedNote({ refusal }: { refusal: PublishedChartRefusal }) {
  return (
    <div className="border-border text-muted-foreground border-t px-6 pt-4 text-xs">
      {describePublishedChartRefusal(refusal)}
    </div>
  );
}

function describeOutputs(blocks: AppManifestBlock[]): string {
  const outputs = blocks.filter((block): block is AppOutputBlock => block.type === 'output');
  if (outputs.length === 1) {
    const only = outputs[0];
    return only.label !== '' ? only.label : only.nodeId !== '' ? only.nodeId : only.id;
  }
  return `${outputs.length} outputs`;
}
