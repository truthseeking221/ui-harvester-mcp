#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { crawlAndCapture } from './extractor.js';
import {
  exportComponentRecipes,
  exportCssVariables,
  exportDtcgJson,
  buildUniversalPackageArtifacts,
  exportUniversalPackageDescriptor,
  exportFigmaConsolePlan,
  exportFigmaPackageBlueprint,
  exportFigmaStyles,
  exportFigmaVariables,
  exportTailwindV4Theme,
  exportThemeObject,
} from './exporters.js';
import { validateVisualMatch } from './validator.js';
import {
  listSnapshotRefs,
  readSnapshot,
  saveSnapshot,
  writeArtifactFiles,
  writeExportFile,
  readArtifactFile,
  writeArtifactFile,
  writeJsonFile,
  writeValidationReport,
} from './storage.js';
import {
  SnapshotExportFormat,
  SnapshotListItem,
  SnapshotTargetStack,
  ExtractDesignSystemInput,
  ValidateInput,
  SnapshotExportArtifact,
} from './types.js';

const server = new McpServer({
  name: 'ui-harvester-mcp',
  version: '0.1.0',
});

const viewportSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().optional(),
});

const themeSchema = z.enum(['light', 'dark', 'auto']);
const cleaningProfileSchema = z.enum(['high', 'balanced', 'minimal']);
const iconCaptureProfileSchema = z.enum(['all', 'selected', 'favicon-only']);

const crawlInputSchema = z.object({
  url: z.string().url(),
  viewports: z.array(viewportSchema).max(8).optional(),
  themes: z.array(themeSchema).optional(),
  cleaningProfile: cleaningProfileSchema.optional(),
  iconCaptureProfile: iconCaptureProfileSchema.optional(),
  sameOriginPages: z.number().int().min(1).max(24).optional(),
  routeDepth: z.number().int().min(1).max(8).optional(),
  interactionBudget: z.number().int().min(1).max(16).optional(),
  stateBudget: z.number().int().min(1).max(16).optional(),
  maxSamplesPerViewport: z.number().int().min(100).max(2000).optional(),
  sampleStride: z.number().int().min(1).max(20).optional(),
  authStatePath: z.string().optional(),
  exactnessMode: z.enum(['observed-only', 'observed-with-warned-fallback']).optional(),
  waitConfig: z
    .object({
      networkQuietMs: z.number().nonnegative().optional(),
      mutationStabilityFrames: z.number().int().nonnegative().optional(),
      fontWaitMs: z.number().nonnegative().optional(),
      settleMs: z.number().nonnegative().optional(),
    })
    .optional(),
});

const exportFormatSchema = z.enum([
  'css-vars',
  'tailwind-v4',
  'dtcg-json',
  'theme-object',
  'figma-variables',
  'figma-styles',
  'figma-console-plan',
  'figma-package',
  'universal-package',
] as const);
const interactionStateSchema = z.enum([
  'default',
  'hover',
  'focus',
  'active',
  'checked',
  'selected',
  'disabled',
  'open',
  'loading',
  'error',
] as const);
const stackSchema = z.enum([
  'next-tailwind',
  'vite-tailwind',
  'mui',
  'chakra',
  'styled-components',
  'css-modules',
  'generic',
] as const);

function resolveArtifactFile(alias: string): string | null {
  const map: Record<string, string> = {
    'universal-manifest': 'universal/package.json',
    'universal-css': 'universal/manifest.css-variables.css',
    'universal-css-vars': 'universal/manifest.css-variables.css',
    'universal-tailwind': 'universal/tailwind-v4.css',
    'universal-theme-object': 'universal/theme-object.json',
    'universal-components': 'universal/components.json',
    'universal-dtcg': 'universal/dtcg-tokens.json',
    'universal-figma-variables': 'universal/figma/variables.json',
    'universal-figma-styles': 'universal/figma/styles.json',
    'universal-figma-blueprint': 'universal/figma/import-blueprint.json',
    'universal-figma-plan': 'universal/figma/figma-console-plan.json',
    'universal-core-tokens': 'universal/tokens/core.json',
    'universal-semantic-tokens': 'universal/tokens/semantic.json',
    'universal-layout': 'universal/layout.json',
    'universal-motion': 'universal/motion.json',
    'universal-evidence-routes': 'universal/evidence/routes.jsonl',
    'universal-evidence-pages': 'universal/evidence/pages.json',
    'universal-validation-template': 'universal/validation/template.json',
    'universal-assets': 'universal/assets/index.json',
    'universal-assets-index': 'universal/assets/index.json',
    'universal-assets-icons': 'universal/assets/icons/index.json',
  };
  return map[alias] || null;
}

