/**
 * lib/ai/conversation/forecast-vocabulary.ts
 *
 * The forecast vocabulary the harness needs, re-exported THROUGH the sanctioned
 * adapter rather than reached for directly.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE A GUARD CAUGHT THE FIRST DRAFT. FORECAST-6, -8 and
 * -9 each pin that nothing outside `lib/forecast/` and `lib/ai/forecast/`
 * consumes them — "no assembler, prompt, route or component reaches past the
 * adapter into the authorities" — and this harness counts as production code to
 * those tests. Importing the cash engine directly, for one prose helper, failed
 * three suites — and the right response was to stop reaching past the seam, not
 * to widen the guard.
 *
 * (The guards are TEXT scans, so even naming the module path in a comment trips
 *  them. That is not a flaw: a path in a comment is how the next import starts.)
 *
 * `lib/ai/forecast/assemble.ts` already re-exports the enums and types its own
 * callers need. That IS the adapter boundary; this file is one hop through it.
 */

export {
  AssumptionOrigin, AssumptionStance, PeriodBasis, StatementMode,
  type AssembledForecast, type ForecastHorizon, type UserStatement,
} from '@/lib/ai/forecast/assemble';
