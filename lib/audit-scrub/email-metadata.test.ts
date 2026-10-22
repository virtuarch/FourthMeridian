import { decideEmailScrub } from "./email-metadata";
import { auditEmailHash } from "@/lib/audit";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };

const a = decideEmailScrub({ email: " Jane@Example.com ", emailStatus: "sent" });
check("raw email → emailHash (normalised digest), other keys kept",
  a.kind === "rewrite" && a.metadata.emailHash === auditEmailHash("jane@example.com") && !("email" in a.metadata) && a.metadata.emailStatus === "sent");
const b = decideEmailScrub({ targetEmail: "x@y.z", targetUserId: "u1" });
check("raw targetEmail → targetEmailHash", b.kind === "rewrite" && b.metadata.targetEmailHash === auditEmailHash("x@y.z") && b.metadata.targetUserId === "u1");
check("already-hashed row is skipped (idempotent)", decideEmailScrub({ emailHash: "abc", emailStatus: "sent" }).kind === "skip");
const c = decideEmailScrub({ email: "p@q.r", emailHash: "existing" });
check("an existing digest is never overwritten; the raw key still goes", c.kind === "rewrite" && c.metadata.emailHash === "existing" && !("email" in c.metadata));
check("a non-address value is left alone", decideEmailScrub({ email: true }).kind === "skip" && decideEmailScrub({ email: "n/a" }).kind === "skip");
check("non-object metadata is skipped", decideEmailScrub(null).kind === "skip" && decideEmailScrub(["a@b.c"]).kind === "skip" && decideEmailScrub("a@b.c").kind === "skip");
const again = a.kind === "rewrite" ? decideEmailScrub(a.metadata) : { kind: "x" };
check("a second pass over a scrubbed row changes nothing", again.kind === "skip");
if (f) process.exit(1);
console.log("\nall checks passed");
