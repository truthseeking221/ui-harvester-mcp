import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { chromium, type Page } from "playwright";
import {
  BreakpointToken,
  ComponentRecipe,
  ComponentVariantState,
  DesignToken,
  DesignTokenBucket,
  ExtractDesignSystemInput,
  CleaningProfile,
  InteractionState,
  NodeComputedStyle,
  NodeSample,
  StateCaptureTargetMeta,
  StateCapture,
  RouteViewportCapture,
  RouteCrawlSummary,
  CollectedIconAsset,
  IconCaptureProfile,
  SemanticTokenBucket,
  ThemeMode,
  ThemeExactnessMode,
  CleaningProfileReport,
  IconHarvestReport,
  UiSnapshotManifest,
  ViewportSpec,
  WaitConfig,
} from "./types.js";
import {
  captureId,
  ensureSnapshot,
  screenshotPath,
  writeBinaryFile,
  writeJsonFile,
} from "./storage.js";

type LocatorAttempt = {
  strategy: string;
  selector: string;
};

type InteractiveTarget = {
  uid: string;
  tag: string;
  role: string | null;
  type: string;
  text: string;
  ariaLabel: string | null;
  classTokens: string[];
  id: string | null;
  bbox: { x: number; y: number; width: number; height: number };
};

type ResolvedInteractiveTarget = {
  found: boolean;
  selector: string;
  strategy: string;
  attempts: string[];
  target: InteractiveTarget;
  resolved: {
    found: boolean;
    strategy: string;
    locator: string;
    attempts: string[];
    recoverable: boolean;
    confidence?: number;
  };
  restore?: () => Promise<void>;
};

type SignatureDiff = {
  changed: string[];
  added: string[];
  removed: string[];
};

type InteractionApplyResult = {
  warnings: string[];
  skipped: boolean;
  probe: InteractionStateProbe;
  restore?: () => Promise<void>;
};

type InteractionStateProbe = {
  supported: boolean;
  stateApplied: boolean;
  locatorRecovered: boolean;
  warnings: string[];
};

type StableResult = {
  stable: boolean;
  checkedFrames: number;
  unchangedFrames: number;
  unstableFrames: number;
};

const LOADING_ERROR_STATES = ["loading", "error"] as const;

function safeToFixed(value: number | null | undefined, digits = 3): string {
  if (!Number.isFinite(value as number)) return "0";
  return `${Math.round((value as number) * 10 ** digits) / 10 ** digits}`;
}

type ComponentStateCaptureInput = {
  state: InteractionState;
  styleSignature: string;
  changedProperties: string[];
  changedPropertiesAdded: string[];
  changedPropertiesRemoved: string[];
  propertyDeltas: Record<string, { before: string; after: string }>;
  targetSelector: string;
  stateTargetMeta: StateCapture["stateTargetMeta"];
  screenshot?: string;
  examples: string[];
  provenance?: string[];
  source?: ComponentVariantState["source"];
};

const signatureStyleKeys: Array<keyof NodeComputedStyle> = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "overflow",
  "boxSizing",
  "color",
  "backgroundColor",
  "borderColor",
  "borderWidth",
  "borderStyle",
  "borderRadius",
  "boxShadow",
  "textShadow",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textTransform",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "gap",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "opacity",
  "transition",
  "animation",
  "outline",
  "outlineColor",
  "outlineWidth",
  "filter",
  "backdropFilter",
];

const DEFAULT_VIEWPORTS: ViewportSpec[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const DEFAULT_WAIT: Required<WaitConfig> = {
  networkQuietMs: 1200,
  mutationStabilityFrames: 5,
  fontWaitMs: 800,
  settleMs: 700,
};

const SUPPORTED_INTERACTION_STATES: InteractionState[] = [
  "hover",
  "focus",
  "active",
  "checked",
  "selected",
  "open",
  "disabled",
  "loading",
  "error",
];

const CHECKABLE_TYPES = new Set(["checkbox", "radio", "switch"]);
const STATE_SUPPORT: Partial<Record<InteractionState, ReadonlySet<string>>> = {
  checked: new Set(["input", "label", "button", "summary", "checkbox", "radio", "switch"]),
  selected: new Set(["option", "tab", "menuitem", "checkbox", "radio", "switch", "row"]),
  open: new Set(["button", "summary", "details", "tab", "menuitem", "combobox", "checkbox", "radio", "switch", "a", "dialog"]),
  disabled: new Set(["button", "input", "textarea", "select", "summary", "a", "option", "menuitem", "tab", "switch", "checkbox", "radio"]),
  loading: new Set(["button", "input", "a", "summary", "div", "span", "article", "section"]),
  error: new Set(["input", "button", "form", "textarea", "select", "article", "section", "div", "span"]),
};

const supportsStateTarget = (state: InteractionState, hint: { tag?: string; role?: string; type?: string }) => {
  if (state === "hover" || state === "focus" || state === "active") return true;
  const tag = toLowerString(hint.tag || "");
  const role = toLowerString(hint.role || "");
  const type = toLowerString(hint.type || "");
  const support = STATE_SUPPORT[state];
  if (!support) return true;
  return support.has(tag) || support.has(role) || support.has(type);
};

const DEFAULT_CLEANING_PROFILE: CleaningProfile = "high";
const DEFAULT_ICON_CAPTURE_PROFILE: IconCaptureProfile = "all";

const PROFILE_LIMITS = {
  high: {
    sampleCapMultiplier: 0.7,
    sampleStrideMultiplier: 2,
    maxComponentStates: 4,
    maxComponentExamples: 6,
    sampleNoiseAreaThreshold: 1,
    numericMinCount: 2,
    outlierIqr: 1.3,
    signatureDedupBucketPx: 4,
    sizeValueDigits: 2,
  },
  balanced: {
    sampleCapMultiplier: 0.9,
    sampleStrideMultiplier: 1.3,
    maxComponentStates: 8,
    maxComponentExamples: 8,
    sampleNoiseAreaThreshold: 1,
    numericMinCount: 1,
    outlierIqr: 2.0,
    signatureDedupBucketPx: 2,
    sizeValueDigits: 3,
  },
  minimal: {
    sampleCapMultiplier: 1,
    sampleStrideMultiplier: 1,
    maxComponentStates: 16,
    maxComponentExamples: 12,
    sampleNoiseAreaThreshold: 0,
    numericMinCount: 1,
    outlierIqr: 9,
    signatureDedupBucketPx: 1,
  sizeValueDigits: 3,
  },
} as const;

type CleaningProfileCtx = {
  profile: CleaningProfile;
  sampleStrideMultiplier: number;
  sampleCapMultiplier: number;
  sampleNoiseAreaThreshold: number;
  maxComponentStates: number;
  maxComponentExamples: number;
  numericMinCount: number;
  signatureDedupBucketPx: number;
  outlierIqr: number;
  sizeValueDigits: number;
};

function createCleaningProfileContext(profile: CleaningProfile): CleaningProfileCtx {
  const cfg = PROFILE_LIMITS[profile];
  return {
    profile,
    sampleStrideMultiplier: cfg.sampleStrideMultiplier,
    sampleCapMultiplier: cfg.sampleCapMultiplier,
    sampleNoiseAreaThreshold: cfg.sampleNoiseAreaThreshold,
    maxComponentStates: cfg.maxComponentStates,
    maxComponentExamples: cfg.maxComponentExamples,
    numericMinCount: cfg.numericMinCount,
    signatureDedupBucketPx: cfg.signatureDedupBucketPx,
    outlierIqr: cfg.outlierIqr,
    sizeValueDigits: cfg.sizeValueDigits,
  };
}

export function resolveCleaningProfileContext(profile: CleaningProfile): CleaningProfileCtx {
  return createCleaningProfileContext(profile);
}

export function defaultCleaningReport(profile: CleaningProfile): CleaningProfileReport {
  return {
    profile,
    samplesSeen: 0,
    samplesKept: 0,
    samplesDropped: 0,
    mergedColorCount: 0,
    spacingOutliersRemoved: 0,
    stateRecordsDropped: 0,
  };
}

type NumericObservation = {
  value: number;
  provenance: string;
};

type GatheredSamples = {
  samples: NodeSample[];
  seen: number;
  kept: number;
  dropped: number;
};

function profileRound(value: number, digits: number): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function formatRoundedPx(value: number, digits: number): string {
  if (!Number.isFinite(value)) return `${value}`;
  const rounded = profileRound(value, digits);
  if (Number.isInteger(rounded)) return `${rounded}`;
  return `${Number(rounded.toFixed(digits))}`;
}

function normalizeCanonicalLengthForProfile(raw: string, profile: CleaningProfile): string | null {
  const digits = PROFILE_LIMITS[profile]?.sizeValueDigits ?? PROFILE_LIMITS[DEFAULT_CLEANING_PROFILE].sizeValueDigits;
  const normalized = toCanonicalLength(raw);
  if (!normalized) return null;
  if (normalized === "0" || normalized === "gradient") return normalized;

  const safe = normalized.split(";px=")[0] ?? normalized;
  if (safe.startsWith("calc(") || safe.startsWith("max(") || safe.startsWith("min(") || safe.startsWith("clamp(")) {
    return safe;
  }

  if (safe.includes("%") || safe.includes("vw") || safe.includes("vh") || safe.includes("vmin") || safe.includes("vmax")) {
    return safe;
  }

  const match = safe.match(/^-?\d*\.?\d+([a-z%]+)?$/);
  if (!match) return normalized;
  const unit = (match[1] || "px").toLowerCase();
  const numeric = Number.parseFloat(safe);
  if (!Number.isFinite(numeric)) return normalized;
  if (unit === "%" || unit === "vw" || unit === "vh" || unit === "vmin" || unit === "vmax") return safe;
  if (unit === "") return `${formatRoundedPx(numeric, digits)}px`;
  if (unit === "px") return `${formatRoundedPx(numeric, digits)}px`;
  return `${formatRoundedPx(numeric, digits)}${unit}`;
}

function outlierTrimmed(observations: NumericObservation[], iqrMultiplier: number) {
  if (!observations.length || !Number.isFinite(iqrMultiplier) || iqrMultiplier <= 0) {
    return { kept: observations, removed: 0 };
  }

  const values = observations.map((entry) => entry.value).sort((a, b) => a - b);
  const q1Index = Math.floor(values.length * 0.25);
  const q3Index = Math.floor(values.length * 0.75);
  const q1 = values[q1Index] ?? values[0] ?? 0;
  const q3 = values[q3Index] ?? values[values.length - 1] ?? 0;
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) {
    const p05Index = Math.floor(values.length * 0.05);
    const p95Index = Math.floor(values.length * 0.95);
    const p05 = values[p05Index] ?? values[0] ?? 0;
    const p95 = values[p95Index] ?? values[values.length - 1] ?? 0;
    const range = p95 - p05;
    if (!Number.isFinite(range) || range <= 0) {
      const freq = new Map<number, number>();
      for (const value of values) freq.set(value, (freq.get(value) || 0) + 1);
      let dominant = values[0] ?? 0;
      let maxCount = 0;
      for (const [value, count] of freq.entries()) {
        if (count > maxCount) {
          dominant = value;
          maxCount = count;
        }
      }
      const kept: NumericObservation[] = [];
      let removed = 0;
      for (const entry of observations) {
        const distance = Math.abs(entry.value - dominant);
        if (distance <= Math.max(1, iqrMultiplier * 1)) {
          kept.push(entry);
        } else {
          removed += 1;
        }
      }
      return { kept, removed };
    }
    const min = p05 - range * iqrMultiplier;
    const max = p95 + range * iqrMultiplier;
    const kept: NumericObservation[] = [];
    let removed = 0;
    for (const entry of observations) {
      if (entry.value < min || entry.value > max) {
        removed += 1;
      } else {
        kept.push(entry);
      }
    }
    return { kept, removed };
  }

  const min = q1 - iqr * iqrMultiplier;
  const max = q3 + iqr * iqrMultiplier;
  const kept: NumericObservation[] = [];
  let removed = 0;
  for (const entry of observations) {
    if (entry.value < min || entry.value > max) {
      removed += 1;
    } else {
      kept.push(entry);
    }
  }
  return { kept, removed };
}

function bucketFromPx(value: number, bucketPx: number) {
  if (!Number.isFinite(bucketPx) || bucketPx <= 0) return value;
  return Math.round(value / bucketPx) * bucketPx;
}

function parseCanonicalLengthToNumber(input: string): number | null {
  if (!input) return null;
  const normalized = toLowerString(input);
  if (!normalized || normalized === "gradient") return null;

  const token = normalized;
  if (token.startsWith("calc(") || token.startsWith("max(") || token.startsWith("min(") || token.startsWith("clamp(")) return null;

  const pxAlias = token.match(/;px=([+-]?\d*\.?\d+)px$/);
  if (pxAlias && pxAlias[1]) {
    const parsed = Number.parseFloat(pxAlias[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const matched = token.match(/^-?\d*\.?\d+(?=px$)/);
  if (!matched) {
    const pct = token.match(/^-?\d*\.?\d+(?=%$)/);
    if (pct) return Number.parseFloat(pct[0]);
    const fallback = token.match(/^-?\d*\.?\d+$/);
    if (fallback) return Number.parseFloat(fallback[0]);
    return null;
  }

  return Number.parseFloat(matched[0]);
}

function parseLengthForProfile(value: string, profile: CleaningProfile): number | null {
  const canonical = normalizeCssLengthForSignature(value, profile);
  if (!canonical) return null;
  const parsed = parseCanonicalLengthToNumber(canonical);
  if (parsed === null) return null;
  return parsed;
}

function roundLengthForProfile(value: number | null, profile: CleaningProfile): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return profileRound(value, PROFILE_LIMITS[profile]?.sizeValueDigits ?? PROFILE_LIMITS[DEFAULT_CLEANING_PROFILE].sizeValueDigits);
}

function stateDeltaFingerprint(stateCapture: ComponentStateCaptureInput): string {
  const changed = [...new Set(stateCapture.changedProperties || [])].sort().join(",");
  const added = [...new Set(stateCapture.changedPropertiesAdded || [])].sort().join(",");
  const removed = [...new Set(stateCapture.changedPropertiesRemoved || [])].sort().join(",");
  const deltas = Object.keys(stateCapture.propertyDeltas || {})
    .sort()
    .map((key) => {
      const delta = stateCapture.propertyDeltas?.[key] || { before: "", after: "" };
      return `${key}:${delta.before}->${delta.after}`;
    })
    .join(";");
  return `${stateCapture.state}|${stateCapture.styleSignature || ""}|${changed}|${added}|${removed}|${deltas}`;
}

function stateKeyFromVariant(state: ComponentVariantState): string {
  const changed = [...new Set(state.changedProperties || [])].sort().join(",");
  const added = [...new Set(state.changedPropertiesAdded || [])].sort().join(",");
  const removed = [...new Set(state.changedPropertiesRemoved || [])].sort().join(",");
  const deltas = Object.keys(state.propertyDeltas || {})
    .sort()
    .map((key) => {
      const delta = state.propertyDeltas?.[key] || { before: "", after: "" };
      return `${key}:${delta.before}->${delta.after}`;
    })
    .join("|");
  return `${state.state}|${state.styleSignature || ""}|${changed}|${added}|${removed}|${deltas}`;
}

function toCanonicalRadiusPxValue(value: string, profile: CleaningProfile): number | null {
  const numeric = parseLengthForProfile(value, profile);
  if (numeric === null) return null;
  return roundLengthForProfile(numeric, profile);
}

function toCanonicalLengthToken(value: number, profile: CleaningProfile): string {
  const rounded = roundLengthForProfile(value, profile);
  if (rounded === null || !Number.isFinite(rounded)) return `${value}`;
  if (Object.is(rounded, -0)) return "0";
  return `${rounded}px`;
}

function canonicalizeStateDeltas(
  propertyDeltas?: ComponentStateCaptureInput["propertyDeltas"] | Record<string, { before: string; after: string }>,
): Record<string, { before: string; after: string }> {
  const out: Record<string, { before: string; after: string }> = {};
  if (!propertyDeltas) return out;
  for (const key of Object.keys(propertyDeltas).sort()) {
    const delta = propertyDeltas[key];
    if (!delta) continue;
    const before = toLowerString(delta.before || "");
    const after = toLowerString(delta.after || "");
    if (before === after) continue;
    out[key] = { before, after };
  }
  return out;
}

function canonicalizeStateTargetMeta(
  meta?: StateCapture["stateTargetMeta"],
): string[] {
  if (!meta) return [];
  const attempts = (meta.attempts || []).filter(Boolean).slice(0, 5);
  const chunks: string[] = [];
  chunks.push(`found=${meta.found ? "true" : "false"}`);
  chunks.push(`strategy=${meta.strategy || "unknown"}`);
  chunks.push(`selector=${meta.selector || "n/a"}`);
  chunks.push(`locator=${meta.locator || "n/a"}`);
  if (meta.route) chunks.push(`route=${meta.route}`);
  if (meta.viewport) chunks.push(`viewport=${meta.viewport}`);
  if (meta.theme) chunks.push(`theme=${meta.theme}`);
  if (meta.tag) chunks.push(`tag=${meta.tag}`);
  if (meta.role) chunks.push(`role=${meta.role}`);
  if (meta.type) chunks.push(`type=${meta.type}`);
  if (meta.text) chunks.push(`text=${meta.text}`);
  if (meta.ariaLabel) chunks.push(`aria=${meta.ariaLabel}`);
  if (meta.classTokens?.length) chunks.push(`class=${meta.classTokens.slice(0, 6).join(" ")}`);
  if (meta.bbox) chunks.push(`bbox=${meta.bbox.x},${meta.bbox.y},${meta.bbox.width},${meta.bbox.height}`);
  if (typeof meta.recoverable === "boolean") chunks.push(`recoverable=${meta.recoverable ? "true" : "false"}`);
  if (attempts.length) chunks.push(`attempts=${attempts.join(",")}`);
  return chunks;
}

type NumericBucket = {
  count: number;
  provenance: string[];
};

type IconContext = "dom-link" | "manifest" | "img" | "css-inline" | "css-stylesheet";

type RawIconCandidate = {
  sourceUrl: string;
  context: IconContext;
  rel?: string;
  nameHint?: string;
  inlineSvg?: string;
  sourcePage: string;
  width?: number | null;
  height?: number | null;
};

type IconHarvestStats = IconHarvestReport;

const ALLOWED_ICON_EXTENSIONS = new Set([".ico", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".avif"]);

const MIME_TO_EXT: Record<string, string> = {
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

type RawIconCandidateBundle = {
  candidates: RawIconCandidate[];
  styleSheets: string[];
};

type IconHarvestAccumulator = {
  bySourceUrl: Set<string>;
  byHash: Set<string>;
  usedFileNames: Set<string>;
  icons: CollectedIconAsset[];
  stats: IconHarvestStats;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBaseNameFromUrl(input: string): string {
  const withoutQuery = input.split("?")[0]?.split("#")[0] ?? "";
  const base = withoutQuery.split("/").filter(Boolean).pop() || "";
  return decodeURIComponent(base || "").trim();
}

export function extractExtFromSource(sourceUrl: string): string | null {
  const withoutQuery = sourceUrl.split("?")[0]?.split("#")[0] ?? "";
  const base = withoutQuery.split("/").filter(Boolean).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length > 0 && ext.length <= 8 ? ext : null;
}

function extFromMime(mime?: string | null): string | null {
  if (!mime) return null;
  const cleaned = mime.split(";")[0]?.trim().toLowerCase() || "";
  return MIME_TO_EXT[cleaned] ?? (cleaned?.split("/")[1]?.trim() || null);
}

function isImageMime(mime?: string | null): boolean {
  const cleaned = mime?.split(";")[0]?.trim().toLowerCase() || "";
  return cleaned.startsWith("image/");
}

function isLikelyIconUrl(rawUrl: string, mime: string | null, context: IconContext, rel?: string, _nameHint?: string): boolean {
  const candidate = rawUrl.toLowerCase().trim();
  const ext = extractExtFromSource(candidate);
  if (ext && ALLOWED_ICON_EXTENSIONS.has(`.${ext}`)) return true;
  if (isImageMime(mime)) return true;
  if (context === "css-inline" || context === "css-stylesheet") {
    return candidate.includes("icon") || candidate.includes("logo") || candidate.includes("favicon") || candidate.includes("apple-touch");
  }
  const normalizedRel = (rel || "").toLowerCase();
  if (normalizedRel.includes("icon") || normalizedRel.includes("apple-touch") || normalizedRel.includes("msapplication")) return true;
  return candidate.includes("icon") || candidate.includes("logo") || candidate.includes("favicon");
}

function shouldCollectCandidate(profile: IconCaptureProfile, context: IconContext): boolean {
  if (profile === "favicon-only") return context === "dom-link";
  if (profile === "selected") return context === "dom-link" || context === "manifest" || context === "img";
  return true;
}

function parseDataUri(input: string): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;base64)?,(.*)$/i.exec(input);
  if (!match) return null;
  const fullMime = (match[1] || "image/png").trim();
  const content = match[2] || "";
  if (!content) return null;
  const mime = fullMime.split(";")[0] ?? null;
  try {
    if (input.includes(";base64")) {
      return { mime, data: Buffer.from(content, "base64") };
    }
    return { mime, data: Buffer.from(decodeURIComponent(content), "utf8") };
  } catch {
    return null;
  }
}

export function safeIconFileName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^\W+|\W+$/g, "")
    .slice(0, 140) || "icon";
}

