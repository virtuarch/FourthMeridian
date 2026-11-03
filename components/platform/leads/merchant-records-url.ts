/**
 * components/platform/leads/merchant-records-url.ts  (PB-9 — Merchant Identity deep links)
 *
 * The Merchant Identity dashboard's state in the Space URL, so a drill-down
 * survives a refresh and is linkable:
 *
 *   ?period=90                      the 30 / 90-day window (30 = default, no param)
 *   &records=unlinked               which KPI's records are open
 *   &rq=…  &rsort=…  &rpage=2       search · sort · page of that table
 *   &rfilter=ELIGIBLE               identity class (Without a merchant only)
 *   &rid=<merchant id>              the merchant whose detail is open
 *
 * Every write goes through the ONE URL seam (useSpaceUrl) with REPLACE intent —
 * opening a KPI's records or refining the table refines the current entry, like
 * the Customer Success `?attention=` filter (S2 ruling); never a Back/Forward
 * step. All seven are workspace-scoped (cleared by a user workspace switch).
 * Values are read with the SAME parser the route validates with
 * (parseRecordsQuery), so the URL can never name a state the server refuses —
 * an unknown value is dropped, never an error page.
 */

import { parseRecordsQuery } from "@/lib/platform/merchant/records-core";
import type { IdentityClass, MerchantRecordsKind, MerchantWindowDays } from "@/lib/platform/merchant/records-types";
import { MERCHANT_RECORDS_SORTS } from "@/lib/platform/merchant/records-types";

export const MERCHANT_URL_PARAMS = ["period", "records", "rq", "rsort", "rpage", "rfilter", "rid"] as const;

export interface MerchantRecordsUrlState {
  period: MerchantWindowDays;
  records: MerchantRecordsKind | null;
  q: string | null;
  sort: string | null;
  page: number;
  filter: IdentityClass | null;
  merchantId: string | null;
}

export const CLOSED_STATE: MerchantRecordsUrlState = { period: 30, records: null, q: null, sort: null, page: 1, filter: null, merchantId: null };

const MERCHANT_ID = /^c[a-z0-9]{20,32}$/;

/** Read the state from a search string. Anything the route would refuse is dropped. */
export function readMerchantRecordsUrl(search: string): MerchantRecordsUrlState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const period: MerchantWindowDays = p.get("period") === "90" ? 90 : 30;
  const kind = p.get("records");
  const rid = p.get("rid");
  const merchantId = rid && MERCHANT_ID.test(rid) ? rid : null;
  if (!kind) return { ...CLOSED_STATE, period };
  const probe = new URLSearchParams({ kind, window: String(period) });
  const parsedKind = parseRecordsQuery(probe);
  if (!parsedKind.ok) return { ...CLOSED_STATE, period };
  const k = parsedKind.query.kind;
  // Validate each refinement on its own, so one bad value drops only itself.
  const one = (key: string, value: string | null) => {
    if (value === null) return null;
    const t = new URLSearchParams(probe); t.set(key, value);
    return parseRecordsQuery(t).ok ? value : null;
  };
  const sort = one("sort", p.get("rsort"));
  const pageRaw = one("page", p.get("rpage"));
  const filter = one("filter", p.get("rfilter")) as IdentityClass | null;
  const q = p.get("rq");
  return {
    period,
    records: k,
    q: q && q.trim() ? q.trim().slice(0, 40) : null,
    sort: sort && sort !== MERCHANT_RECORDS_SORTS[k][0] ? sort : null,
    page: pageRaw ? Number(pageRaw) : 1,
    filter,
    merchantId: k === "merchants" ? merchantId : null,
  };
}

/** The URL update for a state: defaults delete their key (a clean URL for the plain dashboard). */
export function merchantRecordsUrlUpdate(s: MerchantRecordsUrlState): Record<string, string | null> {
  const open = s.records !== null;
  return {
    period: s.period === 90 ? "90" : null,
    records: s.records,
    rq: open && s.q ? s.q : null,
    rsort: open && s.sort ? s.sort : null,
    rpage: open && s.page > 1 ? String(s.page) : null,
    rfilter: open && s.records === "unlinked" && s.filter ? s.filter : null,
    rid: open && s.records === "merchants" && s.merchantId ? s.merchantId : null,
  };
}

/** The records API path for a state (the route re-validates everything). */
export function recordsApiPath(s: MerchantRecordsUrlState): string | null {
  if (!s.records) return null;
  const p = new URLSearchParams({ kind: s.records, window: String(s.period) });
  if (s.q) p.set("q", s.q);
  if (s.sort) p.set("sort", s.sort);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.filter && s.records === "unlinked") p.set("filter", s.filter);
  return `/api/platform/merchant-ops/records?${p.toString()}`;
}

/** Opening a KPI: its records, from page one, unsearched — so the table total is the figure clicked. */
export function openRecords(s: MerchantRecordsUrlState, kind: MerchantRecordsKind, filter: IdentityClass | null = null): MerchantRecordsUrlState {
  return { ...s, records: kind, q: null, sort: null, page: 1, filter: kind === "unlinked" ? filter : null, merchantId: null };
}