function outputExt(format: SnapshotExportFormat): string {
  if (format === 'css-vars' || format === 'tailwind-v4') return 'css';
  return 'json';
}

function toolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function handleCrawlAndSave(input: ExtractDesignSystemInput) {
  const manifest = await crawlAndCapture(input);
  await saveSnapshot(manifest);
  return {
    snapshotId: manifest.snapshotId,
    sourceUrl: manifest.sourceUrl,
    routeCount: manifest.evidence.pages.length,
    routeCountByStatus: manifest.provenance.routeSummary,
    renderedRouteCount: manifest.provenance.routeSummary?.rendered ?? manifest.evidence.pages.length,
    skippedRouteCount:
      (manifest.provenance.routeSummary?.skippedDuplicate ?? 0) +
      (manifest.provenance.routeSummary?.skippedByBudget ?? 0) +
      (manifest.provenance.routeSummary?.filteredByRouteBudget ?? 0) +
      (manifest.provenance.routeSummary?.filteredByPolicy ?? 0),
    createdAt: manifest.createdAt,
    config: manifest.captureConfig,
    exactnessMode: manifest.exactness.mode,
    warnings: manifest.provenance.warning ?? manifest.provenance.warnings ?? [],
    cleaning: manifest.provenance.cleaning,
  };
}

const crawlShape = crawlInputSchema.shape;

async function handleCrawlTool(params: z.infer<typeof crawlInputSchema>) {
  try {
    const input: ExtractDesignSystemInput = {
      ...params,
      cleaningProfile: params.cleaningProfile ?? 'high',
      iconCaptureProfile: params.iconCaptureProfile ?? 'all',
      themes: params.themes ?? ['light', 'dark'],
    };
    const payload = await handleCrawlAndSave(input);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    };
  } catch (error) {
    return toolError(error);
  }
}

server.tool(
  'crawl_and_capture',
  'Render URL(s) and capture a Canonical UI Snapshot Package.',
  crawlShape,
  handleCrawlTool
);

server.tool(
  'extract_design_system',
  'Alias to crawl_and_capture for backward compatibility.',
  crawlShape,
  handleCrawlTool
);

