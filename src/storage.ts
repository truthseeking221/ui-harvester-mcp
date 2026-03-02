import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UiSnapshotManifest } from './types.js';

const STORAGE_ROOT = process.env.UI_HARVESTER_STORAGE_ROOT
  ? path.resolve(process.env.UI_HARVESTER_STORAGE_ROOT)
  : path.resolve(process.cwd(), '.design-extractor');
const SNAPSHOT_DIR = path.join(STORAGE_ROOT, 'snapshots');

function toSafeSegment(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseViewportString(viewport: string): string {
  return viewport
    .toString()
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_');
}

export function snapshotDir(snapshotId: string) {
  return path.join(SNAPSHOT_DIR, snapshotId);
}

export function screenshotPath(snapshotId: string, captureName: string) {
  return path.join(snapshotDir(snapshotId), 'evidence', 'screenshots', `${toSafeSegment(captureName)}.png`);
}

export async function ensureStorage() {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
}

export async function ensureSnapshot(snapshotId: string) {
  const baseDir = snapshotDir(snapshotId);
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(path.join(baseDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'assets', 'icons'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'evidence'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'evidence', 'screenshots'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'evidence', 'nodes'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'validation'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'artifacts'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'artifacts', 'figma'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'exports'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'tokens'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'components'), { recursive: true });
  return baseDir;
}

export async function saveSnapshot(snapshot: UiSnapshotManifest): Promise<string> {
  await ensureStorage();
  const baseDir = await ensureSnapshot(snapshot.snapshotId);
  await fs.writeFile(path.join(baseDir, 'manifest.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.writeFile(path.join(baseDir, 'tokens', 'core.json'), JSON.stringify(snapshot.tokens.core, null, 2), 'utf8');
  await fs.writeFile(
    path.join(baseDir, 'tokens', 'semantic.json'),
    JSON.stringify(snapshot.tokens.semantic, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(baseDir, 'tokens', 'breakpoints.json'),
    JSON.stringify(snapshot.tokens.breakpoints, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(baseDir, 'components', 'inventory.json'),
    JSON.stringify(snapshot.components.inventory, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(baseDir, 'validation', 'report.json'),
    JSON.stringify(snapshot.validation, null, 2),
    'utf8'
  );
  return path.join(baseDir, 'manifest.json');
}

export async function readSnapshot(snapshotId: string): Promise<UiSnapshotManifest> {
  const file = path.join(snapshotDir(snapshotId), 'manifest.json');
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as UiSnapshotManifest;
}

export async function listSnapshots(): Promise<string[]> {
  await ensureStorage();
  const files = await fs.readdir(SNAPSHOT_DIR);
  return files
    .filter((entry) => !entry.startsWith('.'))
    .sort()
    .reverse();
}

export async function listSnapshotRefs(): Promise<Array<{ snapshotId: string; source: string; createdAt: string }>> {
  const ids = await listSnapshots();
  const out: Array<{ snapshotId: string; source: string; createdAt: string }> = [];
  for (const id of ids) {
    try {
      const snapshot = await readSnapshot(id);
      out.push({ snapshotId: snapshot.snapshotId, source: snapshot.sourceUrl, createdAt: snapshot.createdAt });
    } catch {
      continue;
    }
  }
  return out;
}

export async function deleteSnapshot(snapshotId: string) {
  await fs.rm(snapshotDir(snapshotId), { recursive: true, force: true });
}

export async function writeExportFile(snapshotId: string, filename: string, content: string): Promise<string> {
  const baseDir = await ensureSnapshot(snapshotId);
  const file = path.join(baseDir, 'exports', filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return file;
}

function assertSafePath(baseDir: string, resolved: string) {
  const normalizedBase = path.resolve(baseDir);
  const normalizedResolved = path.resolve(resolved);
  if (!normalizedResolved.startsWith(normalizedBase + path.sep) && normalizedResolved !== normalizedBase) {
    throw new Error(`Path traversal blocked: ${resolved} escapes ${baseDir}`);
  }
}

export async function writeArtifactFile(snapshotId: string, relativePath: string, content: string): Promise<string> {
  const baseDir = await ensureSnapshot(snapshotId);
  const artifactsDir = path.join(baseDir, 'artifacts');
  const file = path.join(artifactsDir, relativePath);
  assertSafePath(artifactsDir, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return file;
}

export async function writeArtifactFiles(
  snapshotId: string,
  files: Array<{ relativePath: string; content: string }>
): Promise<Array<{ relativePath: string; file: string }>> {
  const written: Array<{ relativePath: string; file: string }> = [];
  for (const item of files) {
    const file = await writeArtifactFile(snapshotId, item.relativePath, item.content);
    written.push({ relativePath: item.relativePath, file });
  }
  return written;
}

export async function writeBinaryFile(
  snapshotId: string,
  relativePath: string,
  data: Buffer | Uint8Array | string
): Promise<string> {
  const baseDir = await ensureSnapshot(snapshotId);
  const file = path.join(baseDir, relativePath);
  assertSafePath(baseDir, file);
  await fs.writeFile(file, data);
  return file;
}

export async function readArtifactFile(snapshotId: string, relativePath: string): Promise<string> {
  const baseDir = snapshotDir(snapshotId);
  const artifactsDir = path.join(baseDir, 'artifacts');
  const file = path.join(artifactsDir, relativePath);
  assertSafePath(artifactsDir, file);
  return fs.readFile(file, 'utf8');
}

export async function writeValidationReport(snapshotId: string, report: unknown): Promise<string> {
  const baseDir = await ensureSnapshot(snapshotId);
  const file = path.join(baseDir, 'validation', 'report.json');
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

export async function readValidationReport(snapshotId: string) {
  const raw = await fs.readFile(path.join(snapshotDir(snapshotId), 'validation', 'report.json'), 'utf8');
  return JSON.parse(raw);
}

export function getManifestFile(snapshotId: string) {
  return path.join(snapshotDir(snapshotId), 'manifest.json');
}

export async function readJsonFile<T>(snapshotId: string, relativePath: string): Promise<T> {
  const baseDir = snapshotDir(snapshotId);
  const file = path.join(baseDir, relativePath);
  assertSafePath(baseDir, file);
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(snapshotId: string, relativePath: string, data: unknown): Promise<string> {
  const baseDir = await ensureSnapshot(snapshotId);
  const file = path.join(baseDir, relativePath);
  assertSafePath(baseDir, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

export function buildViewportKey(viewport: {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
}) {
  return `${toSafeSegment(viewport.name)}_${viewport.width}x${viewport.height}_dpr${viewport.deviceScaleFactor ?? 1}`;
}

export function captureId(
  routeUrl: string,
  viewport: { name: string; width: number; height: number; deviceScaleFactor?: number },
  theme: string,
  state: string,
  suffix = ''
) {
  let parsed: URL;
  try {
    parsed = new URL(routeUrl);
  } catch {
    parsed = new URL(routeUrl, 'http://localhost');
  }
  const routeKey = toSafeSegment((parsed.pathname || 'home') + (parsed.search || ''));
  const viewKey = parseViewportString(`${viewport.name}-${viewport.width}x${viewport.height}`);
  return toSafeSegment(`${routeKey}_${viewKey}_${theme}_${state}${suffix ? `_${suffix}` : ''}`);
}
