import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type StorageModule = typeof import('../src/storage.js');

describe('storage utilities', () => {
  let storage: StorageModule;
  let root = '';

  const nextRoot = () =>
    path.join(os.tmpdir(), `ui-harvester-storage-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`);

  async function loadStorage(storageRoot: string) {
    process.env.UI_HARVESTER_STORAGE_ROOT = storageRoot;
    vi.resetModules();
    storage = (await import('../src/storage.js')) as StorageModule;
  }

  beforeEach(async () => {
    root = nextRoot();
    await loadStorage(root);
  });

  afterEach(async () => {
    delete process.env.UI_HARVESTER_STORAGE_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds normalized snapshot and screenshot paths', () => {
    expect(storage.snapshotDir('abc')).toBe(path.join(root, 'snapshots', 'abc'));
    expect(storage.screenshotPath('abc', 'Hero Shot')).toBe(
      path.join(root, 'snapshots', 'abc', 'evidence', 'screenshots', 'hero_shot.png')
    );
    expect(storage.buildViewportKey({ name: 'Desktop', width: 1280, height: 720, deviceScaleFactor: 2 })).toBe(
      'desktop_1280x720_dpr2'
    );
    expect(
      storage.captureId(
        'https://example.test/account/settings',
        { name: 'Desktop', width: 1280, height: 720 },
        'dark',
        'default'
      )
    ).toBe('account_settings_desktop_1280x720_dark_default');
    expect(
      storage.captureId(
        'https://example.test/account/settings',
        { name: 'Desktop', width: 1280, height: 720 },
        'light',
        'default',
        'hover'
      )
    ).toBe('account_settings_desktop_1280x720_light_default_hover');
  });

  it('creates directories and persists artifact/json writes', async () => {
    const snapshotId = 'snapshot-1';

    await storage.ensureStorage();
    await storage.ensureSnapshot(snapshotId);

    const exportFile = await storage.writeExportFile(snapshotId, 'notes/overview.txt', 'snapshot notes');
    const note = await fs.readFile(exportFile, 'utf8');
    expect(note).toBe('snapshot notes');

    const artifactFile = await storage.writeArtifactFile(snapshotId, 'tokens/light.json', JSON.stringify({ ok: true }));
    expect(await storage.readArtifactFile(snapshotId, 'tokens/light.json')).toBe(JSON.stringify({ ok: true }));
    expect(artifactFile).toBe(path.join(root, 'snapshots', snapshotId, 'artifacts', 'tokens', 'light.json'));
    expect(await fs.stat(path.join(root, 'snapshots', snapshotId, 'assets', 'icons'))).toBeDefined();

    const iconPath = await storage.writeBinaryFile(snapshotId, 'assets/icons/favorite-icon.png', Buffer.from('icon'));
    const iconContents = await fs.readFile(iconPath);
    expect(iconContents.toString()).toBe('icon');
    expect(iconPath).toBe(path.join(root, 'snapshots', snapshotId, 'assets', 'icons', 'favorite-icon.png'));
  });

  it('stores and loads typed JSON snapshots without schema coupling', async () => {
    const snapshotId = 'snapshot-json';
    await storage.ensureSnapshot(snapshotId);

    await storage.writeJsonFile(snapshotId, 'meta/inspect.json', {
      nested: {
        route: '/home',
        width: 1280,
      },
      tags: ['visual', 'diff'],
    });

    const loaded = await storage.readJsonFile<{ nested: { route: string; width: number }; tags: string[] }>(
      snapshotId,
      'meta/inspect.json'
    );

    expect(loaded.nested.route).toBe('/home');
    expect(loaded.nested.width).toBe(1280);
    expect(loaded.tags).toEqual(['visual', 'diff']);
    expect(await storage.getManifestFile(snapshotId)).toBe(path.join(root, 'snapshots', snapshotId, 'manifest.json'));
  });
});
