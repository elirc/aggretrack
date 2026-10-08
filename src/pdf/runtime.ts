/**
 * Lazy @react-pdf/renderer loader.
 *
 * Why: @react-pdf/* 4.x is ESM-only and its internal deps (e.g.
 * @react-pdf/hyphenate) export only the "import" condition. The worker runs
 * under tsx in a CommonJS package, where a STATIC import compiles to
 * require() and fails with ERR_PACKAGE_PATH_NOT_EXPORTED. A dynamic import()
 * stays native ESM in tsx, vitest and Next, so templates only reference
 * react-pdf primitives at render time via `rp()` (type-only static imports).
 */
type ReactPdfModule = typeof import("@react-pdf/renderer");

let loaded: ReactPdfModule | null = null;
let loading: Promise<ReactPdfModule> | null = null;

export function loadReactPdf(): Promise<ReactPdfModule> {
  if (!loading) {
    loading = import("@react-pdf/renderer").then((m) => {
      loaded = m;
      return m;
    });
    loading.catch(() => {
      loading = null; // allow retry
    });
  }
  return loading;
}

/** The loaded module. Only valid during/after `await loadReactPdf()` (renderPdf does this). */
export function rp(): ReactPdfModule {
  if (!loaded) {
    throw new Error("@react-pdf/renderer not loaded: call loadReactPdf() (renderPdf does) before rendering");
  }
  return loaded;
}
