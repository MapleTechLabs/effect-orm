/**
 * Maple web analytics for the docs site: sessions, visitors and page views.
 * Session replay is off; we only want traffic numbers.
 *
 * Page views after the first come from the SDK's `history.pushState` hook,
 * which is how Astro's `<ClientRouter />` navigates, so no per-route wiring is
 * needed.
 */

import { MapleBrowser } from "@maple-dev/browser";

// Speculation-rules prerendering (Chromium); not in TypeScript's DOM lib yet.
declare global {
  interface Document {
    readonly prerendering?: boolean;
  }
}

const INGEST_KEY = import.meta.env.PUBLIC_MAPLE_INGEST_KEY;

let started = false;

export function startTelemetry(): void {
  // No key at build time (fresh clone, CI, `astro dev`): send nothing.
  if (started || !INGEST_KEY || typeof window === "undefined") return;
  // A prerendered page may never be shown; start the session once it is.
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", startTelemetry, { once: true });
    return;
  }
  started = true;

  MapleBrowser.init({
    ingestKey: INGEST_KEY,
    serviceName: "effect-orm-docs",
    environment: import.meta.env.MODE,
    replay: { enabled: false },
    // The docs' Maple source only accepts `sessions` and `events`; traces and
    // logs (Web Vitals, breadcrumbs, CSP reports) would be rejected with 403.
    tracing: { enabled: false },
    webVitals: false,
    breadcrumbs: false,
    reporting: { csp: false },
  });
}
