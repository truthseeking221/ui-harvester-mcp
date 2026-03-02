# UI Harvester MCP

This MCP server extracts design data from a live website/web app using **rendered evidence** (screenshots + computed style + geometry), then normalizes it into a reusable design package for any workflow: Cursor, another IDE, custom CLI, or internal automation.

This is not raw HTML/CSS scraping.  
The goal is to produce a `snapshot` with traceable evidence that can be used to:

- Restyle any target codebase.
- Run visual diff validation.
- Generate design assets for import into Figma through the generated Figma-compatible payloads.

Precision scope is intentionally limited to what was actually rendered in the crawl session.  
The contract is **`observed-only`**: route/state/theme/viewports that were visited and measured.

## 1) Install

```bash
npm install
npm run build
npx playwright install chromium
```
### Browser requirement

- `crawl_and_capture` and `extract_design_system` run in a local Playwright Chromium runtime.
- Install browser binaries once with:
  - `npx playwright install chromium`
- Keep browsers local; no remote rendering endpoint is used.

```bash
npm run test
npm run lint
npm run typecheck
```

### 1.1) NPX and Local Git support

You can install in 3 ways:

1. NPX (when published on npm):

```bash
npx ui-harvester-mcp
```

> Note: this command requires the package to be available on npm. For private repos, use Local Git or local STDIO.

2. Local Git (install directly from git):

```bash
npx -y git+https://github.com/<org>/<repo>.git
```

Note: the `prepare` script builds `dist/` before the binary is exposed.

3. Local project (direct STDIO):

```bash
npm install
npm run build
node dist/index.js
```

## 2) Run MCP server

```bash
npm start
```

## 3) Configure MCP Client (Cursor / VSCode / custom CLI driver)

```json
{
  "mcpServers": {
    "ui-harvester-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/UI Harvester MCP/dist/index.js"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

For custom agents/CLI drivers, spawn `node dist/index.js` and speak MCP JSON-RPC directly.

### NPX / Local Git MCP config example (STDIO)

```json
{
  "mcpServers": {
    "ui-harvester-mcp (npm)": {
      "command": "npx",
      "args": ["ui-harvester-mcp"]
    },
    "ui-harvester-mcp (local git)": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/<org>/<repo>.git"]
    }
  }
}
```

### Local (path) STDIO config

```json
{
  "mcpServers": {
    "ui-harvester-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/UI Harvester MCP/dist/index.js"]
    }
  }
}
```

If you do not want to prebuild, replace `dist/index.js` with the TypeScript dev command:

```json
{
  "mcpServers": {
    "ui-harvester-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/UI Harvester MCP/node_modules/.bin/tsx", "/ABSOLUTE/PATH/to/UI Harvester MCP/src/index.ts"]
    }
  }
}
```

## 4) Tools

- `crawl_and_capture` (alias: `extract_design_system`)
- `get_snapshot`
- `list_snapshots`
- `export_design_tokens`
- `export_component_recipes`
- `export_design_package` (recommended for pipeline integration)
- `export_css_variables`
- `export_tailwind_v4_theme`
- `apply_snapshot_to_project`
- `validate_visual_match`

### `crawl_and_capture` options

- `url`: target website URL.
- `viewports`: optional array of viewport configs (`name`, `width`, `height`, optional `deviceScaleFactor`).
- `themes`: optional array of theme modes.
- `sameOriginPages`: max number of same-origin routes visited.
- `routeDepth`: max link depth for same-origin discovery.
- `cleaningProfile` (`high` | `balanced` | `minimal`, default: `high`).
- `cleaningProfile` controls how aggressive extraction cleanup is:
  - `high`: strict normalization, dedupe, outlier filtering for spacing/radius/font-size and single-visit noise filtering.
  - `balanced`: medium cleanup; still canonicalizes values but keeps more unique signals.
  - `minimal`: mostly canonicalizes only (mostly passthrough behavior).
- Response includes `cleaning` in `provenance` with report counters: `samplesSeen`, `samplesKept`, `samplesDropped`, `mergedColorCount`, `spacingOutliersRemoved`, `stateRecordsDropped`.
- `iconCaptureProfile` (`all` | `selected` | `favicon-only`, default: `all`):
  - `all`: `link` icons, manifest icons, image/icon-like tags, and CSS background image candidates.
  - `selected`: `link` + manifest + image-like candidates.
  - `favicon-only`: only `link`-based favicon candidates.
- `interactionBudget`, `stateBudget`, `maxSamplesPerViewport`, `sampleStride`, `waitConfig`, `authStatePath`, and `exactnessMode` are also accepted.

Output quality notes for icon capture:

- Every discovered icon candidate is attempted.
- Each asset record includes `captured`, `skipped`, or `failed` with explicit reason.
- Duplicate URL and duplicate content attempts are tracked in capture summary.

### `export_design_tokens`

Supported formats:

- `css-vars`
- `tailwind-v4`
- `theme-object`
- `dtcg-json`
- `figma-variables`
- `figma-styles`
- `figma-package`
- `universal-package`

### `export_design_package`

Writes a reusable package into:

- `.design-extractor/snapshots/{snapshotId}/artifacts/universal/`

Included files:

- `universal/package.json` (manifest)
- `universal/manifest.css-variables.css`
- `universal/tailwind-v4.css`
- `universal/theme-object.json`
- `universal/components.json`
- `universal/dtcg-tokens.json`
- `universal/figma/variables.json`
- `universal/figma/styles.json`
- `universal/figma/import-blueprint.json`
- `universal/assets/index.json`
- `universal/assets/icons/index.json`
- `universal/evidence/routes.jsonl`
- `universal/evidence/pages.json`

## 5) Resources

- `ui://snapshots/{snapshotId}/manifest`
- `ui://snapshots/{snapshotId}/tokens/core`
- `ui://snapshots/{snapshotId}/tokens/semantic`
- `ui://snapshots/{snapshotId}/components/all`
- `ui://snapshots/{snapshotId}/validation/report`
- `ui://snapshots/{snapshotId}/artifacts/{artifact}`

