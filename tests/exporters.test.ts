import { describe, expect, it } from 'vitest';
import {
  exportCssVariables,
  exportDtcgJson,
  exportDesignTokens,
  buildUniversalPackageArtifacts,
  exportComponentRecipes,
} from '../src/exporters.js';
import type { UiSnapshotManifest } from '../src/types.js';

function fixtureSnapshot(): UiSnapshotManifest {
  return {
    manifestVersion: '1.0.0',
    snapshotId: 'snap-01',
    sourceUrl: 'https://example.test',
    createdAt: '2026-03-01T00:00:00.000Z',
    captureConfig: {
      sameOriginPages: 1,
      routeDepth: 2,
      themes: ['light', 'dark'],
      iconCaptureProfile: 'all',
      viewports: [{ name: 'desktop', width: 1280, height: 720 }],
      interactionBudget: 3,
      stateBudget: 4,
      maxSamplesPerViewport: 200,
      sampleStride: 2,
      waitConfig: { networkQuietMs: 900, mutationStabilityFrames: 5, fontWaitMs: 300, settleMs: 150 },
      exactnessMode: 'observed-only',
    },
    evidence: {
      pages: [
        {
          route: '/',
          theme: 'light',
          viewport: { name: 'desktop', width: 1280, height: 720, deviceScaleFactor: 1 },
          captureId: 'home-desktop',
          title: 'Home',
          routeDepth: 1,
          fullPageScreenshot: '/evidence/full.png',
          sampledNodes: 8,
          stateCaptures: [{ state: 'default', screenshot: '/evidence/state-default.png', styleSignature: 'sig-1' }],
          componentInventory: [],
          layoutFingerprint: 'layout-1',
          width: 1280,
          height: 720,
          screenshotHash: 'hash-1',
          capturedAt: '2026-03-01T00:00:00.000Z',
          nodeSamples: [],
        },
      ],
      screenshotsDir: 'screenshots',
      assets: ['hero.png'],
      icons: [
        {
          sourceUrl: 'https://example.test/favicon.ico',
          localPath: 'assets/icons/favicon.ico',
          fileName: 'favicon.ico',
          status: 'captured',
          ext: 'ico',
          mime: 'image/x-icon',
          bytes: 42,
          retries: 0,
          error: null,
          fromRoute: 'https://example.test',
          fromContext: 'dom-link',
          capturedAt: '2026-03-01T00:00:00.000Z',
          sha256: 'a'.repeat(64),
          sourcePage: 'https://example.test',
          width: 16,
          height: 16,
        },
      ],
    },
    tokens: {
      core: {
        colors: [{ name: 'blue-500', value: '#2563eb', count: 1, provenance: ['fixture'] }],
        spacing: [0, 4, 8],
        radii: ['0px', '4px', '6px'],
        shadows: [{ name: 'sm', value: '0 1px 2px rgba(0,0,0,0.15)', count: 1, provenance: ['fixture'] }],
        fontSizes: [{ name: 'base', px: 16, rem: '1rem', count: 1, provenance: ['fixture'] }],
        lineHeights: [{ name: 'normal', value: 'normal', count: 1 }],
        letterSpacings: [{ name: 'normal', value: 'normal', count: 1 }],
        fontFamilies: [
          { name: 'body', stack: 'Inter, Arial, sans-serif', weight: '400', count: 1, provenance: ['fixture'] },
        ],
        textStyles: [
          {
            name: 'body',
            fontFamily: 'Inter',
            fontSize: '16px',
            lineHeight: '1.5',
            fontWeight: '400',
            letterSpacing: 'normal',
            count: 1,
          },
        ],
      },
      semantic: {
        text: { primary: '#0f172a', secondary: '#475569', muted: '#64748b', inverse: '#f8fafc' },
        surface: { page: '#ffffff', card: '#f1f5f9', header: '#111827', sidebar: '#0f172a' },
        action: {
          primaryBg: '#2563eb',
          primaryFg: '#ffffff',
          secondaryBg: '#64748b',
          secondaryFg: '#ffffff',
          disabledBg: '#cbd5e1',
          disabledFg: '#94a3b8',
        },
        border: { default: '#e2e8f0', focus: '#2563eb' },
        focus: { ring: '#60a5fa', ringOffset: '#ffffff' },
      },
      breakpoints: [
        { name: 'sm', width: 640, source: 'observed' },
        { name: 'md', width: 768, source: 'observed' },
      ],
    },
    components: {
      inventory: {
        'button-primary': {
          name: 'Primary Button',
          archetype: 'button',
          count: 1,
          examples: ['<button class="btn">Primary</button>'],
          sizeScale: [{ variant: 'default', minHeight: '32px', horizontalPadding: '12px', verticalPadding: '8px' }],
          states: [
            { state: 'default', styleSignature: 'btn-default' },
            { state: 'hover', styleSignature: 'btn-hover' },
          ],
          commonStyles: {
            display: 'inline-flex',
            borderRadius: '8px',
            fontFamily: 'Inter',
            fontSize: '14px',
            transition: 'background-color .2s',
          },
          provenance: ['fixture'],
        },
      },
    },
    provenance: {
      pagesRendered: 1,
      nodesCaptured: 1,
      screenshotsCaptured: 1,
      routeCount: 1,
      stateCount: 1,
      iconHarvest: {
        attempted: 1,
        downloaded: 1,
        captured: 1,
        skipped: 0,
        failed: 0,
        dedupedByUrl: 0,
        dedupedByHash: 0,
        retries: 0,
      },
      warning: [],
    },
    validation: {
      status: 'ok',
      overallScore: 100,
      summary: { routeCount: 1, viewportCount: 1, stateCount: 1, maxDiffPercent: 0 },
      checks: [],
      warnings: [],
    },
    exactness: { mode: 'observed-only', note: 'fixture' },
  };
}

