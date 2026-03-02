import {
  SnapshotExportFormat,
  SnapshotTargetStack,
  UniversalPackageManifest,
  UiSnapshotManifest,
} from "./types.js";

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function stringifyFont(value: string) {
  if (!value) return "system-ui";
  return value.split(",").map((item) => item.trim()).join(", ");
}

function textStyleToTheme(token?: {
  fontFamily?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight?: string;
  letterSpacing?: string;
}) {
  return {
    fontFamily: token?.fontFamily || "Inter, Arial, sans-serif",
    fontSize: token?.fontSize || "1rem",
    lineHeight: token?.lineHeight || "normal",
    fontWeight: token?.fontWeight || "400",
    letterSpacing: token?.letterSpacing || "normal",
  };
}

function snapshotPathSafe(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "token";
}

export function exportDesignTokens(snapshot: UiSnapshotManifest, format: SnapshotExportFormat): string {
  if (format === "css-vars") return exportCssVariables(snapshot);
  if (format === "tailwind-v4") return exportTailwindV4Theme(snapshot);
  if (format === "theme-object") return exportThemeObject(snapshot);
  if (format === "figma-variables") return exportFigmaVariables(snapshot);
  if (format === "figma-styles") return exportFigmaStyles(snapshot);
  if (format === "figma-console-plan") return exportFigmaConsolePlan(snapshot);
  if (format === "figma-package") return exportFigmaPackageBlueprint(snapshot);
  if (format === "universal-package") return exportUniversalPackageDescriptor(snapshot);
  return exportDtcgJson(snapshot);
}