Shortcut artifact keys:

- `manifest`
- `universal-manifest`
- `universal-css-vars`
- `universal-tailwind`
- `universal-theme-object`
- `universal-components`
- `universal-dtcg`
- `universal-figma-variables`
- `universal-figma-styles`
- `universal-figma-blueprint`
- `universal-assets`
- `universal-assets-index`
- `universal-assets-icons`
- `universal-evidence-routes`
- `universal-evidence-pages`

`ui://snapshots/{snapshotId}/artifacts/manifest` is a shortcut for the exported manifest and returns:

- `universal/package.json`

## 6) Prompts

- `apply-source-style-to-current-project`
- `refactor-local-components-to-match-snapshot`
- `fix-high-visual-diff-components`
- `prepare-figma-import-pack`

## 7) Standard workflow (editor-agnostic)

1. Run `crawl_and_capture` with `url`, `viewports` (for example mobile + desktop), `themes` (`light`, `dark`), `sameOriginPages`, `routeDepth`, `interactionBudget`, `stateBudget`.
2. Store `snapshotId`.
3. Run `export_design_package({ snapshotId, targetStack })`.
4. Read from `ui://snapshots/{id}/artifacts/universal-manifest` and `ui://snapshots/{id}/artifacts/universal-*`.
5. If icon harvest is required, read `universal/assets/index.json` and `universal/assets/icons/index.json`.
6. Map into target project for Tailwind by importing `universal/manifest.css-variables.css` and `universal/tailwind-v4.css`.
7. Map into target project for MUI/Chakra/Styled/CSS Modules by using `universal/theme-object.json` and `universal/components.json`.
8. Run `validate_visual_match` after applying styles and refine until within thresholds.

## 8) Direct Figma flow

Figma package flow:

1. Run `export_design_package({ snapshotId })`.
2. Read `universal/figma/variables.json`, `universal/figma/styles.json`, and `universal/figma/import-blueprint.json`.
3. Use `universal/figma/import-blueprint.json` in your Figma integration flow.

`figma-package` from `export_design_tokens` provides a compact blueprint suitable for audit before import.

## 9) Technical notes

- A single-page URL cannot cover all hidden states (auth paths, deep lazy states, permission-based UI). Increase budgets or provide auth session data when needed.
- This system is based on rendered runtime output, not guessed CSS or LLM inference.
- Pixel-level fidelity requires a loop: extract → apply → validate → patch.

## 10) Use in any CLI/IDE

- For custom scripts or agents, read files directly from `.design-extractor/snapshots/{snapshotId}/artifacts/universal/`.
- Snapshot manifests keep `generatedArtifacts`, so non-Cursor agents can detect latest generated package metadata.
- You do not need Cursor-specific UI to consume outputs: any tool can call `export_design_package` and consume files.

## 11) Recommendations for higher visual fidelity

- Use at least three viewports (`mobile`, `tablet`, `desktop`)
- Increase `sameOriginPages` and `routeDepth` according to app size
- Increase `stateBudget` for critical states (`hover`, `focus`, `active`)
- Run `validate_visual_match` for targeted routes/viewports
- Keep business logic, data fetching, and routing unchanged in the target project; update styling only.

## 12) Scope statement

- `exactnessMode` default is `observed-only`.
- Coverage is guaranteed only for states, routes, themes, and viewports that were actually rendered and measured.
