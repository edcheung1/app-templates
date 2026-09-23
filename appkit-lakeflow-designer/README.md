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
When the notebook export itself overflowed, the total is unknown. The generated runner and its
operator cells are unchanged; no additional counting queries or result cells are added.

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

## File upload parameters

Manifest v4 adds `uploads: { volume, path, maxFileSizeBytes }` and parameter `type: "file"`.
The server/client still read v3 for apps without uploads; a file parameter without valid v4
storage is rejected, never downgraded to a text field or the author's original source path.
Deploy this template before enabling Designer's `enableDesignerApps` flag; uploads share that gate.

Designer provisions a per-app managed UC volume during publishing (or binds an author-selected
existing volume). The `designer_uploads` App resource with `WRITE_VOLUME` gives the app service
principal read/write access; the runner job's run-as principal also needs read access. Uploads
use AppKit's Files plugin, not workspace files or app-container disk. No operator code changes are needed.
The plugin is initialized lazily from the manifest in a backend-only AppKit instance (no server plugin).
Its generic file-browser routes are never mounted; the Designer routes enforce viewer/parameter ownership.
Upload, bounded sidecar reads, metadata, directory creation, and deletion all use the plugin API.

Viewers stage files up to 5 GiB in the browser. Clicking Run streams the staged files through the app
server to the configured Unity Catalog volume before starting the job. Bytes are capped while reading, and the
server limits concurrent upload requests to four. A completed upload gets an immutable generated
directory preserving the original filename and a persisted sidecar; only completed uploads can become
job input. The browser holds an opaque upload reference, not an arbitrary volume path. Uploads are
format-agnostic: the Source operator's configured
format, read options (including Excel sheet/range), and expected columns are unchanged. Uploading
a file does not infer or change that format; schema/parse errors are reported by the normal job run.

The app requires the authenticated `x-forwarded-user` header supplied by Databricks Apps ingress.
Do not expose this server directly to untrusted traffic that can supply its own identity headers.
There is no anonymous/local-development fallback. Uploads are partitioned by job, viewer and
parameter. Run submissions carry a server-owned `_lb_app_viewer` parameter; history, result reads,
and cancellation enforce it even if upload controls are later removed. Existing users with
direct Jobs or UC permissions, and volume owners/admins, are outside this in-app isolation boundary.

Files are retained until the volume owner deletes them. There is no automatic expiration, consumer
delete action, or deletion of storage when an App is deleted. The app does not expose retained files
for selection; viewers select a local file for each browser session. Manual cleanup must account for queued, running, retrying jobs.
Storage paths cannot be changed by republishing, so old references stay bound to the same volume.

`npm test` covers storage completion/partial failures, limits, parameter resolution and ownership
policy with an in-memory storage boundary, plus server-route access checks and history hydration.
Actual Apps ingress, UC provisioning/grants and Jobs
execution still require a deployed smoke test; a local build alone does not validate those services.
