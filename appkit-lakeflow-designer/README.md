# appkit-lakeflow-designer

The published Lakeflow Designer app: a Vite + React client and a Node/AppKit server. One published
Databricks App is deployed per published Designer flow, all sharing this single source, deployed
git-backed (the app points at this repo; Databricks pulls, builds, and runs it).

Per-app differences are injected at deploy time rather than baked into the source:

- **Runner job** — bound as an app resource named `job`, surfaced to the server as the
  `DATABRICKS_JOB_ID` env var via `app.yaml`'s `valueFrom`.
- **Manifest** (`designerApp.json`, which operators/parameters/markdown to render) — written by the
  publish flow to a per-app workspace path and read at startup from
  `${DESIGNER_MANIFEST_ROOT}/${DATABRICKS_JOB_ID}/designerApp.json`. It is keyed by the runner job id
  because that is guaranteed present via the bound `job` resource; `DATABRICKS_APP_NAME` is not
  reliably injected by the Apps runtime.

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
The manifest and runner-job contracts are unchanged.
