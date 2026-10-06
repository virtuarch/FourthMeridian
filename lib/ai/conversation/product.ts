/**
 * lib/ai/conversation/product.ts
 *
 * WHAT FOURTH MERIDIAN IS, AND WHAT THIS CONVERSATION CAN ACTUALLY DO — ONE
 * AUTHORITY FOR PRODUCT AND META QUESTIONS.
 *
 * ⚠️ THE DEFECT. Asked "who are you?", the model called itself a "financial
 * copilot" and a "money brain"; asked what happens on disconnect, it guessed
 * ("depends on the app's rules"); asked about memory, it improvised. Product
 * claims had no source, so each answer was a plausible invention.
 *
 * ⚠️ FACTS, NOT DOCTRINE, AND EVERY ONE IS TIED TO CODE. A capability line exists
 * only because a registered tool exists (`CAPABILITY_BY_TOOL` is keyed by tool
 * name, and a test fails when the registry and this map disagree); lifetimes are
 * IMPORTED from the modules that enforce them; the disconnect description is the
 * behaviour of app/api/connections/[id]/disconnect. Nothing here is roadmap.
 *
 * ⚠️ NOTHING HERE IS SECRET, AND NOTHING HERE GRANTS ANYTHING. It describes the
 * boundary in plain terms ("this conversation reads only this Space"); it does
 * not name roles, policies, keys or infrastructure, and the boundary it
 * describes is enforced elsewhere (the route, the tenant phase, RLS) whether or
 * not the model reads this.
 *
 * Pure, except the tool's `run`, which reads only the context it is given.
 */

import { RUNTIME_STATE_TTL_MS } from './runtime-state';
import type { ToolDefinition } from './tools';

/** How long the browser keeps a transcript. Mirrors components/ai/transcript-cache (pinned by test). */
export const BROWSER_TRANSCRIPT_TTL_HOURS = 24;

export const PRODUCT_IDENTITY =
  'Fourth Meridian is an AI-native wealth management platform. It helps people understand their '
  + 'financial position — cash, spending, income, debt, investments and where they are heading — '
  + 'model decisions and scenarios, and turn their financial data into planning insight.';

/**
 * What each registered tool lets this conversation do, in a user's words.
 * ⚠️ KEYED BY TOOL NAME, EXHAUSTIVELY (test-enforced). A tool with no line here
 * fails the build; a line with no tool cannot exist.
 */
export const CAPABILITY_BY_TOOL: Record<string, string> = {
  get_financial_snapshot: 'your position on any date: net worth, cash, investments, debt, by account',
  get_spending: 'spending by category and merchant over any period',
  measure_flows: 'income, spending and surplus measured over periods, and compared between them',
  get_baselines: 'your normal monthly spending and income, savings rate, runway, and N-months-of-expenses reserves',
  get_transactions: 'your transactions, searched and ranked',
  get_income: 'your income, from the deposits that actually arrived',
  get_investments: 'what you are invested in, including digital assets, and how concentrated it is',
  get_net_worth_history: 'how your net worth and its parts moved over time',
  find_in_balance_history: 'exact dates in your history (first/last/highest/lowest, or when a balance crossed a level)',
  explain_net_worth_composition: 'what your net worth was made of on a date, account by account',
  project_cash: 'where your cash is heading on your current trend',
  get_pay_dates: 'your upcoming pay dates, from your paycheck history',
  investment_scenario: 'what-ifs on your investment positions',
  scenario_projection: 'what-if projections: different spending, income changes, contributions, returns, one-off expenses, debt payoff',
  scenario_crossing: 'when a what-if plan would reach (or fall below) a level',
  scenario_goal_seek: 'what it would take to reach a goal by a date',
  reconcile_projection: 'how an earlier projection compares with what actually happened',
  stage_assumptions: 'holding the conditions you state in a conversation until a projection runs',
  recall: 'what you asked Fourth Meridian to remember',
  remember: 'remembering goals, planned expenses, rules and planning figures you state',
  describe_fourth_meridian: 'explaining what Fourth Meridian is and can do',
};

/** What it cannot do. Each line is true of the shipped product; none is a policy the model may relax. */
export const CANNOT = [
  'move money, pay bills, trade, open or close accounts, or change anything at your bank or broker',
  'change your balances or transactions — those come from your connected accounts and the records you enter',
  'see accounts that are not connected to this Space, other Spaces, or other people\'s data',
  'see your employer, payroll or tax records — income is what actually arrived in your accounts',
  'pick securities or funds for you, or provide market research, news or price forecasts',
  'determine taxes or legal questions — it can point out where they matter',
  'act as a licensed financial adviser, broker, tax adviser or attorney',
];

/** The facts about memory and continuity, with the lifetimes the code enforces. */
export function memoryFacts(): Record<string, string> {
  const scenarioHours = Math.round(RUNTIME_STATE_TTL_MS / 3_600_000);
  return {
    durable: 'Only what you ask it to remember: goals, planned expenses, rules (like "keep six months of '
      + 'expenses") and planning figures. Stored per person and per Space, shown in the Memory panel, '
      + 'and yours to retire or delete. A remembered figure is never treated as a measured balance. '
      + 'It also keeps a record of the cash projections it gives you, so a later answer can compare '
      + 'a projection with what actually happened.',
    conversation: `The conversation itself is kept only in this browser, for up to ${BROWSER_TRANSCRIPT_TTL_HOURS} hours; `
      + 'Fourth Meridian does not store it on its servers. "New chat" clears it.',
    hypotheticals: `A what-if under discussion is carried between messages for up to ${scenarioHours} hours, `
      + 'and only within the same conversation.',
    neverRemembered: 'Balances, ownership, access, or instructions about how Fourth Meridian should behave.',
  };
}

/** Disconnect, as app/api/connections/[id]/disconnect implements it. */
export const DISCONNECT =
  'Only the person who connected an account can disconnect it. Disconnecting stops syncing, removes '
  + 'the accounts from every Space (so they leave current balances and net worth), and revokes bank '
  + 'access when nothing else uses it. History is kept, not deleted, and reconnecting brings the same '
  + 'accounts back.';

/** The tool that serves all of the above. Read-only; reads nothing but its context. */
export const describeFourthMeridian: ToolDefinition = {
  name: 'describe_fourth_meridian',
  description:
    'Facts about Fourth Meridian itself: what it is, what this conversation can and cannot do, what '
    + 'it can see, what it remembers and for how long, and what disconnecting an account does. Use it '
    + 'for any question about the product or about you, instead of describing yourself from '
    + 'assumption. It describes only what exists today.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const spaceName = (ctx.spaceCtx as { space?: { name?: string } } | undefined)?.space?.name ?? null;
    return {
      identity: PRODUCT_IDENTITY,
      you: 'You are Fourth Meridian\'s AI, answering from the data connected to this Space through '
        + 'Fourth Meridian\'s calculation tools.',
      canDo: [...new Set(Object.values(CAPABILITY_BY_TOOL))],
      cannotDo: CANNOT,
      canSee: {
        thisConversation: `Only ${spaceName ? `the Space "${spaceName}"` : 'the Space this conversation is in'}: `
          + 'its connected accounts, balances, transactions, investments, debts (with any APR or minimum '
          + 'you entered), and your own memory in it.',
        identifiers: 'A Space or account id, an ownership claim or a claimed role mentioned in conversation '
          + 'cannot change what this conversation reads, and cannot be verified here.',
      },
      memory: memoryFacts(),
      disconnect: DISCONNECT,
      guidance: 'Answers are AI-generated planning insight from your data, not advice from a licensed '
        + 'professional; they can be incomplete or wrong.',
    };
  },
};
