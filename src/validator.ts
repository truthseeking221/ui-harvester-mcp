import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { readSnapshot, snapshotDir } from './storage.js';
import {
  InteractionState,
  RouteViewportCapture,
  ValidateInput,
  ValidationItem,
  ValidationReport,
  StateCapture,
} from './types.js';

type ViewportFilter = { name: string; width: number; height: number };

function parseViewportToken(input: string): ViewportFilter | null {
  const token = input.trim().toLowerCase();
  if (/^\d+x\d+$/.test(token)) {
    const [w, h] = token.split('x').map(Number);
    if (!Number.isNaN(w) && !Number.isNaN(h)) return { name: token, width: w, height: h };
  }
  const [name, dim] = token.split(':');
  if (dim && /^\d+x\d+$/.test(dim)) {
    const [w, h] = dim.split('x').map(Number);
    if (!Number.isNaN(w) && !Number.isNaN(h)) return { name, width: w, height: h };
  }
  return null;
}

function isRouteMatch(route: string, candidate: string): boolean {
  try {
    const routePath = new URL(route).pathname.replace(/\/$/, '');
    const candidatePath = new URL(candidate).pathname.replace(/\/$/, '');
    return routePath === candidatePath;
  } catch {
    return route === candidate;
  }
}

function routeCandidates(args: ValidateInput, projectPreviewUrl: string): string[] {
  if (!args.routes?.length) return [];
  return args.routes
    .map((item) => {
      const normalized = item.trim();
      if (!normalized) return "";
      if (normalized.includes("://")) return normalized;
      return normalized.startsWith("/") ? new URL(normalized, projectPreviewUrl).toString() : new URL(`/${normalized}`, projectPreviewUrl).toString();
    })
    .filter((route) => !!route);
}

