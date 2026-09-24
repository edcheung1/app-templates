# appkit-lakeflow-designer

The published Lakeflow Designer app: a Vite + React client and a Node/AppKit server. One published
Databricks App is deployed per published Designer flow, all sharing this single source, deployed
git-backed (the app points at this repo; Databricks pulls, builds, and runs it).

Per-app differences are injected at deploy time rather than baked into the source:

- **Runner job** — bound as an app resource named `job`, surfaced to the server as the
  `DATABRICKS_JOB_ID` env var via `app.yaml`'s `valueFrom`.
- **Manifest** (`designerApp.json`, which operators/parameters/markdown to render) — written by the
  publish flow beside the runner notebook in its publisher-owned workspace folder. The server
  derives that folder from the bound job's notebook path; no shared manifest root is needed.

## Layout

- `server/server.ts` — the Node/AppKit server (TypeScript). Type-checked and bundled by
  `build:server` (`tsc -b` + `tsdown`) to `dist/server.js`, which `start` runs.
- `server/uploads.ts` / `server/exports.ts` — upload and on-demand export routes. Their store
  adapters share AppKit volume setup and SDK normalization in `server/storageVolume.ts`, with
  separate upload/export subtree policies, caches, and error handling.
- `client/` — the React client, built by Vite to `client/dist`.
- `app.yaml` — start command and env bindings (`command: ['npm', 'run', 'start']`).
- `tsconfig.shared.json` / `tsconfig.server.json` / `tsconfig.client.json` — a strict shared base
  with a server (Node) and a client (DOM) project, referenced by the root `tsconfig.json`.
- `package.json` — `build` (`build:server` then `build:client`) and `start`
  (`node ./dist/server.js`). Everything the server needs at build and run time is under
  `dependencies` (Databricks Apps skips `devDependencies` when `NODE_ENV=production`).

## Local build

    npm install
    npm run build   # build:server (tsc -b + tsdown -> dist/server.js) + build:client (vite -> client/dist)
    npm run typecheck
    npm run dev    # client-only development; API requests still require the AppKit server
    npm start       # node ./dist/server.js

## Result previews

The app reads each run's exported notebook display results and sends at most 1,000 rows per output
to the client. Tables and charts use this same bounded preview. The notebook's `overflow` flag is
preserved; it can indicate a row or byte limit, so the app does not label it as sampling or guess
which limit was reached. Missing overflow metadata means completeness is unknown, not complete.

The footer shows `1,000 / 1,500 rows` when a complete export supplies an exact total, or `1,000 rows shown`
with a **Truncated** badge when the notebook overflowed without a known total. Complete small
results simply show their row count. Charts warn when they use a truncated result.

A complete export capped only by the app can use its original length as the exact total.
When the notebook export itself overflowed, an exact total comes from the runner's structured
row-count result when available; otherwise it remains unknown. App runs request counts for
published output nodes. The shared Python runtime emits those counts after the table displays.

The app does not trigger a new count query or rerun the job when loading results. Full-data
downloads are not implemented by the preview path.

## Chart rendering

Published bar, line, area, and pie charts use Vega-Lite/Vega, the same chart engine family as
Designer's standard charts. `chartTranslation.ts` validates the manifest's Databricks chart spec;
`chartData.ts` prepares typed, long-format rows and sorted domains; `chartSpec.ts` builds a
Vega-Lite spec; `OutputChart.tsx` embeds it as responsive SVG. Charts use Designer's default
visualization palette. AppKit still supplies the surrounding UI and theme-aware axis/grid colors.
The renderer stays in a lazy-loaded client chunk.
Chart frame titles are hidden, matching Designer; the output block's heading remains visible.

Bars retain their declared orientation and use Designer's band spacing. Color series default to
stacked bars/areas; explicit grouped, layered, and percent-stacked layouts are supported. Lines
map `smooth` to monotone interpolation and `step` to step-after. Pies use Designer's 50% donut
hole by default and honor `mark.innerRadius` (0–100%). Axes honor titles, visibility, label angles,
numeric domain bounds and reversal. Categorical X labels rotate when space is tight. Numeric and
temporal coordinates remain continuous; category labels are never inferred as dates.

Categorical axes and series honor `scale.sort`: natural/reversed, original/reversed, custom lists,
and sorting by X, Y, angle, or a numeric measure present in the result. With no explicit sort,
categories use Designer's schema-aware natural order (lexicographic for strings, numeric for
numbers); pie slices default to descending angle totals. Unlisted custom-order values follow in
natural order. Measure-based sorting ranks category totals without pivoting or aggregating the
returned rows, keeping data aligned and category colors stable across explicit sort changes. Horizontal categories read
top to bottom. Continuous X coordinates remain ascending.