export function uniqueIconPath(fileName: string, usedNames: Set<string>): string {
  let index = 0;
  const base = (fileName.includes(".") ? fileName.split(".").slice(0, -1).join(".") : fileName).trim();
  const ext = fileName.includes(".") ? `.${fileName.split(".").pop() || ""}` : "";
  const sanitizedBase = base || "icon";
  let candidate = `${sanitizedBase}${ext}`;
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${sanitizedBase}-${index}${ext}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export function canonicalizeIconSourceUrl(raw: string, baseUrl: string): string | null {
  if (!raw) return null;
  if (raw.startsWith("data:")) return raw;
  if (raw.startsWith("blob:")) return null;
  const value = raw.trim();
  try {
    const resolved = new URL(value, baseUrl);
    if (resolved.protocol === "data:") return raw;
    if (resolved.protocol === "blob:") return null;
    resolved.hash = "";
    resolved.search = "";
    return resolved.toString();
  } catch {
    if (/^https?:\/\//i.test(value)) return null;
    return null;
  }
}

export function buildIconName(rawUrl: string, ext: string, sha8: string, usedNames: Set<string>, fallbackIndex: number, hint?: string): { fileName: string; ext: string } {
  let finalExt = (ext || "").toLowerCase().replace(/^\./, "");
  const parsedExt = extractExtFromSource(rawUrl);
  if (!finalExt) finalExt = parsedExt || "bin";
  const fromPath = getBaseNameFromUrl(rawUrl);
  const baseHint = (hint || fromPath || `icon-${fallbackIndex}`).replace(/\.[a-z0-9]{1,8}$/i, "");
  const cleanBase = safeIconFileName(baseHint) || `icon-${fallbackIndex}`;
  const withExt = finalExt ? `${cleanBase}.${finalExt}` : cleanBase;
  const normalized = withExt.toLowerCase();
  if (!usedNames.has(normalized)) {
    usedNames.add(normalized);
    return { fileName: withExt, ext: finalExt };
  }
  const collisionBase = finalExt ? `${cleanBase}--${sha8}` : `${cleanBase}--${sha8}`;
  const candidate = finalExt ? `${collisionBase}.${finalExt}` : collisionBase;
  const normalizedCollision = candidate.toLowerCase();
  if (!usedNames.has(normalizedCollision)) {
    usedNames.add(normalizedCollision);
    return { fileName: candidate, ext: finalExt };
  }
  return { fileName: uniqueIconPath(candidate, usedNames), ext: finalExt };
}

function extractUrlsFromCss(cssText: string, baseHref: string): string[] {
  if (!cssText) return [];
  const out: string[] = [];
  const regex = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cssText)) !== null) {
    const raw = (match[2] || "").trim();
    if (!raw || raw.startsWith("javascript:")) continue;
    out.push(raw);
  }
  const importRegex = /@import\s+(?:url\(\s*)?(["']?)(.*?)\1(?:\s*\))?/gi;
  while ((match = importRegex.exec(cssText)) !== null) {
    const raw = (match[2] || "").trim();
    if (!raw || raw.startsWith("javascript:")) continue;
    out.push(raw);
  }
  return out
    .filter((entry) => Boolean(entry))
    .map((entry) => {
      try {
        const resolved = new URL(entry, baseHref);
        return resolved.toString();
      } catch {
        return entry;
      }
    });
}

async function readResourceText(page: Page, sourceUrl: string, timeoutMs = 12_000): Promise<{ body: string; contentType: string | null } | null> {
  try {
    const response = await page.request.get(sourceUrl, { timeout: timeoutMs });
    const status = response.status();
    if (status >= 200 && status < 400) {
      const contentType = response.headers()["content-type"] ?? null;
      const body = await response.text();
      return { body, contentType };
    }
  } catch {
    // intentionally ignored to allow fallback
  }

  try {
    const response = await fetch(sourceUrl, { redirect: "follow" });
    if (!response.ok) return null;
    const body = await response.text();
    return { body, contentType: response.headers.get("content-type") };
  } catch {
    return null;
  }
}

export async function collectIconCandidatesFromPage(
  page: Page,
  sourcePage: string,
  iconCaptureProfile: IconCaptureProfile,
): Promise<RawIconCandidateBundle> {
  const bundle = await page.evaluate(
    (payload) => {
      const shouldCollect = (context: string) => {
        if (payload.profile === "favicon-only") return context === "dom-link";
        if (payload.profile === "selected") return context === "dom-link" || context === "manifest" || context === "img";
        return true;
      };
      const toAbsolute = (value: string | null | undefined) => {
        if (!value) return "";
        try {
          return new URL(value, payload.sourcePage).toString();
        } catch {
          return "";
        }
      };
      const parseStyleIcons = (cssText: string) => {
        const found: string[] = [];
        const regex = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(cssText)) !== null) {
          const value = (match[2] || "").trim();
          if (value && !value.startsWith("javascript:")) found.push(value);
        }
        const importRegex = /@import\s+(?:url\(\s*)?(["']?)(.*?)\1(?:\s*\))?/gi;
        while ((match = importRegex.exec(cssText)) !== null) {
          const value = (match[2] || "").trim();
          if (value && !value.startsWith("javascript:")) found.push(value);
        }
        return found;
      };
      const candidates: Array<{
        sourceUrl: string;
        context: "dom-link" | "manifest" | "img" | "css-inline" | "css-stylesheet";
        rel?: string;
        nameHint?: string;
        inlineSvg?: string;
        sourcePage: string;
        width?: number;
        height?: number;
      }> = [];
      const seenStyleSheets = new Set<string>();

      const add = (sourceUrl: string, context: "dom-link" | "manifest" | "img" | "css-inline" | "css-stylesheet", details: { rel?: string; nameHint?: string; inlineSvg?: string; width?: number; height?: number }) => {
        if (!shouldCollect(context)) return;
        const next = String(sourceUrl || "").trim();
        if (!next) return;
        candidates.push({
          sourceUrl: next,
          context,
          rel: details.rel,
          nameHint: details.nameHint,
          inlineSvg: details.inlineSvg,
          width: details.width,
          height: details.height,
          sourcePage: payload.sourcePage,
        });
      };

      document.querySelectorAll("link[rel][href]").forEach((link) => {
        const html = link as HTMLLinkElement;
        const rel = (html.getAttribute("rel") || "").toLowerCase();
        const href = toAbsolute(html.getAttribute("href") || "");
        if (!href) return;
        const isManifest = rel.includes("manifest");
        const isIcon = rel.includes("icon") || rel.includes("apple-touch-icon") || rel.includes("shortcut");
        if (isManifest) {
          add(href, "manifest", { rel, nameHint: "manifest" });
          return;
        }
        if (!isIcon && payload.profile === "favicon-only") return;
        if (isIcon || payload.profile === "all") {
          add(href, "dom-link", { rel, nameHint: rel });
        }
      });

      const tileMeta = document.querySelector("meta[name='msapplication-TileImage']");
      if (tileMeta && (payload.profile === "all" || payload.profile === "selected")) {
        const content = tileMeta.getAttribute("content") || "";
        add(content, "dom-link", { rel: "msapplication-TileImage", nameHint: "msapplication-tile-image" });
      }

      const collectImgLike = (element: HTMLImageElement | HTMLSourceElement) => {
        const explicit = element.getAttribute("src");
        const srcset = element.getAttribute("srcset");
        const width = Number.parseInt(element.getAttribute("width") || "", 10) || undefined;
        const height = Number.parseInt(element.getAttribute("height") || "", 10) || undefined;
        const nameHint =
          (element as HTMLImageElement).alt || element.getAttribute("title") || element.getAttribute("id") || element.getAttribute("class") || "img-icon";
        if (explicit) add(toAbsolute(explicit), "img", { nameHint, width, height });
        if (!srcset) return;
        const split = srcset
          .split(",")
          .map((entry) => entry.trim().split(/\s+/)[0] || "")
          .filter(Boolean)
          .map((entry) => toAbsolute(entry));
        for (const entry of split) {
          if (entry) add(entry, "img", { nameHint, width, height });
        }
      };
      document.querySelectorAll("img").forEach((image) => collectImgLike(image as HTMLImageElement));
      document.querySelectorAll("source[src], source[srcset]").forEach((source) => collectImgLike(source as HTMLSourceElement));

      let svgIndex = 0;
      document.querySelectorAll("svg").forEach((svg) => {
        if (payload.profile === "favicon-only") return;
        const hint = svg.getAttribute("id") || svg.getAttribute("class") || svg.getAttribute("aria-label") || `inline-svg-${svgIndex + 1}`;
        const width = Number.parseFloat(svg.getAttribute("width") || "") || undefined;
        const height = Number.parseFloat(svg.getAttribute("height") || "") || undefined;
        const containsClues = /logo|icon|brand/i.test(hint || svg.getAttribute("class") || "");
        if (payload.profile === "selected" && !containsClues) {
          const hasRole = svg.getAttribute("role") === "img";
          if (!hasRole) return;
        }
        const svgHtml = svg.outerHTML || "";
        const sourceUrl = `inline-svg://${payload.sourcePage}#${svgIndex + 1}`;
        add(sourceUrl, "img", { inlineSvg: svgHtml, nameHint: hint || `svg-${svgIndex + 1}`, width, height });
        svgIndex += 1;
      });

      const styleTags = Array.from(document.querySelectorAll("style")).map((style) => style.textContent || "").filter(Boolean) as string[];
      const inlineStyleIcons: string[] = [];
      document.querySelectorAll("[style]").forEach((element) => {
        const css = (element.getAttribute("style") || "").trim();
        if (css.includes("url(")) {
          inlineStyleIcons.push(...parseStyleIcons(css));
        }
      });
      if (shouldCollect("css-inline")) {
        for (const entry of inlineStyleIcons) {
          add(toAbsolute(entry), "css-inline", { nameHint: "inline-style" });
        }
        for (const rawCss of styleTags) {
          for (const cssUrl of parseStyleIcons(rawCss)) {
            add(toAbsolute(cssUrl), "css-inline", { nameHint: "css-style-tag" });
          }
        }
      }

      if (shouldCollect("css-stylesheet")) {
        document.querySelectorAll("link[rel='stylesheet'][href]").forEach((styleLink) => {
          const href = toAbsolute((styleLink as HTMLLinkElement).getAttribute("href") || "");
          if (href) seenStyleSheets.add(href);
        });
      }

      const normalized = candidates.filter((entry, index, all) => {
        const key = `${entry.context}:${entry.sourceUrl}`;
        return all.findIndex((item) => `${item.context}:${item.sourceUrl}` === key) === index;
      });
      return { candidates: normalized, styleSheets: [...seenStyleSheets] };
    },
    { profile: iconCaptureProfile, sourcePage },
  );
  const normalized = await Promise.resolve(bundle);
  return normalized;
}

async function collectManifestIcons(page: Page, manifestUrl: string, sourcePage: string, iconCaptureProfile: IconCaptureProfile): Promise<RawIconCandidate[]> {
  if (iconCaptureProfile === "favicon-only") return [];
  const data = await readResourceText(page, manifestUrl);
  if (!data?.body) return [];
  try {
    const parsed = JSON.parse(data.body) as { icons?: Array<{ src?: string; type?: string; sizes?: string; purpose?: string }> };
    if (!Array.isArray(parsed.icons)) return [];
    return parsed.icons
      .map((entry, index): RawIconCandidate | null => {
        if (!entry?.src) return null;
        return {
          sourceUrl: entry.src,
          context: "manifest",
          nameHint: entry.sizes || entry.type || `manifest-icon-${index + 1}`,
          sourcePage,
        };
      })
      .filter((entry): entry is RawIconCandidate => Boolean(entry));
  } catch {
    return [];
  }
}

async function collectStylesheetIcons(page: Page, stylesheetUrl: string, sourcePage: string, iconCaptureProfile: IconCaptureProfile): Promise<RawIconCandidate[]> {
  if (iconCaptureProfile === "favicon-only") return [];
  const data = await readResourceText(page, stylesheetUrl);
  if (!data?.body) return [];
  const extracted = extractUrlsFromCss(data.body, stylesheetUrl);
  return extracted
    .map((entry) => ({
      sourceUrl: entry,
      context: "css-stylesheet" as const,
      sourcePage,
      nameHint: `stylesheet:${new URL(stylesheetUrl).pathname.split("/").pop() || "css"}`,
    }))
    .filter((entry) => entry.sourceUrl);
}

async function downloadIconData(candidate: RawIconCandidate, page: Page, profileStats: IconHarvestStats): Promise<{
  success: boolean;
  bytes: number | null;
  sha256: string | null;
  mime: string | null;
  error?: string | null;
  data?: Buffer;
  retries: number;
}> {
  if (candidate.inlineSvg) {
    const utf = candidate.inlineSvg.trim();
    const buffer = Buffer.from(utf, "utf8");
    return {
      success: buffer.length > 0,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      mime: "image/svg+xml",
      data: buffer,
      retries: 0,
    };
  }
  if (candidate.sourceUrl.startsWith("data:")) {
    const decoded = parseDataUri(candidate.sourceUrl);
    if (!decoded) {
      return { success: false, bytes: null, sha256: null, mime: null, error: "invalid-data-uri", retries: 0 };
    }
    return {
      success: decoded.data.length > 0,
      bytes: decoded.data.length,
      sha256: createHash("sha256").update(decoded.data).digest("hex"),
      mime: decoded.mime,
      data: decoded.data,
      retries: 0,
    };
  }

  let attempt = 0;
  let lastError = "unknown";
  for (const delay of [0, 250, 550]) {
    if (delay) await sleep(delay);
    attempt += 1;
    try {
      let body: Buffer | null = null;
      let responseMime: string | null = null;
      let source = "browser";
      try {
        const response = await page.request.get(candidate.sourceUrl, { timeout: 12_000 });
        responseMime = response.headers()["content-type"] || null;
        if (response.ok()) {
          const raw = await response.body();
          body = Buffer.from(raw);
        } else {
          throw new Error(`status-${response.status()}`);
        }
      } catch (error) {
        const message = String(error);
        try {
          const response = await fetch(candidate.sourceUrl, { redirect: "follow" });
          responseMime = response.headers.get("content-type") || null;
          if (response.ok) {
            const raw = Buffer.from(await response.arrayBuffer());
            body = raw;
            source = "node-fetch";
          } else {
            throw new Error(`status-${response.status}`);
          }
        } catch (fallbackError) {
          lastError = `${message};${String(fallbackError)}`;
          source = "none";
        }
      }

    if (!body) {
        if (source === "none" && attempt < 3) continue;
        if (source === "none") {
          return {
            success: false,
            bytes: null,
            sha256: null,
            mime: null,
            error: lastError,
            retries: Math.max(0, attempt - 1),
          };
        }
      }
      if (!body) continue;
      if (body.length === 0) {
        return {
          success: false,
          bytes: 0,
          sha256: createHash("sha256").update(body).digest("hex"),
          mime: responseMime,
          error: "empty-payload",
          retries: Math.max(0, attempt - 1),
        };
      }
      const retries = attempt - 1;
      profileStats.retries += retries;
      profileStats.downloaded += 1;
      return {
        success: true,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        mime: responseMime,
        data: body,
        retries,
      };
    } catch {
      if (attempt >= 3) break;
    }
  }

  return {
    success: false,
    bytes: null,
    sha256: null,
    mime: null,
    error: lastError,
    retries: Math.max(0, 2),
  };
}

export function createIconHarvestState(): IconHarvestAccumulator {
  return {
    bySourceUrl: new Set<string>(),
    byHash: new Set<string>(),
    usedFileNames: new Set<string>(),
    icons: [],
    stats: {
      attempted: 0,
      downloaded: 0,
      captured: 0,
      skipped: 0,
      failed: 0,
      dedupedByUrl: 0,
      dedupedByHash: 0,
      retries: 0,
    },
  };
}

export async function harvestIconsForRoute(
  snapshotId: string,
  page: Page,
  sourcePage: string,
  iconCaptureProfile: IconCaptureProfile,
  accumulator: IconHarvestAccumulator,
): Promise<CollectedIconAsset[]> {
  const manifest: CollectedIconAsset[] = [];
  const bundle = await collectIconCandidatesFromPage(page, sourcePage, iconCaptureProfile);

  const expanded: RawIconCandidate[] = [...bundle.candidates];
  const manifestCandidates = bundle.candidates.filter((entry) => entry.context === "manifest");
  const stylesheetCandidates = [...bundle.styleSheets];
  const manifestEntries = await Promise.all(manifestCandidates.map((entry) => collectManifestIcons(page, entry.sourceUrl, sourcePage, iconCaptureProfile)));
  const stylesheetEntries = await Promise.all(stylesheetCandidates.map((entry) => collectStylesheetIcons(page, entry, sourcePage, iconCaptureProfile)));
  for (const group of manifestEntries) expanded.push(...group);
  for (const group of stylesheetEntries) expanded.push(...group);

  const dedupeContext = new Set<string>();
  for (let index = 0; index < expanded.length; index += 1) {
    const candidate = expanded[index];
    const key = `${candidate.context}:${candidate.sourceUrl}`;
    if (dedupeContext.has(key)) continue;
    dedupeContext.add(key);

    const observedAt = new Date().toISOString();
    const canonicalCandidateUrl = candidate.sourceUrl.startsWith("inline-svg://")
      ? candidate.sourceUrl
      : canonicalizeIconSourceUrl(candidate.sourceUrl, sourcePage);
    const candidateUrl = canonicalCandidateUrl || candidate.sourceUrl;
    const pathNameHint = getBaseNameFromUrl(candidateUrl).replace(/\.[a-z0-9]{1,8}$/i, "");
    const candidateNameHint = candidate.nameHint?.trim() || pathNameHint || "";
    const hasNameHint = Boolean(candidateNameHint);
    const fallbackNameHint = candidateNameHint || `icon-${index + 1}`;
    const extHint = extractExtFromSource(candidateUrl) || extractExtFromSource(candidate.sourceUrl) || (candidate.inlineSvg ? "svg" : null);
    const sourceHint = candidate.sourceUrl.toLowerCase();
    const width = candidate.width ?? null;
    const height = candidate.height ?? null;
    const fallbackFileName = `${safeIconFileName(fallbackNameHint)}.${extHint || "bin"}`;

    const buildRecord = (
      status: CollectedIconAsset["status"],
      localPath: string,
      fileName: string,
      ext: string,
      mime: string | null,
      bytes: number | null,
      retries: number,
      error: string | null,
      sha256: string | null = null,
    ): CollectedIconAsset => ({
      sourceUrl: recordSourceUrl,
      localPath,
      fileName,
      status,
      ext,
      mime,
      bytes,
      retries,
      error,
      fromRoute: sourcePage,
      fromContext: candidate.context,
      capturedAt: observedAt,
      sha256,
      sourcePage,
      width,
      height,
    });

    const recordSourceUrl = canonicalCandidateUrl || candidate.sourceUrl;
    if (!canonicalCandidateUrl) {
      const statusRecord = buildRecord("failed", `assets/icons/${fallbackFileName}`, fallbackFileName, extHint || "bin", null, 0, 0, "invalid-url");
      manifest.push(statusRecord);
      accumulator.icons.push(statusRecord);
      accumulator.stats.failed += 1;
      accumulator.stats.skipped += 1;
      continue;
    }

    if (!shouldCollectCandidate(iconCaptureProfile, candidate.context)) {
      const statusRecord = buildRecord("skipped", `assets/icons/${fallbackFileName}`, fallbackFileName, extHint || "bin", null, 0, 0, "profile-filtered");
      manifest.push(statusRecord);
      accumulator.icons.push(statusRecord);
      accumulator.stats.skipped += 1;
      continue;
    }

    const likelyIconUrl = candidate.inlineSvg ? true : isLikelyIconUrl(candidateUrl, null, candidate.context, candidate.rel, candidate.nameHint);
    if (!likelyIconUrl && !sourceHint.startsWith("data:image/")) {
      const ext = extHint || "bin";
      const statusRecord = buildRecord("skipped", `assets/icons/${safeIconFileName(fallbackNameHint)}.${ext}`, `${safeIconFileName(fallbackNameHint)}.${ext}`, ext, null, 0, 0, "non-iconish");
      manifest.push(statusRecord);
      accumulator.icons.push(statusRecord);
      accumulator.stats.skipped += 1;
      continue;
    }

    accumulator.stats.attempted += 1;

    if (accumulator.bySourceUrl.has(recordSourceUrl)) {
      accumulator.stats.dedupedByUrl += 1;
      accumulator.stats.skipped += 1;
      const existingFromSameUrl = accumulator.icons.find((entry) => entry.sourceUrl === recordSourceUrl && entry.status === "captured");
      const statusRecord = existingFromSameUrl
        ? buildRecord(
          "skipped",
          existingFromSameUrl.localPath,
          existingFromSameUrl.fileName,
          existingFromSameUrl.ext,
          existingFromSameUrl.mime,
          existingFromSameUrl.bytes,
          0,
          "duplicate-url",
          existingFromSameUrl.sha256,
        )
        : buildRecord("skipped", `assets/icons/${fallbackFileName}`, fallbackFileName, extHint || "bin", null, 0, 0, "duplicate-url");
      manifest.push(statusRecord);
      accumulator.icons.push(statusRecord);
      continue;
    }
    accumulator.bySourceUrl.add(recordSourceUrl);

    const result = await downloadIconData(candidate, page, accumulator.stats);
    if (!result.success) {
      accumulator.stats.failed += 1;
      accumulator.stats.skipped += 1;
      const statusRecord = buildRecord("failed", `assets/icons/${fallbackFileName}`, fallbackFileName, extHint || "bin", null, 0, result.retries, result.error || "unknown");
      manifest.push(statusRecord);
      accumulator.icons.push(statusRecord);
      continue;
    }

    const bytes = result.data || Buffer.alloc(0);
    const mime = result.mime || null;
    const fileExt = extractExtFromSource(candidateUrl) || extFromMime(mime) || extHint || "bin";
    const sha256 = result.sha256 || createHash("sha256").update(bytes).digest("hex");
    const sha8 = sha256.slice(0, 8);
    const namingHint = hasNameHint ? fallbackNameHint : `icon-${index + 1}-${sha8}`;

    if (accumulator.byHash.has(sha256)) {
      accumulator.stats.dedupedByHash += 1;
      accumulator.stats.skipped += 1;
      const duplicate = accumulator.icons.find((entry) => entry.sha256 === sha256 && entry.status === "captured");
      const baseFileName = duplicate?.fileName || `${safeIconFileName(fallbackNameHint)}.${fileExt}`;
      const statusRecord = buildRecord(
        "skipped",
        `assets/icons/${baseFileName}`,
        baseFileName,
        fileExt,
        mime,
        bytes.length,
        result.retries,
        "duplicate-content-hash",
        sha256,
      );
      manifest.push(statusRecord);
      accumulator.icons.push(statusRecord);
      continue;
    }

    const name = buildIconName(candidateUrl, fileExt, sha8, accumulator.usedFileNames, index + 1, namingHint);
    const relativePath = `assets/icons/${name.fileName}`;
    await writeBinaryFile(snapshotId, relativePath, bytes);
    accumulator.byHash.add(sha256);
    const capturedRecord: CollectedIconAsset = {
      sourceUrl: recordSourceUrl,
      localPath: relativePath,
      fileName: name.fileName,
      status: "captured",
      ext: name.ext || fileExt,
      mime,
      bytes: bytes.length,
      retries: result.retries,
      error: null,
      fromRoute: sourcePage,
      fromContext: candidate.context,
      capturedAt: observedAt,
      sha256,
      sourcePage,
      width: candidate.width ?? null,
      height: candidate.height ?? null,
    };
    manifest.push(capturedRecord);
    accumulator.icons.push(capturedRecord);
    accumulator.stats.captured += 1;
  }

  return manifest;
}

function cleanUrl(input: string) {
  const parsed = new URL(input);
  parsed.hash = "";
  parsed.searchParams.sort();
  const cleanPathname = parsed.pathname || "/";
  const search = parsed.searchParams.toString();
  return `${parsed.origin}${cleanPathname}${search ? `?${search}` : ""}`;
}

function toLowerString(value: string | null | undefined) {
  return (value || "").toLowerCase().trim();
}

function pickPercentFromParts(raw: string) {
  const parsed = Number.parseFloat(raw.replace("%", ""));
  if (!Number.isFinite(parsed)) return null;
  return parsed / 100;
}

const NAMED_COLOR_HEX = new Map<string, string>([
  ["black", "#000000"],
  ["white", "#ffffff"],
  ["red", "#ff0000"],
  ["green", "#008000"],
  ["blue", "#0000ff"],
  ["yellow", "#ffff00"],
  ["gray", "#808080"],
  ["grey", "#808080"],
  ["silver", "#c0c0c0"],
  ["maroon", "#800000"],
  ["olive", "#808000"],
  ["navy", "#000080"],
  ["teal", "#008080"],
  ["purple", "#800080"],
  ["orange", "#ffa500"],
]);

function toCanonicalHex(value: number) {
  return clampByte(value).toString(16).padStart(2, "0");
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex(n: number) {
  return clampByte(n).toString(16).padStart(2, "0");
}

function normalizeAlphaValue(raw: string): number {
  const value = raw.trim().replace("%", "");
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 1;
  if (raw.endsWith("%")) return clamp01(parsed / 100);
  return clamp01(parsed);
}

function normalizeNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTo(value: number, decimals = 2) {
  const step = 10 ** decimals;
  return Math.round(value * step) / step;
}

function toCanonicalLength(value: string): string | null {
  const normalized = toLowerString(value);
  if (!normalized || normalized === "auto" || normalized === "normal" || normalized === "initial" || normalized === "inherit" || normalized === "unset" || normalized === "none" || normalized === "transparent") {
    return null;
  }

  if (normalized === "0" || normalized === "0px" || normalized === "0em" || normalized === "0rem" || normalized === "0vw" || normalized === "0vh" || normalized === "0%" || normalized === "0vmin" || normalized === "0vmax") {
    return "0";
  }

  if (normalized.startsWith("calc(") && normalized.endsWith(")")) {
    return `calc(${normalized.slice(5, -1).replace(/\s+/g, " ").trim()})`;
  }
  if (normalized.startsWith("var(") || normalized.startsWith("url(") || normalized.startsWith("env(")) return null;
  if (normalized.startsWith("color-mix(") || normalized.startsWith("linear-gradient") || normalized.startsWith("radial-gradient") || normalized.startsWith("conic-gradient") || normalized.startsWith("repeating-linear-gradient")) {
    return "gradient";
  }

  const numeric = Number.parseFloat(normalized);
  if (!Number.isFinite(numeric)) return null;

  const toPx = (unit: string, base = 1) => {
    if (unit === "px") return `${roundTo(numeric * base, 3)}px`;
    const px = `${roundTo(numeric * base, 3)}px`;
    return `${roundTo(numeric, 3)}${unit};px=${px}`;
  };

  if (normalized.endsWith("px")) return toPx("px");
  if (normalized.endsWith("rem")) return toPx("rem", 16);
  if (normalized.endsWith("em")) return toPx("em", 16);
  if (normalized.endsWith("vw") || normalized.endsWith("vh") || normalized.endsWith("vmin") || normalized.endsWith("vmax") || normalized.endsWith("%")) {
    return normalized;
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return `${roundTo(numeric, 3)}px`;

  const directUnits = ["cm", "mm", "in", "pc", "pt", "q", "ex", "ch", "lh", "rlh", "vi", "vb", "svh", "lvh", "dvh"];
  for (const unit of directUnits) {
    if (normalized.endsWith(unit)) return toPx(unit);
  }
  if (normalized.startsWith("max(") || normalized.startsWith("min(") || normalized.startsWith("clamp(")) return normalized;
  return normalized;
}

function normalizeCssLengthForSignature(raw: string, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE): string | null {
  return normalizeCanonicalLengthForProfile(raw, profile);
}

function normalizePxNumericOnly(value: string): number | null {
  const canonical = toCanonicalLength(value);
  if (!canonical) return null;
  const pxMatch = canonical.match(/-?\d*\.?\d+(?=px)/);
  if (!pxMatch) return null;
  const numeric = Number.parseFloat(pxMatch[0]);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizePxNumericOrZero(value: string): number | null {
  const canonical = toCanonicalLength(value);
  if (!canonical) return null;
  const pxMatch = canonical.match(/-?\d*\.?\d+(?=px)/);
  if (!pxMatch) return null;
  const numeric = Number.parseFloat(pxMatch[0]);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizePx(value: string, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE): string {
  if (typeof value !== "string") return "";
  const canonical = toCanonicalLength(value);
  if (!canonical) return "";
  if (canonical === "0") return "0";
  if (canonical === "auto" || canonical === "none" || canonical === "initial" || canonical === "unset" || canonical === "normal" || canonical === "inherit") {
    return canonical;
  }
  if (canonical.startsWith("calc(") || canonical.startsWith("max(") || canonical.startsWith("min(") || canonical.startsWith("clamp(")) {
    return canonical;
  }
  const [normalized, alias] = canonical.split(";px=");
  const normalizedLower = (normalizeCanonicalLengthForProfile(normalized, profile) || normalized).toLowerCase();
  if (!normalizedLower) return "";

  const match = normalizedLower.match(/^(-?\d*\.?\d+)([a-z%]+)?$/);
  if (!match) {
    return `${normalizedLower};raw`;
  }
  const numeric = Number.parseFloat(match[1] || "");
  if (!Number.isFinite(numeric)) return "";
  const unit = (match[2] || "px").toLowerCase();
  const digits = PROFILE_LIMITS[profile].sizeValueDigits;

  if (unit === "px") return safeToFixed(numeric, digits) + "px";
  if (unit === "%") return safeToFixed(numeric, digits) + "%";
  if (unit === "rem" || unit === "em") {
    const asPx = safeToFixed(numeric * 16, digits);
    const base = `${safeToFixed(numeric, digits)}${unit}`;
    return profile === "minimal" ? base : `${base};px=${asPx}px`;
  }
  if (unit === "vw" || unit === "vh" || unit === "vmin" || unit === "vmax" || unit === "ch" || unit === "ex" || unit === "lh" || unit === "rlh" || unit === "fr") {
    return `${safeToFixed(numeric, digits)}${unit}`;
  }
  if (unit === "cqw" || unit === "cqh" || unit === "cqi" || unit === "cqb" || unit === "cqmin" || unit === "cqmax") {
    return profile === "minimal" ? `${safeToFixed(numeric, digits)}${unit}` : `${safeToFixed(numeric, digits)}${unit};alias=${alias || normalizedLower}`;
  }

  if (alias && profile !== "minimal") return `${safeToFixed(numeric, digits)}${unit};alias=${alias}`;
  return `${safeToFixed(numeric, digits)}${unit};raw`;
}

function normalizePxOrRawLength(value: string): string {
  const canonical = toCanonicalLength(value);
  if (!canonical) return "";
  return canonical;
}

function normalizePxDisplay(value: string): string | null {
  return toCanonicalLength(value);
}

function parseLengthOrNumber(raw: string): number | null {
  const canonical = toCanonicalLength(raw);
  if (!canonical) return null;
  const pxMatch = canonical.match(/-?\d*\.?\d+/);
  if (!pxMatch) return null;
  const parsed = Number.parseFloat(pxMatch[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLineHeightOrFontSize(style: NodeComputedStyle, field: "lineHeight" | "fontSize" | "letterSpacing"): string {
  return normalizePxDisplay(style[field] || "") || "";
}

function normalizeLengthForSignature(value: string): string | null {
  const normalized = toLowerString(value);
  if (!normalized || normalized === "auto" || normalized === "normal" || normalized === "initial" || normalized === "inherit" || normalized === "unset" || normalized === "none") {
    return null;
  }

  if (normalized === "0" || normalized === "0px" || normalized === "0em" || normalized === "0rem" || normalized === "0vw" || normalized === "0vh" || normalized === "0%") {
    return "0";
  }

  if (normalized.startsWith("calc(") && normalized.endsWith(")")) {
    return `calc(${normalized.slice(5, -1).replace(/\s+/g, " ").trim()})`;
  }
  if (normalized.startsWith("var(") || normalized.startsWith("url(") || normalized.startsWith("env(")) return null;
  if (
    normalized.startsWith("linear-gradient") ||
    normalized.startsWith("radial-gradient") ||
    normalized.startsWith("conic-gradient") ||
    normalized.startsWith("repeating-linear-gradient") ||
    normalized.startsWith("color-mix(")
  ) {
    return "gradient";
  }

  const numeric = Number.parseFloat(normalized);
  if (!Number.isFinite(numeric)) return null;

  const rounded = roundTo(numeric, 3);
  if (normalized.endsWith("px")) return `${rounded}px`;
  if (normalized.endsWith("rem") || normalized.endsWith("em")) {
    const unit = normalized.endsWith("rem") ? "rem" : "em";
    const pxAlias = roundTo(numeric * 16, 3);
    return `${rounded}${unit};px=${pxAlias}px`;
  }
  if (normalized.endsWith("vw") || normalized.endsWith("vh") || normalized.endsWith("vmin") || normalized.endsWith("vmax") || normalized.endsWith("%")) {
    return normalized;
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return `${rounded}px`;

  const directUnits = ["cm", "mm", "in", "pc", "pt", "q", "ex", "ch", "lh", "rlh", "vi", "vb", "svh", "lvh", "dvh", "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax"];
  for (const unit of directUnits) {
    if (normalized.endsWith(unit)) {
      const pxAlias = roundTo(numeric * 16, 3);
      return `${rounded}${unit};px=${pxAlias}px`;
    }
  }

  if (normalized.startsWith("max(") || normalized.startsWith("min(") || normalized.startsWith("clamp(")) return normalized;
  return `${normalized};raw`;
}

function normalizeColor(input: string): string {
  const value = toLowerString(input);
  if (!value) return "";
  const normalized = normalizeColorValue(value, "minimal");
  if (normalized) return normalized;
  if (value === "currentColor".toLowerCase()) return "";
  return value;
}

function normalizeStyleValueForSignature(key: keyof NodeComputedStyle, value: string, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE): string {
  if (typeof value !== "string") return "";
  const val = value.trim();
  if (!val) return "";
  if (key === "color" || key === "backgroundColor" || key === "borderColor" || key === "outlineColor") return normalizeColorValue(val, profile);
  if (key === "fontFamily") return normalizeFontFamilyValue(val);
  if (key === "boxShadow" || key === "textShadow") return normalizeShadowValue(val, profile);
  if (key === "borderRadius") return normalizeRadiusValue(val, profile);
  if (
    key === "paddingTop" ||
    key === "paddingRight" ||
    key === "paddingBottom" ||
    key === "paddingLeft" ||
    key === "marginTop" ||
    key === "marginRight" ||
    key === "marginBottom" ||
    key === "marginLeft" ||
    key === "borderWidth" ||
    key === "width" ||
    key === "height" ||
    key === "minWidth" ||
    key === "minHeight" ||
    key === "maxWidth" ||
    key === "maxHeight" ||
    key === "top" ||
    key === "right" ||
    key === "bottom" ||
    key === "left" ||
    key === "lineHeight" ||
    key === "fontSize" ||
    key === "letterSpacing"
  ) {
    return normalizePx(val, profile) || "";
  }
  if (key === "fontWeight") return toLowerString(val).replace(/\s+/g, "");
  if (key === "display" || key === "position" || key === "textAlign" || key === "textTransform" || key === "outline" || key === "boxSizing") {
    return toLowerString(val);
  }
  return val.replace(/\s+/g, " ");
}

export function normalizeFontFamilyValue(input: string): string {
  const values = (input || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  if (!values.length) return "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const lowered = value.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    const hasSpace = /\s/.test(value) || /["']/.test(value);
    out.push(hasSpace ? `"${value}"` : value);
  }
  return out.join(", ");
}

function splitShadowParts(value: string): string[] {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

function tokeniseLengthAndColor(part: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      const token = current.trim();
      if (token) out.push(token);
      current = "";
      continue;
    }
    current += ch;
  }
  const final = current.trim();
  if (final) out.push(final);
  return out;
}

function normalizeShadowToken(rawToken: string, profile: CleaningProfile): string {
  const token = rawToken.toLowerCase();
  if (token === "none" || token === "unset" || token === "initial" || token === "inherit") return "";
  if (token.startsWith("inset")) return "inset";

  const alphaFunctions = /^rgba?\(|^hsla?\(|^hsl\(/;
  if (alphaFunctions.test(token) || token.startsWith("var(") || token.startsWith("url(") || token.startsWith("linear-gradient") || token.startsWith("radial-gradient")) {
    const color = normalizeColorValue(rawToken, profile);
    return color ? color : "";
  }

  const numberOnly = Number.parseFloat(token);
  if (Number.isFinite(numberOnly) && /[a-z%]+$/.test(token)) {
    return toCanonicalLength(token) || token;
  }
  const named = NAMED_COLOR_HEX.get(token);
  if (named) return named;
  const hex = parseHexColor(token);
  if (hex) return hex;

  const asColor = normalizeColorValue(rawToken, profile);
  if (asColor && asColor !== "gradient") return asColor;
  return rawToken.trim();
}

function parseColorToken(raw: string): string {
  const token = normalizeShadowToken(raw, "minimal");
  return token || "";
}

function normalizeShadowValue(value: string, profile: CleaningProfile): string {
  const normalized = toLowerString(value);
  if (!normalized || normalized === "none" || normalized === "initial" || normalized === "unset" || normalized === "inherit") return "";
  const list = splitShadowParts(normalized);
  const normalizedLayers = list.map((layer) => {
    const tokens = tokeniseLengthAndColor(layer);
    const colorToken = tokens.find((token) => {
      if (!token) return false;
      if (token.startsWith("rgb") || token.startsWith("hsl") || token.startsWith("hwb") || token.startsWith("#") || NAMED_COLOR_HEX.has(token) || token.startsWith("var(") || token === "transparent") {
        return true;
      }
      if (/^-?\d*\.?\d+[a-z%]+$/i.test(token)) return false;
      if (token === "inset") return false;
      const hex = parseHexColor(token);
      if (hex) return true;
      return false;
    });
    const color = colorToken ? parseColorToken(colorToken) : "";
    const numeric = tokens.filter((token) => token !== colorToken).map((token) => normalizeShadowToken(token, profile)).filter(Boolean).join(" ");
    const base = [numeric, color].filter(Boolean).join(" ");
    return base;
  });
  const filtered = normalizedLayers.filter(Boolean);
  if (!filtered.length) return normalized.includes("none") ? "none" : "";
  return filtered.join(", ");
}

function normalizeRadiusValue(value: string, profile: CleaningProfile): string {
  const canonical = toCanonicalLength(value) || "";
  if (!canonical || canonical === "gradient") return "";
  const parts = canonical.split(/[\s/]+/).map((part) => normalizeCssLengthForSignature(part)).filter(Boolean) as string[];
  const normalized = parts.map((item) => (item === "0" ? "0" : item)).join(" ");
  return normalized;
}

function parseHexColor(value: string): string | null {
  const raw = toLowerString(value);
  if (!raw.startsWith("#")) return null;
  if (raw.length !== 4 && raw.length !== 5 && raw.length !== 7 && raw.length !== 9) return null;
  const hex = raw.slice(1);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 3) {
    const [r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (hex.length === 4) {
    const [r, g, b, a] = hex;
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`;
  }
  if (hex.length === 9) return `#${hex}`.slice(0, 9);
  return `#${hex}`;
}

function normalizeColorFunctionFallback(value: string): string {
  const match = /^([a-z0-9_-]+)\((.*)\)$/i.exec(value.trim());
  if (!match) return "";
  const fn = toLowerString(match[1] || "");
  const body = toLowerString(match[2] || "");
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact || !fn) return "";
  if (fn === "color-mix") return `color-mix(${compact.slice(0, 160)})`;
  if (fn === "linear-gradient" || fn === "radial-gradient" || fn === "conic-gradient" || fn === "repeating-linear-gradient") return `${fn}(...)`;
  if (fn === "hwb" || fn === "hsl" || fn === "hsla" || fn === "rgb" || fn === "rgba" || fn === "lab" || fn === "lch" || fn === "contrast" || fn === "color") {
    return `${fn}(${compact.slice(0, 120)})`;
  }
  return `${fn}(${compact.slice(0, 80)})`;
}

function parseColorChannelForSpace(value: string, spaceMax = 255): number | null {
  const raw = toLowerString(value);
  if (!raw) return null;
  if (raw.endsWith("%")) {
    const normalized = normalizeNumber(raw.slice(0, -1));
    if (normalized === null) return null;
    return clampByte((normalized / 100) * spaceMax);
  }
  const numeric = normalizeNumber(raw);
  if (numeric === null) return null;
  if (spaceMax === 1) return clampByte(Math.round(normalizeAlphaValue(raw) * 255));
  return clampByte(Math.round(Math.min(spaceMax, Math.max(0, numeric))));
}

function tryParseColorFunctionToHex(input: string): string | null {
  const value = toLowerString(input);
  if (!value.startsWith("color(") || !value.endsWith(")")) return null;
  const body = value.slice(6, -1).trim();
  if (!body) return null;
  const tokens = body
    .replace(/\//g, " / ")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => token.trim());
  const space = tokens[0] || "";
  const separatorIndex = tokens.indexOf("/");
  const channels = separatorIndex === -1 ? tokens.slice(1) : tokens.slice(1, separatorIndex);
  if (channels.length < 3) return null;
  if (space === "srgb" || space === "srgb-linear" || space === "display-p3" || space === "a98-rgb" || space === "prophoto-rgb" || space === "rec-2020") {
    const channelValues = channels.slice(0, 3).map((item) => parseColorChannelForSpace(item, 255));
    if (channelValues.includes(null)) return null;
    const base = `#${toHex(channelValues[0] || 0)}${toHex(channelValues[1] || 0)}${toHex(channelValues[2] || 0)}`;
    const alphaToken = separatorIndex === -1 ? null : tokens[separatorIndex + 1] || null;
    const alpha = alphaToken === null ? 1 : normalizeAlphaValue(alphaToken);
    if (!Number.isFinite(alpha) || alpha >= 1) return base;
    return `${base}${toHex(Math.round(Math.min(1, Math.max(0, alpha)) * 255))}`;
  }
  return null;
}

export function normalizeColorValue(input: string, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE): string {
  const value = toLowerString(input);
  if (!value || value === "currentcolor" || value === "none" || value === "initial" || value === "inherit" || value === "unset") return "";
  if (value === "transparent" || value === "rgba(0,0,0,0)" || value === "rgba(0, 0, 0, 0)") {
    if (profile === "minimal") return "#00000000";
    return "";
  }
  if (value.startsWith("url(") || value.startsWith("var(") || value.startsWith("env(")) return profile === "minimal" ? value : "";

  if (
    value.startsWith("linear-gradient") ||
    value.startsWith("radial-gradient") ||
    value.startsWith("conic-gradient") ||
    value.startsWith("repeating-linear-gradient") ||
    value.startsWith("color-mix(")
  ) {
    return profile === "minimal" ? "gradient" : normalizeColorFunctionFallback(value);
  }

  const named = NAMED_COLOR_HEX.get(value);
  if (named) return named;

  const hex = parseHexColor(value);
  if (hex) return hex;

  if (value.startsWith("hsl(") || value.startsWith("hsla(")) {
    const tokenise = (inputValue: string) => {
      const inner = inputValue.replace(/^hsla?\(/, "").replace(/\)$/, "");
      if (!inner) return null;
      const normalized = inner.replace(/\//g, " / ").trim();
      const tokens = normalized
        .split("/")
        .flatMap((chunk, chunkIndex) => {
          if (!chunk.trim()) return [];
          if (chunkIndex === 0) return chunk.replace(/,/g, " ").split(/\s+/).filter(Boolean);
          return chunk.split(",").map((part) => part.trim()).filter(Boolean);
        })
        .filter(Boolean);
      if (tokens.length < 3) return null;
      return tokens;
    };
    const parsed = tokenise(value);
    if (!parsed) return value;
    const h = normalizeNumber(parsed[0]);
    const s = parsed[1] ? normalizeNumber(parsed[1].replace("%", "")) : null;
    const l = parsed[2] ? normalizeNumber(parsed[2].replace("%", "")) : null;
    const a = parsed[3] ? normalizeAlphaValue(parsed[3]) : 1;
    if (h === null || s === null || l === null) return value;
    const H = ((h || 0) % 360 + 360) % 360;
    const S = clamp01((s || 0) / 100);
    const L = clamp01((l || 0) / 100);

    const C = (1 - Math.abs(2 * L - 1)) * S;
    const X = C * (1 - Math.abs(((H / 60) % 2) - 1));
    const m = L - C / 2;
    const rgb = [
      [C, X, 0],
      [X, C, 0],
      [0, C, X],
      [0, X, C],
      [X, 0, C],
      [C, 0, X],
    ][Math.floor(H / 60)]!.map((v) => clampByte((v + m) * 255));
    const base = `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
    if (a >= 1) return base;
    return `${base}${toHex(Math.round(a * 255))}`;
  }

  if (value.startsWith("rgb(") || value.startsWith("rgba(")) {
    const parsed = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (!parsed) return value;
    const normalized = parsed[1].replace(/\//g, " / ").trim();
    const head = normalized.split("/")[0] || "";
    const tail = normalized.split("/")[1];
    const parts = [...head.replace(/,/g, " ").split(/\s+/).filter(Boolean), ...(tail ? [tail.trim()] : [])].filter(Boolean);
    if (parts.length < 3) return value;

    const toByte = (item: string) => {
      if (item.endsWith("%")) {
        const parsedPercent = normalizeNumber(item.slice(0, -1));
        if (parsedPercent === null) return null;
        return clampByte(parsedPercent / 100 * 255);
      }
      const parsedNum = normalizeNumber(item);
      if (parsedNum === null) return null;
      return clampByte(parsedNum);
    };
    const r = toByte(parts[0]);
    const g = toByte(parts[1]);
    const b = toByte(parts[2]);
    if (r === null || g === null || b === null) return value;
    const base = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    if (!parts[3]) return base;
    const alpha = normalizeAlphaValue(parts[3]);
    if (alpha >= 1) return base;
    return `${base}${toHex(Math.round(alpha * 255))}`;
  }

  if (value.startsWith("color(")) {
    const parsed = tryParseColorFunctionToHex(value);
    if (parsed) return parsed;
    return normalizeColorFunctionFallback(value);
  }

  if (value.startsWith("hwb(")) {
    const raw = value.slice(4, -1).trim();
    const normalized = raw.replace(/\//g, " / ");
    const tokens = normalized
      .split("/")
      .flatMap((chunk, chunkIndex) => {
        if (!chunk.trim()) return [];
        if (chunkIndex === 0) return chunk.replace(/,/g, " ").split(/\s+/).filter(Boolean);
        return [chunk.trim()];
      })
      .filter(Boolean);
    if (tokens.length >= 3) {
      const h = normalizeNumber(tokens[0]);
      const w = normalizeNumber(tokens[1]);
      const b = normalizeNumber(tokens[2]);
      if (h !== null && w !== null && b !== null) {
        const c = clamp01(1 - (w || 0) / 100 - (b || 0) / 100);
        const cRaw = clamp01(Math.max(0, c));
        const huePrime = (((h || 0) % 360) / 60) % 6;
        const X = cRaw * (1 - Math.abs((huePrime % 2) - 1));
        let rgb: [number, number, number] = [0, 0, 0];
        if (huePrime >= 0 && huePrime < 1) rgb = [cRaw, X, 0];
        else if (huePrime < 2) rgb = [X, cRaw, 0];
        else if (huePrime < 3) rgb = [0, cRaw, X];
        else if (huePrime < 4) rgb = [0, X, cRaw];
        else if (huePrime < 5) rgb = [X, 0, cRaw];
        else rgb = [cRaw, 0, X];
        const m = w ? (w || 0) / 100 : 0;
        const out = rgb.map((channel) => toHex(Math.round((channel + m) * 255)));
        return `#${out[0]}${out[1]}${out[2]}`;
      }
    }
  }

  if (value.startsWith("lab(") || value.startsWith("lch(") || value.startsWith("color(") || value.startsWith("contrast(")) {
    if (value.startsWith("lab(") || value.startsWith("lch(") || value.startsWith("contrast(")) {
      return normalizeColorFunctionFallback(value);
    }
    return value;
  }

  return value;
}

function signatureFromStyles(style: NodeComputedStyle, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE) {
  const entries = signatureStyleKeys
    .map((key) => {
      const raw = (style as unknown as Record<string, string>)[key] || "";
      return [String(key), normalizeStyleValueForSignature(key, raw, profile)] as const;
    })
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}:${value}`)
    .sort((a, b) => a.localeCompare(b));

  const customEntries = Object.keys(style.customProperties || {})
    .sort()
    .map((name) => {
      const raw = (style.customProperties?.[name] || "").trim();
      if (!raw) return "";
      const value = raw.startsWith("#") || raw.startsWith("var(") || raw.includes("calc(")
        ? normalizeStyleValueForSignature("color" as keyof NodeComputedStyle, raw, profile)
        : normalizePx(raw, profile) || normalizeLengthForSignature(raw) || raw;
      return value ? `var:${name}=${value}` : "";
    })
    .filter(Boolean);

  return [...entries, ...customEntries].sort((a, b) => a.localeCompare(b)).join("|");
}

function parseCustomProperties(cssText: string): Record<string, string> {
  const source = cssText || "";
  const out: Record<string, string> = {};
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = (match[1] || "").trim().toLowerCase();
    const value = (match[2] || "").trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function toCssNodeStyle(raw: Record<string, string>, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE): NodeComputedStyle {
  const normalize = (key: keyof NodeComputedStyle) => normalizeStyleValueForSignature(key, (raw?.[key] as string) || "", profile);
  return {
    display: normalize("display"),
    position: normalize("position"),
    top: normalize("top"),
    right: normalize("right"),
    bottom: normalize("bottom"),
    left: normalize("left"),
    zIndex: normalize("zIndex"),
    overflow: normalize("overflow"),
    boxSizing: normalize("boxSizing"),
    color: normalize("color"),
    backgroundColor: normalize("backgroundColor"),
    borderColor: normalize("borderColor"),
    borderWidth: normalize("borderWidth"),
    borderStyle: normalize("borderStyle"),
    borderRadius: normalize("borderRadius"),
    boxShadow: normalize("boxShadow"),
    textShadow: normalize("textShadow"),
    fontFamily: normalize("fontFamily"),
    fontSize: normalize("fontSize"),
    fontWeight: normalize("fontWeight"),
    lineHeight: normalize("lineHeight"),
    letterSpacing: normalize("letterSpacing"),
    textAlign: normalize("textAlign"),
    textTransform: normalize("textTransform"),
    marginTop: normalize("marginTop"),
    marginRight: normalize("marginRight"),
    marginBottom: normalize("marginBottom"),
    marginLeft: normalize("marginLeft"),
    paddingTop: normalize("paddingTop"),
    paddingRight: normalize("paddingRight"),
    paddingBottom: normalize("paddingBottom"),
    paddingLeft: normalize("paddingLeft"),
    gap: normalize("gap"),
    width: normalize("width"),
    height: normalize("height"),
    minWidth: normalize("minWidth"),
    minHeight: normalize("minHeight"),
    maxWidth: normalize("maxWidth"),
    maxHeight: normalize("maxHeight"),
    opacity: normalize("opacity"),
    transition: normalize("transition"),
    animation: normalize("animation"),
    outline: normalize("outline"),
    outlineColor: normalize("outlineColor"),
    outlineWidth: normalize("outlineWidth"),
    filter: normalize("filter"),
    backdropFilter: normalize("backdropFilter"),
    customProperties: parseCustomProperties(raw?.cssText || ""),
  };
}

function classifyArchetype(sample: {
  tag: string;
  role: string | null;
  className: string;
  text: string | null;
  childCount?: number;
  styles?: NodeComputedStyle;
  typeHint?: string;
}) {
  const tag = sample.tag.toLowerCase();
  const role = toLowerString(sample.role);
  const className = toLowerString(sample.className);
  const text = toLowerString(sample.text || "");
  const typeHint = toLowerString(sample.typeHint || "");
  const normalizedType = typeHint;
  const hasExplicitCardClass = /(card|panel|hero|tile|widget|surface|module)/.test(className);
  const hasExplicitCardText = /(card|panel|hero|tile|widget|surface|module)/.test(text);
  const hasCardHints = hasExplicitCardClass || hasExplicitCardText || role === "article";
  const childCount = sample.childCount || 0;
  const roleHint = role ? role : "";
  const type = typeHint;
  const tagLayoutHint = /^main|header|section|article|aside|nav|footer$/.test(tag);
  const hasToggleHint =
    className.includes("toggle") ||
    roleHint === "switch" ||
    roleHint === "toggle" ||
    text.includes("toggle") ||
    normalizedType === "checkbox" ||
    normalizedType === "radio";
  const hasRadius = Boolean(sample.styles?.borderRadius && sample.styles.borderRadius !== "0" && sample.styles.borderRadius !== "0px");
  const hasBorder = Boolean(sample.styles?.borderWidth && sample.styles.borderWidth !== "0" && sample.styles.borderWidth !== "none");
  const hasPadding = Boolean(
    (normalizePxNumericOnly(sample.styles?.paddingTop || "") || 0) > 0 ||
      (normalizePxNumericOnly(sample.styles?.paddingRight || "") || 0) > 0 ||
      (normalizePxNumericOnly(sample.styles?.paddingBottom || "") || 0) > 0 ||
      (normalizePxNumericOnly(sample.styles?.paddingLeft || "") || 0) > 0,
  );
  const hasSurfaceStyle = hasRadius || Boolean(sample.styles?.boxShadow && sample.styles.boxShadow !== "none");

  if (roleHint === "button" || tag === "button") return "button";
  if (role === "link" || tag === "a") return "link";
  if (roleHint === "switch" || role === "switch" || tag === "summary") return "switch";
  if (hasToggleHint) return "toggle";
  if (normalizedType === "checkbox") return "input-checkbox";
  if (normalizedType === "radio") return "input-radio";
  if (normalizedType === "range") return "input-range";
  if (normalizedType === "search" || normalizedType === "password" || normalizedType === "email" || normalizedType === "tel" || normalizedType === "date" || normalizedType === "time" || normalizedType === "month" || normalizedType === "week" || normalizedType === "number") {
    return `input-${normalizedType}`;
  }
  if (tag === "input") {
    if (type === "checkbox") return "input-checkbox";
    if (type === "radio") return "input-radio";
    if (type === "button") return "input-button";
    if (type === "submit") return "input-submit";
    if (type === "range") return "input-range";
    if (type === "search") return "input-search";
    if (type === "password") return "input-password";
    if (type === "email") return "input-email";
    if (type === "checkbox" || type === "radio") return `input-${type}`;
    if (type === "date") return "input-date";
    if (type === "tel") return "input-tel";
    if (type === "number") return "input-number";
    if (type === "text") return "input-text";
    if (type === "file") return "input-file";
    if (type === "url") return "input-url";
    if (type === "color") return "input-color";
    if (type === "datetime-local") return "input-datetime";
    if (type === "time") return "input-time";
    if (type === "month") return "input-month";
    if (type === "week") return "input-week";
    if (type === "checkbox" || type === "radio") return `input-${type}`;
    if (roleHint === "switch") return "input-switch";
    return `input-${type || "text"}`;
  }
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (roleHint === "radio" || roleHint === "switch") return roleHint;
  if (tag === "summary") return "switch";
  if (roleHint === "listbox" || tag === "li" || roleHint === "list") return "list";
  if (roleHint === "tabpanel") return "tabpanel";
  if (tag === "table" || tag === "thead" || tag === "tbody" || tag === "tr" || tag === "td" || tag === "th") return "table";
  if (role === "dialog" || tag === "dialog") return "modal";
  if (roleHint === "checkbox") return "input-checkbox";
  if (roleHint === "radio") return "input-radio";
  if (roleHint === "tab") return "tab";
  if (tag === "nav" || role === "navigation") return "navbar";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "header") return "header";
  if (tag === "footer") return "footer";
  if (
    (tagLayoutHint || tag === "div" || tag === "section" || tag === "article") &&
    (hasCardHints ||
      ((childCount >= 2 || className.includes("row") || className.includes("col") || className.includes("container")) &&
        (hasPadding || hasSurfaceStyle || hasRadius || hasBorder || childCount >= 3)))
  )
    return "card";
  if (tag === "dialog" || role === "dialog") return "modal";
  if (tag === "form" || roleHint === "form") return "form";
  if (className.includes("toast") || roleHint === "status" || roleHint === "alert") return "toast";
  return "generic";
}

function styleFingerprintFromSamples(
  samples: NodeSample[],
  context?: {
    route?: string;
    theme?: ThemeMode;
    viewport?: ViewportSpec;
    routeDepth?: number;
  },
) {
  if (!samples.length) return createHash("sha1").update(`empty|${context?.route || ""}`).digest("hex");

  const visibleSampleCount = samples.filter((entry) => entry.visible).length;
  const totalCount = samples.length || 0;
  const topKCount = Math.max(100, Math.min(280, Math.min(420, Math.ceil(totalCount * 0.32))));
  const weightBySample = (sample: NodeSample) => {
    const visibleWeight = sample.visible ? 1 : 0.45;
    const area = Math.max(0, Math.round(sample.rect.width * sample.rect.height));
    return visibleWeight * Math.log(area + 1);
  };
  const topK = [...samples]
    .map((entry) => ({ entry, score: weightBySample(entry) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.uid.localeCompare(b.entry.uid);
    })
    .slice(0, topKCount)
    .map(({ entry }) => `${entry.uid}|${entry.styleSignature}`)
    .sort((a, b) => a.localeCompare(b));

  const signature = topK.join("|");
  const route = context?.route || "";
  const viewport = context?.viewport ? `${context.viewport.width}x${context.viewport.height}` : "";
  const viewportName = context?.viewport?.name || "";
  const theme = context?.theme || "";
  const depth = context?.routeDepth ?? "";
  const scope = [route, theme, viewportName, viewport, depth]
    .filter(Boolean)
    .join("|");
  const scopeHint = `${scope}|samples=${samples.length}|visible=${visibleSampleCount}|depth=${depth}`;
  return createHash("sha1").update(scopeHint ? `${scopeHint}|${signature}` : signature).digest("hex");
}

function signatureToMap(signature: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of signature.split("|").filter(Boolean)) {
    const idx = entry.indexOf(":");
    if (idx <= 0) continue;
    entries.set(entry.slice(0, idx), entry.slice(idx + 1));
  }
  return entries;
}

function changedPropertiesFromSignatures(before?: string | null, after?: string | null): SignatureDiff {
  const beforeSafe = typeof before === "string" ? before : "";
  const afterSafe = typeof after === "string" ? after : "";

  if (!beforeSafe && afterSafe) {
    const addedMap = signatureToMap(afterSafe);
    return {
      changed: [...addedMap.keys()].sort(),
      added: [...addedMap.keys()].sort(),
      removed: [],
    };
  }

  if (beforeSafe && !afterSafe) {
    const removedMap = signatureToMap(beforeSafe);
    return {
      changed: [...removedMap.keys()].sort(),
      added: [],
      removed: [...removedMap.keys()].sort(),
    };
  }

  const beforeMap = signatureToMap(beforeSafe);
  const afterMap = signatureToMap(afterSafe);

  const changed = new Set<string>();
  const added = new Set<string>();
  const removed = new Set<string>();
  const allKeys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  for (const key of allKeys) {
    const beforeValue = beforeMap.get(key);
    const afterValue = afterMap.get(key);
    if (beforeValue === undefined) {
      added.add(key);
      changed.add(key);
      continue;
    }
    if (afterValue === undefined) {
      removed.add(key);
      changed.add(key);
      continue;
    }
    if (beforeValue !== afterValue) changed.add(key);
  }
  return { changed: [...changed].sort(), added: [...added].sort(), removed: [...removed].sort() };
}

function resolveStateCaptureSource(
  capture: { state: InteractionState; stateTargetMeta?: StateCaptureTargetMeta },
  route: string,
  viewport: ViewportSpec,
  theme: ThemeMode,
  screenshot?: string,
): ComponentVariantState["source"] {
  return {
    route,
    viewport: `${viewport.width}x${viewport.height}`,
    theme,
    selector: capture.stateTargetMeta?.selector,
    locator: capture.stateTargetMeta?.locator,
    screenshot,
  };
}

function signatureValueDeltas(before: string, after: string) {
  const beforeMap = signatureToMap(before || "");
  const afterMap = signatureToMap(after || "");
  const out: Record<string, { before: string; after: string }> = {};
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  for (const key of keys) {
    const beforeValue = beforeMap.get(key) || "";
    const afterValue = afterMap.get(key) || "";
    if (beforeValue !== afterValue) out[key] = { before: beforeValue, after: afterValue };
  }
  return out;
}

function readFileBuffer(file: string) {
  return fs.readFile(file);
}

async function waitForStable(page: Page, cfg: Required<WaitConfig>): Promise<StableResult> {
  await page.waitForLoadState("domcontentloaded", { timeout: 90_000 }).catch(() => {});
  await Promise.race([
    page.waitForLoadState("networkidle", { timeout: cfg.networkQuietMs }),
    page.waitForTimeout(cfg.networkQuietMs),
  ]).catch(() => {});
  await page.waitForTimeout(cfg.settleMs);
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  let unchanged = 0;
  let unstable = 0;
  let prev = "";
  for (let i = 0; i < cfg.mutationStabilityFrames; i++) {
    await page.waitForTimeout(180);
    const sig = await page.evaluate(() => {
      if (!document.body) return "";
      const body = document.body;
      const first = body.children ? body.children.length : 0;
      const state = body.innerText || "";
      const textLength = Number(state.length);
      const htmlLength = body.innerHTML ? body.innerHTML.length : 0;
      return `${first}:${body.scrollHeight}:${textLength}:${htmlLength}`;
    });
    if (sig === prev) unchanged += 1;
    else unstable += 1;
    prev = sig;
  }
  if (cfg.fontWaitMs > 0) await page.waitForTimeout(cfg.fontWaitMs);
  return {
    stable: unchanged >= Math.max(1, cfg.mutationStabilityFrames - 1),
    checkedFrames: cfg.mutationStabilityFrames,
    unchangedFrames: unchanged,
    unstableFrames: unstable,
  };
}

async function gatherSamples(
  page: Page,
  maxSamples: number,
  sampleStride: number,
  profileContext: CleaningProfileCtx,
  sampleContext: {
    route?: string;
    viewport?: string;
    theme?: ThemeMode;
  } = {},
): Promise<GatheredSamples> {
  const contextToken = `${sampleContext.route || "route"}|${sampleContext.viewport || "viewport"}|${sampleContext.theme || "theme"}`;
  const rawSamples: any[] = await page.evaluate(
    ({ maxSamples, sampleStride }) => {
      const nodes = Array.from(document.querySelectorAll("*")).filter((node) => node instanceof Element) as Element[];
      const step = Math.max(1, sampleStride * Math.max(1, Math.floor(nodes.length / Math.max(1, maxSamples))));

      function buildSelector(node: Element) {
        const tag = node.tagName.toLowerCase();
        const id = node.id ? `#${CSS.escape(node.id)}` : "";
        const cls = (node.getAttribute("class") || "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((token) => `.${CSS.escape(token)}`)
          .join("");
        if (id) return `${tag}${id}`;
        if (cls) return `${tag}${cls}`;
        const parent = node.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        const index = siblings.indexOf(node) + 1;
        return `${tag}:nth-of-type(${index})`;
      }

      function pickPseudo(node: Element, pseudo: string) {
        const style = getComputedStyle(node, pseudo);
        return {
          content: style.getPropertyValue("content"),
          color: style.color,
          backgroundColor: style.backgroundColor,
          opacity: style.opacity,
        };
      }

      const out: any[] = [];
      for (let i = 0; i < nodes.length && out.length < maxSamples; i += step) {
        const node = nodes[i];
        const rect = node.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) continue;
        const style = getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
        const sample = {
          uid: `${node.tagName.toLowerCase()}-${Math.round(rect.x)}-${Math.round(rect.y)}-${Math.round(rect.width)}-${Math.round(rect.height)}-${i}`,
          selector: buildSelector(node),
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute("role"),
          typeHint: (node as HTMLInputElement).type || "",
          text: node instanceof HTMLElement ? (node.innerText || "").trim().slice(0, 140) : "",
          className: node.getAttribute("class") || "",
          id: node.getAttribute("id"),
          ariaLabel: node.getAttribute("aria-label"),
          childCount: node.children.length,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
          visibility: style.visibility,
          opacity: style.opacity,
          styles: {
            display: style.display,
            position: style.position,
            top: style.top,
            right: style.right,
            bottom: style.bottom,
            left: style.left,
            zIndex: style.zIndex,
            overflow: style.overflow,
            boxSizing: style.boxSizing,
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderColor: style.borderTopColor,
            borderWidth: style.borderTopWidth,
            borderStyle: style.borderTopStyle,
            borderRadius: style.borderTopLeftRadius,
            boxShadow: style.boxShadow,
            textShadow: style.textShadow,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            textAlign: style.textAlign,
            textTransform: style.textTransform,
            marginTop: style.marginTop,
            marginRight: style.marginRight,
            marginBottom: style.marginBottom,
            marginLeft: style.marginLeft,
            gap: style.gap,
            width: style.width,
            height: style.height,
            minWidth: style.minWidth,
            minHeight: style.minHeight,
            maxWidth: style.maxWidth,
            maxHeight: style.maxHeight,
            opacity: style.opacity,
            transition: style.transition,
            animation: style.animation,
            outline: style.outline,
            outlineColor: style.outlineColor,
            outlineWidth: style.outlineWidth,
            filter: style.filter,
            backdropFilter: style.backdropFilter,
            cssText: style.cssText,
          } as Record<string, string>,
          pseudoBefore: pickPseudo(node, "::before"),
          pseudoAfter: pickPseudo(node, "::after"),
        };
        out.push(sample);
      }

      return out;
    },
    { maxSamples, sampleStride },
  );

  const seen = rawSamples.length;
  const seenSignatures = new Set<string>();
  const kept: NodeSample[] = [];
  let dropped = 0;
  const areaThreshold = Number.isFinite(profileContext.sampleNoiseAreaThreshold) ? profileContext.sampleNoiseAreaThreshold : 0;
  const bucketPx = Math.max(1, profileContext.signatureDedupBucketPx || 1);

  for (const sample of rawSamples as any[]) {
    const styles = toCssNodeStyle(sample.styles as Record<string, string>, profileContext.profile);
    const styleSignature = signatureFromStyles(styles, profileContext.profile);

    if (!sample.visible || typeof sample.opacity !== "string" || sample.opacity === "0" || sample.opacity === "0.0" || !sample.rect) {
      dropped += 1;
      continue;
    }

    const area = Number(sample.rect.width) * Number(sample.rect.height);
    if (!Number.isFinite(area) || area <= areaThreshold) {
      dropped += 1;
      continue;
    }

    const bucketSignature = [sample.rect.x, sample.rect.y, sample.rect.width, sample.rect.height]
      .map((value) => bucketFromPx(Number(value) || 0, bucketPx))
      .join("|");
    const dedupeKey = `${sample.selector}|${bucketSignature}|${styleSignature}`;
    if (seenSignatures.has(dedupeKey)) {
      dropped += 1;
      continue;
    }
    seenSignatures.add(dedupeKey);

    kept.push({
      uid: sample.uid,
      selector: sample.selector,
      tag: sample.tag,
      role: sample.role,
      typeHint: sample.typeHint || "",
      text: sample.text || null,
      className: sample.className || "",
      id: sample.id,
      ariaLabel: sample.ariaLabel,
      childCount: sample.childCount,
      rect: sample.rect,
      visible: sample.visible,
      styles,
      pseudoBefore: sample.pseudoBefore || null,
      pseudoAfter: sample.pseudoAfter || null,
      styleSignature,
    });
  }

  return { samples: kept, seen, kept: kept.length, dropped };
}

function buildDescriptorSelectorCandidates(target: InteractiveTarget): string[] {
  const candidates = new Set<string>();
  if (target.id) {
    candidates.add(`#${CSS.escape(target.id)}`);
    candidates.add(`${target.tag}#${CSS.escape(target.id)}`);
    candidates.add(`*[id='${CSS.escape(target.id)}']`);
  }
  if (target.tag) {
    candidates.add(target.tag);
    if (target.role) candidates.add(`${target.tag}[role="${CSS.escape(target.role)}"]`);
    if (target.type) candidates.add(`${target.tag}[type="${CSS.escape(target.type)}"]`);
  }
  if (target.ariaLabel) candidates.add(`[aria-label="${CSS.escape(target.ariaLabel)}"]`);
  if (target.classTokens.length) {
    const escaped = target.classTokens.map((token) => CSS.escape(token));
    candidates.add(`.${escaped[0]}`);
    candidates.add(`${target.tag}.${escaped.slice(0, 2).join(".")}`);
  }
  if (target.text && target.text.length > 0) {
    const sanitizedText = target.text.slice(0, 90).replace(/[\"']/g, "");
    candidates.add(`text:${sanitizedText}`);
  }
  if (target.type) {
    candidates.add(`[type="${CSS.escape(target.type)}"]`);
    candidates.add(`${target.tag || "*"}[type='${CSS.escape(target.type)}']`);
  }
  if (target.role) {
    candidates.add(`[role="${CSS.escape(target.role)}"]`);
    if (target.role === "switch") candidates.add(`${target.tag || "*"}[aria-checked]`);
  }
  if (target.classTokens.length >= 2) {
    const escaped = target.classTokens.map((token) => CSS.escape(token)).filter(Boolean);
    if (escaped[1]) candidates.add(`.${escaped[0]}.${escaped[1]}`);
  }
  if (target.bbox) {
    candidates.add(`bbox:${Math.round(target.bbox.x)},${Math.round(target.bbox.y)}`);
  }
  return [...candidates];
}

function toTargetAttemptsText(target: InteractiveTarget, state?: InteractionState) {
  return [
    `tag=${target.tag}`,
    target.role ? `role=${target.role}` : "",
    target.type ? `type=${target.type}` : "",
    target.id ? `id=${target.id}` : "",
    `state=${state || "default"}`,
  ]
    .filter(Boolean)
    .join("|");
}

function resolveLocatorFromStrategy(
  page: Page,
  selector: string,
  strategy: string,
): Promise<{ found: boolean; locator: string; attempts?: string[]; confidence: number } | null> {
  const normalizedText = selector?.startsWith("text:") ? selector.replace(/^text:/, "") : "";
  const normalizedBbox = selector?.startsWith("bbox:") ? selector : "";
  const candidate: string = selector;

  return new Promise(async (resolve) => {
    try {
      if (strategy === "role-text" && selector?.startsWith("role-text:")) {
        const at = selector.replace(/^role-text:/, "");
        const [rolePart, textPart] = at.split("|", 2);
        const normalizedRole = rolePart?.replace(/^role=/, "").toLowerCase();
        const normalizedInputText = decodeURIComponent(textPart || "").toLowerCase();
        if (!normalizedRole || !normalizedInputText) return resolve(null);
        const snapshot = await page
          .evaluate(
            (input) => {
              const matchedByRole = Array.from(
                document.querySelectorAll(`*[role='${input.role}'], [role='${input.role}']`),
              ) as Element[];
              if (!matchedByRole.length) return null;
              const withText = matchedByRole
                .map((node) => ({
                  node,
                  text: (node.textContent || "").toLowerCase(),
                }))
                .find((entry) => entry.text.includes(input.text));
              if (!withText) return null;
              const selectedNode = withText.node;
              if (!(selectedNode instanceof Element)) return null;
              if (selectedNode.id) return `${selectedNode.tagName.toLowerCase()}#${CSS.escape(selectedNode.id)}`;
              const classes = (selectedNode.getAttribute("class") || "")
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((token) => `.${CSS.escape(token)}`)
                .join("");
              return classes ? `${selectedNode.tagName.toLowerCase()}${classes}` : selectedNode.tagName.toLowerCase();
            },
            { role: normalizedRole, text: normalizedInputText },
          )
          .catch(() => null);
        if (!snapshot) return resolve(null);
        return resolve({
          found: true,
          locator: snapshot,
          attempts: ["role-text"],
          confidence: 0.74,
        });
      }

      if (strategy === "text" && normalizedText) {
        const matched = page.getByText(normalizedText, { exact: false });
        const count = await matched.count().catch(() => 0);
        if (!count) return resolve(null);
        const locator = matched.first();
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) return resolve(null);
        const snapshot = await locator
          .evaluate((node) => {
            if (!(node instanceof Element)) return "";
            if (node.id) return `${node.tagName.toLowerCase()}#${CSS.escape(node.id)}`;
            const classes = (node.getAttribute("class") || "")
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((token) => `.${CSS.escape(token)}`)
              .join("");
            return classes ? `${node.tagName.toLowerCase()}${classes}` : node.tagName.toLowerCase();
          })
          .catch(() => "");
        return resolve({
          found: true,
          locator: snapshot || candidate,
          attempts: ["text"],
          confidence: normalizedText ? 0.68 : 0.4,
        });
      }

      if (strategy === "bbox" && normalizedBbox) {
        const coords = normalizedBbox.replace(/^bbox:/, "");
        const [x, y] = coords.split(",").map((value) => Number.parseFloat(value));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return resolve(null);
        const foundLocator = await page
          .evaluate(
            (point) => {
              const candidates = Array.from(
                document.querySelectorAll(
                  "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='list'],[role='navigation'],[role='menu'],[role='textbox'],[role='slider'],[role='search'],[role='toolbar'],[role='tabpanel'],[role='dialog'],details,summary,option,li",
                ),
              ) as Element[];
              if (!candidates.length) return "";
              let best = candidates[0];
              let bestDistance = Number.POSITIVE_INFINITY;
              for (const candidate of candidates) {
                const rect = candidate.getBoundingClientRect();
                const cx = rect.x + rect.width / 2;
                const cy = rect.y + rect.height / 2;
                const distance = Math.hypot(cx - point.x, cy - point.y);
                if (distance < bestDistance) {
                  bestDistance = distance;
                  best = candidate;
                }
              }
              const tag = best.tagName.toLowerCase();
              if (best.id) return `${tag}#${CSS.escape(best.id)}`;
              const classes = (best.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
              return classes.length ? `${tag}.${classes.map((token) => CSS.escape(token)).join(".")}` : tag;
            },
            { x, y },
          )
          .catch(() => "");
        if (!foundLocator) return resolve(null);
        return resolve({ found: true, locator: foundLocator, attempts: ["bbox"], confidence: 0.55 });
      }

      const locator = page.locator(candidate).first();
      const count = await locator.count().catch(() => 0);
      if (!count) return resolve(null);
      const visible = await locator
        .isVisible()
        .catch(async () => {
          const c = await locator.count().catch(() => 0);
          if (!c) return false;
          return locator.evaluate((node) => node instanceof Element && node.getClientRects().length > 0).catch(() => false);
        });
      if (!visible) return resolve(null);
      return resolve({
        found: true,
        locator: candidate,
        attempts: [strategy],
        confidence: strategy === "selector" ? 0.88 : 0.55,
      });
    } catch {
      return resolve(null);
    }
  });
}

async function resolveStyleSignatureByLocator(
  page: Page,
  target: ResolvedInteractiveTarget,
  profile: CleaningProfile,
): Promise<string | null> {
  const attempts = target.resolved?.attempts?.length ? target.resolved.attempts : target.attempts;
  const candidates = [target.selector, ...(attempts || [])];
  const fallbackSelector = target.found ? target.selector : undefined;
  const ordered = [...new Set([...(fallbackSelector ? [fallbackSelector] : []), ...(candidates || []), target.target.tag ? target.target.tag : "", ""])];

  for (const candidate of ordered) {
    if (!candidate) continue;
    const style = await page.evaluate((selector) => {
      if (!selector) return null;
      let element: Element | null = null;
      if (selector.startsWith("text:")) {
        const text = selector.replace(/^text:/, "");
        if (!text) return null;
        const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='list'],[role='navigation'],[role='menu'],[role='textbox'],[role='slider'],[role='search'],[role='toolbar'],[role='tabpanel'],[role='dialog'],details,summary,option,li"));
        let best: Element | null = null;
        let bestMatch = -Infinity;
        for (const node of elements) {
          const nodeText = (node.textContent || "").toLowerCase();
          const score = nodeText.includes(text.toLowerCase()) ? text.length / Math.max(1, nodeText.length) : 0;
          if (score > bestMatch) {
            bestMatch = score;
            best = node;
          }
        }
        element = best;
      } else if (selector.startsWith("bbox:")) {
        const [x, y] = selector
          .replace(/^bbox:/, "")
          .split(",")
          .map((entry) => Number.parseFloat(entry));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const nodes = Array.from(document.querySelectorAll("*")) as Element[];
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const distance = Math.hypot(cx - x, cy - y);
          if (distance < bestDistance && rect.width > 0 && rect.height > 0) {
            bestDistance = distance;
            element = node;
          }
        }
      } else {
        element = document.querySelector(selector);
      }
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        display: style.display,
        position: style.position,
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
        zIndex: style.zIndex,
        overflow: style.overflow,
        boxSizing: style.boxSizing,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        borderRadius: style.borderTopLeftRadius,
        boxShadow: style.boxShadow,
        width: style.width,
        height: style.height,
        minWidth: style.minWidth,
        minHeight: style.minHeight,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textAlign: style.textAlign,
        textTransform: style.textTransform,
        opacity: style.opacity,
        transition: style.transition,
        animation: style.animation,
        outline: style.outline,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        filter: style.filter,
        backdropFilter: style.backdropFilter,
      } as Record<string, string>;
    }, candidate);

    if (!style) continue;
    return signatureFromStyles(toCssNodeStyle(style as Record<string, string>, profile));
  }

  if (!target.found && target.target.tag && target.target.bbox) {
    const selector = `bbox:${Math.round(target.target.bbox.x)},${Math.round(target.target.bbox.y)}`;
    const style = await page.evaluate((selectorFallback) => {
      if (!selectorFallback.startsWith("bbox:")) return null;
      const [x, y] = selectorFallback
        .replace(/^bbox:/, "")
        .split(",")
        .map((entry) => Number.parseFloat(entry));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const all = Array.from(document.querySelectorAll("*")).filter((entry) => entry instanceof Element) as Element[];
      let bestDistance = Number.POSITIVE_INFINITY;
      let best: Element | null = null;
      for (const entry of all) {
        const rect = entry.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const distance = Math.hypot(cx - x, cy - y);
        if (distance < bestDistance && rect.width > 0 && rect.height > 0) {
          bestDistance = distance;
          best = entry;
        }
      }
      if (!best) return null;
      const style = getComputedStyle(best);
      return {
        display: style.display,
        position: style.position,
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
        zIndex: style.zIndex,
        overflow: style.overflow,
        boxSizing: style.boxSizing,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        borderRadius: style.borderTopLeftRadius,
        boxShadow: style.boxShadow,
        width: style.width,
        height: style.height,
        minWidth: style.minWidth,
        minHeight: style.minHeight,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textAlign: style.textAlign,
        textTransform: style.textTransform,
        opacity: style.opacity,
        transition: style.transition,
        animation: style.animation,
        outline: style.outline,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        filter: style.filter,
        backdropFilter: style.backdropFilter,
      } as Record<string, string>;
    }, `bbox:${Math.round(target.target.bbox.x)},${Math.round(target.target.bbox.y)}`).catch(() => null);
    if (style) return signatureFromStyles(toCssNodeStyle(style, profile));
  }
  return null;
}

async function listInteractiveTargets(page: Page): Promise<InteractiveTarget[]> {
  const selector =
    "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='list'],[role='navigation'],[role='menu'],[role='textbox'],[role='slider'],[role='search'],[role='toolbar'],[role='tabpanel'],[role='dialog'],details,summary,option,li";
  const nodes = await page.evaluate((targetSelector) => {
    const candidates = Array.from(document.querySelectorAll(targetSelector)).filter((node) => node instanceof Element) as Element[];
    return candidates.map((node, index) => {
      const tag = node.tagName.toLowerCase();
      const rect = node.getBoundingClientRect();
      const text = node instanceof HTMLElement ? (node.textContent || "").trim().slice(0, 160) : "";
      return {
        uid: `${tag}-${index}-${Math.round(rect.x)}-${Math.round(rect.y)}-${node.getAttribute("type") || "el"}`,
        tag,
        role: node.getAttribute("role"),
        type: (node as HTMLInputElement).type || node.getAttribute("type") || "",
        text,
        ariaLabel: node.getAttribute("aria-label"),
        classTokens: (node.getAttribute("class") || "").split(/\s+/).filter(Boolean),
        id: node.getAttribute("id"),
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    });
  }, selector);

  const uniq = new Map<string, InteractiveTarget>();
  for (const item of nodes) {
    const key = `${item.tag}|${item.role || ""}|${item.type || ""}|${toLowerString(item.text || "")}|${toLowerString(item.ariaLabel || "")}|${item.id || ""}`;
    if (!uniq.has(key)) uniq.set(key, item);
  }
  return [...uniq.values()];
}

async function resolveInteractiveTarget(
  page: Page,
  target: InteractiveTarget,
  route: string,
  viewport: ViewportSpec,
  state?: InteractionState,
): Promise<ResolvedInteractiveTarget> {
  const attempts: string[] = [];
  const cleanText = toLowerString(target.text || "").slice(0, 120);
  const cleanRole = toLowerString(target.role || "");
  const cleanTag = toLowerString(target.tag || "");
  const cleanType = toLowerString(target.type || "");
  const cleanAriaLabel = toLowerString(target.ariaLabel || "");
  const fallbackSelector = buildDescriptorSelectorCandidates(target);
  const selectorSet = new Set<string>(fallbackSelector);

  const rankedFromPage = await page
    .evaluate(
      (input) => {
        const safe = (value: string | null | undefined) => {
          if (!value) return "";
          return String(value).toLowerCase().trim();
        };
        const tag = safe(input.tag);
        const role = safe(input.role);
        const type = safe(input.type);
        const aria = safe(input.ariaLabel);
        const text = safe(input.text);
        const classTokens = (input.classTokens || []).map((token: string) => safe(token)).filter(Boolean);
        const candidates = Array.from(
          document.querySelectorAll(
            "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='list'],[role='navigation'],[role='menu'],[role='textbox'],[role='slider'],[role='search'],[role='toolbar'],[role='tabpanel'],[role='dialog'],details,summary,option,li",
          ),
        ) as Element[];

        const scoreNode = (node: Element) => {
          const nodeRole = safe(node.getAttribute("role"));
          const nodeType = safe((node as HTMLInputElement).getAttribute("type"));
          let score = 0;
          if (tag && node.tagName.toLowerCase() === tag) score += 10;
          if (role && nodeRole) score += nodeRole === role ? 14 : 0;
          if (type && nodeType) score += nodeType === type ? 12 : 0;
          const nid = safe(node.id);
          if (input.id && safe(input.id) && nid === safe(input.id)) score += 60;
          const classSet = new Set(safe(node.getAttribute("class")).split(/\s+/).filter(Boolean));
          for (const token of classTokens) if (classSet.has(token)) score += 1;
          if (text) {
            const nodeText = safe(node.textContent || "");
            if (nodeText.includes(text)) score += 8;
            if (nodeText === text) score += 3;
          }
          if (aria && safe(node.getAttribute("aria-label")) === aria) score += 5;
          if (input.bbox) {
            const rect = node.getBoundingClientRect();
            const dx = Math.abs(rect.x - input.bbox.x);
            const dy = Math.abs(rect.y - input.bbox.y);
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (Number.isFinite(distance)) score += Math.max(0, (160 - distance) / 24);
          }
          return score;
        };

        const ranked = candidates
          .map((node) => ({ node, score: scoreNode(node) }))
          .sort((a, b) => b.score - a.score || a.node.tagName.localeCompare(b.node.tagName))
          .slice(0, 18);

        const selectorForNode = (element: Element) => {
          const candidateTag = element.tagName.toLowerCase();
          if (element.id) return `${candidateTag}#${CSS.escape(element.id)}`;
          const classes = (element.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
          if (classes.length) return `${candidateTag}.${classes.map((token) => CSS.escape(token)).join(".")}`;
          const parent = element.parentElement;
          if (!parent) return candidateTag;
          const siblings = Array.from(parent.children).filter((entry) => entry.tagName === element.tagName);
          const index = siblings.indexOf(element) + 1;
          return `${candidateTag}:nth-of-type(${index})`;
        };

        const out: string[] = [];
        for (const entry of ranked) {
          const candidate = selectorForNode(entry.node);
          if (candidate) out.push(candidate);
          if (entry.score > 2) {
            const text = (entry.node.textContent || "").trim();
            if (text) out.push(`text:${text.slice(0, 90)}`);
          }
        }
        return out;
      },
      { ...target, selectors: fallbackSelector },
    )
    .catch(() => [] as string[]);

  const strategyTryOrder: Array<{ strategy: string; selector: string; text?: string; filter?: string }> = [];

  for (const selector of rankedFromPage) {
    if (selector.startsWith("text:")) continue;
    if (selector) strategyTryOrder.push({ strategy: "selector", selector });
  }

  if (selectorSet.size) {
    for (const selector of selectorSet) {
      if (!selector.startsWith("text:")) strategyTryOrder.push({ strategy: "selector", selector });
    }
  }

  if (cleanRole && cleanText) {
    strategyTryOrder.push({ strategy: "role-text", selector: "", text: cleanText, filter: `role=${cleanRole}` });
  }
  if (cleanRole) strategyTryOrder.push({ strategy: "role", selector: `[role='${target.role}']` });
  if (cleanTag) strategyTryOrder.push({ strategy: "tag", selector: cleanTag });
  if (cleanType) strategyTryOrder.push({ strategy: "type", selector: `${cleanTag}[type='${target.type}']` });
  if (target.classTokens[0]) strategyTryOrder.push({ strategy: "class", selector: `.${CSS.escape(target.classTokens[0])}` });
  if (cleanText) strategyTryOrder.push({ strategy: "text", selector: cleanText, text: cleanText });
  if (cleanAriaLabel) strategyTryOrder.push({ strategy: "aria", selector: `[aria-label='${CSS.escape(target.ariaLabel || "")}']` });
  if (target.bbox) strategyTryOrder.push({ strategy: "bbox", selector: `bbox:${Math.round(target.bbox.x)},${Math.round(target.bbox.y)}` });
  strategyTryOrder.push({ strategy: "role-text", selector: "", text: cleanText || "", filter: cleanRole ? `[role='${target.role}']` : "" });

  if (!strategyTryOrder.length) {
    strategyTryOrder.push({
      strategy: "selector",
      selector: "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='list'],[role='navigation'],[role='menu'],[role='textbox'],[role='slider'],[role='search'],[role='toolbar'],[role='tabpanel'],[role='dialog'],details,summary,option,li",
    });
  }

  const normalizeSelector = (item: { strategy: string; selector: string; text?: string }) => {
    if (item.selector.startsWith("bbox:")) return item.selector;
    if (item.strategy === "text" || item.strategy === "role-text") return `${item.strategy}:${(item.text || "").slice(0, 120)}`;
    if (item.strategy === "class" && item.selector.startsWith(".") && !item.selector.includes(" ")) return `class=${item.selector}`;
    if (item.selector) return item.selector;
    return "";
  };

  const dedupe = new Set<string>();
  const ordered: Array<{ strategy: string; selector: string; text?: string; filter?: string }> = [];
  for (const item of strategyTryOrder) {
    const key = `${item.strategy}::${normalizeSelector(item)}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    ordered.push(item);
  }

  const seen = new Set<string>();
  for (const item of ordered) {
    const key = `${item.strategy}:${item.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attempts.push(item.strategy);

    if (item.strategy === "role-text") {
      const roleTextSelector = `role=${item.filter?.replace(/^\[role='|'\]$/g, "")}|${encodeURIComponent(item.text || "")}`;
      const result = await resolveLocatorFromStrategy(page, `role-text:${roleTextSelector}`, "role-text");
      if (!result) continue;
      return {
        found: true,
        selector: result.locator,
        strategy: item.strategy,
        attempts,
        target,
        resolved: {
          found: true,
          strategy: result.attempts?.includes("role-text") ? "role-text" : item.strategy,
          locator: result.locator,
          attempts: attempts.length ? [...attempts] : [item.strategy],
          recoverable: true,
          confidence: result.confidence,
        },
      };
    }

    if (item.strategy === "text" && item.text) {
      const textLocator = page.getByText(item.text, { exact: false });
      const count = await textLocator.count().catch(() => 0);
      if (!count) continue;
      const locator = textLocator.first();
      const matched = await locator
        .evaluate((node) => node instanceof Element && Boolean(node.textContent && node.textContent.trim()), [])
        .catch(() => false);
      if (!matched) continue;
      const selector = await locator
        .evaluate((node) => {
          if (!(node instanceof Element)) return "body";
          if (node.id) return `${node.tagName.toLowerCase()}#${CSS.escape(node.id)}`;
          const classes = (node.getAttribute("class") || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((token) => `.${CSS.escape(token)}`)
            .join("");
          return classes ? `${node.tagName.toLowerCase()}${classes}` : node.tagName.toLowerCase();
        })
        .catch(() => "body");
      return {
        found: true,
        selector,
        strategy: item.strategy,
        attempts,
        target,
        resolved: {
          found: true,
          strategy: item.strategy,
          locator: selector,
          attempts: attempts.length ? [...attempts] : [item.strategy],
          recoverable: true,
          confidence: 0.72,
        },
      };
    }

    if (item.strategy === "role-text" && item.filter && item.text) {
      const roleFiltered = page.locator(item.filter);
      const count = await roleFiltered.count().catch(() => 0);
      if (!count) continue;
      const textLocator = roleFiltered.getByText(item.text, { exact: false }).first();
      const matched = await textLocator
        .count()
        .then((value) => value > 0)
        .catch(() => false);
      if (!matched) continue;
      const selector = await textLocator
        .evaluate((node) => {
          if (!(node instanceof Element)) return "body";
          if (node.id) return `${node.tagName.toLowerCase()}#${CSS.escape(node.id)}`;
          const classes = (node.getAttribute("class") || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((token) => `.${CSS.escape(token)}`)
            .join("");
          return classes ? `${node.tagName.toLowerCase()}${classes}` : node.tagName.toLowerCase();
        })
        .catch(() => "body");
      return {
        found: true,
        selector,
        strategy: item.strategy,
        attempts,
        target,
        resolved: {
          found: true,
          strategy: item.strategy,
          locator: selector,
          attempts: attempts.length ? [...attempts] : [item.strategy],
          recoverable: true,
          confidence: 0.68,
        },
      };
    }

    if (item.strategy === "bbox" && target.bbox) {
      const selector = await page
        .evaluate(
          (input) => {
            const targetX = input.x + input.width / 2;
            const targetY = input.y + input.height / 2;
            const query = "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='combobox'],[role='listbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='list'],[role='navigation'],[role='menu'],[role='textbox']";
            const candidates = Array.from(document.querySelectorAll(query)).filter((node) => node instanceof Element) as Element[];
            if (!candidates.length) return "";
            let best = candidates[0];
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const candidate of candidates) {
              const rect = candidate.getBoundingClientRect();
              const cx = rect.x + rect.width / 2;
              const cy = rect.y + rect.height / 2;
              const distance = Math.hypot(cx - targetX, cy - targetY);
              if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
              }
            }
            const tag = best.tagName.toLowerCase();
            if (best.id) return `${tag}#${CSS.escape(best.id)}`;
            const classes = (best.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
            return classes.length ? `${tag}.${classes.map((token) => CSS.escape(token)).join(".")}` : tag;
          },
          target.bbox,
        )
        .catch(() => "");
    if (selector && (await page.locator(selector).count().catch(() => 0))) {
      return {
        found: true,
        selector,
        strategy: item.strategy,
        attempts,
        target,
        resolved: {
          found: true,
          strategy: item.strategy,
          locator: selector,
          attempts: attempts.length ? [...attempts] : [item.strategy],
          recoverable: true,
          confidence: 0.6,
        },
      };
    }
    continue;
  }

    const locator = page.locator(item.selector).first();
    const foundCount = await locator.count().catch(() => 0);
    if (!foundCount) continue;
    const visible = await locator
      .isVisible()
      .catch(async () => {
        const c = await locator.count().catch(() => 0);
        if (!c) return false;
        return locator.evaluate((node) => node instanceof Element && node.getClientRects().length > 0).catch(() => false);
      });
    if (!visible) continue;

    const finalSelector = item.selector.startsWith("bbox:")
      ? await locator
          .evaluate((node) => {
            if (!(node instanceof Element)) return "body";
            if (node.id) return `${node.tagName.toLowerCase()}#${node.id}`;
            const classes = (node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
            return `${node.tagName.toLowerCase()}${classes.length ? `.${classes.map((token) => token).join(".")}` : ""}`;
          })
          .catch(() => target.tag)
      : item.selector;

    return {
      found: true,
      selector: finalSelector,
      strategy: item.strategy,
      attempts,
      target,
      resolved: {
        found: true,
        strategy: item.strategy,
        locator: finalSelector,
        attempts: attempts.length ? [...attempts] : [item.strategy],
        recoverable: true,
      },
    };
  }

    return {
      found: false,
      selector: target.tag,
      strategy: "selector",
      attempts: attempts.length ? attempts : ["not-found"],
      target,
      resolved: {
        found: false,
        strategy: "selector",
        locator: target.tag || "",
        attempts: attempts.length ? [...attempts] : ["not-found"],
        recoverable: true,
        confidence: 0.12,
      },
    };
}

async function nodeStyleSignatureBySelector(page: Page, selector: string, profile: CleaningProfile = DEFAULT_CLEANING_PROFILE): Promise<string | null> {
  const raw = await page.evaluate((sel) => {
    const element = document.querySelector(sel) as Element | null;
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      display: style.display,
      position: style.position,
      top: style.top,
      right: style.right,
      bottom: style.bottom,
      left: style.left,
      zIndex: style.zIndex,
      overflow: style.overflow,
      boxSizing: style.boxSizing,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      borderRadius: style.borderTopLeftRadius,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      marginTop: style.marginTop,
      marginRight: style.marginRight,
      marginBottom: style.marginBottom,
      marginLeft: style.marginLeft,
      gap: style.gap,
      boxShadow: style.boxShadow,
      textShadow: style.textShadow,
      width: style.width,
      height: style.height,
      minWidth: style.minWidth,
      minHeight: style.minHeight,
      maxWidth: style.maxWidth,
      maxHeight: style.maxHeight,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      textAlign: style.textAlign,
      textTransform: style.textTransform,
      opacity: style.opacity,
      transition: style.transition,
      animation: style.animation,
      outline: style.outline,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      filter: style.filter,
      backdropFilter: style.backdropFilter,
    } as Record<string, string>;
  }, selector);
  if (!raw) return null;
  return signatureFromStyles(toCssNodeStyle(raw, profile));
}

async function applyInteractionState(
  page: Page,
  state: InteractionState,
  target: ResolvedInteractiveTarget,
): Promise<InteractionApplyResult> {
  const warnings: string[] = [];
  const probe: InteractionStateProbe = {
    supported: true,
    stateApplied: false,
    locatorRecovered: true,
    warnings: [],
  };

  if (!target.found) {
    probe.supported = false;
    probe.warnings.push("target_not_found");
    return { warnings: ["target_not_found"], skipped: true, probe };
  }

  const locator = page.locator(target.selector).first();
  const exists = await locator.count();
  if (!exists) {
    probe.supported = false;
    probe.warnings.push("target_not_found_after_resolve");
    return { warnings: ["target_not_found_after_resolve"], skipped: true, probe };
  }

  const controlState = await locator
    .evaluate((node) => {
      const element = node as HTMLElement;
      const role = (element.getAttribute("role") || element.tagName).toLowerCase();
      const tag = element.tagName ? element.tagName.toLowerCase() : "";
      const inputType = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.type : "";
      const isDisabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-disabled") === "1";
      const isChecked = "checked" in (element as { checked?: boolean }) ? Boolean((element as { checked?: boolean }).checked) : false;
      const isSelected = element.getAttribute("aria-selected") === "true";
      const expanded = element.getAttribute("aria-expanded");
      const ariaBusy = element.getAttribute("aria-busy");
      const dataState = element.getAttribute("data-state");
      const ariaInvalid = element.getAttribute("aria-invalid");
      const ariaPressed = element.getAttribute("aria-pressed");
      const dataOpen = element.getAttribute("data-open");
      const detailsOpen = element instanceof HTMLDetailsElement ? String(element.open) : null;
      const className = (element.getAttribute("class") || "").toLowerCase();
      return {
        role,
        tag,
        type: (inputType || "").toLowerCase(),
        isDisabled: Boolean(isDisabled),
        hasAriaDisabled: element.hasAttribute("aria-disabled"),
        canNativeDisable: "disabled" in element,
        canAriaDisable:
          element.hasAttribute("aria-disabled") ||
          role === "button" ||
          role === "menuitem" ||
          role === "tab" ||
          role === "switch" ||
          role === "checkbox" ||
          role === "radio" ||
          tag === "button" ||
          tag === "a" ||
          tag === "summary" ||
          tag === "option",
        isChecked,
        isSelected,
        hasExpanded: expanded === "true" || expanded === "false",
        expanded,
        ariaPressed: ariaPressed,
        dataState: dataState,
        detailsOpen,
        ariaBusy: Boolean(ariaBusy && ariaBusy !== "false"),
        hasDataState: Boolean(dataState && dataState !== "false"),
        hasAriaInvalid: ariaInvalid === "true",
        hasDetailsOpen: detailsOpen !== null,
        hasDataOpen: dataOpen === "true" || dataOpen === "1",
        hasOpenIndicator:
          role === "button" ||
          role === "summary" ||
          role === "tab" ||
          role === "menuitem" ||
          role === "combobox" ||
          role === "details" ||
          role === "listbox" ||
          tag === "summary" ||
          tag === "details" ||
          /toggle|switch|expand|accordion/.test(className),
        hasAriaControlHint: Boolean(element.getAttribute("aria-controls")),
        hasDataOpenHint: Boolean(dataOpen),
      };
    })
        .catch(
          () =>
            ({
              role: "",
              tag: "",
              type: "",
              isDisabled: false,
              hasAriaDisabled: false,
              canNativeDisable: false,
              canAriaDisable: false,
              isChecked: false,
              isSelected: false,
              hasExpanded: false,
              expanded: null as string | null,
              ariaPressed: null,
          dataState: null,
          detailsOpen: null,
          ariaBusy: false,
          hasDataState: false,
          hasDataOpen: false,
          hasAriaInvalid: false,
          hasDetailsOpen: false,
          hasOpenIndicator: false,
          hasAriaControlHint: false,
          hasDataOpenHint: false,
        } as {
          role: string;
          tag: string;
          type: string;
          isDisabled: boolean;
          hasAriaDisabled: boolean;
          canNativeDisable: boolean;
          canAriaDisable: boolean;
          isChecked: boolean;
          isSelected: boolean;
          hasExpanded: boolean;
          expanded: string | null;
          ariaPressed: string | null;
          dataState: string | null;
          detailsOpen: string | null;
          ariaBusy: boolean;
          hasDataState: boolean;
          hasDataOpen: boolean;
          hasAriaInvalid: boolean;
          hasDetailsOpen: boolean;
          hasOpenIndicator: boolean;
          hasAriaControlHint: boolean;
          hasDataOpenHint: boolean;
        }),
    );

  const isCheckLike = ["checkbox", "radio", "switch"].includes(controlState.type) || ["checkbox", "radio", "switch"].includes(controlState.role);
  const supportsChecked = isCheckLike;
  const supportsSelected = ["tab", "option", "menuitem", "row", "checkbox", "radio", "switch"].includes(controlState.role);
  const hasOpenTarget = controlState.hasOpenIndicator || controlState.hasExpanded || controlState.hasAriaControlHint || controlState.hasDataOpenHint;
  const stateCapable = supportsStateTarget(state, {
    tag: controlState.tag,
    role: controlState.role,
    type: controlState.type,
  });

  const captureDisabledRestore: { fn?: () => Promise<void> } = {};

  switch (state) {
    case "hover":
      await locator.hover({ timeout: 1_000 }).catch(() => {});
      probe.stateApplied = true;
      break;
    case "focus":
      await locator.focus().catch(() => {});
      probe.stateApplied = true;
      break;
    case "active":
      await locator.dispatchEvent("mousedown").catch(() => {});
      await locator.dispatchEvent("mouseup").catch(() => {});
      probe.stateApplied = true;
      break;
    case "checked":
      if (!stateCapable || !supportsChecked || (!["checkbox", "radio", "switch"].includes(controlState.type) && !["checkbox", "radio", "switch"].includes(controlState.role))) {
        warnings.push("checked_not_applicable");
        probe.supported = false;
        break;
      }
      if (controlState.isDisabled) {
        warnings.push("checked_disabled_target");
        probe.supported = false;
        break;
      }
      if (!controlState.isChecked) {
        await locator.click({ timeout: 1_000 }).catch(() => {});
      }
      const postChecked = await locator
        .evaluate((node) => (node as HTMLInputElement).checked || node.getAttribute("aria-checked") === "true")
        .catch(() => false);
      if (!postChecked) {
        warnings.push(controlState.isChecked ? "checked_already_active" : "checked_state_not_reflected");
        probe.stateApplied = false;
      } else {
        probe.stateApplied = true;
      }
      break;
    case "selected":
      if (!stateCapable || !supportsSelected) {
        if (!supportsSelected) warnings.push("selected_not_applicable");
        probe.supported = false;
        break;
      }
      if (controlState.isSelected) {
        warnings.push("selected_already_selected");
        probe.stateApplied = true;
        break;
      }
      if (controlState.isDisabled) {
        warnings.push("selected_disabled_target");
        probe.supported = false;
        break;
      }
      if (controlState.type || controlState.role) {
        await locator.click({ timeout: 1_000 }).catch(() => {});
        probe.stateApplied = true;
      }
      break;
    case "open":
      if (!stateCapable || !hasOpenTarget) {
        warnings.push("open_not_applicable");
        probe.supported = false;
        break;
      }
      if (controlState.isDisabled) {
        warnings.push("open_disabled_target");
        probe.supported = false;
        break;
      }
      await locator.click({ timeout: 1_000 }).catch(() => {});
      await page.waitForTimeout(70).catch(() => {});
      const openAfter = await locator
        .evaluate((node) => ({
          expanded: node.getAttribute("aria-expanded"),
          controls: (node as HTMLElement).getAttribute("aria-controls"),
          detailsOpen: (node instanceof HTMLDetailsElement) ? String((node as HTMLDetailsElement).open) : null,
          dataState: node.getAttribute("data-state"),
          dataOpen: node.getAttribute("data-open"),
          ariaPressed: node.getAttribute("aria-pressed"),
          ariaControls: node.getAttribute("aria-controls"),
        }))
        .catch(
          () =>
            ({
              expanded: null as string | null,
              controls: null as string | null,
              detailsOpen: null as string | null,
              dataState: null as string | null,
              dataOpen: null as string | null,
              ariaPressed: null as string | null,
              ariaControls: null as string | null,
            }) as {
              expanded: string | null;
              controls: string | null;
              detailsOpen: string | null;
              dataState: string | null;
              dataOpen: string | null;
              ariaPressed: string | null;
              ariaControls: string | null;
            },
        );
      const normalizedExpanded = (openAfter.expanded || "").toLowerCase();
      const normalizedPressed = (openAfter.ariaPressed || "").toLowerCase();
      const normalizedDataState = (openAfter.dataState || "").toLowerCase();
      const normalizedDataOpen = (openAfter.dataOpen || "").toLowerCase();
      const isOpen =
        normalizedExpanded === "true" ||
        normalizedPressed === "true" ||
        normalizedDataState === "open" ||
        normalizedDataOpen === "open" ||
        normalizedDataOpen === "true" ||
        String(openAfter.detailsOpen).toLowerCase() === "true";
      const hasMarker =
        Boolean(openAfter.expanded) ||
        Boolean(openAfter.controls) ||
        Boolean(openAfter.ariaControls) ||
        Boolean(openAfter.dataState) ||
        Boolean(openAfter.dataOpen) ||
        Boolean(openAfter.ariaPressed) ||
        Boolean(openAfter.detailsOpen) ||
        controlState.hasExpanded ||
        controlState.hasDataOpen ||
        controlState.hasAriaControlHint;
      if (!hasMarker || !isOpen) {
        warnings.push(hasMarker ? "open_state_not_reflected" : "open_state_marker_missing");
        probe.stateApplied = false;
        probe.supported = false;
        break;
      }
      probe.stateApplied = true;
      break;
    case "disabled":
      if (!stateCapable) {
        warnings.push("disabled_not_applicable");
        probe.supported = false;
        break;
      }
      if (!controlState.canNativeDisable && !controlState.canAriaDisable) {
        warnings.push("disabled_not_applicable");
        probe.supported = false;
        break;
      }
      if (controlState.isDisabled) {
        warnings.push("disabled_state_already_disabled");
        probe.stateApplied = true;
        break;
      }
      const disabledProbe = await locator
        .evaluate(
          (node, payload: { canNative: boolean; canAria: boolean }) => {
            const hasDisabled = payload.canNative && node instanceof Element && node.hasAttribute("disabled");
            const ariaDisabled =
              payload.canAria && node instanceof Element ? node.getAttribute("aria-disabled") === "true" || node.getAttribute("aria-disabled") === "1" : false;
            const className = (node.getAttribute("class") || "").toLowerCase();
            const disabledClass = /\b(?:disabled|is-disabled|state-disabled|aria-disabled)\b/.test(className);
            const dataState = node.getAttribute("data-state");
            const dataDisabled = node.getAttribute("data-disabled");
            const hasDisabledSignal = Boolean(hasDisabled || ariaDisabled || disabledClass || dataState === "disabled" || dataDisabled === "true");
            return {
              hasDisabledSignal,
              hasDisabled,
              ariaDisabled,
              disabledClass,
              dataState,
              dataDisabled,
            };
          },
          {
            canNative: controlState.canNativeDisable,
            canAria: controlState.canAriaDisable,
          },
        )
        .catch(() => null);
      if (!disabledProbe) {
        warnings.push("disabled_probe_failed");
        probe.supported = false;
        break;
      }
      if (disabledProbe.hasDisabledSignal) {
        probe.stateApplied = true;
        break;
      }

      const simulated = await locator
        .evaluate(
          (node, payload: { canNative: boolean; canAria: boolean }) => {
            if (!(node instanceof HTMLElement)) return null;
            const canNative = payload.canNative && "disabled" in node;
            const canAria = payload.canAria;
            const element = node;
            const hadDisabled = element.hasAttribute("disabled");
            const hadAriaDisabled = element.getAttribute("aria-disabled");
            const hadDataDisabled = element.getAttribute("data-disabled");
            const hadDataState = element.getAttribute("data-state");
            const hadDisabledClass = element.classList.contains("is-disabled");
            const hadPointerEvents = element.style.pointerEvents;
            const hadCursor = element.style.cursor;
            if (canNative && !hadDisabled) {
              (element as HTMLInputElement).setAttribute("disabled", "true");
              (element as HTMLInputElement).disabled = true;
              return {
                applied: true,
                strategy: "native",
                hadDisabled,
                hadAriaDisabled,
                hadDataDisabled,
                hadDataState,
                hadDisabledClass,
                hadPointerEvents,
                hadCursor,
              };
            }
            if (canAria) {
              element.setAttribute("aria-disabled", "true");
              element.style.pointerEvents = "none";
              return {
                applied: true,
                strategy: "aria",
                hadDisabled,
                hadAriaDisabled,
                hadDataDisabled,
                hadDataState,
                hadDisabledClass,
                hadPointerEvents,
                hadCursor,
              };
            }
            element.setAttribute("data-state", "disabled");
            element.setAttribute("data-disabled", "true");
            element.setAttribute("aria-disabled", "true");
            element.style.pointerEvents = "none";
            if (!hadDisabledClass) element.classList.add("is-disabled");
            return {
              applied: true,
              strategy: "data",
              hadDisabled,
              hadAriaDisabled,
              hadDataDisabled,
              hadDataState,
              hadDisabledClass,
              hadPointerEvents,
              hadCursor,
            };
          },
          {
            canNative: controlState.canNativeDisable,
            canAria: controlState.canAriaDisable,
          },
        )
        .catch(() => null);
      if (!simulated || !simulated.applied) {
        warnings.push("disabled_state_not_reproducible");
        probe.supported = false;
        break;
      }
      captureDisabledRestore.fn = async () => {
        try {
          await locator.evaluate(
            (node, payload) => {
              if (!(node instanceof HTMLElement)) return;
              if (payload.strategy === "native") {
                (node as HTMLInputElement).disabled = false;
                if (!payload.hadDisabled) node.removeAttribute("disabled");
                if (payload.hadAriaDisabled == null) {
                  node.removeAttribute("aria-disabled");
                } else {
                  node.setAttribute("aria-disabled", payload.hadAriaDisabled);
                }
              } else {
                if (payload.hadAriaDisabled == null) node.removeAttribute("aria-disabled");
                else node.setAttribute("aria-disabled", payload.hadAriaDisabled);
                if (payload.hadDataDisabled == null) node.removeAttribute("data-disabled");
                else node.setAttribute("data-disabled", payload.hadDataDisabled);
                if (payload.hadDataState == null) node.removeAttribute("data-state");
                else node.setAttribute("data-state", payload.hadDataState);
                if (!payload.hadDisabledClass) node.classList.remove("is-disabled");
              }
              if (payload.hadPointerEvents == null || payload.hadPointerEvents === "") node.style.removeProperty("pointer-events");
              else node.style.pointerEvents = payload.hadPointerEvents;
              if (payload.hadCursor == null || payload.hadCursor === "") node.style.removeProperty("cursor");
              else node.style.cursor = payload.hadCursor;
            },
            {
              strategy: simulated.strategy,
              hadDisabled: simulated.hadDisabled,
              hadAriaDisabled: simulated.hadAriaDisabled,
              hadDataDisabled: simulated.hadDataDisabled,
              hadDataState: simulated.hadDataState,
              hadDisabledClass: simulated.hadDisabledClass,
              hadPointerEvents: simulated.hadPointerEvents,
              hadCursor: simulated.hadCursor,
            },
          );
        } catch {}
      };
      const postProbe = await locator
        .evaluate(
          (node, payload: { canNative: boolean; canAria: boolean }) => {
            const hasDisabled = payload.canNative && node instanceof Element && node.hasAttribute("disabled");
            const ariaDisabled = payload.canAria && node instanceof Element ? node.getAttribute("aria-disabled") === "true" || node.getAttribute("aria-disabled") === "1" : false;
            const className = (node.getAttribute("class") || "").toLowerCase();
            const disabledClass = /\b(?:disabled|is-disabled|state-disabled|aria-disabled)\b/.test(className);
            const dataState = node.getAttribute("data-state");
            const dataDisabled = node.getAttribute("data-disabled");
            const hasDisabledSignal = Boolean(hasDisabled || ariaDisabled || disabledClass || dataState === "disabled" || dataDisabled === "true");
            return hasDisabledSignal;
          },
          {
            canNative: controlState.canNativeDisable,
            canAria: controlState.canAriaDisable,
          },
        )
        .catch(() => false);
      if (!postProbe) {
        warnings.push("disabled_state_not_reflected");
        if (captureDisabledRestore.fn) {
          await captureDisabledRestore.fn().catch(() => {});
          captureDisabledRestore.fn = undefined;
        }
        probe.stateApplied = false;
        probe.supported = false;
        break;
      }
      warnings.push("disabled_state_simulated");
      probe.stateApplied = true;
      break;
    case "loading":
      if (!stateCapable) {
        warnings.push("loading_not_applicable");
        probe.supported = false;
        break;
      }
      if (controlState.isDisabled) {
        warnings.push("loading_skipped_disabled");
        probe.supported = false;
        break;
      }
      const loadingProbe = await locator
        .evaluate((node) => {
          const candidates = [
            node,
            node.closest("button, a, summary, [role='button'], [role='tab'], [role='menuitem'], [role='switch'], [role='checkbox'], [role='radio']"),
            node.closest("[role='status'], [role='progressbar'], [aria-live]"),
            node.parentElement,
          ].filter(Boolean) as Element[];

          const nearby = Array.from(
            node.querySelectorAll?.("[aria-busy], [data-loading], [data-busy], [data-state], [data-status], [role='progressbar'], [aria-live], .loading, .spinner, .skeleton, .progress, .busy") || [],
          )
            .map((candidate) => `${candidate.className || ""} ${candidate.getAttribute("aria-busy") || ""} ${candidate.getAttribute("data-state") || ""}`)
            .join(" | ");

          const signals = candidates
            .map((candidate) => {
              const busy = [
                candidate.getAttribute("aria-busy"),
                candidate.getAttribute("data-loading"),
                candidate.getAttribute("data-state"),
                candidate.getAttribute("data-status"),
                candidate.getAttribute("data-busy"),
              ].join(" ");
              const className = candidate.className || "";
              return `${busy} ${className}`;
            })
            .join(" | ");

          const state = `${signals} ${nearby}`.toLowerCase();
          const hasIndicator = /(true|loading|busy|spinner|skeleton|progress|shimmer)/i.test(state);
          return {
            hasIndicator,
            details: state,
          };
        })
        .catch(() => ({ hasIndicator: false, details: "" as string }));

      if (loadingProbe.hasIndicator) {
        if (controlState.ariaBusy) {
          warnings.push("loading_already_busy");
        }
        probe.stateApplied = true;
      } else {
        warnings.push("loading_no_indicator");
        probe.supported = false;
      }
      break;
    case "error":
      if (!stateCapable) {
        warnings.push("error_not_applicable");
        probe.supported = false;
        break;
      }
      const errorProbe = await locator
        .evaluate((node) => {
          const candidates = [
            node,
            node.closest("form, [role='form'], [role='status'], [role='alert'], [role='group']"),
            node.parentElement,
          ].filter(Boolean) as Element[];

          const stateText = candidates
            .map((candidate) =>
              [
                candidate.getAttribute("data-error"),
                candidate.getAttribute("data-status"),
                candidate.getAttribute("aria-invalid"),
                candidate.getAttribute("role"),
                candidate.getAttribute("data-state"),
                candidate.className,
              ].join(" "),
            )
            .join(" | ")
            .toLowerCase();

          const nearbyText = Array.from(
            node.querySelectorAll?.("[role='alert'], [role='status'], [aria-live], .error, .invalid, .danger, .warn") || [],
          )
            .map((candidate) => `${candidate.className} ${candidate.textContent || ""}`)
            .join(" | ")
            .toLowerCase();

          const hasIndicator = /(error|invalid|danger|warn|failed|aria-invalid|data-error)/i.test(`${stateText} ${nearbyText}`);
          return { hasIndicator, stateText, nearbyText };
        })
        .catch(() => ({ hasIndicator: false, stateText: "", nearbyText: "" as string }));

      if (!errorProbe.hasIndicator) {
        warnings.push("error_no_indicator");
        probe.supported = false;
        break;
      }
      probe.stateApplied = true;
      break;
    default:
      break;
  }

  await page.waitForTimeout(140);
  const shouldSkip = probe.supported === false;
  probe.warnings = warnings;
  return {
    warnings,
    skipped: shouldSkip,
    probe,
    restore: captureDisabledRestore.fn,
  };
}

function buildComponentRecipe(groups: Record<string, NodeSample[]>): Record<string, ComponentRecipe> {
  return buildComponentRecipeWithState(groups);
}

export function buildComponentRecipeWithState(
  groups: Record<string, NodeSample[]>,
  stateByArchetype: Record<string, ComponentStateCaptureInput[]> = {},
  cleaningContext: CleaningProfileCtx = createCleaningProfileContext(DEFAULT_CLEANING_PROFILE),
  cleaning?: CleaningProfileReport,
): Record<string, ComponentRecipe> {
  const output: Record<string, ComponentRecipe> = {};
  const profileContext = cleaningContext;
  let stateRecordsDropped = 0;

  for (const [name, samples] of Object.entries(groups)) {
    if (!samples.length) continue;
    const archetype = name;
    const hPad: number[] = [];
    const vPad: number[] = [];
    const heights: number[] = [];
    const signatures: string[] = [];
    const common: ComponentRecipe["commonStyles"] = {
      display: null,
      borderRadius: null,
      fontFamily: null,
      fontSize: null,
      transition: null,
    };
    const states: ComponentVariantState[] = [];
    const examples: string[] = [];
    const cleanedSamples = samples
      .slice(0, Math.max(3, profileContext.maxComponentStates * 3))
      .filter((sample) => sample && sample.styleSignature)
      .slice(0, Math.max(3, profileContext.maxComponentStates * 2));

    const estimateHeight = (sample: NodeSample) => {
      const h = parseLengthForProfile(sample.styles.height, profileContext.profile);
      if (h !== null && h > 0) return h;
      const minH = parseLengthForProfile(sample.styles.minHeight, profileContext.profile);
      if (minH !== null && minH > 0) return minH;
      const lineHeight = parseLengthForProfile(sample.styles.lineHeight, profileContext.profile);
      const pt = parseLengthForProfile(sample.styles.paddingTop, profileContext.profile) || 0;
      const pb = parseLengthForProfile(sample.styles.paddingBottom, profileContext.profile) || 0;
      const minFallback = lineHeight !== null && lineHeight > 0 ? lineHeight + pt + pb : null;
      if (minFallback) return minFallback;
      return null;
    };

    for (const sample of cleanedSamples) {
      if (!common.display) common.display = sample.styles.display || null;
      if (!common.borderRadius) common.borderRadius = sample.styles.borderRadius || null;
      if (!common.fontFamily) common.fontFamily = sample.styles.fontFamily || null;
      if (!common.fontSize) common.fontSize = sample.styles.fontSize || null;
      if (!common.transition) common.transition = sample.styles.transition || null;
      if (examples.length < profileContext.maxComponentExamples) examples.push(sample.selector || sample.uid);

      const h = parseLengthForProfile(sample.styles.paddingLeft, profileContext.profile) || 0;
      const hp = parseLengthForProfile(sample.styles.paddingRight, profileContext.profile) || 0;
      const vp = parseLengthForProfile(sample.styles.paddingTop, profileContext.profile) || 0;
      const vb = parseLengthForProfile(sample.styles.paddingBottom, profileContext.profile) || 0;
      const height = estimateHeight(sample);
      hPad.push(h + hp);
      vPad.push(vp + vb);
      if (height !== null) heights.push(height);
      signatures.push(sample.styleSignature);
    }

    const uniquePadH = [...new Set(hPad)].map((value) => toCanonicalLengthToken(value, profileContext.profile)).filter(Boolean);
    const uniquePadV = [...new Set(vPad)].map((value) => toCanonicalLengthToken(value, profileContext.profile)).filter(Boolean);
    const uniqueHeights = [...new Set(heights)]
      .map((value) => toCanonicalLengthToken(value, profileContext.profile))
      .filter(Boolean)
      .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
      .slice(0, 3);
    const firstPadH = uniquePadH[0] || null;
    const firstPadV = uniquePadV[0] || null;

    const sizeScale: ComponentRecipe["sizeScale"] = uniqueHeights.map((height) => {
      const px = Number.parseFloat(height);
      const variant = px <= 30 ? "sm" : px <= 42 ? "md" : px > 62 ? "lg" : "md";
      return {
        variant,
        minHeight: height || null,
        horizontalPadding: firstPadH,
        verticalPadding: firstPadV,
      };
    });
    const normalizedSizeScale = sizeScale
      .filter((entry, index, all) => all.findIndex((item) => `${item.variant}|${item.minHeight}|${item.horizontalPadding}|${item.verticalPadding}` === `${entry.variant}|${entry.minHeight}|${entry.horizontalPadding}|${entry.verticalPadding}`) === index)
      .sort((a, b) => {
        const order = ["sm", "md", "lg", "xl"];
        const ai = order.indexOf(a.variant);
        const bi = order.indexOf(b.variant);
        return ai - bi;
      })
      .slice(0, Math.max(2, Math.min(4, profileContext.maxComponentStates)));

    const dedupeStates = new Map<string, ComponentVariantState>();
    const stateBudget = Math.max(1, profileContext.maxComponentStates);
    states.push({
      state: "default",
      styleSignature: signatures.length ? signatures[0] : "",
      examples: [...new Set(examples)].slice(0, profileContext.maxComponentExamples),
    });

    for (const stateCapture of stateByArchetype[archetype] || []) {
      const capturePropertyDeltas = canonicalizeStateDeltas(stateCapture.propertyDeltas);
      const isNoop =
        profileContext.profile === "high" &&
        !stateCapture.changedProperties.length &&
        !stateCapture.changedPropertiesAdded.length &&
        !stateCapture.changedPropertiesRemoved.length &&
        Object.keys(capturePropertyDeltas).length === 0;
      if (isNoop) {
        stateRecordsDropped += 1;
        continue;
      }
      const cleanedState: ComponentVariantState = {
        state: stateCapture.state,
        styleSignature: stateCapture.styleSignature || "",
        changedProperties: [...new Set(stateCapture.changedProperties || [])].sort(),
        changedPropertiesAdded: [...new Set(stateCapture.changedPropertiesAdded || [])].sort(),
        changedPropertiesRemoved: [...new Set(stateCapture.changedPropertiesRemoved || [])].sort(),
        propertyDeltas: capturePropertyDeltas,
        examples: [...new Set(stateCapture.examples || [])].slice(0, profileContext.maxComponentExamples),
        source: {
          route: stateCapture.stateTargetMeta?.route || "",
          viewport: stateCapture.stateTargetMeta?.viewport || "",
          theme: stateCapture.stateTargetMeta?.theme as ThemeMode | undefined,
          screenshot: stateCapture.screenshot || "",
          selector: stateCapture.stateTargetMeta?.selector || stateCapture.targetSelector || "",
          locator: stateCapture.stateTargetMeta?.locator || stateCapture.targetSelector || "",
        },
        provenance: [
          ...canonicalizeStateTargetMeta(stateCapture.stateTargetMeta),
          `style:${stateCapture.styleSignature}`,
          ...((stateCapture.stateTargetMeta?.attempts || []).slice(0, 3).map((attempt) => `attempt:${attempt}`)),
          stateCapture.changedProperties?.length ? `changed:${(stateCapture.changedProperties || []).sort().join(",")}` : "",
        ].filter(Boolean),
      };

      const stateKey = stateKeyFromVariant(cleanedState);
      if (dedupeStates.has(stateKey)) {
        const existing = dedupeStates.get(stateKey);
        if (existing) {
          existing.changedProperties = [...new Set([...(existing.changedProperties || []), ...(cleanedState.changedProperties || [])])].sort();
          existing.changedPropertiesAdded = [...new Set([...(existing.changedPropertiesAdded || []), ...(cleanedState.changedPropertiesAdded || [])])].sort();
          existing.changedPropertiesRemoved = [...new Set([...(existing.changedPropertiesRemoved || []), ...(cleanedState.changedPropertiesRemoved || [])])].sort();
          existing.examples = [...new Set([...(existing.examples || []), ...(cleanedState.examples || [])])].slice(
            0,
            profileContext.maxComponentExamples,
          );
          existing.provenance = [...new Set([...(existing.provenance || []), ...(cleanedState.provenance || [])])];
          existing.propertyDeltas = existing.propertyDeltas || {};
          for (const [key, delta] of Object.entries(cleanedState.propertyDeltas || {})) {
            existing.propertyDeltas[key] = delta;
          }
        }
        stateRecordsDropped += 1;
        continue;
      }

      dedupeStates.set(stateKey, cleanedState);
    }

    const extraStates = [...dedupeStates.values()]
      .filter((entry) => entry.state !== "default")
      .sort((a, b) => a.state.localeCompare(b.state))
      .slice(0, Math.max(0, stateBudget - 1));
    states.push(...extraStates);

    output[name] = {
      name: archetype,
      archetype,
      count: samples.length,
      examples,
      sizeScale: normalizedSizeScale,
      states,
      commonStyles: common,
      provenance: samples.slice(0, 6).map((s) => s.uid),
    };
  }

  if (cleaning) {
    cleaning.stateRecordsDropped += stateRecordsDropped;
  }

  return output;
}

async function makeRouteCapture(
  snapshotId: string,
  page: Page,
  route: string,
  theme: ThemeMode,
  viewport: ViewportSpec,
  routeDepth: number,
  maxSamplesPerViewport: number,
  sampleStride: number,
  interactionBudget: number,
  stateBudget: number,
  waitConfig: Required<WaitConfig>,
  cleaningContext: CleaningProfileCtx,
  cleaningReport?: CleaningProfileReport,
): Promise<RouteViewportCapture> {
  const settling = await waitForStable(page, waitConfig);
  const stateWarnings: string[] = [];
  const shouldThrottleStateCapture =
    !settling.stable &&
    settling.unstableFrames > Math.max(2, Math.floor(waitConfig.mutationStabilityFrames * 0.6));
  const stateCaptureBudget = Math.max(1, settling.stable ? interactionBudget : Math.max(1, Math.floor(interactionBudget * 0.6)));
  const effectiveStateCaptureBudget = shouldThrottleStateCapture ? 0 : stateCaptureBudget;
  if (!settling.stable) {
    stateWarnings.push(`route-not-stable-${route}-${viewport.name}-${theme}`);
  }
  if (shouldThrottleStateCapture) {
    stateWarnings.push(`state_capture_throttled route=${route} viewport=${viewport.name} theme=${theme}`);
  }

  const captureNamePrefix = captureId(route, viewport, theme, "route", "default");
  const defaultShot = screenshotPath(snapshotId, `${captureNamePrefix}_default`);
  let defaultScreenshotTaken = false;
  try {
    await page.screenshot({ path: defaultShot, fullPage: true });
    defaultScreenshotTaken = true;
  } catch {
    stateWarnings.push(`screenshot-default-failed ${captureNamePrefix}`);
  }

  const profileAdjustedSamples = Math.max(120, Math.round(maxSamplesPerViewport * cleaningContext.sampleCapMultiplier));
  const profileAdjustedStride = Math.max(1, Math.round(sampleStride * cleaningContext.sampleStrideMultiplier));

  const gathered = await gatherSamples(
    page,
    profileAdjustedSamples,
    profileAdjustedStride,
    cleaningContext,
    {
      route,
      viewport: `${viewport.width}x${viewport.height}`,
      theme,
    },
  );
  if (cleaningReport) {
    cleaningReport.samplesSeen += gathered.seen;
    cleaningReport.samplesKept += gathered.kept;
    cleaningReport.samplesDropped += gathered.dropped;
  }
  const samples = gathered.samples;
  const componentByArchetype: Record<string, NodeSample[]> = {};
  for (const sample of samples) {
    const archetype = classifyArchetype(sample);
    if (!componentByArchetype[archetype]) componentByArchetype[archetype] = [];
    componentByArchetype[archetype].push(sample);
  }

  const stateCaptures: RouteViewportCapture["stateCaptures"] = [];
  const defaultSignature = styleFingerprintFromSamples(samples, {
    route,
    theme,
    viewport,
    routeDepth,
  });
  stateCaptures.push({
    state: "default",
    screenshot: defaultShot,
    styleSignature: defaultSignature,
    changedProperties: [],
  });

  const componentStateBuckets: Record<string, ComponentStateCaptureInput[]> = {};
  const defaultRouteFingerprint = styleFingerprintFromSamples(samples, {
    route,
    theme,
    viewport,
    routeDepth,
  });
  const targets = await listInteractiveTargets(page);
  const capped = targets.slice(0, Math.max(0, effectiveStateCaptureBudget));
  const stateSequence = SUPPORTED_INTERACTION_STATES.slice(0, Math.max(0, shouldThrottleStateCapture ? 0 : stateBudget));
  const routeStateWarningBudget = Math.max(1, Math.min(20, stateCaptureBudget));

  for (const state of stateSequence) {
    for (const target of capped) {
      const archetype = classifyArchetype({
        tag: target.tag,
        role: target.role,
        className: target.classTokens.join(" "),
        text: target.text || null,
        typeHint: target.type,
      });
      const resolved = await resolveInteractiveTarget(page, target, route, viewport, state);
      const stateTargetMeta = {
        selector: resolved.selector || target.tag || "",
        locator: resolved.selector,
        found: resolved.found,
        strategy: resolved.strategy,
        attempts: resolved.attempts,
        state,
        resolved: resolved.resolved,
        route,
        viewport: `${viewport.name}:${viewport.width}x${viewport.height}`,
        recoverable: resolved.resolved?.recoverable,
        tag: target.tag,
        role: target.role,
        type: target.type,
        text: target.text,
        ariaLabel: target.ariaLabel,
        classTokens: target.classTokens,
        bbox: target.bbox,
      };
      const stateProvenance = [`route=${route}`, `viewport=${viewport.width}x${viewport.height}`, `theme=${theme}`, `state=${state}`, `strategy=${resolved.strategy}`];

      if (!resolved.found) {
        stateWarnings.push(
          `state_target_not_found route=${route} state=${state} tag=${target.tag} strategy=${resolved.strategy} attempts=${resolved.attempts.join(",")}`,
        );
        stateCaptures.push({
          state,
          stateTarget: resolved.selector,
          screenshot: defaultScreenshotTaken ? defaultShot : "",
          styleSignature: defaultSignature,
          changedProperties: [],
          changedPropertiesAdded: [],
          changedPropertiesRemoved: [],
          stateTargetMeta,
          targetFound: false,
          targetCaptureAttempts: resolved.attempts.length,
          targetFingerprint: {
            before: defaultSignature,
            after: defaultSignature,
          },
          targetStyleDelta: {},
          nodeSignatures: {
            [`${target.uid}:before`]: defaultSignature,
            [`${target.uid}:after`]: defaultSignature,
          },
          stateTargetResolved: {
            found: false,
            strategy: resolved.strategy,
            locator: resolved.selector,
            attempts: [...resolved.attempts],
            recoverable: resolved.resolved?.recoverable,
            confidence: resolved.resolved?.confidence,
          },
          targetProvenance: [...stateProvenance],
          provenanceWarnings: ["state_target_not_found"],
        });
        continue;
      }

      const before = resolved.found ? await resolveStyleSignatureByLocator(page, resolved, cleaningContext.profile).catch(() => null) : null;
      const interaction = await applyInteractionState(page, state, resolved).catch((error) => {
        stateWarnings.push(`interaction_error route=${route} state=${state} target=${resolved.selector} ${String(error)}`);
        return {
          warnings: ["interaction_error"],
          skipped: true,
          probe: {
            supported: false,
            stateApplied: false,
            locatorRecovered: false,
            warnings: ["interaction_error"],
          },
        };
      });
      if (interaction?.skipped) {
        stateWarnings.push(`interaction_skipped route=${route} state=${state} target=${resolved.selector} ${interaction?.warnings[0] || ""}`.trim());
      } else if (interaction?.warnings?.length) {
        stateWarnings.push(...interaction.warnings.map((warning) => `state_${state}_${warning}:${target.tag}`));
      }
      await page.waitForTimeout(waitConfig.settleMs);
      const shot = screenshotPath(snapshotId, `${captureNamePrefix}_${state}_${target.tag}`);
      const shotSucceeded = await page.screenshot({ path: shot, fullPage: true }).then(() => true).catch(() => false);
      if (!shotSucceeded) {
        stateWarnings.push(`state_screenshot_failed route=${route} state=${state} target=${target.uid}`);
      }
      const shotPath = shotSucceeded ? shot : defaultScreenshotTaken ? defaultShot : "";

      const after = resolved.found ? await resolveStyleSignatureByLocator(page, resolved, cleaningContext.profile).catch(() => null) : null;
      const diff = changedPropertiesFromSignatures(before || "", after || "");
      const deltas = signatureValueDeltas(before || "", after || "");
      const stateCapture: RouteViewportCapture["stateCaptures"][number] = {
        state,
        stateTarget: resolved.selector,
        screenshot: shotPath,
        styleSignature: after || defaultSignature,
        changedProperties: diff.changed,
        changedPropertiesAdded: diff.added,
        changedPropertiesRemoved: diff.removed,
        targetFound: true,
        targetCaptureAttempts: resolved.attempts.length,
        stateTargetMeta,
        stateTargetResolved: {
          found: true,
          strategy: resolved.strategy,
          locator: resolved.selector,
          attempts: [...resolved.attempts],
          recoverable: resolved.resolved?.recoverable,
          confidence: resolved.resolved?.confidence,
        },
        targetFingerprint: {
          before: before || "",
          after: after || "",
        },
        targetStyleDelta: Object.keys(deltas).length ? deltas : undefined,
        nodeSignatures: {
          [`${target.uid}:before`]: before || "",
          [`${target.uid}:after`]: after || "",
        },
        targetProvenance: [...stateProvenance],
        provenanceWarnings: interaction?.warnings || [],
      };
      stateCaptures.push(stateCapture);

      if (stateWarnings.length > routeStateWarningBudget) {
        stateWarnings.push(`state-warning-limit-reached route=${route} state=${state} target=${target.tag}`);
        if (interaction && !interaction.skipped) {
          stateWarnings.push("state_warning_budget_hit");
        }
      }

      if (interaction?.skipped) {
        continue;
      }

      if (!componentStateBuckets[archetype]) componentStateBuckets[archetype] = [];
      componentStateBuckets[archetype].push({
        state,
        styleSignature: stateCapture.styleSignature,
        changedProperties: diff.changed,
        changedPropertiesAdded: diff.added,
        changedPropertiesRemoved: diff.removed,
        propertyDeltas: deltas,
        targetSelector: resolved.selector,
        stateTargetMeta,
        screenshot: shotPath,
        examples: [target.text || target.uid],
        source: {
          route,
          viewport: `${viewport.width}x${viewport.height}`,
          theme,
          screenshot: shotPath,
          selector: resolved.selector,
          locator: resolved.selector,
        },
      });

      if ("restore" in interaction && typeof (interaction as any).restore === "function") {
        await (interaction as any).restore().catch(() => {});
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.move(0, 0).catch(() => {});
    }
  }

  const routeFingerprint = `${defaultRouteFingerprint}|${route}|${viewport.width}x${viewport.height}|${theme}`;
  const routeSignature = `${route}|${theme}|${viewport.width}x${viewport.height}|${defaultRouteFingerprint.slice(0, 24)}`;

  const screenshotBuffer = await readFileBuffer(defaultShot).catch(() => Buffer.from(""));
  const screenshotHash = createHash("sha256").update(screenshotBuffer).digest("hex");
  const title = await page.title().catch(() => "");

  const componentInventory = Object.values(
    buildComponentRecipeWithState(componentByArchetype, componentStateBuckets, cleaningContext, cleaningReport),
  );

  return {
    route,
    theme,
    viewport,
    captureId: captureNamePrefix,
    title,
    routeDepth,
    fullPageScreenshot: defaultShot,
    sampledNodes: samples.length,
    stateCaptures,
    componentInventory,
    layoutFingerprint: defaultRouteFingerprint,
    routeFingerprint,
    routeSignature,
    width: viewport.width,
    height: viewport.height,
    screenshotHash,
    capturedAt: new Date().toISOString(),
    nodeSamples: samples,
    interactionBudgetUsed: effectiveStateCaptureBudget,
    stateCaptureBudget: effectiveStateCaptureBudget,
    stateCaptureCount: stateCaptures.length,
    stateWarnings: stateWarnings.length ? stateWarnings : undefined,
  };
}

export function aggregateCoreTokens(
  pages: RouteViewportCapture[],
  cleaningContext: CleaningProfileCtx = createCleaningProfileContext(DEFAULT_CLEANING_PROFILE),
  cleaningReport?: CleaningProfileReport,
): DesignTokenBucket {
  const profile = cleaningContext.profile;
  const report = cleaningReport ?? defaultCleaningReport(profile);

  const colorMap = new Map<string, { count: number; provenance: string[]; sourceValues: string[] }>();
  const spacingObservations: NumericObservation[] = [];
  const radiusObservations: NumericObservation[] = [];
  const shadows = new Map<string, { count: number; provenance: string[] }>();
  const fontSizeObservations: NumericObservation[] = [];
  const lineHeights = new Map<string, { count: number; provenance: string[] }>();
  const letterSpacings = new Map<string, { count: number; provenance: string[] }>();
  const fonts = new Map<string, { stack: string; weight: string; count: number; provenance: string[] }>();
  const textStyles = new Map<
    string,
    {
      count: number;
      provenance: string[];
      fontFamily: string;
      fontSize: string;
      lineHeight: string;
      fontWeight: string;
      letterSpacing: string;
      textAlign: string;
      textTransform: string;
    }
  >();

  const normalizeFontToken = (value: string) => {
    const trimmed = normalizeFontFamilyValue(value || "");
    if (!trimmed) return "";
    return trimmed;
  };

  const buildCanonicalColor = (value: string, profile: CleaningProfile, report: CleaningProfileReport) => {
    const raw = toLowerString(value);
    if (!raw) return null;
    const normalized = normalizeColorValue(raw, profile);
    if (!normalized) return null;
    if (normalized !== raw) report.mergedColorCount += 1;
    return normalized;
  };

  const addNumeric = (list: NumericObservation[], rawValue: string, provenance: string) => {
    const px = parseLengthForProfile(rawValue, profile);
    if (px === null || !Number.isFinite(px)) return;
    if (px < 0 || px > 8192) return;
    const rounded = roundLengthForProfile(px, profile);
    if (rounded === null || !Number.isFinite(rounded)) return;
    list.push({ value: rounded, provenance });
  };

  const finalizeNumericBucket = (input: NumericObservation[], fallbackLimit: number) => {
    const trimmed = profile === "minimal" ? { kept: input, removed: 0 } : outlierTrimmed(input, cleaningContext.outlierIqr);
    if (profile !== "minimal") report.spacingOutliersRemoved += trimmed.removed;

    const grouped = new Map<number, { count: number; provenance: string[] }>();
    for (const entry of trimmed.kept) {
      const normalized = roundLengthForProfile(entry.value, profile);
      if (normalized === null || !Number.isFinite(normalized)) continue;
      const bucket = grouped.get(normalized) ?? { count: 0, provenance: [] };
      bucket.count += 1;
      if (bucket.provenance.length < 20) bucket.provenance.push(entry.provenance);
      grouped.set(normalized, bucket);
    }

    return [...grouped.entries()]
      .filter(([, item]) => item.count >= cleaningContext.numericMinCount)
      .sort((a, b) => a[0] - b[0])
      .filter(([value]) => value >= 0 && value <= fallbackLimit);
  };

  for (const page of pages) {
    const provenanceBase = `${page.route} (${page.viewport.name})`;
    for (const sample of page.nodeSamples) {
      const style = sample.styles;

      for (const source of [style.color, style.backgroundColor, style.borderColor, style.outlineColor]) {
        const color = buildCanonicalColor(source, profile, report);
        if (!color) continue;
        const entry = colorMap.get(color) ?? { count: 0, provenance: [], sourceValues: [] };
        entry.count += 1;
        if (entry.provenance.length < 20) entry.provenance.push(provenanceBase);
        entry.sourceValues.push(source || "");
        colorMap.set(color, entry);
      }

      const canonicalFontSize = parseLengthForProfile(style.fontSize, profile);
      const canonicalLineHeight = normalizePxNumericOnly(style.lineHeight);
      const family = normalizeFontToken(style.fontFamily || "");
      const weight = toLowerString(style.fontWeight) || "400";

      if (style.fontSize) addNumeric(fontSizeObservations, style.fontSize, provenanceBase);

      [
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
        style.marginTop,
        style.marginRight,
        style.marginBottom,
        style.marginLeft,
        style.gap,
      ].forEach((token) => addNumeric(spacingObservations, token, provenanceBase));

      if (style.borderRadius) {
        const canonicalRadius = normalizeRadiusValue(style.borderRadius, profile);
        if (canonicalRadius) {
          const radiusTokens = canonicalRadius
            .split(/\s+/)
            .map((entry) => parseLengthForProfile(entry, profile))
            .filter((radius): radius is number => radius !== null && Number.isFinite(radius) && radius >= 0);
          for (const radius of radiusTokens) {
            const roundedRadius = roundLengthForProfile(radius, profile);
            if (roundedRadius === null) continue;
            radiusObservations.push({ value: roundedRadius, provenance: provenanceBase });
          }
        }
      }

      if (style.boxShadow && style.boxShadow !== "none") {
        const canonicalShadow = normalizeShadowValue(style.boxShadow, profile);
        if (canonicalShadow) {
          const item = shadows.get(canonicalShadow) ?? { count: 0, provenance: [] };
          item.count += 1;
          if (item.provenance.length < 20) item.provenance.push(provenanceBase);
          shadows.set(canonicalShadow, item);
        }
      }

      if (style.lineHeight) {
        const normalizedLineHeight = normalizePxOrRawLength(style.lineHeight);
        const entry = lineHeights.get(normalizedLineHeight) ?? { count: 0, provenance: [] };
        entry.count += 1;
        if (entry.provenance.length < 20) entry.provenance.push(provenanceBase);
        lineHeights.set(normalizedLineHeight, entry);
      }

      if (style.letterSpacing) {
        const normalizedLetterSpacing = normalizePxOrRawLength(style.letterSpacing);
        const entry = letterSpacings.get(normalizedLetterSpacing) ?? { count: 0, provenance: [] };
        entry.count += 1;
        if (entry.provenance.length < 20) entry.provenance.push(provenanceBase);
        letterSpacings.set(normalizedLetterSpacing, entry);
      }

      if (family || canonicalLineHeight !== null || canonicalFontSize !== null || weight || style.letterSpacing) {
        const key = `${family}|${canonicalFontSize !== null ? `${canonicalFontSize}px` : style.fontSize}|${style.lineHeight}|${weight}|${style.letterSpacing}`;
        const item =
          textStyles.get(key) ??
          {
            count: 0,
            provenance: [],
            fontFamily: family,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontWeight: weight,
            letterSpacing: style.letterSpacing,
            textAlign: style.textAlign || "",
            textTransform: style.textTransform || "",
          };
        item.count += 1;
        if (item.provenance.length < 20) item.provenance.push(provenanceBase);
        textStyles.set(key, item);
      }

      if (family) {
        const existingFont = fonts.get(family) ?? { stack: family, weight, count: 0, provenance: [] };
        existingFont.count += 1;
        if (existingFont.provenance.length < 20) existingFont.provenance.push(provenanceBase);
        fonts.set(family, existingFont);
      }
    }
  }

  const spacingBuckets = finalizeNumericBucket(spacingObservations, 768);
  const fontSizeBuckets = finalizeNumericBucket(fontSizeObservations, 1024);
  const radiusBuckets = finalizeNumericBucket(radiusObservations, 400);

  const uniqueColors = [...colorMap.entries()]
    .map(([value, data]) => ({
      name: `color-${value.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/-$/g, "")}`,
      value,
      count: data.count,
      provenance: data.provenance,
    }))
    .sort((a, b) => b.count - a.count);

  const colors = uniqueColors.slice(0, 160).map((entry) => ({
    name: entry.name,
    value: entry.value,
    count: entry.count,
    provenance: entry.provenance,
  }));

  const roundedRadiusRemainder = new Map<string, { count: number; provenance: string[] }>();
  for (const [px, data] of radiusBuckets) {
    const rounded = toCanonicalLengthToken(px, profile);
    if (!rounded) continue;
    const bucket = roundedRadiusRemainder.get(rounded) ?? { count: 0, provenance: [] };
    bucket.count += data.count;
    if (bucket.provenance.length < 20) bucket.provenance.push(...data.provenance);
    roundedRadiusRemainder.set(rounded, bucket);
  }

  return {
    colors,
    spacing: spacingBuckets.map(([value]) => value).filter((value) => value >= 0),
    radii: [...roundedRadiusRemainder.keys()].sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
    shadows: [...shadows.entries()]
      .map(([value, item]) => ({
        name: `shadow-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`,
        value,
        count: item.count,
        provenance: item.provenance,
      }))
      .sort((a, b) => b.count - a.count),
    fontSizes: fontSizeBuckets.map(([px, item]) => ({
      name: `${px}px`,
      px,
      rem: `${Math.round((px / 16) * 10 ** Math.min(3, cleaningContext.sizeValueDigits)) / 10 ** Math.min(3, cleaningContext.sizeValueDigits)}rem`,
      count: item.count,
      provenance: item.provenance,
    })),
    lineHeights: [...lineHeights.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([value, item]) => ({
        name: `lh-${value.replace(/[^a-z0-9]/gi, "-")}`,
        value,
        count: item.count,
      })),
    letterSpacings: [...letterSpacings.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([value, item]) => ({
        name: `ls-${value.replace(/[^a-z0-9]/gi, "-")}`,
        value,
        count: item.count,
      })),
    fontFamilies: [...fonts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, item]) => ({
        name: name.split(",")[0]?.replace(/["']/g, "").trim() || "font",
        stack: item.stack,
        weight: item.weight,
        count: item.count,
        provenance: item.provenance,
      })),
    textStyles: [...textStyles.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([, item]) => ({
        name: `${item.fontWeight || "regular"}/${item.fontSize || "base"}`,
        fontFamily: item.fontFamily,
        fontSize: item.fontSize,
        lineHeight: item.lineHeight,
        fontWeight: item.fontWeight,
        letterSpacing: item.letterSpacing,
        textAlign: item.textAlign || undefined,
        textTransform: item.textTransform || undefined,
        count: item.count,
      })),
  };
}

function aggregateSemanticTokens(tokens: DesignTokenBucket): SemanticTokenBucket {
  const pickNth = (index: number) => tokens.colors[index]?.value || null;
  const byName = (term: string) => {
    const found = tokens.colors.find((token) => token.name.includes(term) || token.value.includes(term));
    return found?.value || null;
  };

  return {
    text: {
      primary: pickNth(0) || byName("gray") || null,
      secondary: pickNth(1) || byName("text") || pickNth(0),
      muted: pickNth(2) || byName("muted") || pickNth(1),
      inverse: byName("white") || pickNth(0),
    },
    surface: {
      page: byName("white") || pickNth(0),
      card: byName("surface") || byName("white") || pickNth(1),
      header: byName("header") || byName("gray") || pickNth(1),
      sidebar: byName("sidebar") || byName("gray") || pickNth(1),
    },
    action: {
      primaryBg: byName("blue") || byName("primary") || pickNth(0),
      primaryFg: byName("white") || pickNth(3),
      secondaryBg: byName("gray") || byName("secondary") || pickNth(1),
      secondaryFg: byName("white") || pickNth(0),
      disabledBg: pickNth(6),
      disabledFg: byName("muted"),
    },
    border: {
      default: byName("border") || pickNth(2),
      focus: byName("focus") || byName("blue") || pickNth(0),
    },
    focus: {
      ring: byName("focus") || byName("blue") || pickNth(0),
      ringOffset: byName("white") || pickNth(0),
    },
  };
}

export function toComponentInventory(
  pages: RouteViewportCapture[],
  cleaningContext: CleaningProfileCtx = createCleaningProfileContext(DEFAULT_CLEANING_PROFILE),
  cleaningReport?: CleaningProfileReport,
): Record<string, ComponentRecipe> {
  const profileContext = cleaningContext;
  const merged: Record<string, ComponentRecipe> = {};
  const maxStates = profileContext.maxComponentStates;
  const maxExamples = profileContext.maxComponentExamples;

  for (const page of pages) {
    for (const recipe of page.componentInventory) {
      const canonicalStates = new Map<string, ComponentVariantState>();
      const sizeScaleKey = (entry: ComponentRecipe["sizeScale"][number]) => `${entry.variant}|${entry.minHeight}|${entry.horizontalPadding}|${entry.verticalPadding}`;

      const canonicalSizeScale = recipe.sizeScale
        .map((entry) => ({
          ...entry,
          minHeight: entry.minHeight
            ? toCanonicalLengthToken(parseLengthForProfile(entry.minHeight, profileContext.profile) ?? NaN, profileContext.profile)
            : null,
          horizontalPadding: entry.horizontalPadding
            ? toCanonicalLengthToken(parseLengthForProfile(entry.horizontalPadding, profileContext.profile) ?? NaN, profileContext.profile)
            : null,
          verticalPadding: entry.verticalPadding
            ? toCanonicalLengthToken(parseLengthForProfile(entry.verticalPadding, profileContext.profile) ?? NaN, profileContext.profile)
            : null,
        }))
        .filter((entry) => !entry.minHeight || !Number.isNaN(Number.parseFloat(entry.minHeight)))
        .filter((entry, index, all) => all.findIndex((item) => sizeScaleKey(item) === sizeScaleKey(entry)) === index)
        .sort((a, b) => {
          const order = ["sm", "md", "lg", "xl"];
          const ai = order.indexOf(a.variant);
          const bi = order.indexOf(b.variant);
          return ai - bi;
        })
        .slice(0, maxStates);

      const canonicalExamples = [...new Set(recipe.examples)].slice(0, maxExamples);
      const current = merged[recipe.archetype];
      if (!current) {
        merged[recipe.archetype] = {
          ...recipe,
          sizeScale: canonicalSizeScale,
          examples: canonicalExamples,
          states: [...recipe.states],
        };
        continue;
      }

      for (const state of current.states) {
        canonicalStates.set(stateKeyFromVariant(state), state);
      }
      for (const state of recipe.states) {
        const key = stateKeyFromVariant(state);
        const existing = canonicalStates.get(key);
        if (!existing) {
          canonicalStates.set(key, { ...state, examples: [...new Set(state.examples || [])].slice(0, maxExamples) });
          continue;
        }

        existing.changedProperties = [...new Set([...(existing.changedProperties || []), ...(state.changedProperties || [])])].sort();
        existing.changedPropertiesAdded = [...new Set([...(existing.changedPropertiesAdded || []), ...(state.changedPropertiesAdded || [])])].sort();
        existing.changedPropertiesRemoved = [...new Set([...(existing.changedPropertiesRemoved || []), ...(state.changedPropertiesRemoved || [])])].sort();
        existing.examples = [...new Set([...(existing.examples || []), ...(state.examples || [])])].slice(0, maxExamples);
        existing.provenance = [...new Set([...(existing.provenance || []), ...(state.provenance || [])])];
        existing.propertyDeltas = { ...(existing.propertyDeltas || {}), ...(state.propertyDeltas || {}) };
        if (cleaningReport) cleaningReport.stateRecordsDropped += 1;
      }

      const mergedStates = [...canonicalStates.values()].sort((a, b) => {
        if (a.state === b.state) return a.styleSignature.localeCompare(b.styleSignature);
        if (a.state === "default") return -1;
        if (b.state === "default") return 1;
        return a.state.localeCompare(b.state);
      });
      const limit = Math.max(1, maxStates);
      const keptStates = [
        ...mergedStates.filter((entry) => entry.state === "default"),
        ...mergedStates.filter((entry) => entry.state !== "default").slice(0, Math.max(0, limit - 1)),
      ].slice(0, limit);

      current.states = keptStates;
      current.count += recipe.count;
      current.examples = [...new Set([...current.examples, ...canonicalExamples])].slice(0, maxExamples);
      current.sizeScale = [...current.sizeScale, ...canonicalSizeScale]
        .filter((entry, index, all) => all.findIndex((item) => sizeScaleKey(item) === sizeScaleKey(entry)) === index)
        .sort((a, b) => {
          const order = ["sm", "md", "lg", "xl"];
          const ai = order.indexOf(a.variant);
          const bi = order.indexOf(b.variant);
          return ai - bi;
        })
        .slice(0, maxStates);

      current.provenance = [...new Set([...current.provenance, ...recipe.provenance])];
      current.commonStyles = {
        display: current.commonStyles.display || recipe.commonStyles.display || null,
        borderRadius: current.commonStyles.borderRadius || recipe.commonStyles.borderRadius || null,
        fontFamily: current.commonStyles.fontFamily || recipe.commonStyles.fontFamily || null,
        fontSize: current.commonStyles.fontSize || recipe.commonStyles.fontSize || null,
        transition: current.commonStyles.transition || recipe.commonStyles.transition || null,
      };
    }
  }

  return merged;
}

function detectBreakpoints(viewports: ViewportSpec[]): BreakpointToken[] {
  const seen = new Map<number, BreakpointToken>();
  const sorted = [...viewports].sort((a, b) => a.width - b.width);
  for (const viewport of sorted) {
    if (!seen.has(viewport.width)) {
      const name = viewport.width <= 640 ? "sm" : viewport.width <= 768 ? "md" : viewport.width <= 1024 ? "lg" : viewport.width <= 1440 ? "xl" : "2xl";
      seen.set(viewport.width, { name, width: viewport.width, source: "observed" });
    }
  }
  return [...seen.values()];
}

async function discoverSameOriginLinks(page: Page, sourceUrl: string, routeDepth: number, maxDepth: number): Promise<string[]> {
  if (routeDepth >= maxDepth) return [];
  const origin = new URL(sourceUrl).origin;
  const current = new URL(sourceUrl);
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href"))
      .filter((href): href is string => Boolean(href))
      .map((href) => href!.trim())
      .filter((href) => href.length < 380);
  });
  const out: string[] = [];
  for (const href of hrefs) {
    try {
      const resolved = new URL(href, current);
      if (resolved.origin !== origin) continue;
      if (resolved.pathname.endsWith(".png") || resolved.pathname.endsWith(".jpg") || resolved.pathname.endsWith(".jpeg") || resolved.pathname.endsWith(".webp")) continue;
      out.push(cleanUrl(resolved.toString()));
    } catch {
      continue;
    }
  }
  return [...new Set(out)];
}

export async function crawlAndCapture(input: ExtractDesignSystemInput): Promise<UiSnapshotManifest> {
  const sourceUrl = cleanUrl(input.url);
  const source = new URL(sourceUrl);
  const sameOriginPages = Math.max(1, Math.min(25, input.sameOriginPages ?? 4));
  const routeDepth = Math.max(1, input.routeDepth ?? 2);
  const interactionBudget = Math.max(1, input.interactionBudget ?? 4);
  const stateBudget = Math.max(1, input.stateBudget ?? 2);
  const maxSamplesPerViewport = Math.max(120, input.maxSamplesPerViewport ?? 420);
  const sampleStride = Math.max(1, input.sampleStride ?? 2);
  const themes: ThemeMode[] = input.themes?.length ? input.themes : ["light", "dark"];
  const viewports: ViewportSpec[] = input.viewports?.length ? input.viewports : DEFAULT_VIEWPORTS;
  const waitConfig: Required<WaitConfig> = { ...DEFAULT_WAIT, ...input.waitConfig };
  const cleaningProfile: CleaningProfile = input.cleaningProfile ?? DEFAULT_CLEANING_PROFILE;
  const cleaningContext = createCleaningProfileContext(cleaningProfile);
  const cleaningReport = defaultCleaningReport(cleaningProfile);
  const exactnessMode: ThemeExactnessMode = input.exactnessMode ?? "observed-only";
  const iconCaptureProfile: IconCaptureProfile = input.iconCaptureProfile ?? DEFAULT_ICON_CAPTURE_PROFILE;

  const snapshotId = randomUUID();
  await ensureSnapshot(snapshotId);

  const queue: Array<{ route: string; depth: number }> = [{ route: sourceUrl, depth: 0 }];
  const visited = new Set<string>([sourceUrl]);
  const captures: RouteViewportCapture[] = [];
  const iconAccumulator = createIconHarvestState();
  const iconEvidence: CollectedIconAsset[] = [];
  const seenFingerprints = new Set<string>();
  const routeSummary: RouteCrawlSummary = {
    rendered: 0,
    skippedDuplicate: 0,
    skippedByBudget: 0,
    unstableSettling: 0,
    renderedByStatus: {
      default: 0,
      skipped: 0,
      failed: 0,
      unstable: 0,
    },
    renderedByTheme: {
      light: 0,
      dark: 0,
      auto: 0,
    },
    renderedByViewport: {},
    filteredByDuplicateSignature: 0,
    warnings: [],
  };

  const browser = await chromium.launch({ headless: true });
  try {
    while (queue.length > 0 && visited.size < sameOriginPages) {
      const item = queue.shift();
      if (!item) break;
      const { route, depth } = item;
      const routeBase = route.replace(/\/$/, "");

      for (const theme of themes) {
        for (const viewport of viewports) {
          const context = await browser.newContext({
            viewport: {
              width: viewport.width,
              height: viewport.height,
            },
            deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
            userAgent:
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            colorScheme: theme === "dark" ? "dark" : "light",
            locale: "en-US",
            storageState: input.authStatePath || undefined,
          });
          const page = await context.newPage();

          try {
            const routeStartTs = Date.now();
            await page.goto(route, { timeout: 90_000, waitUntil: "domcontentloaded" }).catch(async () => {
              await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
            });

            const capture = await makeRouteCapture(
              snapshotId,
              page,
              routeBase,
              theme,
              viewport,
              depth,
              maxSamplesPerViewport,
              sampleStride,
              interactionBudget,
              stateBudget,
              waitConfig,
              cleaningContext,
              cleaningReport,
            );

            if (seenFingerprints.has(capture.routeFingerprint || `${capture.layoutFingerprint}-${route}-${viewport.width}x${viewport.height}-${theme}`)) {
              routeSummary.skippedDuplicate += 1;
              routeSummary.filteredByDuplicateSignature = (routeSummary.filteredByDuplicateSignature ?? 0) + 1;
              routeSummary.renderedByStatus!.skipped += 1;
              routeSummary.warnings?.push(`duplicate-fingerprint route=${route} theme=${theme} viewport=${viewport.name}`);
              continue;
            }

            seenFingerprints.add(capture.routeFingerprint || `${capture.layoutFingerprint}-${route}-${viewport.width}x${viewport.height}-${theme}`);
            captures.push(capture);
            routeSummary.rendered += 1;
            routeSummary.renderedByTheme![theme] = (routeSummary.renderedByTheme![theme] || 0) + 1;
            const viewportKey = `${viewport.width}x${viewport.height}`;
            routeSummary.renderedByViewport![viewportKey] = (routeSummary.renderedByViewport![viewportKey] || 0) + 1;
            routeSummary.renderedByStatus!.default += 1;
            if (capture.stateWarnings?.length) {
              routeSummary.unstableSettling += 1;
              routeSummary.renderedByStatus!.unstable += 1;
              routeSummary.warnings?.push(`unstable route=${route} theme=${theme} viewport=${viewport.name}`);
            }

            const captureMs = Date.now() - routeStartTs;
            if (captureMs > DEFAULT_WAIT.networkQuietMs * 3 + DEFAULT_WAIT.settleMs + 200) {
              routeSummary.warnings?.push(`long_capture_ms route=${route} theme=${theme} viewport=${viewport.name} ms=${captureMs}`);
            }

            const capturedIcons = await harvestIconsForRoute(snapshotId, page, routeBase, iconCaptureProfile, iconAccumulator);
            iconEvidence.push(...capturedIcons);

            if (depth < routeDepth) {
              const discovered = await discoverSameOriginLinks(page, routeBase, depth, routeDepth);
              for (const href of discovered) {
                if (visited.size >= sameOriginPages) {
                  routeSummary.skippedByBudget += 1;
                  routeSummary.filteredByRouteBudget = (routeSummary.filteredByRouteBudget || 0) + 1;
                  break;
                }
                if (!visited.has(href)) {
                  visited.add(href);
                  queue.push({ route: href, depth: depth + 1 });
                }
              }
            }
          } catch (error) {
            routeSummary.renderedByStatus!.failed += 1;
            routeSummary.warnings?.push(`capture-failed route=${route} theme=${theme} viewport=${viewport.name}`);
            routeSummary.warnings?.push(`capture-failed route=${route} theme=${theme} viewport=${viewport.name} ${String(error)}`);
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const core = aggregateCoreTokens(captures, cleaningContext, cleaningReport);
  const semantic = aggregateSemanticTokens(core);
  const components = toComponentInventory(captures, cleaningContext, cleaningReport);
  const createdAt = new Date().toISOString();
  await writeJsonFile(snapshotId, "assets/icons/index.json", {
    snapshotId,
    sourceUrl: source.toString(),
    generatedAt: createdAt,
    iconCaptureProfile,
    cleaningProfile,
    total: iconEvidence.length,
    summary: iconAccumulator.stats,
    icons: iconEvidence,
  });

  return {
    manifestVersion: "1.2.0",
    snapshotId,
    sourceUrl: source.toString(),
    createdAt,
    captureConfig: {
      sameOriginPages,
      routeDepth,
      cleaningProfile,
      iconCaptureProfile,
      themes,
      viewports,
      interactionBudget,
      stateBudget,
      maxSamplesPerViewport,
      sampleStride,
      waitConfig,
      exactnessMode,
    },
    evidence: {
      pages: captures,
      screenshotsDir: "evidence/screenshots",
      assets: [],
      icons: iconEvidence,
    },
    tokens: {
      core,
      semantic,
      breakpoints: detectBreakpoints(viewports),
    },
    components: {
      inventory: components,
    },
    provenance: {
      pagesRendered: captures.length,
      nodesCaptured: captures.reduce((count, page) => count + page.sampledNodes, 0),
      screenshotsCaptured: captures.reduce((count, page) => count + page.stateCaptures.length, 0),
      routeCount: new Set(captures.map((capture) => capture.route)).size,
      stateCount: captures.reduce((count, page) => count + page.stateCaptures.length, 0),
      warning: [],
      cleaning: cleaningReport,
      iconHarvest: iconAccumulator.stats,
      routeSummary,
    },
    validation: {
      status: "unknown",
      overallScore: 0,
      summary: {
        routeCount: 0,
        viewportCount: 0,
        stateCount: 0,
        maxDiffPercent: 0,
      },
      checks: [],
      warnings: ["Not validated yet. Run validate_visual_match to populate coverage diff report."],
    },
    exactness: {
      mode: exactnessMode,
      note: "Computed styles, geometry, and screenshots are only for observed routes/views/states under this crawl config.",
    },
  };
}

export const extractDesignSystem = crawlAndCapture;