function buildRouteLabel(route: string): string {
  try {
    const parsed = new URL(route);
    return `${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return route;
  }
}

function viewportAllows(
  page: { viewport: { name: string; width: number; height: number } },
  filters: string[] | undefined
): boolean {
  if (!filters?.length) return true;
  return filters.some((entry) => {
    const parsed = parseViewportToken(entry);
    if (!parsed) return false;
    if (parsed.name && page.viewport.name.toLowerCase() === parsed.name.toLowerCase()) return true;
    return parsed.width === page.viewport.width && parsed.height === page.viewport.height;
  });
}

function normalizeStates(args: ValidateInput): InteractionState[] {
  if (!args.states?.length) return ['default'];
  const set = new Set<InteractionState>();
  for (const state of args.states) {
    set.add(state as InteractionState);
  }
  return [...set];
}

type ValidationStateCapture = Pick<
  StateCapture,
  'state' | 'screenshot' | 'styleSignature' | 'stateTargetMeta' | 'stateTargetResolved' | 'stateTarget'
>;

type ValidationFailureReason = NonNullable<ValidationItem['failureReason']>;

type LocatorCandidate = {
  strategy: string;
  type: 'selector' | 'text' | 'bbox';
  selector: string;
  confidence: number;
};

function escapeCssIdent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\n/g, '').trim();
}

async function resolveTargetLocator(
  page: Page,
  sourceState?: ValidationStateCapture
): Promise<LocatorCandidate | null> {
  const meta = sourceState?.stateTargetMeta;
  const candidates: LocatorCandidate[] = [];

  if (sourceState?.stateTargetResolved?.locator) {
    candidates.push({
      strategy: 'resolved-locator',
      type: 'selector',
      selector: sourceState.stateTargetResolved.locator,
      confidence: 1,
    });
  }
  if (meta?.locator)
    candidates.push({ strategy: 'locator', type: 'selector', selector: meta.locator, confidence: 0.99 });
  if (meta?.selector)
    candidates.push({ strategy: 'selector', type: 'selector', selector: meta.selector, confidence: 0.95 });
  if (meta?.id)
    candidates.push({ strategy: 'id', type: 'selector', selector: `#${escapeCssIdent(meta.id)}`, confidence: 0.94 });
  if (meta?.role) {
    candidates.push({
      strategy: 'role',
      type: 'selector',
      selector: `[role='${escapeCssIdent(meta.role)}']`,
      confidence: 0.9,
    });
  }
  if (meta?.type) {
    const typeValue = escapeCssIdent(meta.type);
    candidates.push({
      strategy: 'type',
      type: 'selector',
      selector: `input[type='${typeValue}'], button[type='${typeValue}'], [type='${typeValue}']`,
      confidence: 0.88,
    });
  }
  if (meta?.tag) {
    const tagValue = meta.tag.toLowerCase();
    candidates.push({ strategy: 'tag', type: 'selector', selector: tagValue, confidence: 0.82 });
  }
  if (meta?.classTokens?.length) {
    const classes = meta.classTokens
      .filter(Boolean)
      .slice(0, 3)
      .map((value) => `.${escapeCssIdent(value)}`);
    if (classes.length > 0) {
      candidates.push({ strategy: 'class', type: 'selector', selector: classes.join(''), confidence: 0.8 });
    }
  }
  if (meta?.ariaLabel && meta.ariaLabel.length < 180) {
    candidates.push({
      strategy: 'aria-label',
      type: 'selector',
      selector: `[aria-label='${escapeCssIdent(meta.ariaLabel)}']`,
      confidence: 0.78,
    });
  }
  if (meta?.text && meta.text.length > 0 && meta.text.length < 120) {
    candidates.push({ strategy: 'text', type: 'text', selector: meta.text, confidence: 0.74 });
  }
  if (meta?.bbox?.width && meta?.bbox?.height) {
    candidates.push({ strategy: 'bbox', type: 'bbox', selector: JSON.stringify(meta.bbox), confidence: 0.68 });
  }
  if (sourceState?.stateTarget) {
    candidates.push({
      strategy: 'legacy-target',
      type: 'selector',
      selector: sourceState.stateTarget,
      confidence: 0.62,
    });
  }

  if (!candidates.length) {
    candidates.push({
      strategy: 'generic',
      type: 'selector',
      selector:
        "a,button,input,textarea,select,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],summary",
      confidence: 0.3,
    });
  }

  for (const candidate of candidates) {
    if (candidate.type === 'text') {
      const target = page.getByText(candidate.selector).first();
      const count = await target.count().catch(() => 0);
      if (!count) continue;
      const visible = await target.isVisible().catch(() => false);
      if (!visible) continue;
      return candidate;
    }

    if (candidate.type === 'bbox') {
      const selectorFromBBox = await page
        .evaluate<string | null, string>((value) => {
          let bbox: { x: number; y: number; width: number; height: number };
          try {
            bbox = JSON.parse(value) as { x: number; y: number; width: number; height: number };
          } catch {
            return null;
          }
          const cx = Math.max(0, bbox.x + Math.max(1, bbox.width) / 2);
          const cy = Math.max(0, bbox.y + Math.max(1, bbox.height) / 2);
          const point = document.elementFromPoint(Math.round(cx), Math.round(cy));
          if (!point) return null;
          const tag = point.tagName.toLowerCase();
          const id = point.getAttribute('id');
          const aria = point.getAttribute('aria-label');
          const role = point.getAttribute('role');
          if (id) return `#${id.replace(/["'\\]/g, '\\$&')}`;
          if (role) return `${tag}[role='${role.replace(/["'\\]/g, '\\$&')}']`;
          if (aria) return `${tag}[aria-label='${aria.replace(/["'\\]/g, '\\$&')}']`;
          const classes = Array.from(point.classList)
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 2)
            .map((item) => `.${item.replace(/["'\\]/g, '\\$&')}`);
          if (classes.length) return `${tag}${classes.join('')}`;
          return tag;
        }, candidate.selector)
        .catch(() => null);
      if (!selectorFromBBox) continue;
      const target = page.locator(selectorFromBBox).first();
      const count = await target.count().catch(() => 0);
      if (!count) continue;
      const visible = await target.isVisible().catch(() => false);
      if (!visible) continue;
      return { ...candidate, selector: selectorFromBBox };
    }

    const locator = page.locator(candidate.selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    return candidate;
  }

  return null;
}

function mapValidationState(state: InteractionState, stateCaptures: StateCapture[]) {
  const exact = stateCaptures.find((capture) => capture.state === state);
  if (exact) return exact as ValidationStateCapture;
  const fallback = stateCaptures.find((capture) => capture.state === 'default');
  return fallback ? (fallback as ValidationStateCapture) : null;
}

async function applyStateForValidation(
  page: Page,
  state: InteractionState,
  sourceState?: ValidationStateCapture,
  options?: { allowInteraction?: boolean }
): Promise<{ applied: boolean; warnings: string[]; failureReason?: ValidationFailureReason }> {
  if (state === 'default') return { applied: true, warnings: [] };
  if (options?.allowInteraction === false) {
    return { applied: true, warnings: ['state_capture_fallback'] };
  }

  const candidate = await resolveTargetLocator(page, sourceState);
  if (!candidate) {
    return { applied: false, warnings: ['state_replay_not_found'], failureReason: 'selector_not_reproducible' };
  }

  const target = page.locator(candidate.selector).first();
  const count = await target.count();
  if (!count) {
    return { applied: false, warnings: ['state_replay_not_found'], failureReason: 'selector_not_reproducible' };
  }

  const stateInfo = await target
    .evaluate((element) => {
      const el = element as Element;
      const html = el as HTMLElement & { disabled?: boolean };
      const typed = el as HTMLInputElement;
      return {
        role: el.getAttribute('role'),
        type: typed.type || null,
        tag: el.tagName.toLowerCase(),
        ariaExpanded: el.getAttribute('aria-expanded'),
        disabled: html.disabled === true,
        ariaDisabled: el.getAttribute('aria-disabled'),
        dataState: el.getAttribute('data-state'),
      };
    })
    .catch(() => null);

  const warningBag: string[] = [`resolved-by-${candidate.strategy}`];
  switch (state) {
    case 'hover':
      await target.hover({ timeout: 1_000 }).catch(() => {});
      break;
    case 'focus':
      await target.focus().catch(() => {});
      break;
    case 'active':
      await target.dispatchEvent('mousedown', {}).catch(() => {});
      await page.waitForTimeout(40).catch(() => {});
      await target.dispatchEvent('mouseup', {}).catch(() => {});
      break;
    case 'checked': {
      if (!stateInfo) {
        warningBag.push('checked_state_info_unavailable');
        return { applied: false, warnings: warningBag, failureReason: 'target_interaction_not_reproducible' };
      }
      const role = (stateInfo.role || '').toLowerCase();
      const type = (stateInfo.type || '').toLowerCase();
      if (!['checkbox', 'radio', 'switch'].includes(type) && !['checkbox', 'radio', 'switch'].includes(role)) {
        warningBag.push('checked_not_applicable');
        return { applied: false, warnings: warningBag, failureReason: 'target_interaction_not_reproducible' };
      }
      await target.click({ timeout: 1_000 }).catch(() => {});
      break;
    }
    case 'selected':
      await target.click({ timeout: 1_000 }).catch(() => {});
      break;
    case 'open': {
      if (stateInfo && (stateInfo.ariaExpanded !== null || stateInfo.tag === 'summary')) {
        const beforeExpanded = stateInfo.ariaExpanded;
        await target.click({ timeout: 1_000 }).catch(() => {});
        await page.waitForTimeout(90).catch(() => {});
        const afterExpanded = await target
          .evaluate((element) => element.getAttribute('aria-expanded'))
          .catch(() => null);
        if (beforeExpanded !== null && afterExpanded !== null && beforeExpanded === afterExpanded) {
          warningBag.push('open_no_attribute_transition');
        }
      } else {
        warningBag.push('open_not_applicable');
        return { applied: false, warnings: warningBag, failureReason: 'target_interaction_not_reproducible' };
      }
      break;
    }
    case 'loading':
    case 'error': {
      const probe = await target
        .evaluate((element, desiredState) => {
          if (desiredState === 'loading') {
            const loadingCandidates = [
              element,
              element.closest("[role='status'], [role='progressbar'], [aria-live]"),
              element.parentElement,
              ...Array.from(
                element.querySelectorAll?.(
                  "[aria-busy], [data-loading], [data-busy], [data-state], [data-status], [role='progressbar'], [aria-live], .loading, .spinner, .skeleton, .progress, .busy"
                ) || []
              ),
            ].filter(Boolean) as Element[];
            const signalText = loadingCandidates
              .map(
                (candidate) =>
                  `${candidate.getAttribute('aria-busy') || ''} ${candidate.getAttribute('data-loading') || ''} ${candidate.getAttribute('data-state') || ''} ${
                    candidate.getAttribute('data-status') || ''
                  } ${candidate.className || ''}`
              )
              .join(' | ')
              .toLowerCase();
            return /true|loading|busy|spinner|skeleton|progress|shimmer/.test(signalText);
          }
          const errorCandidates = [
            element,
            element.closest("[role='status'], [role='alert'], [role='group'], [role='form']"),
            element.parentElement,
            ...Array.from(
              element.querySelectorAll?.(
                "[role='alert'], [role='status'], [aria-live], .error, .invalid, .danger, .warn"
              ) || []
            ),
          ].filter(Boolean) as Element[];
          const stateText = errorCandidates
            .map(
              (candidate) =>
                `${candidate.getAttribute('data-error') || ''} ${candidate.getAttribute('aria-invalid') || ''} ${candidate.className || ''} ${candidate.getAttribute('data-state') || ''}`
            )
            .join(' | ')
            .toLowerCase();
          return /(error|invalid|danger|warn|failed|aria-invalid|data-error)/.test(stateText);
        }, state)
        .catch(() => false);
      if (!probe) {
        warningBag.push(`${state}_indicator_missing`);
        return { applied: false, warnings: warningBag, failureReason: 'target_interaction_not_reproducible' };
      }
      break;
    }
    case 'disabled':
      if (!stateInfo?.disabled && stateInfo?.ariaDisabled !== 'true') {
        warningBag.push('disabled_state_not_reproducible');
        return { applied: false, warnings: warningBag, failureReason: 'target_interaction_not_reproducible' };
      }
      break;
    default:
      break;
  }

  await page.waitForTimeout(160);
  return { applied: true, warnings: warningBag };
}

async function captureValidationShot(
  browser: import('playwright').Browser,
  projectPreviewUrl: string,
  targetRoute: string,
  viewport: { width: number; height: number },
  state: InteractionState,
  snapshotId: string,
  captureId: string,
  sourceCapture?: ValidationStateCapture,
  allowInteraction = true
): Promise<{ path: string; buffer: Buffer; failureReason?: ValidationFailureReason }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  const targetPath = path.join(snapshotDir(snapshotId), 'validation', 'shots');
  await fs.mkdir(targetPath, { recursive: true });
  const screenshotPath = path.join(targetPath, `${captureId}-${state}.png`);
  let targetUrl: string;
  try {
    const sourceParsed = new URL(targetRoute);
    targetUrl = new URL(sourceParsed.pathname + sourceParsed.search + sourceParsed.hash, projectPreviewUrl).toString();
  } catch {
    targetUrl = new URL(targetRoute, projectPreviewUrl).toString();
  }

  try {
    await page.goto(targetUrl, { timeout: 90_000, waitUntil: 'domcontentloaded' }).catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    });
    await page.waitForTimeout(900);

    const replay = await applyStateForValidation(page, state, sourceCapture, { allowInteraction }).catch(() => ({
      applied: false,
      warnings: ['state_replay_error'],
      failureReason: 'target_interaction_not_reproducible' as const,
    }));
    if (!replay.applied) {
      return { path: screenshotPath, buffer: Buffer.from([]), failureReason: replay.failureReason };
    }

    const extraWait = replay.warnings.length ? 80 : 0;
    if (extraWait) await page.waitForTimeout(extraWait).catch(() => undefined);
    const buffer = (await page.screenshot({ path: screenshotPath, fullPage: true })) as Buffer;
    return { path: screenshotPath, buffer: Buffer.from(buffer) };
  } catch {
    return { path: screenshotPath, buffer: Buffer.from([]), failureReason: 'missing_target_screenshot' };
  } finally {
    await context.close();
  }
}

