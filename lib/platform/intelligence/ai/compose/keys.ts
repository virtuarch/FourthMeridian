/**
 * lib/platform/intelligence/ai/compose/keys.ts — the metric registry's key index (known keys / ids / labels), shared by
 * placeholder resolution and the link-target diagnosis.
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import { METRICS, metricKey } from "@/lib/platform/intelligence/metrics/registry";

const KNOWN_KEYS: ReadonlySet<string> = new Set(METRICS.map(metricKey));
/** The registry label of each metric key (what {{l:<key>}} renders with no part). */
const LABEL_OF_KEY: ReadonlyMap<string, string> = new Map(METRICS.map((m) => [metricKey(m), m.label]));
const KNOWN_IDS: ReadonlySet<string> = new Set(METRICS.map((m) => m.id));
const idOfKey = (k: string) => { const at = k.lastIndexOf("@"); return at >= 0 ? k.slice(0, at) : k; };

/** Module-internal to compose/* (not part of core.ts's facade). */
export { KNOWN_KEYS, LABEL_OF_KEY, KNOWN_IDS, idOfKey };