server.tool(
  'get_snapshot',
  'Load a snapshot payload by snapshotId.',
  { snapshotId: z.string() },
  async ({ snapshotId }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      return {
        content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool('list_snapshots', 'List all snapshots already extracted.', {}, async () => {
  try {
    const refs = await listSnapshotRefs();
    const result: SnapshotListItem[] = [];
    for (const item of refs) {
      try {
        const snapshot = await readSnapshot(item.snapshotId);
        result.push({
          snapshotId: snapshot.snapshotId,
          sourceUrl: snapshot.sourceUrl,
          createdAt: snapshot.createdAt,
          routeCount: snapshot.evidence.pages.length,
          screenshotCount: snapshot.evidence.pages.reduce((sum, page) => sum + page.stateCaptures.length, 0),
        });
      } catch {
        continue;
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return toolError(error);
  }
});

server.tool(
  'export_design_tokens',
  'Export canonical tokens in css-vars, tailwind-v4, theme-object, dtcg-json, figma, figma-console-plan, or universal descriptor formats.',
  {
    snapshotId: z.string(),
    format: exportFormatSchema.default('css-vars'),
    targetStack: stackSchema.default('generic').optional(),
  },
  async ({ snapshotId, format, targetStack }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      const chosenFormat = format as SnapshotExportFormat;
      const chosenTarget = (targetStack as SnapshotTargetStack) || 'generic';
      const output = (() => {
        switch (chosenFormat) {
          case 'theme-object':
            return exportThemeObject(snapshot, chosenTarget);
          case 'dtcg-json':
            return exportDtcgJson(snapshot);
          case 'tailwind-v4':
            return exportTailwindV4Theme(snapshot);
          case 'figma-variables':
            return exportFigmaVariables(snapshot);
          case 'figma-styles':
            return exportFigmaStyles(snapshot);
          case 'figma-console-plan':
            return exportFigmaConsolePlan(snapshot);
          case 'figma-package':
            return exportFigmaPackageBlueprint(snapshot);
          case 'universal-package':
            return exportUniversalPackageDescriptor(snapshot);
          default:
            return exportCssVariables(snapshot);
        }
      })();
      const file = await writeExportFile(snapshotId, `tokens-${chosenFormat}.${outputExt(chosenFormat)}`, output);
      return {
        content: [
          { type: 'text', text: output },
          { type: 'text', text: `Wrote: ${file}` },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  'export_component_recipes',
  'Export component recipes inventory for a given target stack.',
  {
    snapshotId: z.string(),
    targetStack: stackSchema.default('generic'),
  },
  async ({ snapshotId, targetStack }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      const output = exportComponentRecipes(snapshot, targetStack as SnapshotTargetStack);
      const file = await writeExportFile(snapshotId, `components-${targetStack || 'generic'}.json`, output);
      return {
        content: [
          { type: 'text', text: output },
          { type: 'text', text: `Wrote: ${file}` },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  'export_design_package',
  'Build a portable multi-file design package (tokens + recipes + figma payloads + evidence indexes).',
  {
    snapshotId: z.string(),
    targetStack: stackSchema.default('generic'),
    includeFigmaBlueprint: z.boolean().default(true),
    includeValidationTemplate: z.boolean().default(true),
  },
  async ({ snapshotId, targetStack, includeFigmaBlueprint, includeValidationTemplate }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      const stack = (targetStack as SnapshotTargetStack) || 'generic';
      const artifacts = buildUniversalPackageArtifacts(snapshot, stack)
        .filter((entry) => {
          if (!includeFigmaBlueprint) {
            return !entry.relativePath.startsWith('universal/figma/');
          }
          return true;
        })
        .filter((entry) => {
          if (includeValidationTemplate) return true;
          return entry.relativePath !== 'universal/validation/template.json';
        });

      const written = await writeArtifactFiles(
        snapshotId,
        artifacts.map((entry) => ({ relativePath: entry.relativePath, content: entry.content }))
      );
      const manifest: SnapshotExportArtifact[] = artifacts.map((entry) => ({
        path: entry.relativePath,
        description: entry.description,
        mediaType: entry.mediaType,
      }));

      snapshot.generatedArtifacts = {
        ...(snapshot.generatedArtifacts || {}),
        'universal-package': {
          generatedAt: new Date().toISOString(),
          files: manifest,
        },
      };
      await writeJsonFile(snapshotId, 'manifest.json', snapshot);

      const manifestPath = `universal/package.json`;
      const manifestFile = {
        snapshotId,
        sourceUrl: snapshot.sourceUrl,
        generatedAt: new Date().toISOString(),
        exactnessMode: snapshot.exactness.mode,
        schemaVersion: snapshot.schemaVersion || '1.2.0',
        files: manifest,
      };
      const manifestText = JSON.stringify(manifestFile, null, 2);
      await writeArtifactFile(snapshotId, manifestPath, manifestText);

      const manifestFiles = [...written.map((entry) => entry.relativePath), manifestPath].sort();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'ok',
                snapshotId,
                targetStack: stack,
                artifactCount: artifacts.length,
                artifactFiles: manifestFiles,
                manifest: `artifacts/${manifestPath}`,
                warnings: written.length ? [] : ['No files generated.'],
                artifactWarnings: snapshot.provenance.warning ?? snapshot.provenance.warnings ?? [],
                exactnessModeUsed: snapshot.exactness.mode,
                routeCountByStatus: snapshot.provenance.routeSummary,
              },
              null,
              2
            ),
          },
          { type: 'text', text: `Wrote: artifacts/${manifestPath}` },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  'export_css_variables',
  'Backward-compatible alias for CSS variables export.',
  { snapshotId: z.string() },
  async ({ snapshotId }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      const text = exportCssVariables(snapshot);
      const file = await writeExportFile(snapshotId, 'tokens-css-vars.css', text);
      return {
        content: [
          { type: 'text', text },
          { type: 'text', text: `Wrote: ${file}` },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  'export_tailwind_v4_theme',
  'Backward-compatible alias for Tailwind v4 theme export.',
  { snapshotId: z.string() },
  async ({ snapshotId }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      const text = exportTailwindV4Theme(snapshot);
      const file = await writeExportFile(snapshotId, 'theme-tailwind-v4.css', text);
      return {
        content: [
          { type: 'text', text },
          { type: 'text', text: `Wrote: ${file}` },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  'apply_snapshot_to_project',
  'Generate reusable token files into projectPath using the snapshot.',
  {
    snapshotId: z.string(),
    projectPath: z.string(),
    targetStack: stackSchema.default('vite-tailwind'),
    createFilesOnly: z.boolean().default(true),
  },
  async ({ snapshotId, projectPath, targetStack, createFilesOnly }) => {
    try {
      const snapshot = await readSnapshot(snapshotId);
      const base = path.resolve(projectPath);
      if (base.includes('..') || !path.isAbsolute(base)) {
        return toolError(new Error('projectPath must resolve to a safe absolute path'));
      }
      const styleDir = path.join(base, 'src', 'styles');
      await fs.mkdir(styleDir, { recursive: true });
      const input = (targetStack as SnapshotTargetStack) || 'vite-tailwind';
      const cssVars = exportCssVariables(snapshot);
      const tw = exportTailwindV4Theme(snapshot);
      const themeObj = exportThemeObject(snapshot, input);
      const components = exportComponentRecipes(snapshot, input);
      const created: string[] = [];

      if (input === 'next-tailwind' || input === 'vite-tailwind') {
        await fs.writeFile(path.join(styleDir, 'tokens.css'), cssVars, 'utf8');
        await fs.writeFile(path.join(styleDir, 'theme.css'), tw, 'utf8');
        created.push('src/styles/tokens.css', 'src/styles/theme.css');
      } else {
        await fs.writeFile(path.join(styleDir, 'theme.json'), themeObj, 'utf8');
        created.push('src/styles/theme.json');
      }

      if (!createFilesOnly) {
        await fs.writeFile(path.join(styleDir, 'component-recipes.json'), components, 'utf8');
        created.push('src/styles/component-recipes.json');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'ok',
                projectPath: base,
                created,
                note: 'Generated scaffold files only; component refactor still requires manual mapping.',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.tool(
  'validate_visual_match',
  'Compare rendered project screenshots against source captures.',
  {
    snapshotId: z.string(),
    projectPreviewUrl: z.string().url(),
    routes: z.array(z.string()).optional(),
    states: z.array(interactionStateSchema).optional(),
    viewports: z.array(z.string()).optional(),
    maxDiffPercent: z.number().min(0).max(100).optional(),
  },
  async (params) => {
    try {
      const args: ValidateInput = {
        snapshotId: params.snapshotId,
        projectPreviewUrl: params.projectPreviewUrl,
        routes: params.routes,
        states: params.states as ValidateInput['states'],
        viewports: params.viewports,
        maxDiffPercent: params.maxDiffPercent,
      };
      const report = await validateVisualMatch(args);
      const file = await writeValidationReport(args.snapshotId, report);
      return {
        content: [
          { type: 'text', text: JSON.stringify(report, null, 2) },
          { type: 'text', text: `Wrote: ${file}` },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.resource(
  'snapshot-manifest',
  new ResourceTemplate('ui://snapshots/{snapshotId}/manifest', { list: undefined }),
  { description: 'Read snapshot manifest from disk' },
  async (uri, vars) => {
    const snapshotId = String(vars.snapshotId ?? '');
    const snapshot = await readSnapshot(snapshotId);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(snapshot, null, 2),
        },
      ],
    };
  }
);

server.resource(
  'snapshot-core-tokens',
  new ResourceTemplate('ui://snapshots/{snapshotId}/tokens/core', { list: undefined }),
  { description: 'Read core tokens by snapshotId' },
  async (uri, vars) => {
    const snapshotId = String(vars.snapshotId ?? '');
    const snapshot = await readSnapshot(snapshotId);
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot.tokens.core, null, 2) }],
    };
  }
);

server.resource(
  'snapshot-semantic-tokens',
  new ResourceTemplate('ui://snapshots/{snapshotId}/tokens/semantic', { list: undefined }),
  { description: 'Read semantic tokens by snapshotId' },
  async (uri, vars) => {
    const snapshotId = String(vars.snapshotId ?? '');
    const snapshot = await readSnapshot(snapshotId);
    return {
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot.tokens.semantic, null, 2) },
      ],
    };
  }
);

server.resource(
  'snapshot-component-recipes',
  new ResourceTemplate('ui://snapshots/{snapshotId}/components/{archetype}', { list: undefined }),
  { description: 'Read component recipes by snapshotId' },
  async (uri, vars) => {
    const snapshotId = String(vars.snapshotId ?? '');
    const archetype = String(vars.archetype ?? 'all');
    const snapshot = await readSnapshot(snapshotId);
    if (archetype && archetype !== 'all') {
      const recipe = snapshot.components.inventory[archetype as keyof typeof snapshot.components.inventory];
      if (!recipe) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'archetype not found' }, null, 2),
            },
          ],
        };
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(recipe, null, 2) }] };
    }
    return {
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot.components.inventory, null, 2) },
      ],
    };
  }
);

server.resource(
  'snapshot-validation',
  new ResourceTemplate('ui://snapshots/{snapshotId}/validation/report', { list: undefined }),
  { description: 'Read latest validation report by snapshotId' },
  async (uri, vars) => {
    const snapshotId = String(vars.snapshotId ?? '');
    const snapshot = await readSnapshot(snapshotId);
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot.validation, null, 2) }],
    };
  }
);