function normalizeForPixelDiff(sourceImage: PNG, targetImage: PNG): { source: PNG; target: PNG; drifted: boolean } {
  const width = Math.min(sourceImage.width, targetImage.width);
  const height = Math.min(sourceImage.height, targetImage.height);
  if (
    width === sourceImage.width &&
    height === sourceImage.height &&
    width === targetImage.width &&
    height === targetImage.height
  ) {
    return { source: sourceImage, target: targetImage, drifted: false };
  }

  const normalizedSource = new PNG({ width, height });
  const normalizedTarget = new PNG({ width, height });
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * sourceImage.width * 4;
    const targetOffset = row * targetImage.width * 4;
    const outputOffset = row * width * 4;
    normalizedSource.data.set(sourceImage.data.subarray(sourceOffset, sourceOffset + width * 4), outputOffset);
    normalizedTarget.data.set(targetImage.data.subarray(targetOffset, targetOffset + width * 4), outputOffset);
  }
  return { source: normalizedSource, target: normalizedTarget, drifted: true };
}

function buildMissingViewportLabels(args: ValidateInput): string[] {
  if (!args.viewports?.length) return ['captured'];
  return args.viewports.map((viewport) => {
    const parsed = parseViewportToken(viewport);
    if (!parsed) return viewport;
    return `${parsed.width}x${parsed.height}`;
  });
}

