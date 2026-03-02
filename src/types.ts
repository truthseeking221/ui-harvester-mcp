export type ThemeMode = "light" | "dark" | "auto";

export type CleaningProfile = "high" | "balanced" | "minimal";

export type IconCaptureProfile = "all" | "selected" | "favicon-only";

export type IconCaptureStatus = "captured" | "skipped" | "failed";

export type ThemeExactnessMode = "observed-only" | "observed-with-warned-fallback";

export type ViewportSpec = {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
};

export type InteractionState =
  | "default"
  | "hover"
  | "focus"
  | "active"
  | "checked"
  | "selected"
  | "disabled"
  | "open"
  | "loading"
  | "error";

export type WaitConfig = {
  networkQuietMs?: number;
  mutationStabilityFrames?: number;
  fontWaitMs?: number;
  settleMs?: number;
};

export type ExtractDesignSystemInput = {
  url: string;
  cleaningProfile?: CleaningProfile;
  iconCaptureProfile?: IconCaptureProfile;
  themes?: ThemeMode[];
  viewports?: ViewportSpec[];
  sameOriginPages?: number;
  routeDepth?: number;
  interactionBudget?: number;
  stateBudget?: number;
  maxSamplesPerViewport?: number;
  sampleStride?: number;
  waitConfig?: WaitConfig;
  authStatePath?: string | null;
  exactnessMode?: ThemeExactnessMode;
};

export type SnapshotExportFormat =
  | "css-vars"
  | "tailwind-v4"
  | "dtcg-json"
  | "theme-object"
  | "figma-variables"
  | "figma-styles"
  | "figma-console-plan"
  | "universal-package"
  | "figma-package";

export type SnapshotExportArtifact = {
  path: string;
  description: string;
  mediaType?: string;
};

export type UniversalPackageManifest = {
  schemaVersion: "universal-package/1.2.0";
  snapshotId: string;
  sourceUrl: string;
  generatedAt: string;
  exactnessMode: ThemeExactnessMode;
  note?: string;
  files: SnapshotExportArtifact[];
};

export type SnapshotTargetStack = "next-tailwind" | "vite-tailwind" | "mui" | "chakra" | "styled-components" | "css-modules" | "generic";

export type ExportComponentRecipesInput = {
  snapshotId: string;
  targetStack?: SnapshotTargetStack;
};

export type ApplySnapshotInput = {
  snapshotId: string;
  projectPath: string;
  targetStack?: SnapshotTargetStack;
  createFilesOnly?: boolean;
};

export type ValidateInput = {
  snapshotId: string;
  projectPreviewUrl: string;
  routes?: string[];
  states?: InteractionState[];
  viewports?: string[];
  maxDiffPercent?: number;
};

export type NodeComputedStyle = {
  display: string;
  position: string;
  top: string;
  right: string;
  bottom: string;
  left: string;
  zIndex: string;
  overflow: string;
  boxSizing: string;
  color: string;
  backgroundColor: string;
  borderColor: string;
  borderWidth: string;
  borderStyle: string;
  borderRadius: string;
  boxShadow: string;
  textShadow: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  textTransform: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  gap: string;
  width: string;
  height: string;
  minWidth: string;
  minHeight: string;
  maxWidth: string;
  maxHeight: string;
  opacity: string;
  transition: string;
  animation: string;
  outline: string;
  outlineColor: string;
  outlineWidth: string;
  filter: string;
  backdropFilter: string;
  customProperties: Record<string, string>;
};

export type CssPseudoStyle = {
  content: string;
  color: string;
  backgroundColor: string;
  opacity: string;
};

export type NodeSample = {
  uid: string;
  selector: string;
  tag: string;
  role: string | null;
  typeHint: string;
  text: string | null;
  className: string;
  id: string | null;
  ariaLabel: string | null;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  styles: NodeComputedStyle;
  pseudoBefore?: CssPseudoStyle | null;
  pseudoAfter?: CssPseudoStyle | null;
  styleSignature: string;
  childCount?: number;
};

export type CollectedIconAsset = {
  sourceUrl: string;
  localPath: string;
  fileName: string;
  status: IconCaptureStatus;
  ext: string;
  mime: string | null;
  bytes: number | null;
  retries: number;
  error: string | null;
  fromRoute: string;
  fromContext: "dom-link" | "manifest" | "img" | "css-inline" | "css-stylesheet";
  capturedAt: string;
  sha256: string | null;
  sourcePage?: string;
  width?: number | null;
  height?: number | null;
};

