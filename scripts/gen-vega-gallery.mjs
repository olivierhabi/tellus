// ---------------------------------------------------------------------------
// Regenerate src/seeds/vegaGallerySpecs.ts from the upstream Vega examples.
//
// Fetches each canonical Vega (low-level grammar) spec verbatim from the Vega
// repo, absolutizes its relative `data/*` URLs to the CORS-enabled host
// https://vega.github.io/vega/data/*, and emits a typed registry consumed by
// vegaGalleryShowcaseSeed.ts. Run after bumping the upstream pin or editing the
// chart list.
//
//   node scripts/gen-vega-gallery.mjs
//
// (Optional) validate every emitted spec compiles, from a package that has
// `vega` installed:  node -e "import('vega')..."  — the seed's create/update
// path also runs B02 validation, and the canvas compiles specs at render time.
// ---------------------------------------------------------------------------

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const RAW = "https://raw.githubusercontent.com/vega/vega/main/docs/examples";
const DATA_HOST = "https://vega.github.io/vega/data/";

// Ordered registry: [slug, title, group]. Order drives the on-page layout.
const META = [
  ["bar-chart", "Bar Chart", "Bar Charts"],
  ["stacked-bar-chart", "Stacked Bar Chart", "Bar Charts"],
  ["grouped-bar-chart", "Grouped Bar Chart", "Bar Charts"],
  ["nested-bar-chart", "Nested Bar Chart", "Bar Charts"],
  ["population-pyramid", "Population Pyramid", "Bar Charts"],
  ["line-chart", "Line Chart", "Line & Area Charts"],
  ["area-chart", "Area Chart", "Line & Area Charts"],
  ["stacked-area-chart", "Stacked Area Chart", "Line & Area Charts"],
  ["horizon-graph", "Horizon Graph", "Line & Area Charts"],
  ["job-voyager", "Job Voyager", "Line & Area Charts"],
  ["pie-chart", "Pie Chart", "Circular Charts"],
  ["donut-chart", "Donut Chart", "Circular Charts"],
  ["donut-chart-labelled", "Donut Chart Labelled", "Circular Charts"],
  ["radial-plot", "Radial Plot", "Circular Charts"],
  ["top-k-plot", "Top K Plot", "Distributions"],
  ["top-k-plot-with-others", "Top K Plot With Others", "Distributions"],
  ["histogram", "Histogram", "Distributions"],
  ["histogram-null-values", "Histogram Null Values", "Distributions"],
  ["dot-plot", "Dot Plot", "Distributions"],
  ["probability-density", "Probability Density", "Distributions"],
  ["box-plot", "Box Plot", "Distributions"],
  ["violin-plot", "Violin Plot", "Distributions"],
  ["binned-scatter-plot", "Binned Scatter Plot", "Distributions"],
  ["contour-plot", "Contour Plot", "Distributions"],
  ["wheat-plot", "Wheat Plot", "Distributions"],
  ["quantile-quantile-plot", "Quantile Quantile Plot", "Distributions"],
  ["quantile-dot-plot", "Quantile Dot Plot", "Distributions"],
  ["hypothetical-outcome-plots", "Hypothetical Outcome Plots", "Distributions"],
  ["time-units", "Time Units", "Time & Interactive"],
  ["crossfilter-flights", "Crossfilter Flights", "Time & Interactive"],
  ["overview-plus-detail", "Overview Plus Detail", "Time & Interactive"],
  ["bar-line-toggle", "Bar Line Toggle", "Time & Interactive"],
];

/** Absolutize every relative `data/<file>` url to the CORS-enabled host. */
function absolutize(node) {
  if (Array.isArray(node)) return node.map(absolutize);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "url" && typeof v === "string" && v.startsWith("data/")) {
        out[k] = DATA_HOST + v.slice("data/".length);
      } else {
        out[k] = absolutize(v);
      }
    }
    return out;
  }
  return node;
}

async function main() {
  const entries = [];
  for (const [slug, title, group] of META) {
    const res = await fetch(`${RAW}/${slug}.vg.json`);
    if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
    const spec = absolutize(await res.json());
    entries.push({ slug, title, group, spec: JSON.stringify(spec) });
    console.log(`  ${slug}`);
  }

  const out = `// AUTO-GENERATED — do not edit by hand. Regenerate with:
//   node scripts/gen-vega-gallery.mjs
//
// Canonical Vega example specs (https://vega.github.io/vega/examples/) for the
// Vega Chart gallery showcase seed. Each spec is fetched verbatim from the Vega
// repo (docs/examples/<slug>.vg.json) with its relative \`data/*\` URLs absolutized
// to the CORS-enabled host https://vega.github.io/vega/data/*. \`spec\` is the
// chart's full Vega (low-level grammar) specification as a JSON string — exactly
// what \`config.vegaChart.spec\` persists. Count: ${entries.length}.

export interface VegaGallerySpec {
  /** Stable kebab-case slug (matches the upstream example filename). */
  readonly slug: string;
  /** Human title shown as the chart's section header. */
  readonly title: string;
  /** Gallery group the chart belongs to (section grouping). */
  readonly group: string;
  /** Full Vega spec as a JSON string (config.vegaChart.spec). */
  readonly spec: string;
}

export const VEGA_GALLERY_SPECS: ReadonlyArray<VegaGallerySpec> = ${JSON.stringify(
    entries,
    null,
    2,
  )};
`;

  const dest = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "seeds",
    "vegaGallerySpecs.ts",
  );
  writeFileSync(dest, out);
  console.log(`\nwrote ${dest} (${entries.length} specs)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