server.resource(
  'snapshot-artifacts',
  new ResourceTemplate('ui://snapshots/{snapshotId}/artifacts/{artifact}', { list: undefined }),
  { description: 'Read packaged artifacts for a snapshot by logical artifact key.' },
  async (uri, vars) => {
    const snapshotId = String(vars.snapshotId ?? '');
    const artifactKey = String(vars.artifact ?? '');
    const snapshot = await readSnapshot(snapshotId);
    if (artifactKey === 'manifest') {
      try {
        const file = await readArtifactFile(snapshotId, 'universal/package.json');
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: file }] };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ warning: 'No universal package has been exported yet.' }, null, 2),
            },
          ],
        };
      }
    }

    const relative = resolveArtifactFile(artifactKey);
    if (!relative) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                error: 'artifact_not_found',
                snapshotId: snapshot.snapshotId,
                supportedArtifacts: [
                  'manifest',
                  'universal-manifest',
                  'universal-css',
                  'universal-css-vars',
                  'universal-tailwind',
                  'universal-theme-object',
                  'universal-components',
                  'universal-dtcg',
                  'universal-figma-variables',
                  'universal-figma-styles',
                  'universal-figma-blueprint',
                  'universal-figma-plan',
                  'universal-core-tokens',
                  'universal-semantic-tokens',
                  'universal-layout',
                  'universal-motion',
                  'universal-evidence-routes',
                  'universal-evidence-pages',
                  'universal-validation-template',
                  'universal-assets',
                  'universal-assets-index',
                  'universal-assets-icons',
                ],
              },
              null,
              2
            ),
          },
        ],
      };
    }

    let file: string;
    try {
      file = await readArtifactFile(snapshotId, relative);
    } catch {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ warning: `artifact missing: ${artifactKey}` }, null, 2),
          },
        ],
      };
    }
    const ext = relative.split('.').pop()?.toLowerCase() || 'txt';
    const mimeType =
      ext === 'json'
        ? 'application/json'
        : ext === 'css'
          ? 'text/css'
          : ext === 'jsonl' || ext === 'ndjson'
            ? 'application/x-ndjson'
            : 'text/plain';
    return { contents: [{ uri: uri.href, mimeType, text: file }] };
  }
);

