"use client";

/**
 * components/platform/keyed-fetch.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * A single-resource reader for a body that is REMOUNTED per url (the caller
 * keys the component on the query it renders). `useWidgetFetch` is
 * contractually static-url only (widget-fetch-static-url.test.ts); this is
 * the sanctioned shape for a filtered read: the same same-origin credentials,
 * abort-on-unmount and status wording, with the url fixed for the lifetime of
 * the mounted body.
 */

import { useEffect, useState } from "react";

export function useKeyedFetch<T>(url: string): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(r.status === 403 ? "Not authorized" : r.status === 404 ? "Not found" : `Request failed (${r.status})`);
        }
        return (await r.json()) as T;
      })
      .then((j) => { if (!alive) return; setData(j); setLoading(false); })
      .catch((e) => { if (!alive) return; setError(e instanceof Error ? e.message : "Failed to load"); setLoading(false); });
    return () => { alive = false; };
  }, [url]);

  return { data, loading, error };
}

/** A small segmented filter control shared by the observability widgets. */
export interface SegmentOption<V extends string> { value: V; label: string }