describe('exporters', () => {
  it('exports CSS variables with semantic fallbacks and expected keys', () => {
    const snapshot = fixtureSnapshot();
    const css = exportCssVariables(snapshot);
    const lines = css.split('\n');

    expect(lines[0]).toBe(':root {');
    expect(css).toContain('--ui-blue-500: #2563eb;');
    expect(css).toContain('--text-primary: #0f172a;');
    expect(css).toContain('--surface-page: #ffffff;');
    expect(css).toContain('--spacing-0: 0px;');
  });

  it('exports DTCG JSON in parseable token format', () => {
    const snapshot = fixtureSnapshot();
    const output = JSON.parse(exportDtcgJson(snapshot));

    expect(output.$schema).toBe('https://tr.designtokens.org/TR/2025.10');
    expect(output.$value.color).toEqual({ 'blue-500': '#2563eb' });
    expect(output.semantic.text.primary).toBe('#0f172a');
  });

  it('builds package artifacts and component recipe exports', () => {
    const snapshot = fixtureSnapshot();
    const artifacts = buildUniversalPackageArtifacts(snapshot);
    const paths = artifacts.map((artifact) => artifact.relativePath);

    const assetIndexEntry = artifacts.find((entry) => entry.relativePath === 'universal/assets/index.json');
    const iconIndexEntry = artifacts.find((entry) => entry.relativePath === 'universal/assets/icons/index.json');

    expect(paths).toContain('universal/manifest.css-variables.css');
    expect(paths).toContain('universal/theme-object.json');
    expect(paths).toContain('universal/components.json');
    expect(assetIndexEntry).toBeDefined();
    expect(iconIndexEntry).toBeDefined();
    expect(JSON.parse(assetIndexEntry!.content).assets).toEqual(['hero.png']);
    expect(JSON.parse(iconIndexEntry!.content).icons).toHaveLength(1);

    const componentRecipe = JSON.parse(exportComponentRecipes(snapshot));
    expect(componentRecipe).toHaveLength(1);
    expect(componentRecipe[0].name).toBe('Primary Button');
  });

  it('returns each serializer through exportDesignTokens', () => {
    const snapshot = fixtureSnapshot();

    expect(exportDesignTokens(snapshot, 'css-vars')).toContain('--ui-blue-500');
    expect(exportDesignTokens(snapshot, 'tailwind-v4')).toContain('@theme {');
    expect(JSON.parse(exportDesignTokens(snapshot, 'theme-object')).tokens.colors['blue-500']).toBe('#2563eb');
    expect(JSON.parse(exportDesignTokens(snapshot, 'dtcg-json')).$schema).toBe(
      'https://tr.designtokens.org/TR/2025.10'
    );
    expect(exportDesignTokens(snapshot, 'universal-package')).toContain('"universal/manifest.json"');
    expect(exportDesignTokens(snapshot, 'figma-variables')).toContain('"schema": "ui-harvester/figma-variables/1.1"');
  });
});