This is not a full Designer visualization renderer. Measure sorting uses sums of the returned
rows: the published result does not include Designer's column-transform metadata or separate
grouping results needed for more advanced aggregation semantics, such as custom MIN/MAX sorts.
Designer-specific formatters, advanced color mappings, custom legends/tooltips, annotations,
facets, additional encoding channels and chart types are not reproduced. Default label rotation
uses an estimated text width, not Designer's measured text layout. This is closer to Designer,
not pixel-identical. Unsupported chart types, unrecognized sort settings, missing sort fields,
and runtime rendering failures fall back to the result table.

Run `npm test` with Node 22.18+ to check translation, sorting, and real Vega-Lite compilation/Vega
SVG rendering, including resizing, stacked totals, category colors, and empty results. No
Playwright tests or additional test dependencies are required.

The renderer pins [Vega](https://github.com/vega/vega) 6.2.0,
[Vega-Lite](https://github.com/vega/vega-lite) 6.4.3, and
[Vega Embed](https://github.com/vega/vega-embed) 7.0.2. All three use the BSD-3-Clause license;
the lockfile records package integrity hashes. Installs during development use the internal
package proxy, but the committed lockfile must use `https://registry.npmjs.org/` for all
package URLs so published apps do not depend on corporate network access. After dependency
updates, normalize any proxy URLs in the lockfile without changing versions or integrity
hashes; changing npm's registry setting alone does not rewrite existing lockfile URLs.
Chart rendering does not change the manifest or runner-job contracts.

## Shared App storage and file upload parameters

Manifest v5 uses one optional storage declaration for uploads and on-demand exports:

```json
{
  "version": 5,
  "storage": {
    "volume": "main.apps.shared",
    "path": "/Volumes/main/apps/shared/designer_apps/my_app",
    "maxUploadFileSizeBytes": 5368709120
  }
}
```

The server/client accept v5 only. Apps without file parameters or exports may omit storage; a file
parameter or `exports: true` without valid storage is rejected. File inputs are never downgraded
to text or the author's original source path.
Update the template and republish existing apps together; there is no legacy-manifest fallback.
The app is unavailable between the template update and the v5 manifest write.
Deploy this template before enabling Designer's `enableDesignerApps` flag; uploads share that gate.

The author selects a UC volume in Designer; publishing binds it without creating another volume.
The existing `designer_uploads` App resource with `WRITE_VOLUME` gives the app service
principal read/write access; the runner job's run-as principal also needs read access and, for
exports, write access. Uploads
use AppKit's Files plugin, not workspace files or app-container disk. No operator code changes are needed.
The plugin is initialized lazily from the manifest in a backend-only AppKit instance (no server plugin).
Its generic file-browser routes are never mounted; the Designer routes enforce viewer/parameter ownership.
Upload, bounded sidecar reads, metadata, directory creation, and deletion all use the plugin API.

Viewers stage files up to 5 GiB in the browser. Clicking Run streams the staged files through the app
server to the configured Unity Catalog volume before starting the job. Bytes are capped while reading, and the
server limits concurrent upload requests to four. A completed upload gets an immutable generated
directory preserving the original filename and a persisted sidecar; only completed uploads can become
job input. The browser holds an opaque upload reference, not an arbitrary volume path. Publishing
records each upload parameter's static Source formats in `fileFormats`. The picker filters known
extensions; browser and server reject mismatched filenames before upload, and run submission rechecks
retained uploads against the current manifest. A parameter used by multiple Sources must match all
their static constraints. Text/binary readers, inferred formats, unknown providers and formats
parameterized at runtime have no filename restriction.
This is extension validation, not content or schema validation: renamed or malformed files still
reach the reader. Uploading never changes the Source format, read options (including Excel
sheet/range), or expected columns. Parse/schema errors are reported by the normal Job run.

The app requires the authenticated `x-forwarded-user` header supplied by Databricks Apps ingress.
Do not expose this server directly to untrusted traffic that can supply its own identity headers.
There is no anonymous/local-development fallback. Uploads are partitioned by job, viewer and
parameter. Run submissions carry a server-owned `_lb_app_viewer` parameter; history, result reads,
and cancellation enforce it even if upload controls are later removed. Existing users with
direct Jobs or UC permissions, and volume owners/admins, are outside this in-app isolation boundary.

Uploaded files are retained until the volume owner deletes them. There is no automatic expiration, consumer
delete action, or deletion of storage when an App is deleted. The app does not expose retained files
for selection; viewers select a local file for each browser session. Manual cleanup must account for queued, running, retrying jobs.
Uploads use `<storage.path>/uploads/<viewer-hash>/<parameter-hash>/<upload-id>/<filename>`.
Exports use `<storage.path>/exports/<viewer-hash>/<request-hash>/`. Separate backend-only Files
plugin policies restrict upload and export operations to their respective subtrees.
Existing files are not moved or deleted; viewers upload a new file after the app adopts the new root.
The Files plugin refreshes its path policy when the manifest root changes within the same volume; no restart is needed.
Replacing the bound volume remains unsupported.

`npm test` covers storage completion/partial failures, limits, parameter resolution and ownership
policy with an in-memory storage boundary, plus server-route access checks and history hydration.
Actual Apps ingress, UC provisioning/grants and Jobs
execution still require a deployed smoke test; a local build alone does not validate those services.

## On-demand CSV and Excel downloads

Authors enable full-data downloads in Designer's App storage settings; the manifest then has
`exports: true`. Viewers choose Generate CSV or Generate Excel on a successful published table output.
Visualizations do not show download controls or a row-count footer, even when they fall back to a table.
The App verifies run ownership, Job identity, output membership, the runner notebook, and an execution revision,
then reuses a matching generated file or pending generation before starting an idempotent export run
using that source run's recorded parameters. On a cache miss, data is recomputed at export time, not
retrieved from a historical snapshot. The revision covers output IDs/ports and their
execution plans, parameter names, and storage location. Presentation changes (labels, layout, chart
settings, publication timestamps) and new defaults do not invalidate recorded results. Changed runner
code or execution configuration requires a new App run. Runs using the previous whole-manifest hash
need one new App run after upgrading this template. Generating or downloading an export does not
invalidate its source run; subsequent exports can use the same run, including different outputs.
Cache entries are isolated by viewer, Job, source run, output, format, execution revision, recorded
parameters and runner notebook path/content. Their index is persisted under
`<storage.path>/exports/<viewer-hash>/cache/`, so reuse survives browser and server restarts.
CSV and Excel have independent entries. Failed/cancelled generations and missing/incomplete files
can be regenerated with a new request ID, without overwriting old artifacts. Changes to upstream
tables or files are not detected automatically: run the App again to export newer source data.
Export status includes a **View job run** link once Jobs supplies its run URL, including after failure.
Opening that link requires the viewer's own workspace/Job permissions; the App does not grant them.

For download-enabled apps, each output block in `designerApp.json` contains `executionNodeIds`:
the target and its ancestors, computed at publication with Designer's Run up to graph helper.
The manifest remains beside the runner in Workspace files, not in the storage volume. The server
passes the selected output's plan in `_lb_export_request`; the browser cannot choose execution nodes.
Missing/invalid plans require republishing. Republish installs the updated manifest, helper, and runner;
then run the App again before exporting. Oversized plans/parameters are rejected before Job submission.
The server also checks the current runner source for the target export hook and execution guards;
outdated or modified runners require republishing instead of starting a job that cannot export.
Treat published runners as deployment artifacts: edit the original Designer document and republish.

The Python helper lives in Universe alongside shared operator codegen, not in this Node.js app.
Designer publishes a content-addressed `.py` file beside the runner notebook and pins the generated
imports to it. The dormant hook also serves full row counts on ordinary App runs. Normal Designer
runs do not import it. Every operator's wiring has a small `should_run(node_id)` guard; export runs skip
unrelated config evaluation, input lookups, operator execution, checkpoints, and output hooks.
Ordinary App runs still execute all published branches. Operator function definitions/imports remain
at module scope. Export runs disable preview displays/counts, write just the selected output,
then exit. The Job's run-as identity must read the helper and write to the volume; Excel generation
additionally requires `openpyxl==3.1.5` in the Job environment.

Both formats have hard limits of 1,000,000 data rows, 5,000,000 data cells, and 256 MiB, with no
silent truncation. Excel uses a write-only workbook; unsupported Excel cell values fail with an
actionable error. Formula-like strings are exported as literals. No Output operator is required.

The browser downloads through an authenticated same-origin attachment endpoint. The App server
streams UC bytes without buffering the full file or exposing a presigned cloud URL. Downloads are
read-only and may run concurrently. Completed and interrupted transfers both retain the artifact;
the same file can be downloaded repeatedly without starting another Job. No download lock or
consumption marker is needed.

There is no automatic TTL, cleanup Job, or consumer DELETE endpoint. Generated files, abandoned
or failed exports, cache indexes and request metadata remain in the volume until manually removed.
Downloads never delete exports, uploads or published helper versions.
