// Platform AI conversation scene (parity PR5). Synthetic, fabricated data only:
// the real pure `PlatformAiConversationsView` is rendered with local state, and no
// API is called. `?platform-ai` shows a selected thread; `?platform-ai=empty`
// shows the empty state with the starter chips; `?platform-ai=first` is a first visit (no
// conversations: the full notice expanded). The rail starts collapsed (the default).
import React, {useState} from 'react';
import {PlatformAiConversationsView} from '@/components/platform/PlatformAiConversations';
import type {ClientConversation, ClientMessage} from '@/components/platform/platform-ai-conversations-model';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const CONVERSATIONS: ClientConversation[] = [
  {id: 'c00000000000000000000001', area: 'PLATFORM_OPS', areaLabel: 'Platform Operations', createdAt: at(2), lastActivityAt: at(1), label: 'Which synthetic fixture jobs ran late, and which providers had the longest queue this week?', messageCount: 16, full: false},
  {id: 'c00000000000000000000002', area: 'PLATFORM_OPS', areaLabel: 'Platform Operations', createdAt: at(5), lastActivityAt: at(4), label: 'Fixture incidents open right now', messageCount: 4, full: false},
  {id: 'c00000000000000000000003', area: 'PLATFORM_GROWTH', areaLabel: 'Growth', createdAt: at(30), lastActivityAt: at(28), label: 'Fixture sign-up funnel question', messageCount: 50, full: true},
  {id: 'c00000000000000000000004', area: 'PLATFORM_OPS', areaLabel: 'Platform Operations', createdAt: at(80), lastActivityAt: at(76), label: 'Fixture cost drivers', messageCount: 6, full: false},
];
const user = (id: string, content: string): ClientMessage => ({id, role: 'USER', status: 'COMPLETE', createdAt: at(1), completedAt: at(1), content, citations: [], notes: [], failureCode: null, unavailable: false, stale: true});
const answer = (id: string, correction: boolean): ClientMessage => ({
  id, role: 'ASSISTANT', status: 'COMPLETE', createdAt: at(1), completedAt: at(1),
  content: [
    ...(correction ? [{kind: 'correction' as const, text: 'Fixture period correction: showing the last 7 days instead of the requested range.'}] : []),
    {kind: 'text', text: 'Fixture answer with a long unbroken token SyntheticProviderIdentifierWithoutSpaces_0123456789 and figures: '},
    {kind: 'figure', text: '12', metric: 'provider-outcome@1', window: 7},
    {kind: 'text', text: ' fixture failures and '},
    {kind: 'figure', text: '3', metric: 'incident-broken-now@1', window: null},
    {kind: 'text', text: ' fixture incidents. See '},
    {kind: 'link', text: 'Providers', href: '/dashboard/platform/PLATFORM_OPS?workspace=platform-providers'},
  ],
  citations: [{metric: 'provider-outcome@1', label: 'Provider outcomes', window: 'last 7 days'}, {metric: 'incident-broken-now@1', label: 'Incidents broken now', window: 'now'}],
  notes: ['A deterministic fixture note.'], failureCode: null, unavailable: false, stale: true,
});
// `?platform-ai=callouts` (2026-11-08, S2 capture): the REAL server callouts — the period
// CORRECTION (Question C wording), the quiet WINDOW NOTE (F-1), and a briefing answer with a
// section label + one nested list level (F-2) — as the shared typed renderer lays them out.
const CORRECTION_TEXT = 'Correction: the figures for Estimated operating cost this cycle (by category) cover so far this month (since 2026-01-01), not the past 30 days you asked about; that period cannot be measured for them.';
const NOTE_TEXT = 'Note: Estimated operating cost this cycle (by category) covers this UTC calendar month to date, since 2026-01-01, not the 30 days you asked about.';
const CALLOUTS: ClientMessage[] = [
  user('cu1', "What's costing me the most money in the past 30 days?"),
  {id: 'ca1', role: 'ASSISTANT', status: 'COMPLETE', createdAt: at(1), completedAt: at(1), content: [
    {kind: 'correction', text: CORRECTION_TEXT},
    {kind: 'text', text: 'In the past 30 days, the largest measured cost is '}, {kind: 'text', text: 'AI'}, {kind: 'text', text: ' at '},
    {kind: 'figure', text: 'at least $3.36 (this UTC calendar month to date, since 2026-01-01, estimated)', metric: 'economics-operating-cost@1', window: 'this UTC calendar month to date'}, {kind: 'text', text: '.'},
  ], citations: [{metric: 'economics-operating-cost@1', label: 'Estimated operating cost this cycle (by category)', window: 'this UTC calendar month to date'}], notes: [], failureCode: null, unavailable: false, stale: true},
  user('cu2', 'And what is it costing overall?'),
  {id: 'ca2', role: 'ASSISTANT', status: 'COMPLETE', createdAt: at(1), completedAt: at(1), content: [
    {kind: 'note', text: NOTE_TEXT},
    {kind: 'text', text: 'The estimated operating cost so far is '},
    {kind: 'figure', text: 'at least $4.10 (this UTC calendar month to date, since 2026-01-01, estimated)', metric: 'economics-operating-cost@1', window: 'this UTC calendar month to date'}, {kind: 'text', text: '.'},
  ], citations: [], notes: [], failureCode: null, unavailable: false, stale: true},
  user('cu3', 'How are we looking today? Please give me the issues as a short bulleted list.'),
  {id: 'ca3', role: 'ASSISTANT', status: 'COMPLETE', createdAt: at(1), completedAt: at(1), content: [
    {kind: 'text', text: 'Connections need attention:\n- '}, {kind: 'figure', text: '1', metric: 'ops-overall-posture@1', window: null}, {kind: 'text', text: ' domain is degraded (Connections).\n  - '},
    {kind: 'figure', text: '2', metric: 'connection-health-summary@1', window: null}, {kind: 'text', text: ' connections need the customer to reconnect.\n- '},
    {kind: 'figure', text: '3', metric: 'incident-broken-now@1', window: null}, {kind: 'text', text: ' incidents are active. Review '},
    {kind: 'link', text: 'Connections', href: '/dashboard/platform/PLATFORM_OPS?view=pipeline'}, {kind: 'text', text: '.'},
  ], citations: [], notes: [], failureCode: null, unavailable: false, stale: true},
];
const MESSAGES: ClientMessage[] = Array.from({length: 8}, (_, i) => [
  user(`u${i}`, `Fixture question ${i + 1}: which jobs ran late and which providers were slowest over the last week?`),
  answer(`a${i}`, i % 3 === 0),
]).flat();