export async function validateVisualMatch(args: ValidateInput): Promise<ValidationReport> {
  const snapshot = await readSnapshot(args.snapshotId);
  const reportItems: ValidationItem[] = [];
  const warnings: string[] = [];
  const requestedStates = normalizeStates(args);
  const allCapturedRoutes = snapshot.evidence.pages;
  const routesToCheck = routeCandidates(args, args.projectPreviewUrl);
  const viewportFiltered = allCapturedRoutes.filter((page) => viewportAllows(page, args.viewports));

  const sourcePages: RouteViewportCapture[] = [];
  if (!routesToCheck.length) {
    sourcePages.push(...viewportFiltered);
  } else {
    const uniqueRequestedRoutes = [...new Set(routesToCheck)];
    for (const route of uniqueRequestedRoutes) {
      const routeMatches = viewportFiltered.filter(
        (page) => isRouteMatch(route, page.route) || isRouteMatch(page.route, route)
      );
      if (!routeMatches.length) {
        warnings.push(`Route not captured: ${buildRouteLabel(route)}`);
        const viewportLabel = buildMissingViewportLabels(args);
        for (const state of requestedStates) {
          reportItems.push({
            route,
            viewport: viewportLabel.join(','),
            state,
            diffPercent: 100,
            sourceScreenshot: 'not-generated',
            targetScreenshot: 'not-generated',
            diffScreenshot: null,
            matched: false,
            error: `No captured page for requested route "${route}".`,
            failureReason: 'route_not_crawled_in_state',
            routeFound: false,
            sourceState: 'default',
            targetState: state,
          });
        }
        continue;
      }
      sourcePages.push(...routeMatches);
    }
  }

  const maxDiffPercent =
    typeof args.maxDiffPercent === 'number' && Number.isFinite(args.maxDiffPercent) ? args.maxDiffPercent : 2;
  let matched = 0;
  let worstDiff = 0;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const sourcePage of sourcePages) {
      if (!sourcePage.stateCaptures.length) {
        reportItems.push({
          route: sourcePage.route,
          viewport: `${sourcePage.viewport.width}x${sourcePage.viewport.height}`,
          state: 'default',
          diffPercent: 100,
          sourceScreenshot: sourcePage.fullPageScreenshot,
          targetScreenshot: 'not-generated',
          diffScreenshot: null,
          matched: false,
          error: 'No source state captures found for this route.',
          failureReason: 'state_capture_missing',
          routeFound: true,
          sourceState: 'default',
          targetState: 'default',
        });
        continue;
      }

      const viewportLabel = `${sourcePage.viewport.name} (${sourcePage.viewport.width}x${sourcePage.viewport.height})`;

      for (const state of requestedStates) {
        const sourceCapture = mapValidationState(state, sourcePage.stateCaptures);
        if (!sourceCapture) {
          reportItems.push({
            route: sourcePage.route,
            viewport: viewportLabel,
            state,
            diffPercent: 100,
            sourceScreenshot: sourcePage.fullPageScreenshot,
            targetScreenshot: 'not-generated',
            diffScreenshot: null,
            matched: false,
            error: `No source capture for state "${state}".`,
            failureReason: 'state_capture_missing',
            routeFound: true,
            sourceState: 'default',
            targetState: state,
          });
          continue;
        }

        const useFallbackState = sourceCapture.state !== state;
        const targetResult = await captureValidationShot(
          browser,
          args.projectPreviewUrl,
          sourcePage.route,
          sourcePage.viewport,
          state,
          snapshot.snapshotId,
          sourcePage.captureId,
          sourceCapture,
          !useFallbackState
        );

        const screenshotFile = path.isAbsolute(sourceCapture.screenshot)
          ? sourceCapture.screenshot
          : path.join(snapshotDir(snapshot.snapshotId), sourceCapture.screenshot);
        const sourceBuffer = await fs.readFile(screenshotFile).catch(() => null);
        if (!sourceBuffer) {
          reportItems.push({
            route: sourcePage.route,
            viewport: viewportLabel,
            state,
            diffPercent: 100,
            sourceScreenshot: sourceCapture.screenshot,
            targetScreenshot: targetResult.path,
            diffScreenshot: null,
            matched: false,
            error: 'Missing source screenshot file.',
            failureReason: 'missing_source_screenshot',
            routeFound: true,
            sourceState: sourceCapture.state,
            targetState: state,
            warnings: useFallbackState ? ['state_capture_fallback'] : undefined,
          });
          continue;
        }
        if (!targetResult.buffer.length || targetResult.failureReason) {
          const failureReason =
            targetResult.failureReason ||
            (useFallbackState ? 'state_capture_fallback' : 'target_interaction_not_reproducible');
          reportItems.push({
            route: sourcePage.route,
            viewport: viewportLabel,
            state,
            diffPercent: 100,
            sourceScreenshot: sourceCapture.screenshot,
            targetScreenshot: targetResult.path || 'not-generated',
            diffScreenshot: null,
            matched: false,
            error:
              failureReason === 'state_capture_fallback'
                ? 'State capture fallback was used; exact state was not observed in source.'
                : 'Failed to reproduce target state in validation run.',
            failureReason,
            sourceState: sourceCapture.state,
            targetState: sourceCapture.state !== state ? state : sourceCapture.state,
            routeFound: true,
            warnings: useFallbackState ? ['state_capture_fallback'] : ['state_replay_not_found'],
          });
          continue;
        }

        const sourceImage = PNG.sync.read(sourceBuffer);
        const targetImage = PNG.sync.read(targetResult.buffer);
        const normalized = normalizeForPixelDiff(sourceImage, targetImage);
        const driftReason = normalized.drifted ? 'viewport_drift' : undefined;

        const diffImage = new PNG({ width: normalized.source.width, height: normalized.source.height });
        const mismatches = pixelmatch(
          normalized.source.data,
          normalized.target.data,
          diffImage.data,
          normalized.source.width,
          normalized.source.height,
          { threshold: 0.12 }
        );

        const diffPercent = Number(
          ((mismatches / (normalized.source.width * normalized.source.height)) * 100).toFixed(2)
        );
        const matchedNow = diffPercent <= maxDiffPercent;
        if (matchedNow) matched += 1;
        worstDiff = Math.max(worstDiff, diffPercent);

        const diffRelPath = path.join(
          snapshotDir(snapshot.snapshotId),
          'validation',
          `${sourcePage.captureId}-${state}-diff.png`
        );
        let diffScreenshot: string | null = null;
        if (!matchedNow) {
          await fs.writeFile(diffRelPath, PNG.sync.write(diffImage));
          diffScreenshot = diffRelPath;
        }

        reportItems.push({
          route: sourcePage.route,
          viewport: viewportLabel,
          state,
          diffPercent,
          sourceScreenshot: sourceCapture.screenshot,
          targetScreenshot: targetResult.path,
          diffScreenshot,
          matched: matchedNow,
          failureReason: driftReason ?? (useFallbackState ? 'state_capture_fallback' : undefined),
          sourceViewport:
            sourceCapture.stateTargetMeta?.viewport || `${sourcePage.viewport.width}x${sourcePage.viewport.height}`,
          targetViewport: `${sourcePage.viewport.width}x${sourcePage.viewport.height}`,
          sourceState: sourceCapture.state,
          targetState: state,
          routeFound: true,
          warnings: useFallbackState ? ['state_capture_fallback'] : undefined,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const checks = reportItems.length || 1;
  const summary = {
    routeCount: new Set(sourcePages.map((entry) => entry.route)).size,
    viewportCount: new Set(sourcePages.map((entry) => `${entry.viewport.width}x${entry.viewport.height}`)).size,
    stateCount: reportItems.length,
    maxDiffPercent: worstDiff,
  };

  const status: ValidationReport['status'] =
    reportItems.every((item) => item.matched) && !reportItems.some((item) => item.error) ? 'ok' : 'needs_fix';

  return {
    status,
    overallScore: reportItems.length ? (matched / checks) * 100 : 0,
    summary,
    checks: reportItems,
    warnings: warnings.length ? warnings : reportItems.length === 0 ? ['No comparable captures found.'] : [],
  };
}