server.prompt(
  'apply-source-style-to-current-project',
  'Given snapshot and target stack, generate a safe migration plan to replace local UI styling.',
  { snapshotId: z.string(), targetStack: stackSchema.default('vite-tailwind') },
  ({ snapshotId, targetStack }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Use snapshot ${snapshotId} and target stack ${targetStack || 'vite-tailwind'}.\n` +
            `1) Read ui://snapshots/${snapshotId}/manifest\n` +
            `2) Read ui://snapshots/${snapshotId}/tokens/semantic and ui://snapshots/${snapshotId}/tokens/core\n` +
            `3) Read ui://snapshots/${snapshotId}/components/all\n` +
            `4) Optionally read ui://snapshots/${snapshotId}/artifacts/universal-manifest\n` +
            '5) Export tokens:\n' +
            "   - export_design_tokens({snapshotId, format: 'tailwind-v4'}) if using Tailwind\n" +
            "   - or export_design_tokens({snapshotId, format: 'theme-object'}) for MUI/Chakra/styled system\n" +
            '6) Patch existing components only (do not copy raw HTML from source).',
        },
      },
    ],
  })
);

server.prompt(
  'refactor-local-components-to-match-snapshot',
  'Generate direct edits to make local components match the snapshot.',
  {
    snapshotId: z.string(),
    componentNames: z.array(z.string()).optional(),
    targetStack: stackSchema.default('vite-tailwind'),
  },
  ({ snapshotId, targetStack }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `You are applying design packages from ${snapshotId}.\n` +
            `Target stack: ${targetStack}. \n` +
            'Only map semantics and component archetypes (button/input/card/navbar/card/header/sidebar/modal/card/table/list). ' +
            'Do not clone business logic, routes, or static text content. ' +
            `Start from ui://snapshots/${snapshotId}/components/all and ui://snapshots/${snapshotId}/tokens/core.`,
        },
      },
    ],
  })
);