export function PlatformAiScene({empty, first = false, callouts = false}: {empty: boolean; first?: boolean; callouts?: boolean}) {
  const [draft, setDraft] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [noticeOpen, setNoticeOpen] = useState<boolean | null>(null);
  const noop = () => {};
  return (
    <>
      <PlatformAiConversationsView
        areaLabel="Platform Operations" now={NOW} conversations={first ? [] : CONVERSATIONS} limits={{used: first ? 0 : 4, max: 50}} listError={null}
        selected={empty ? null : {conversation: CONVERSATIONS[0], messages: callouts ? CALLOUTS : MESSAGES}} threadLoading={false}
        draft={draft} sendingQuestion={null} problem={null} canRetrySend={false}
        sheetOpen={sheetOpen} railCollapsed={railCollapsed} confirmDelete={null} deleting={false}
        onDraft={setDraft} onSend={() => setDraft('')} onStarter={noop} onRetrySend={noop} onRetryFailed={noop} onCheckPending={noop}
        onSelect={() => setSheetOpen(false)} onNew={noop} onAskDelete={noop} onConfirmDelete={noop} onCancelDelete={noop}
        onSheet={setSheetOpen} onRail={setRailCollapsed} noticeOpen={noticeOpen} onNotice={setNoticeOpen}
      />
      <nav style={{position: 'fixed', bottom: 0, height: 56, background: 'var(--glass-thick)', left: 0, right: 0}}>Fixture platform bottom bar</nav>
    </>
  );
}
