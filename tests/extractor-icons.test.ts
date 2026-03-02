import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

type ExtractorModule = typeof import("../src/extractor.js");
type StorageModule = typeof import("../src/storage.js");

type LoadedModules = {
  extractor: ExtractorModule;
  storage: StorageModule;
};

const nextRoot = () => path.join(os.tmpdir(), `ui-harvester-icon-tests-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`);

async function loadModules(storageRoot: string): Promise<LoadedModules> {
  process.env.UI_HARVESTER_STORAGE_ROOT = storageRoot;
  vi.resetModules();
  const storage = (await import("../src/storage.js")) as StorageModule;
  const extractor = (await import("../src/extractor.js")) as ExtractorModule;
  return { extractor, storage };
}

describe("icon harvesting", () => {
  let browser: Browser;
  let storageRoot = "";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    delete process.env.UI_HARVESTER_STORAGE_ROOT;
    if (storageRoot) {
      await fs.rm(storageRoot, { recursive: true, force: true });
      storageRoot = "";
    }
  });

  beforeEach(() => {
    storageRoot = nextRoot();
  });

  it("normalizes icon URLs and keeps clean filenames", async () => {
    const { extractor } = await loadModules(storageRoot);
    expect(extractor.canonicalizeIconSourceUrl("/icons/favicon.ico", "https://example.test/page")).toBe("https://example.test/icons/favicon.ico");
    expect(extractor.canonicalizeIconSourceUrl("https://example.test/icon.svg?x=1#v2", "https://example.test/page")).toBe("https://example.test/icon.svg");

    const usedNames = new Set<string>();
    const first = extractor.buildIconName("https://cdn.example.test/assets/logo.png", "png", "deadbeef", usedNames, 1, "logo");
    const second = extractor.buildIconName("https://cdn.example.test/assets/logo.png", "png", "deadbeef", usedNames, 2, "logo");
    expect(first.fileName).toBe("logo.png");
    expect(second.fileName).toBe("logo--deadbeef.png");
    expect(extractor.safeIconFileName("Icon Brand ✨")).toBe("Icon-Brand");

    const fallback = extractor.buildIconName("https://cdn.example.test/", "png", "cafebabe", new Set<string>(), 7, "");
    expect(fallback.fileName).toBe("icon-7-cafebabe.png");
  });

  it("collects and captures icon assets across DOM, manifest, and CSS sources", async () => {
    const { extractor, storage } = await loadModules(storageRoot);
    const snapshotId = randomUUID();
    await storage.ensureSnapshot(snapshotId);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const snapshotBase = new URL("https://example.test/page");

    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      const pathname = requestUrl.pathname;
      if (pathname === "/favicon.ico") {
        await route.fulfill({ status: 200, body: "favicon", headers: { "content-type": "image/x-icon" } });
        return;
      }
      if (pathname === "/manifest.webmanifest") {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            icons: [{ src: "/logo.png", type: "image/png" }],
          }),
          headers: { "content-type": "application/manifest+json" },
        });
        return;
      }
      if (pathname === "/logo.png" || pathname === "/css-bg.png" || pathname === "/inline-bg.png" || pathname === "/imported-bg.png") {
        await route.fulfill({ status: 200, body: `${pathname.slice(1)}-icon`, headers: { "content-type": "image/png" } });
        return;
      }
      if (pathname === "/styles.css") {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/css" },
          body: "body { background: url('/css-bg.png'); } @import url('/imported.css');",
        });
        return;
      }
      if (pathname === "/imported.css") {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/css" },
          body: ".brand{background-image: url('/imported-bg.png')}",
        });
        return;
      }
      if (pathname === "/apple-touch-icon.png") {
        await route.fulfill({ status: 200, body: "apple-touch", headers: { "content-type": "image/png" } });
        return;
      }
      await route.continue();
    });

    const html = `
      <!doctype html>
      <html>
        <head>
          <link rel="icon" href="/favicon.ico">
          <link rel="apple-touch-icon" href="/apple-touch-icon.png">
          <link rel="manifest" href="/manifest.webmanifest">
          <link rel="stylesheet" href="/styles.css">
        </head>
        <body>
          <img src="/logo.png" alt="logo" />
          <img src="/logo.png" alt="logo duplicate" />
          <div class="brand" style="background-image: url('/inline-bg.png')"></div>
        </body>
      </html>
    `;

    await page.setContent(html, { url: snapshotBase.toString() });

    const candidates = await extractor.collectIconCandidatesFromPage(page, snapshotBase.toString(), "all");
    const collectedContexts = candidates.candidates.map((entry) => entry.context);
    expect(collectedContexts).toContain("dom-link");
    expect(collectedContexts).toContain("manifest");
    expect(collectedContexts).toContain("img");
    expect(collectedContexts).toContain("css-inline");
    expect(collectedContexts).toContain("css-stylesheet");

    const accumulator = extractor.createIconHarvestState();
    const iconAssets = await extractor.harvestIconsForRoute(snapshotId, page, snapshotBase.toString(), "all", accumulator);
    await context.close();

    expect(iconAssets).toEqual(expect.any(Array));
    expect(iconAssets.some((item) => item.status === "captured")).toBe(true);
    expect(iconAssets.some((item) => item.status === "skipped")).toBe(true);
    expect(iconAssets.some((item) => item.error === "duplicate-url")).toBe(true);
    expect(accumulator.stats.captured).toBeGreaterThan(0);
    expect(accumulator.stats.dedupedByUrl).toBeGreaterThan(0);

    await storage.writeJsonFile(snapshotId, "assets/icons/index.json", {
      snapshotId,
      sourceUrl: snapshotBase.toString(),
      icons: iconAssets,
      total: iconAssets.length,
      summary: accumulator.stats,
    });

    const snapshotDir = storage.snapshotDir(snapshotId);
    for (const icon of iconAssets.filter((item) => item.status === "captured")) {
      const expected = path.join(snapshotDir, icon.localPath);
      const actual = await fs.readFile(expected);
      expect(actual.length).toBeGreaterThan(0);
    }

    const manifest = await storage.readJsonFile<{ icons: Array<{ localPath: string }> }>(snapshotId, "assets/icons/index.json");
    expect(manifest.icons).toHaveLength(iconAssets.length);
    expect(manifest.icons[0]).toHaveProperty("localPath");
  });
});