export type IconHarvestReport = {
  attempted: number;
  downloaded: number;
  captured: number;
  skipped: number;
  failed: number;
  dedupedByUrl: number;
  dedupedByHash: number;
  retries: number;
};

export type StateCaptureTargetMeta = {
  selector: string;
  locator: string;
  found: boolean;
  strategy: string;
  attempts: string[];
  id?: string;
  resolved?: {
    found: boolean;
    strategy: string;
    locator: string;
    attempts?: string[];
    recoverable?: boolean;
    confidence?: number;
  };
  route?: string;
  viewport?: string;
  theme?: string;
  state?: InteractionState;
  confidence?: number;
  recoverable?: boolean;
  tag?: string;
  role?: string | null;
  type?: string;
  text?: string;
  ariaLabel?: string | null;
  classTokens?: string[];
  bbox?: { x: number; y: number; width: number; height: number };
};

export type StateCapture = {
  state: InteractionState;
  screenshot: string;
  styleSignature: string;
  stateTarget?: string;
  changedProperties: string[];
  changedPropertiesAdded?: string[];
  changedPropertiesRemoved?: string[];
  stateTargetMeta?: StateCaptureTargetMeta;
  stateTargetResolved?: {
    found: boolean;
    strategy: string;
    locator: string;
    attempts?: string[];
    recoverable?: boolean;
    confidence?: number;
  };
  targetFingerprint?: {
    before: string;
    after: string;
  };
  targetStyleDelta?: Record<string, { before: string; after: string }>;
  nodeSignatures?: Record<string, string>;
  targetProvenance?: string[];
  provenanceWarnings?: string[];
  targetFound?: boolean;
  targetCaptureAttempts?: number;
};

export type RouteViewportCapture = {
  route: string;
  theme: ThemeMode;
  viewport: ViewportSpec;
  captureId: string;
  title: string;
  routeDepth: number;
  fullPageScreenshot: string;
  sampledNodes: number;
  stateCaptures: StateCapture[];
  componentInventory: ComponentRecipe[];
  layoutFingerprint: string;
  width: number;
  height: number;
  screenshotHash: string;
  capturedAt: string;
  nodeSamples: NodeSample[];
  stateCaptureCount?: number;
  stateWarnings?: string[];
  interactionBudgetUsed?: number;
  stateCaptureBudget?: number;
  routeFingerprint?: string;
  routeSignature?: string;
};

export type SnapshotGeneratedArtifact = {
  generatedAt: string;
  files: SnapshotExportArtifact[];
  schemaVersion?: string;
  schema?: string;
  warnings?: string[];
};

export type DesignToken = { name: string; value: string; count: number; provenance: Array<string> };

export type DesignTokenBucket = {
  colors: DesignToken[];
  spacing: number[];
  radii: string[];
  shadows: Array<{ name: string; value: string; count: number; provenance: string[] }>;
  fontSizes: Array<{ name: string; px: number; rem: string; count: number; provenance: string[] }>;
  lineHeights: Array<{ name: string; value: string; count: number }>;
  letterSpacings: Array<{ name: string; value: string; count: number }>;
  fontFamilies: Array<{ name: string; stack: string; weight: string; count: number; provenance: string[] }>;
  textStyles: Array<{
    name: string;
    fontFamily: string;
    fontSize: string;
    lineHeight: string;
    fontWeight: string;
    letterSpacing: string;
    textAlign?: string;
    textTransform?: string;
    count: number;
    provenance?: string[];
  }>;
};

export type SemanticTokenBucket = {
  text: {
    primary: string | null;
    secondary: string | null;
    muted: string | null;
    inverse: string | null;
  };
  surface: {
    page: string | null;
    card: string | null;
    header: string | null;
    sidebar: string | null;
  };
  action: {
    primaryBg: string | null;
    primaryFg: string | null;
    secondaryBg: string | null;
    secondaryFg: string | null;
    disabledBg: string | null;
    disabledFg: string | null;
  };
  border: {
    default: string | null;
    focus: string | null;
  };
  focus: {
    ring: string | null;
    ringOffset: string | null;
  };
};

export type BreakpointToken = {
  name: string;
  width: number;
  source: "observed" | "interpolated";
};