server.prompt(
  'fix-high-visual-diff-components',
  'Create a remediation list from latest validation report and snapshot diff.',
  { snapshotId: z.string() },
  ({ snapshotId }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `1) Read ui://snapshots/${snapshotId}/manifest\n2) Read ui://snapshots/${snapshotId}/validation/report\n3) For each failed check, propose the minimal CSS/component adjustments and the state to patch.`,
        },
      },
    ],
  })
);

server.prompt(
  'prepare-figma-import-pack',
  'Prepare files for figma-console-mcp from a snapshot package.',
  {
    snapshotId: z.string(),
    includeFigmaBlueprint: z.boolean().default(true),
  },
  ({ snapshotId, includeFigmaBlueprint }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `1) Read ui://snapshots/${snapshotId}/manifest\n` +
            '2) Run export_design_package({snapshotId}).\n' +
            '3) Read ui://snapshots/${snapshotId}/artifacts/manifest.\n' +
            (includeFigmaBlueprint
              ? '4) Read ui://snapshots/${snapshotId}/artifacts/universal-figma-variables\n5) Read ui://snapshots/${snapshotId}/artifacts/universal-figma-styles\n6) Read ui://snapshots/${snapshotId}/artifacts/universal-figma-plan (recommended executable import plan)\n7) Read ui://snapshots/${snapshotId}/artifacts/universal-figma-blueprint\n'
              : '') +
            '8) For southleft/figma-console-mcp, use the figma payload files as direct input and apply into a dedicated Figma file.' +
            (includeFigmaBlueprint
              ? ' Keep source route/component naming and aliases in sync for pixel-first parity.'
              : ''),
        },
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ui-harvester-mcp] started');
