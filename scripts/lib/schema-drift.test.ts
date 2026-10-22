import { driftStatements, shadowServerAllowed, shadowUrl } from "./schema-drift";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
check("empty diff ⇒ no statements", driftStatements("-- This is an empty migration.\n\n").length === 0);
check("statements kept, comments dropped", driftStatements("-- AlterIndex\nALTER INDEX \"a\" RENAME TO \"b\";\n").length === 1);
check("CI service URL allowed", shadowServerAllowed("postgresql://fintracker:fintracker@localhost:5432/fintracker_ci?schema=public").ok);
check("127.0.0.1 allowed", shadowServerAllowed("postgresql://u:p@127.0.0.1:55432/fintracker_x").ok);
check("hosted host refused", !shadowServerAllowed("postgresql://u:p@db.abcd.supabase.co:5432/postgres").ok);
check("pooler refused even on localhost", !shadowServerAllowed("postgresql://u:p@localhost:6543/x?pgbouncer=true").ok);
check("unset refused", !shadowServerAllowed(undefined).ok);
check("shadow URL keeps server and credentials, swaps the database, drops params",
  shadowUrl("postgresql://u:p@localhost:5432/fintracker_ci?schema=public", "fintracker_driftshadow_1") === "postgresql://u:p@localhost:5432/fintracker_driftshadow_1");
if (f) process.exit(1);
console.log("\nall checks passed");
