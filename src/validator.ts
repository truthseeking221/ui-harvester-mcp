import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { readSnapshot, snapshotDir } from "./storage.js";
import { InteractionState, ValidateInput, ValidationReport, ValidationItem } from "./types.js";

type ViewportFilter = { name: string; width: number; height: number };

function parseViewportToken(input: string): ViewportFilter | null {
  const token = input.trim().toLowerCase();
  if (/^\d+x\d+$/.test(token)) {
    const [w, h] = token.split("x").map(Number);
    if (!Number.isNaN(w) && !Number.isNaN(h)) return { name: token, width: w, height: h };
  }
  const [name, dim] = token.split(":");
  if (dim && /^\d+x\d+$/.test(dim)) {
    const [w, h] = dim.split("x").map(Number);
    if (!Number.isNaN(w) && !Number.isNaN(h)) return { name, width: w, height: h };
  }
  return null;
}

function isRouteMatch(route: string, candidate: string): boolean {
  try {
    const routePath = new URL(route).pathname.replace(/\/$/, "");
    const candidatePath = new URL(candidate).pathname.replace(/\/$/, "");
    return routePath === candidatePath;
  } catch {
    return route === candidate;
  }
}

function routeCandidates(args: ValidateInput, projectPreviewUrl: string): string[] {
  if (!args.routes?.length) return [];
  return args.routes.map((item) => {
    const normalized = item.trim();
    if (!normalized) return "";
    if (item.includes("://")) return item;
    const resolved = normalized.startsWith("/") ? new URL(normalized, projectPreviewUrl).toString() : new URL(`/${normalized}`, projectPreviewUrl).toString();
    return resolved;
  });
}

function viewportAllows(
  page: { viewport: { name: string; width: number; height: number } },
  filters: string[] | undefined,
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
  if (!args.states?.length) return ["default"];
  const set = new Set<InteractionState>();
  for (const state of args.states) {
    set.add(state as InteractionState);
  }
  return [...set];
}

async function applyStateForValidation(page: Page, state: InteractionState) {
  const control = page.locator("a,button,input,textarea,select,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='switch'],summary");
  const count = await control.count();
  if (!count) return;
  const target = control.first();

  switch (state) {
    case "hover":
      await target.hover().catch(() => {});
      break;
    case "focus":
      await target.focus().catch(() => {});
      break;
    case "active":
      await target.dispatchEvent("mousedown").catch(() => {});
      await page.waitForTimeout(40).catch(() => {});
      await target.dispatchEvent("mouseup").catch(() => {});
      break;
    case "checked":
    case "selected":
    case "open":
    case "error":
      await target.click().catch(() => {});
      break;
    default:
      break;
  }
}

function mapValidationState(state: InteractionState, stateCaptures: { state: string; screenshot: string; styleSignature: string }[]) {
  const exact = stateCaptures.find((capture) => capture.state === state);
  if (exact) return exact;
  return stateCaptures.find((capture) => capture.state === "default") || stateCaptures[0];
}

async function captureValidationShot(
  browser: import("playwright").Browser,
  projectPreviewUrl: string,
  targetRoute: string,
  viewport: { width: number; height: number },
  state: InteractionState,
  snapshotId: string,
  captureId: string,
): Promise<{ path: string; buffer: Buffer }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  const targetPath = path.join(snapshotDir(snapshotId), "validation", "shots");
  await fs.mkdir(targetPath, { recursive: true });
  const screenshotPath = path.join(targetPath, `${captureId}-${state}.png`);
  const targetUrl = new URL(targetRoute, projectPreviewUrl).toString();

  try {
    await page.goto(targetUrl, { timeout: 90_000, waitUntil: "domcontentloaded" }).catch(async () => {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    });
    await page.waitForTimeout(900);
    await applyStateForValidation(page, state).catch(() => {});
    await page.waitForTimeout(200);
    const buffer = (await page.screenshot({ path: screenshotPath, fullPage: true })) as Buffer;
    return { path: screenshotPath, buffer: Buffer.from(buffer) };
  } finally {
    await context.close();
  }
}

