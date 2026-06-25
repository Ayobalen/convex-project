import { v, Infer } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { auditLogFields } from "./types";

// The only path that writes the append-only auditLog, in two forms because a
// mutation/cron CANNOT call ctx.runMutation (only actions can):
//  - writeAuditLog: a plain helper called in-process by mutations and the cron.
//  - logAuditEvent: an internalMutation wrapping it, so the webhook's ACTION
//    context can log via ctx.runMutation. Both are unreachable by clients, so the
//    trail can't be forged.

const auditEntryValidator = v.object(auditLogFields);
export type AuditEntry = Infer<typeof auditEntryValidator>;

export async function writeAuditLog(
  ctx: MutationCtx,
  entry: AuditEntry,
): Promise<void> {
  await ctx.db.insert("auditLog", entry);
}

export const logAuditEvent = internalMutation({
  args: auditLogFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeAuditLog(ctx, args);
    return null;
  },
});
