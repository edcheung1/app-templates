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
    npm start       # node ./dist/server.js

## Chart rendering

Published charts use AppKit's themed option builders with the Designer spec's axis roles,
titles, and line shape. Bars with a categorical X axis stay vertical; bars with a categorical
Y axis stay horizontal. Numeric and temporal X axes use continuous coordinates. Category labels
and supplied row order are preserved rather than inferred from their values.

This is not a full Designer visualization renderer. Advanced sorting, aggregation, layouts,
formatting, and chart types still need additional support. Unsupported chart types fall back
to the result table.

Run `npm test` with Node 22.18+ to check chart translation and the real AppKit-generated options.
The tests use the existing bundler; no browser or additional test dependencies are required.