export async function validateVisualMatch(args: ValidateInput): Promise<ValidationReport> {
  const snapshot = await readSnapshot(args.snapshotId);
  const reportItems: ValidationItem[] = [];
  const candidateStates = normalizeStates(args);
  const allCapturedRoutes = snapshot.evidence.pages;
  const routesToCheck = routeCandidates(args, args.projectPreviewUrl);
  const sourcePages = allCapturedRoutes.filter((page) => {
    if (!viewportAllows(page, args.viewports)) return false;
    if (!routesToCheck.length) return true;
    return routesToCheck.some((route) => isRouteMatch(route, page.route) || isRouteMatch(page.route, route));
  });

  const maxDiffPercent = typeof args.maxDiffPercent === "number" && Number.isFinite(args.maxDiffPercent) ? args.maxDiffPercent : 2;
  let matched = 0;
  let worstDiff = 0;

  const browser = await chromium.launch({ headless: true });
  try {
  for (const sourcePage of sourcePages) {
    if (!sourcePage.stateCaptures.length) {
      reportItems.push({
        route: sourcePage.route,
        viewport: `${sourcePage.viewport.width}x${sourcePage.viewport.height}`,
        state: "default",
        diffPercent: 100,
        sourceScreenshot: sourcePage.fullPageScreenshot,
        targetScreenshot: "not-generated",
        diffScreenshot: null,
        matched: false,
        error: "No source state captures found for this route.",
      });
      continue;
    }

    const viewportLabel = `${sourcePage.viewport.name} (${sourcePage.viewport.width}x${sourcePage.viewport.height})`;

    for (const state of candidateStates) {
      const sourceCapture = mapValidationState(state, sourcePage.stateCaptures);
      if (!sourceCapture) {
        reportItems.push({
          route: sourcePage.route,
          viewport: viewportLabel,
          state,
          diffPercent: 100,
          sourceScreenshot: sourcePage.fullPageScreenshot,
          targetScreenshot: "not-generated",
          diffScreenshot: null,
          matched: false,
          error: `No source capture for state "${state}".`,
        });
        continue;
      }

      const targetResult = await captureValidationShot(
        browser,
        args.projectPreviewUrl,
        sourcePage.route,
        sourcePage.viewport,
        state,
        snapshot.snapshotId,
        sourcePage.captureId,
      );

      const sourceBuffer = await fs.readFile(sourceCapture.screenshot).catch(() => null);
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
          error: "Missing source screenshot file.",
        });
        continue;
      }

      const sourceImage = PNG.sync.read(sourceBuffer);
      const targetImage = PNG.sync.read(targetResult.buffer);

      if (sourceImage.width !== targetImage.width || sourceImage.height !== targetImage.height) {
        const sourceHash = createHash("sha1").update(sourceBuffer).digest("hex");
        const targetHash = createHash("sha1").update(targetResult.buffer).digest("hex");
        const mismatch = sourceHash !== targetHash;
        const diffPercent = mismatch ? 100 : 0;
        worstDiff = Math.max(worstDiff, diffPercent);
        if (!mismatch) matched += 1;
        reportItems.push({
          route: sourcePage.route,
          viewport: viewportLabel,
          state,
          diffPercent,
          sourceScreenshot: sourceCapture.screenshot,
          targetScreenshot: targetResult.path,
          diffScreenshot: mismatch ? null : null,
          matched: !mismatch,
          error: mismatch ? "Viewport dimensions differ and hash mismatch." : undefined,
        });
        continue;
      }

      const diffImage = new PNG({ width: sourceImage.width, height: sourceImage.height });
      const mismatches = pixelmatch(
        sourceImage.data,
        targetImage.data,
        diffImage.data,
        sourceImage.width,
        sourceImage.height,
        { threshold: 0.12 },
      );

      const diffPercent = Number(((mismatches / (sourceImage.width * sourceImage.height)) * 100).toFixed(2));
      const matchedNow = diffPercent <= maxDiffPercent;
      if (matchedNow) matched += 1;
      worstDiff = Math.max(worstDiff, diffPercent);

      const diffRelPath = path.join(snapshotDir(snapshot.snapshotId), "validation", `${sourcePage.captureId}-${state}-diff.png`);
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

  const status: ValidationReport["status"] = reportItems.every((item) => item.matched) && !reportItems.some((item) => item.error)
    ? "ok"
    : "needs_fix";

  return {
    status,
    overallScore: reportItems.length ? (matched / checks) * 100 : 0,
    summary,
    checks: reportItems,
    warnings: reportItems.length === 0 ? ["No comparable captures found."] : [],
  };
}
