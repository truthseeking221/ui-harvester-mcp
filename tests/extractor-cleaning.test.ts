import { describe, expect, it } from 'vitest';
import {
  aggregateCoreTokens,
  buildComponentRecipeWithState,
  defaultCleaningReport,
  normalizeColorValue,
  resolveCleaningProfileContext,
  toComponentInventory,
} from '../src/extractor.js';
import type {
  CleaningProfile,
  NodeComputedStyle,
  NodeSample,
  RouteViewportCapture,
  ViewportSpec,
  ThemeMode,
} from '../src/types.js';

function createStyle(overrides: Partial<NodeComputedStyle> = {}): NodeComputedStyle {
  return {
    display: 'block',
    position: 'static',
    top: 'auto',
    right: 'auto',
    bottom: 'auto',
    left: 'auto',
    zIndex: 'auto',
    overflow: 'visible',
    boxSizing: 'content-box',
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'white',
    borderColor: '#ffffff',
    borderWidth: '0px',
    borderStyle: 'solid',
    borderRadius: '0',
    boxShadow: 'none',
    textShadow: 'none',
    fontFamily: 'Inter',
    fontSize: '16px',
    fontWeight: '400',
    lineHeight: 'normal',
    letterSpacing: 'normal',
    textAlign: 'left',
    textTransform: 'none',
    marginTop: '0px',
    marginRight: '0px',
    marginBottom: '0px',
    marginLeft: '0px',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
    gap: '0px',
    width: 'auto',
    height: 'auto',
    minWidth: 'auto',
    minHeight: 'auto',
    maxWidth: 'none',
    maxHeight: 'none',
    opacity: '1',
    transition: 'none',
    animation: 'none',
    outline: 'none',
    outlineColor: 'transparent',
    outlineWidth: '0',
    filter: 'none',
    backdropFilter: 'none',
    customProperties: {},
    ...overrides,
  };
}

function createSamples(spacings: number[], fontSizes: number[]): NodeSample[] {
  return spacings.map((spacing, index) => ({
    uid: `node-${index}`,
    selector: `button#sample-${index}`,
    tag: 'button',
    role: null,
    typeHint: 'button',
    text: `Sample ${index}`,
    className: 'btn',
    id: `sample-${index}`,
    ariaLabel: null,
    rect: { x: 0, y: index * 3, width: 20, height: 20 },
    visible: true,
    styles: createStyle({
      paddingTop: `${spacing}px`,
      paddingRight: `${spacing}px`,
      paddingBottom: `${spacing}px`,
      paddingLeft: `${spacing}px`,
      fontSize: `${fontSizes[index]}px`,
      borderRadius: index % 2 ? `${spacing}px` : '2px',
      color: index % 2 ? 'rgba(255, 0, 0, 0.5)' : 'red',
    }),
    pseudoBefore: null,
    pseudoAfter: null,
    styleSignature: `sig-${index}`,
    childCount: 0,
  }));
}

function createCapture(samples: NodeSample[]) {
  const viewport: ViewportSpec = { name: 'desktop', width: 1440, height: 900 };
  const page: RouteViewportCapture = {
    route: 'https://example.test',
    theme: 'light' as ThemeMode,
    viewport,
    captureId: 'default-home',
    title: 'Example',
    routeDepth: 1,
    fullPageScreenshot: '/screens/route.png',
    sampledNodes: samples.length,
    stateCaptures: [],
    componentInventory: [],
    layoutFingerprint: 'lf-home',
    width: viewport.width,
    height: viewport.height,
    screenshotHash: 'hash',
    capturedAt: '2026-03-01T00:00:00.000Z',
    nodeSamples: samples,
    stateCaptureCount: 0,
  };
  return page;
}

function captureByProfile(profile: CleaningProfile, spacings: number[], fontSizes: number[]) {
  const context = resolveCleaningProfileContext(profile);
  const report = defaultCleaningReport(profile);
  return {
    bucket: aggregateCoreTokens([createCapture(createSamples(spacings, fontSizes))], context, report),
    report,
  };
}

