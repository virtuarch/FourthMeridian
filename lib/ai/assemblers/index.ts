/**
 * lib/ai/assemblers/index.ts
 *
 * Assembler bootstrap barrel.
 *
 * Each import below is a side-effect import — the module calls
 * registerAssembler() at load time, so importing this barrel is sufficient to
 * guarantee all assemblers are registered before buildContext() runs.
 *
 * To add a new assembler:
 *   1. Create lib/ai/assemblers/<domain>.ts
 *   2. Call registerAssembler(domain, fn) at the bottom of that file
 *   3. Add one import line here — nothing else changes
 */

// Finance assemblers (D4 Slice 2+)
import './accounts';
import './snapshot';
import './goals';