export function exportCssVariables(snapshot: UiSnapshotManifest): string {
  const lines: string[] = [];
  lines.push(":root {");

  for (const token of snapshot.tokens.core.colors.slice(0, 180)) {
    lines.push(`  --ui-${token.name}: ${token.value};`);
  }
  lines.push("  --text-primary: " + (snapshot.tokens.semantic.text.primary || "#111827") + ";");
  lines.push("  --text-secondary: " + (snapshot.tokens.semantic.text.secondary || "#6b7280") + ";");
  lines.push("  --text-muted: " + (snapshot.tokens.semantic.text.muted || "#9ca3af") + ";");
  lines.push("  --surface-page: " + (snapshot.tokens.semantic.surface.page || "#ffffff") + ";");
  lines.push("  --surface-card: " + (snapshot.tokens.semantic.surface.card || "#f9fafb") + ";");

  snapshot.tokens.core.spacing.slice(0, 80).forEach((value, index) => {
    const key = index === 0 ? "0" : String(index + 1);
    lines.push(`  --spacing-${key}: ${value}px;`);
  });

  snapshot.tokens.core.radii.slice(0, 24).forEach((radius, index) => {
    const key = index === 0 ? "none" : index === 1 ? "sm" : index === 2 ? "md" : index === 3 ? "lg" : `${index}`;
    lines.push(`  --radius-${key}: ${radius};`);
  });

  snapshot.tokens.core.shadows.slice(0, 20).forEach((shadow, index) => {
    const key = index === 0 ? "sm" : index === 1 ? "md" : index === 2 ? "lg" : `x${index}`;
    lines.push(`  --shadow-${key}: ${shadow.value};`);
  });

  snapshot.tokens.core.fontSizes.slice(0, 20).forEach((font, idx) => {
    const key = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"][idx] ?? `size-${idx}`;
    lines.push(`  --text-${key}: ${font.rem};`);
  });

  snapshot.tokens.core.fontFamilies.forEach((font) => {
    lines.push(`  --font-${slug(font.name)}: ${JSON.stringify(stringifyFont(font.stack))};`);
    lines.push(`  --font-weight-${slug(font.name)}: ${font.weight || "400"};`);
  });

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function exportTailwindV4Theme(snapshot: UiSnapshotManifest): string {
  const out: string[] = ["@import 'tailwindcss';", "", "@theme {"];

  snapshot.tokens.core.colors.forEach((token) => {
    out.push(`  --color-${token.name}: ${token.value};`);
  });

  snapshot.tokens.core.fontSizes.slice(0, 16).forEach((fontSize, idx) => {
    const key = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"][idx] ?? `size-${idx}`;
    out.push(`  --text-${key}: ${fontSize.rem};`);
  });

  snapshot.tokens.core.fontFamilies.forEach((font) => {
    const alias = slug(font.name) || "sans";
    out.push(`  --font-${alias}: ${JSON.stringify(stringifyFont(font.stack))};`);
    out.push(`  --font-weight-${alias}: ${font.weight || "400"};`);
  });

  snapshot.tokens.core.spacing.slice(0, 64).forEach((value, idx) => {
    const key = idx === 0 ? "0" : idx === 1 ? "1" : String(idx + 1);
    out.push(`  --spacing-${key}: ${value}px;`);
  });

  snapshot.tokens.core.radii.slice(0, 12).forEach((radius, idx) => {
    const key = idx === 0 ? "none" : idx === 1 ? "sm" : idx === 2 ? "md" : idx === 3 ? "lg" : `${idx}`;
    out.push(`  --radius-${key}: ${radius};`);
  });

  snapshot.tokens.core.shadows.slice(0, 10).forEach((shadow, idx) => {
    const key = idx === 0 ? "sm" : idx === 1 ? "md" : idx === 2 ? "lg" : `${idx}`;
    out.push(`  --shadow-${key}: ${shadow.value};`);
  });

  out.push("}");
  return `${out.join("\n")}\n`;
}

type ExportableArtifact = {
  relativePath: string;
  description: string;
  mediaType: string;
  content: string;
};

function toFigmaSafeName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildFigmaTextStyleName(style: {
  name: string;
  fontFamily?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight?: string;
}) {
  const family = toFigmaSafeName(style.fontFamily || "Sans");
  const size = toFigmaSafeName(style.fontSize || "16px");
  const weight = toFigmaSafeName(style.fontWeight || "400");
  return `${family}-${size}-${weight}`.slice(0, 72) || "text-style";
}

export function exportFigmaVariables(snapshot: UiSnapshotManifest): string {
  const colors = snapshot.tokens.core.colors.slice(0, 220).map((token, index) => ({
    name: `color/${token.name || `scale-${index}`}`,
    type: "COLOR",
    value: token.value,
    provenance: token.provenance,
  }));

  const spacing = snapshot.tokens.core.spacing.slice(0, 160).map((value, index) => ({
    name: `spacing/${index}`,
    type: "FLOAT",
    value: `${value}`,
  }));

  const radii = snapshot.tokens.core.radii.slice(0, 120).map((value, index) => ({
    name: `radius/${index}`,
    type: "FLOAT",
    value: value,
  }));

  const shadows = snapshot.tokens.core.shadows.slice(0, 80).map((entry, index) => ({
    name: `shadow/${index}`,
    type: "STRING",
    value: entry.value,
    provenance: entry.provenance,
  }));

  const fontFamilies = snapshot.tokens.core.fontFamilies.slice(0, 32).map((entry, index) => ({
    name: `font/family/${toFigmaSafeName(entry.name || `font-${index}`)}`,
    type: "STRING",
    value: entry.stack,
    weight: entry.weight,
    provenance: entry.provenance,
  }));

  const fontSizes = snapshot.tokens.core.fontSizes.slice(0, 48).map((entry, index) => ({
    name: `font/size/${toFigmaSafeName(entry.name || `size-${index}`)}`,
    type: "FLOAT",
    value: String(Math.round(entry.px)),
  }));

  return JSON.stringify(
    {
      schema: "ui-harvester/figma-variables/1.0",
      generatedAt: new Date().toISOString(),
      sourceUrl: snapshot.sourceUrl,
      snapshotId: snapshot.snapshotId,
      modes: snapshot.captureConfig.themes,
      variableGroups: {
        core: {
          colors,
          spacing,
          radii,
          shadows,
          fontFamilies,
          fontSizes,
        },
        semantic: {
          text: snapshot.tokens.semantic.text,
          surface: snapshot.tokens.semantic.surface,
          action: snapshot.tokens.semantic.action,
          border: snapshot.tokens.semantic.border,
          focus: snapshot.tokens.semantic.focus,
        },
      },
      notes: [
        "Generated from resolved computed styles + geometry + viewport/theme evidence.",
        "This payload is designed to be transformed by figma-console-mcp import scripts.",
      ],
    },
    null,
    2,
  );
}

export function exportFigmaStyles(snapshot: UiSnapshotManifest): string {
  const styles = Object.values(snapshot.components.inventory).map((recipe) => ({
    name: `${recipe.archetype}.${recipe.name}`,
    archetype: recipe.archetype,
    variants: recipe.sizeScale.map((entry) => ({
      variant: entry.variant,
      minHeight: entry.minHeight,
      paddingX: entry.horizontalPadding,
      paddingY: entry.verticalPadding,
    })),
    commonStyles: {
      display: recipe.commonStyles.display,
      borderRadius: recipe.commonStyles.borderRadius,
      fontFamily: recipe.commonStyles.fontFamily,
      fontSize: recipe.commonStyles.fontSize,
      transition: recipe.commonStyles.transition,
    },
    states: recipe.states.map((state) => ({
      state: state.state,
      styleSignature: state.styleSignature,
    })),
    provenance: recipe.provenance,
  }));

  return JSON.stringify(
    {
      schema: "ui-harvester/figma-recipes/1.0",
      generatedAt: new Date().toISOString(),
      sourceUrl: snapshot.sourceUrl,
      snapshotId: snapshot.snapshotId,
      typographyLibrary: snapshot.tokens.core.textStyles.map((style) => ({
        name: buildFigmaTextStyleName(style),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
      })),
      componentRecipes: styles,
    },
    null,
    2,
  );
}

export function exportFigmaPackageBlueprint(snapshot: UiSnapshotManifest): string {
  const blueprint = {
    schema: "ui-harvester/figma-blueprint/1.0",
    createdAt: new Date().toISOString(),
    sourceUrl: snapshot.sourceUrl,
    snapshotId: snapshot.snapshotId,
    objective: "Create variable sets, text styles, and component styles in Figma from this snapshot artifact.",
    sources: {
      variablePayload: "artifacts/universal/figma/variables.json",
      stylePayload: "artifacts/universal/figma/styles.json",
    },
    steps: [
      "Read variables.json and create/extend Figma variable collections.",
      "Read styles.json and create local Text styles/component style records.",
      "Map semantic tokens to project naming and create aliases in the target UI library.",
      "Generate components by applying recipes to existing component templates.",
    ],
  };
  return JSON.stringify(blueprint, null, 2);
}

export function exportFigmaConsolePlan(snapshot: UiSnapshotManifest): string {
  const modes = snapshot.captureConfig.themes.filter((mode) => mode !== "auto");
  const figmaModes = modes.length ? modes : ["light"];

  const variablePayload = {
    collectionName: `ui-harvester-${snapshot.snapshotId}`,
    modes: figmaModes,
    tokens: [
      ...snapshot.tokens.core.colors.slice(0, 240).map((token, index) => ({
        name: `color/${token.name || `scale-${index}`}`,
        resolvedType: "COLOR",
        values: Object.fromEntries(figmaModes.map((mode) => [mode, token.value])),
        provenance: token.provenance,
      })),
      ...snapshot.tokens.core.spacing.slice(0, 160).map((value, index) => ({
        name: `spacing/${index}`,
        resolvedType: "FLOAT",
        values: Object.fromEntries(figmaModes.map((mode) => [mode, `${value}`])),
      })),
      ...snapshot.tokens.core.radii.slice(0, 120).map((value, index) => ({
        name: `radius/${index}`,
        resolvedType: "FLOAT",
        values: Object.fromEntries(figmaModes.map((mode) => [mode, value])),
      })),
      ...snapshot.tokens.core.shadows.slice(0, 80).map((entry, index) => ({
        name: `shadow/${index}`,
        resolvedType: "STRING",
        values: Object.fromEntries(figmaModes.map((mode) => [mode, entry.value])),
        provenance: entry.provenance,
      })),
      ...snapshot.tokens.core.fontFamilies.slice(0, 32).map((entry, index) => ({
        name: `font/family/${toFigmaSafeName(entry.name || `font-${index}`)}`,
        resolvedType: "STRING",
        values: Object.fromEntries(figmaModes.map((mode) => [mode, entry.stack])),
        weight: entry.weight,
        provenance: entry.provenance,
      })),
      ...snapshot.tokens.core.fontSizes.slice(0, 48).map((entry, index) => ({
        name: `font/size/${toFigmaSafeName(entry.name || `size-${index}`)}`,
        resolvedType: "FLOAT",
        values: Object.fromEntries(figmaModes.map((mode) => [mode, String(Math.round(entry.px))])),
      })),
    ],
  };

  const plan = {
    schema: "ui-harvester/figma-console-plan/1.0",
    generatedAt: new Date().toISOString(),
    sourceUrl: snapshot.sourceUrl,
    snapshotId: snapshot.snapshotId,
    objective: "Import snapshot into Figma with reusable variables + text styles then manually map component recipes.",
    setup: variablePayload,
    textStyles: snapshot.tokens.core.textStyles.map((style) => ({
      name: buildFigmaTextStyleName(style),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      textAlign: style.textAlign,
      textTransform: style.textTransform,
    })),
    componentRecipes: Object.values(snapshot.components.inventory).map((recipe) => ({
      archetype: recipe.archetype,
      variants: recipe.sizeScale,
      states: recipe.states,
      commonStyles: recipe.commonStyles,
      examples: recipe.examples.slice(0, 3),
    })),
    toolCalls: [
      {
        tool: "figma_setup_design_tokens",
        payload: variablePayload,
        note: "Create variables and collections before styling text/components.",
      },
      {
        tool: "figma_set_text_style",
        payload: {
          styles: snapshot.tokens.core.textStyles.map((style) => ({
            name: buildFigmaTextStyleName(style),
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            textAlign: style.textAlign,
            textTransform: style.textTransform,
          })),
        },
        note: "Create text styles from this payload and reuse them when rebuilding components.",
      },
    ],
  };

  return JSON.stringify(plan, null, 2);
}

export function exportUniversalPackageDescriptor(snapshot: UiSnapshotManifest): string {
  const iconCaptureProfile = snapshot.captureConfig.iconCaptureProfile || "all";
  const manifest: UniversalPackageManifest = {
    schemaVersion: "universal-package/1.2.0",
    snapshotId: snapshot.snapshotId,
    sourceUrl: snapshot.sourceUrl,
    generatedAt: new Date().toISOString(),
    exactnessMode: snapshot.exactness.mode,
    files: [
      { path: "universal/manifest.json", description: "Package index", mediaType: "application/json" },
      { path: "universal/manifest.css-variables.css", description: "CSS variables export", mediaType: "text/css" },
      { path: "universal/tailwind-v4.css", description: "Tailwind v4 theme tokens", mediaType: "text/css" },
      { path: "universal/theme-object.json", description: "Generic/theme stack token object", mediaType: "application/json" },
      { path: "universal/components.json", description: "Component recipes + state matrix", mediaType: "application/json" },
      { path: "universal/dtcg-tokens.json", description: "DTCG-like token export", mediaType: "application/json" },
      { path: "universal/assets/index.json", description: "Universal assets index", mediaType: "application/json" },
      { path: "universal/assets/icons/index.json", description: "Captured icon index", mediaType: "application/json" },
      { path: "universal/figma/variables.json", description: "Figma variable blueprint", mediaType: "application/json" },
      { path: "universal/figma/styles.json", description: "Figma component/style blueprint", mediaType: "application/json" },
      { path: "universal/figma/import-blueprint.json", description: "Step-by-step apply guide for figma-console-mcp", mediaType: "application/json" },
      { path: "universal/figma/figma-console-plan.json", description: "Executable figma-console-mcp plan", mediaType: "application/json" },
      { path: "universal/evidence/routes.jsonl", description: "Observed route+viewport captures", mediaType: "application/x-ndjson" },
      { path: "universal/evidence/pages.json", description: "Captured page manifest", mediaType: "application/json" },
    ],
  };
  return JSON.stringify(manifest, null, 2);
}

export function buildUniversalPackageArtifacts(
  snapshot: UiSnapshotManifest,
  targetStack: SnapshotTargetStack = "generic",
): ExportableArtifact[] {
  const artifacts: ExportableArtifact[] = [];
  const iconCaptureProfile = snapshot.captureConfig.iconCaptureProfile || "all";
  const iconHarvestSummary = snapshot.provenance.iconHarvest || {
    attempted: 0,
    downloaded: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
    dedupedByUrl: 0,
    dedupedByHash: 0,
    retries: 0,
  };
  const iconArtifacts = snapshot.evidence.icons || [];
  const routes = snapshot.evidence.pages.map((capture) => ({
    route: capture.route,
    theme: capture.theme,
    viewport: `${capture.viewport.width}x${capture.viewport.height}`,
    viewportName: capture.viewport.name,
    routeDepth: capture.routeDepth,
    screenshot: capture.fullPageScreenshot,
    screenshotHash: capture.screenshotHash,
    nodeCount: capture.sampledNodes,
    stateCount: capture.stateCaptures.length,
  }));

  artifacts.push(
    { relativePath: "universal/manifest.json", description: "Universal package manifest", mediaType: "application/json", content: exportUniversalPackageDescriptor(snapshot) },
    { relativePath: "universal/manifest.css-variables.css", description: "CSS variables", mediaType: "text/css", content: exportCssVariables(snapshot) },
    { relativePath: "universal/tailwind-v4.css", description: "Tailwind v4 theme", mediaType: "text/css", content: exportTailwindV4Theme(snapshot) },
    { relativePath: "universal/theme-object.json", description: "Theme object export", mediaType: "application/json", content: exportThemeObject(snapshot, targetStack) },
    {
      relativePath: "universal/components.json",
      description: "Component recipes",
      mediaType: "application/json",
      content: exportComponentRecipes(snapshot, targetStack),
    },
    {
      relativePath: "universal/assets/index.json",
      description: "Asset index (legacy + captured icons)",
      mediaType: "application/json",
      content: JSON.stringify(
        {
          snapshotId: snapshot.snapshotId,
          sourceUrl: snapshot.sourceUrl,
          generatedAt: new Date().toISOString(),
          cleaningProfile: snapshot.captureConfig.cleaningProfile,
          iconCaptureProfile,
          assets: snapshot.evidence.assets,
          iconCount: iconArtifacts.length,
          icons: iconArtifacts,
        },
        null,
        2,
      ),
    },
    {
      relativePath: "universal/assets/icons/index.json",
      description: "Captured icon index",
      mediaType: "application/json",
      content: JSON.stringify(
        {
          snapshotId: snapshot.snapshotId,
          sourceUrl: snapshot.sourceUrl,
          generatedAt: new Date().toISOString(),
          iconCaptureProfile,
          summary: iconHarvestSummary,
          icons: iconArtifacts,
        },
        null,
        2,
      ),
    },
    { relativePath: "universal/dtcg-tokens.json", description: "DTCG-like tokens", mediaType: "application/json", content: exportDtcgJson(snapshot) },
    { relativePath: "universal/figma/variables.json", description: "Figma-compatible variables", mediaType: "application/json", content: exportFigmaVariables(snapshot) },
    { relativePath: "universal/figma/styles.json", description: "Figma-compatible styles", mediaType: "application/json", content: exportFigmaStyles(snapshot) },
    { relativePath: "universal/figma/import-blueprint.json", description: "Figma import blueprint", mediaType: "application/json", content: exportFigmaPackageBlueprint(snapshot) },
    {
      relativePath: "universal/figma/figma-console-plan.json",
      description: "Executable figma-console-mcp plan",
      mediaType: "application/json",
      content: exportFigmaConsolePlan(snapshot),
    },
    {
      relativePath: "universal/evidence/routes.jsonl",
      description: "Observed route+viewport evidence list",
      mediaType: "application/x-ndjson",
      content: routes.map((route) => JSON.stringify(route)).join("\n"),
    },
    {
      relativePath: "universal/evidence/pages.json",
      description: "Observed page capture inventory",
      mediaType: "application/json",
      content: JSON.stringify(snapshot.evidence.pages, null, 2),
    },
  );

  artifacts.push(
    {
      relativePath: "universal/tokens/core.json",
      description: "Core tokens (raw)",
      mediaType: "application/json",
      content: JSON.stringify(snapshot.tokens.core, null, 2),
    },
    {
      relativePath: "universal/tokens/semantic.json",
      description: "Semantic token aliases",
      mediaType: "application/json",
      content: JSON.stringify(snapshot.tokens.semantic, null, 2),
    },
    {
      relativePath: "universal/layout.json",
      description: "Breakpoints and layout hints",
      mediaType: "application/json",
      content: JSON.stringify({ breakpoints: snapshot.tokens.breakpoints }, null, 2),
    },
    {
      relativePath: "universal/motion.json",
      description: "Motion and transition hints from observed elements",
      mediaType: "application/json",
      content: JSON.stringify(
        {
          transitions: snapshot.tokens.core.textStyles.map((entry) => ({
            name: entry.name,
            transition: "not-abstracted",
            lineHeight: entry.lineHeight,
            letterSpacing: entry.letterSpacing,
          })),
        },
        null,
        2,
      ),
    },
    {
      relativePath: "universal/validation/template.json",
      description: "Validation plan template (placeholder)",
      mediaType: "application/json",
      content: JSON.stringify(
        {
          type: "visual-match",
          defaultMaxDiffPercent: 2.5,
          requiredStateCoverage: ["default", "hover", "focus"],
          notes: "Run validate_visual_match after project apply to fill this with real diff metrics.",
        },
        null,
        2,
      ),
    },
  );

  return artifacts;
}

export function exportDtcgJson(snapshot: UiSnapshotManifest): string {
  const object = {
    $schema: "https://tr.designtokens.org/TR/2025.10",
    id: `snapshot://${snapshot.snapshotId}`,
    name: `snapshot-${snapshot.snapshotId}`,
    description: "DTCG-style token bundle generated from rendered UI snapshot",
    source: {
      url: snapshot.sourceUrl,
      capturedAt: snapshot.createdAt,
      viewportCount: snapshot.captureConfig.viewports.length,
      themes: snapshot.captureConfig.themes,
    },
    $value: {
      color: Object.fromEntries(
        snapshot.tokens.core.colors.slice(0, 240).map((token) => [slug(token.name) || snapshotPathSafe(token.value), token.value]),
      ),
      spacing: Object.fromEntries(snapshot.tokens.core.spacing.slice(0, 80).map((value) => [String(value), `${value}px`])),
      radius: Object.fromEntries(snapshot.tokens.core.radii.slice(0, 24).map((radius, index) => [`${index + 1}`, radius])),
      shadow: Object.fromEntries(snapshot.tokens.core.shadows.slice(0, 20).map((shadow) => [shadow.name, shadow.value])),
      font: Object.fromEntries(
        snapshot.tokens.core.fontFamilies.map((font) => [slug(font.name) || snapshotPathSafe(font.stack), { family: font.stack }]),
      ),
      typography: Object.fromEntries(
        snapshot.tokens.core.textStyles.map((textStyle) => [snapshotPathSafe(textStyle.name), textStyleToTheme(textStyle)]),
      ),
    },
    semantic: snapshot.tokens.semantic,
    components: snapshot.components,
  };
  return JSON.stringify(object, null, 2);
}

export function exportThemeObject(snapshot: UiSnapshotManifest, targetStack: SnapshotTargetStack = "generic"): string {
  if (targetStack === "mui" || targetStack === "next-tailwind" || targetStack === "vite-tailwind") {
    const textStyles = snapshot.tokens.core.textStyles;
    const obj = {
      palette: {
        primary: {
          main: snapshot.tokens.semantic.action.primaryBg || snapshot.tokens.core.colors[0]?.value || "#2563eb",
          contrastText: snapshot.tokens.semantic.action.primaryFg || "#ffffff",
        },
        secondary: {
          main: snapshot.tokens.semantic.action.secondaryBg || snapshot.tokens.core.colors[1]?.value || "#64748b",
          contrastText: snapshot.tokens.semantic.action.secondaryFg || "#111827",
        },
        text: {
          primary: snapshot.tokens.semantic.text.primary || "#111827",
          secondary: snapshot.tokens.semantic.text.secondary || "#6b7280",
        },
        background: {
          default: snapshot.tokens.semantic.surface.page || "#ffffff",
          paper: snapshot.tokens.semantic.surface.card || "#f9fafb",
        },
        divider: snapshot.tokens.semantic.border.default || "#e5e7eb",
      },
      typography: {
        fontFamily: snapshot.tokens.core.fontFamilies[0]?.stack || "Inter, Arial, sans-serif",
        h1: textStyleToTheme(textStyles[0]),
        h2: textStyleToTheme(textStyles[1]),
        h3: textStyleToTheme(textStyles[2]),
        body1: textStyleToTheme(textStyles[3]),
        body2: textStyleToTheme(textStyles[4]),
        button: textStyleToTheme(textStyles[0]),
      },
      shape: {
        borderRadius: snapshot.tokens.core.radii[0] || "8px",
      },
      shadows: snapshot.tokens.core.shadows.slice(0, 12).map((entry) => entry.value),
      spacing: 4,
    };
    return JSON.stringify(obj, null, 2);
  }

  const obj = {
    tokens: {
      colors: Object.fromEntries(snapshot.tokens.core.colors.slice(0, 200).map((token) => [token.name, token.value])),
      spacing: snapshot.tokens.core.spacing.slice(0, 120),
      radii: snapshot.tokens.core.radii.slice(0, 64),
      shadows: snapshot.tokens.core.shadows.slice(0, 24).map((entry) => entry.value),
    },
    semantic: snapshot.tokens.semantic,
    components: snapshot.components,
    exactness: "observed-only",
  };
  return JSON.stringify(obj, null, 2);
}

export function exportComponentRecipes(snapshot: UiSnapshotManifest, targetStack: SnapshotTargetStack = "generic"): string {
  const recipes = snapshot.components.inventory;
  const normalized = Object.values(recipes).map((recipe) => ({
    name: recipe.name,
    archetype: recipe.archetype,
    count: recipe.count,
    examples: recipe.examples,
    sizeScale: recipe.sizeScale,
    states: recipe.states,
    commonStyles: recipe.commonStyles,
  }));

  if (targetStack === "mui") {
    const byName = Object.fromEntries(
      normalized.map((entry) => {
        return [
          entry.archetype,
          {
            components: {
              styleOverrides: {
                root: Object.fromEntries(
                  Object.entries(entry.commonStyles).filter(([, value]) => Boolean(value)),
                ),
              },
              variants: entry.sizeScale.map((size) => ({
                props: { size: size.variant },
                style: { minHeight: size.minHeight, padding: `${size.verticalPadding || "0"} ${size.horizontalPadding || "0"}` },
              })),
            },
            states: entry.states.map((state) => state.state),
          },
        ];
      }),
    );
    return JSON.stringify({ byName }, null, 2);
  }

  return JSON.stringify(normalized, null, 2);
}
