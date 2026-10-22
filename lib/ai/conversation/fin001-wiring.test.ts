/**
 * FIN-001 wiring — the income-completeness verdicts reach the model.
 *
 * lib/ai/forecast/income-completeness.ts now marks a recently-silent or
 * feed-stale payroll stream RECENTLY_SILENT / UNKNOWN (blocking, with a bound).
 * project_cash returned INCOMPLETE_ESTIMATE for it but listed no omitted stream
 * until tools.ts filtered on isOmittedLine; get_baselines fell silently from
 * CADENCE to MEASURED until it passed the stream's continuation. This file pins
 * both seams (tools.ts cannot be imported without its DB-bound graph) and proves
 * the adapter carries the continuation behaviourally.
 */
import { incomeStreamEvidence } from '@/lib/ai/forecast/income-evidence';
import { readToolsSource } from '@/lib/test-support/tools-source';

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

// CQ-011: the tool layer (facade + lib/ai/conversation/tools/**) — incompletenessBlock now
// lives in tools/projection.ts, get_baselines in tools/measures.ts.
const tools = readToolsSource();
const block = tools.slice(tools.indexOf('function incompletenessBlock'), tools.indexOf('function projectionQualification'));
const qual = tools.slice(tools.indexOf('function projectionQualification'), tools.indexOf('function projectionQualification') + 2500);

check('incompletenessBlock lists every omitted status (isOmittedLine), not only AMOUNT_UNESTABLISHED',
  /isOmittedLine\(l\) && l\.material/.test(block) && !/status === 'AMOUNT_UNESTABLISHED' && l\.material/.test(block));
check('each omitted stream carries its status and silence', /status: l\.status, silence: l\.silence \?\? null/.test(block));
check('the meaning sentence names the reason per status',
  /RECENTLY_SILENT: its latest scheduled payment has not arrived/.test(block) && /UNKNOWN: the account/.test(block));
check('the INCOMPLETE qualification no longer says "could not be priced"', !/could not be priced/.test(qual));
check('minor omitted streams use isOmittedLine', /isOmittedLine\(l\) && !l\.material/.test(qual));
check('get_baselines passes continuationOf(s) into the evidence adapter',
  /stillPaying: s\.projectionEligible,\n[^\n]*\n\s*continuation: continuationOf\(s\),/.test(tools));

const ev = incomeStreamEvidence({ label: 'Acme Payroll', cadence: 'BIWEEKLY' as never, typicalAmount: 3000, stillPaying: false, continuation: 'RECENTLY_SILENT' });
check('the adapter carries continuation', ev.continuation === 'RECENTLY_SILENT' && ev.stillPaying === false);
const ev0 = incomeStreamEvidence({ cadence: null, typicalAmount: null, stillPaying: true });
check('absent continuation stays absent (existing callers unchanged)', !('continuation' in ev0));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
