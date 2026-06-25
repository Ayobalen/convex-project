import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { roleUnion, ticketStatusUnion, auditLogFields } from "./types";

// Index discipline: a Convex index on ["a","b"] also serves equality lookups on
// ["a"] (prefix scan) and implicitly ends with _creationTime. So a single-field
// index that is the prefix of a compound one is redundant — there are none here.
export default defineSchema({
  // Fetched only by _id; "a user's orgs" comes from memberships, never a scan here.
  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  }),

  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"]) // login: token -> user
    .index("by_email", ["email"]), // webhook: sender address -> user

  // The many-to-many at the heart of access control.
  memberships: defineTable({
    userId: v.id("users"),
    orgId: v.id("organizations"),
    role: roleUnion,
    joinedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    // Access-control hot path + uniqueness. Its ["orgId"] prefix lists an org's
    // members, so a separate by_orgId index would be redundant.
    .index("by_orgId_userId", ["orgId", "userId"]),

  tickets: defineTable({
    orgId: v.id("organizations"),
    title: v.string(),
    description: v.string(),
    status: ticketStatusUnion,
    openedBy: v.id("users"),
    assigneeId: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Primary list query; its ["orgId"] prefix also covers "all tickets in org",
    // so no separate by_orgId index.
    .index("by_orgId_status", ["orgId", "status"])
    .index("by_orgId_assigneeId", ["orgId", "assigneeId"])
    // Cron only. Deliberately NOT org-scoped: the sweep spans every tenant, and
    // ordering by updatedAt lets it read just the stale rows, not the whole table.
    .index("by_status_updatedAt", ["status", "updatedAt"]),

  // by_ticketId already returns comments in chronological order (Convex appends
  // _creationTime), so a separate by_ticketId_createdAt index would be redundant.
  comments: defineTable({
    ticketId: v.id("tickets"),
    author: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  }).index("by_ticketId", ["ticketId"]),

  // Append-only; written only by internal functions (internal.ts) so it can't be
  // forged. Field set shared via auditLogFields so table and validators can't drift.
  auditLog: defineTable(auditLogFields).index("by_orgId_timestamp", [
    "orgId",
    "timestamp",
  ]),
});