export type ComponentVariantState = {
  state: InteractionState;
  styleSignature: string;
  changedProperties?: string[];
  changedPropertiesAdded?: string[];
  changedPropertiesRemoved?: string[];
  propertyDeltas?: Record<string, { before: string; after: string }>;
  examples?: string[];
  provenance?: string[];
  source?: {
    route: string;
    viewport?: string;
    theme?: ThemeMode;
    screenshot?: string;
    selector?: string;
    locator?: string;
  };
};

export type ComponentRecipe = {
  name: string;
  archetype: string;
  count: number;
  examples: string[];
  sizeScale: Array<{
    variant: string;
    minHeight: string | null;
    horizontalPadding: string | null;
    verticalPadding: string | null;
  }>;
  states: ComponentVariantState[];
  commonStyles: {
    display: string | null;
    borderRadius: string | null;
    fontFamily: string | null;
    fontSize: string | null;
    transition: string | null;
  };
  provenance: string[];
};

export type ValidationItem = {
  route: string;
  viewport: string;
  state: string;
  routeFound?: boolean;
  diffPercent: number;
  sourceScreenshot: string;
  targetScreenshot: string;
  diffScreenshot: string | null;
  matched: boolean;
  failureReason?:
    | "missing_source_screenshot"
    | "target_interaction_not_reproducible"
    | "viewport_drift"
    | "route_not_crawled_in_state"
    | "state_capture_missing"
    | "state_capture_fallback"
    | "selector_not_reproducible"
    | "missing_target_screenshot";
  error?: string;
  sourceViewport?: string;
  targetViewport?: string;
  sourceState?: string;
  targetState?: string;
};

export type ValidationReport = {
  status: "unknown" | "ok" | "needs_fix";
  overallScore: number;
  summary: {
    routeCount: number;
    viewportCount: number;
    stateCount: number;
    maxDiffPercent: number;
  };
  checks: ValidationItem[];
  warnings: string[];
};

export type RouteCrawlSummary = {
  rendered: number;
  skippedDuplicate: number;
  skippedByBudget: number;
  unstableSettling: number;
  renderedByStatus?: {
    default: number;
    skipped: number;
    failed: number;
    unstable: number;
  };
  renderedByTheme?: Record<ThemeMode, number>;
  renderedByViewport?: Record<string, number>;
  skippedByRenderFailure?: number;
  filteredByPolicy?: number;
  filteredByDuplicateSignature?: number;
  filteredByRouteBudget?: number;
  warnings?: string[];
  filteredByThemeMismatch?: number;
};

export type CleaningProfileReport = {
  profile: CleaningProfile;
  samplesSeen: number;
  samplesKept: number;
  samplesDropped: number;
  mergedColorCount: number;
  spacingOutliersRemoved: number;
  stateRecordsDropped: number;
};

export type UiSnapshotManifest = {
  manifestVersion: "1.2.0";
  schemaVersion?: "1.2.0";
  snapshotId: string;
  sourceUrl: string;
  createdAt: string;
  captureConfig: {
    sameOriginPages: number;
    routeDepth: number;
    themes: ThemeMode[];
    viewports: ViewportSpec[];
    cleaningProfile?: CleaningProfile;
    iconCaptureProfile?: IconCaptureProfile;
    interactionBudget: number;
    stateBudget: number;
    maxSamplesPerViewport: number;
    sampleStride: number;
    waitConfig: Required<WaitConfig>;
    exactnessMode: ThemeExactnessMode;
  };
  evidence: {
    pages: RouteViewportCapture[];
    screenshotsDir: string;
    assets: string[];
    icons?: CollectedIconAsset[];
  };
  tokens: {
    core: DesignTokenBucket;
    semantic: SemanticTokenBucket;
    breakpoints: BreakpointToken[];
  };
  components: {
    inventory: Record<string, ComponentRecipe>;
  };
  generatedArtifacts?: Record<string, SnapshotGeneratedArtifact>;
  provenance: {
    pagesRendered: number;
    nodesCaptured: number;
    screenshotsCaptured: number;
    routeCount: number;
    stateCount: number;
    warning?: string[];
    warnings?: string[];
    cleaning?: CleaningProfileReport;
    routeSummary?: RouteCrawlSummary;
    iconHarvest?: IconHarvestReport;
  };
  validation: ValidationReport;
  exactness: {
    mode: ThemeExactnessMode;
    note: string;
  };
};

export type SnapshotListItem = {
  snapshotId: string;
  sourceUrl: string;
  createdAt: string;
  routeCount: number;
  screenshotCount: number;
};
