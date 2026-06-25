import { v } from "convex/values";

// Shared validators — defined once, imported by schema.ts AND the functions, so a
// table and its arg/return validators can never drift. (paginationOptsValidator is
// intentionally NOT here: the real one from "convex/server" is imported directly;
// re-implementing it diverges from what .paginate() expects.)

export const roleUnion = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);

export const ticketStatusUnion = v.union(
  v.literal("open"),
  v.literal("pending"),
  v.literal("closed"),
);

// Not v.any() (the brief forbids it): a typed map of JSON scalars, expressive
// enough for "from/to status, stale days" metadata while staying validated.
export const auditDetailsValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
);

// userId is id|null, not optional: v.optional means "may be absent" and rejects
// the value null, but system/automated events need an explicit null.
export const auditLogFields = {
  orgId: v.id("organizations"),
  userId: v.union(v.id("users"), v.null()),
  actionType: v.string(),
  targetType: v.string(),
  targetId: v.string(),
  details: v.optional(auditDetailsValidator),
  timestamp: v.number(),
};

// Document validators, reused as function return validators (include the _id /
// _creationTime system fields so a stored doc satisfies `returns:` directly).
export const organizationDoc = v.object({
  _id: v.id("organizations"),
  _creationTime: v.number(),
  name: v.string(),
  createdAt: v.number(),
  createdBy: v.id("users"),
});

export const membershipDoc = v.object({
  _id: v.id("memberships"),
  _creationTime: v.number(),
  userId: v.id("users"),
  orgId: v.id("organizations"),
  role: roleUnion,
  joinedAt: v.number(),
});

export const ticketDoc = v.object({
  _id: v.id("tickets"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  title: v.string(),
  description: v.string(),
  status: ticketStatusUnion,
  openedBy: v.id("users"),
  assigneeId: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const commentDoc = v.object({
  _id: v.id("comments"),
  _creationTime: v.number(),
  ticketId: v.id("tickets"),
  author: v.id("users"),
  body: v.string(),
  createdAt: v.number(),
});

export const auditLogDoc = v.object({
  _id: v.id("auditLog"),
  _creationTime: v.number(),
  ...auditLogFields,
});

// Pagination return validators. Exactly the three fields the handlers return:
// Convex rejects unexpected extra fields, and continueCursor is always a string.
export const paginatedMemberships = v.object({
  page: v.array(membershipDoc),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

export const paginatedTickets = v.object({
  page: v.array(ticketDoc),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

export const paginatedComments = v.object({
  page: v.array(commentDoc),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

export const paginatedAuditLog = v.object({
  page: v.array(auditLogDoc),
  isDone: v.boolean(),
  continueCursor: v.string(),
});