describe('extractor cleaning profile behavior', () => {
  it('canonicalizes color tokens by profile for common formats', () => {
    expect(normalizeColorValue('rgb(255, 0, 0)', 'high')).toBe('#ff0000');
    expect(normalizeColorValue('rgba(0, 0, 0, 0.5)', 'high')).toBe('#00000080');
    expect(normalizeColorValue('hsl(0, 100%, 50%)', 'high')).toBe('#ff0000');
    expect(normalizeColorValue('hsla(0,100%,50%,0.25)', 'high')).toBe('#ff000040');
    expect(normalizeColorValue('var(--brand-text)', 'high')).toBe('');
    expect(normalizeColorValue('var(--brand-text)', 'minimal')).toBe('var(--brand-text)');
    expect(normalizeColorValue('transparent', 'high')).toBe('');
    expect(normalizeColorValue('blue', 'high')).toBe('#0000ff');
  });

  it('removes spacing/radius/font-size outliers in high and keeps minimal profile permissive', () => {
    const high = captureByProfile('high', [0, 4, 4, 4, 100], [12, 12, 12, 13, 100]);
    const balanced = captureByProfile('balanced', [0, 4, 4, 4, 100], [12, 12, 12, 13, 100]);
    const minimal = captureByProfile('minimal', [0, 4, 4, 4, 100], [12, 12, 12, 13, 100]);

    expect(high.bucket.spacing).toContain(4);
    expect(high.bucket.spacing).not.toContain(100);
    expect(high.bucket.fontSizes.some((item) => item.px === 100)).toBe(false);

    expect(balanced.bucket.spacing).not.toContain(100);
    expect(balanced.bucket.spacing).toContain(4);

    expect(minimal.bucket.spacing).toContain(100);
    expect(minimal.bucket.fontSizes.some((item) => item.px === 100)).toBe(true);

    expect(high.report.spacingOutliersRemoved).toBeGreaterThan(0);
    expect(high.report.mergedColorCount).toBeGreaterThan(0);
  });

  it('shows monotonic filtering between high/balanced/minimal', () => {
    const high = captureByProfile('high', [1, 1, 1, 1, 9, 200, 210], [12, 12, 12, 14, 14, 80, 120]);
    const balanced = captureByProfile('balanced', [1, 1, 1, 1, 9, 200, 210], [12, 12, 12, 14, 14, 80, 120]);
    const minimal = captureByProfile('minimal', [1, 1, 1, 1, 9, 200, 210], [12, 12, 12, 14, 14, 80, 120]);

    expect(high.report.profile).toBe('high');
    expect(balanced.report.profile).toBe('balanced');
    expect(minimal.report.profile).toBe('minimal');

    expect(high.bucket.spacing.length).toBeLessThanOrEqual(balanced.bucket.spacing.length);
    expect(balanced.bucket.spacing.length).toBeLessThanOrEqual(minimal.bucket.spacing.length);

    expect(high.bucket.fontSizes.length).toBeLessThanOrEqual(minimal.bucket.fontSizes.length);
    expect(balanced.bucket.fontSizes.length).toBeLessThanOrEqual(minimal.bucket.fontSizes.length);

    expect(high.report.spacingOutliersRemoved).toBeGreaterThan(0);
    expect(minimal.report.spacingOutliersRemoved).toBe(0);

    expect(high.bucket.spacing).not.toContain(200);
    expect(minimal.bucket.spacing).toContain(200);
  });

  it('dedupes state records and drops no-op states for high profile', () => {
    const context = resolveCleaningProfileContext('high');
    const sample: NodeSample[] = [
      {
        uid: 'sample-noop',
        selector: '.btn-noop',
        tag: 'button',
        role: 'button',
        typeHint: 'button',
        text: 'Button',
        className: 'btn',
        id: 'btn-noop',
        ariaLabel: null,
        childCount: 0,
        rect: { x: 0, y: 0, width: 20, height: 20 },
        visible: true,
        styles: createStyle({
          fontSize: '16px',
          paddingLeft: '8px',
          paddingRight: '8px',
          paddingTop: '8px',
          paddingBottom: '8px',
        }),
        pseudoBefore: null,
        pseudoAfter: null,
        styleSignature: 's1',
      },
    ];

    const stateByArchetype = {
      button: [
        {
          state: 'hover',
          styleSignature: 's-hover',
          changedProperties: [],
          changedPropertiesAdded: [],
          changedPropertiesRemoved: [],
          propertyDeltas: {},
          targetSelector: '.btn-noop',
          stateTargetMeta: {
            selector: '.btn-noop',
            locator: '.btn-noop',
            found: true,
            strategy: 'css',
            attempts: ['css'],
          },
          examples: ['Button'],
        },
        {
          state: 'hover',
          styleSignature: 's-hover',
          changedProperties: [],
          changedPropertiesAdded: [],
          changedPropertiesRemoved: [],
          propertyDeltas: {},
          targetSelector: '.btn-noop',
          stateTargetMeta: {
            selector: '.btn-noop',
            locator: '.btn-noop',
            found: true,
            strategy: 'css',
            attempts: ['css'],
          },
          examples: ['Button duplicate'],
        },
        {
          state: 'focus',
          styleSignature: 's-focus',
          changedProperties: ['outline'],
          changedPropertiesAdded: ['outline'],
          changedPropertiesRemoved: [],
          propertyDeltas: { outline: { before: 'none', after: '1px solid blue' } },
          targetSelector: '.btn-noop',
          stateTargetMeta: {
            selector: '.btn-noop',
            locator: '.btn-noop',
            found: true,
            strategy: 'css',
            attempts: ['css'],
          },
          examples: ['Button focus'],
        },
      ],
    };

    const report = defaultCleaningReport('high');
    const recipes = buildComponentRecipeWithState({ button: sample }, stateByArchetype, context, report);

    expect(Object.keys(recipes)).toContain('button');
    expect(recipes.button.states).toHaveLength(2);
    expect(recipes.button.states.map((state) => state.state).sort()).toEqual(['default', 'focus']);
    expect(recipes.button.states.some((state) => state.state === 'hover')).toBe(false);
    expect(report.stateRecordsDropped).toBeGreaterThan(0);

    const reportFromInventory = defaultCleaningReport('high');
    const page = {
      route: 'https://example.test',
      theme: 'light' as ThemeMode,
      viewport: { name: 'desktop', width: 390, height: 844 },
      captureId: 'route-light',
      title: 'home',
      routeDepth: 1,
      fullPageScreenshot: 'full.png',
      sampledNodes: 1,
      stateCaptures: [],
      componentInventory: Object.values(recipes),
      layoutFingerprint: 'layout',
      width: 390,
      height: 844,
      screenshotHash: 'hash',
      capturedAt: '2026-03-01T00:00:00.000Z',
      nodeSamples: sample,
    };

    const merged = toComponentInventory([page as RouteViewportCapture], context, reportFromInventory);

    expect(merged.button.states).toHaveLength(2);
    expect(report.stateRecordsDropped).toBeGreaterThan(0);
  });
});
