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

- `build/server.js` — the Node/AppKit server. Authored JS committed as source (not a build artifact),
  run directly by `start`.
- `client/` — the React client, built by Vite to `client/dist`.
- `app.yaml` — start command and env bindings.
- `package.json` — `build` (client typecheck + `vite build`) and `start` (`node build/server.js`);
  dependencies include `@databricks/appkit` for the server.

## Local build

    npm install
    npm run build   # typecheck client + vite build -> client/dist
    npm start       # node build/server.js
