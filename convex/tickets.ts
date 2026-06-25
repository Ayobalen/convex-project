import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { requireOrgMember, requireOrgAdmin } from "./auth";
import { writeAuditLog } from "./internal";
import {
  ticketStatusUnion,
  ticketDoc,
  paginatedTickets,
} from "./types";

// Tenancy rule throughout: the org is read from the ticket itself, then the gate
// runs against THAT org — so a guessed ticketId from another tenant fails the
// membership check. Cross-org access is impossible.

export const createTicket = mutation({
  args: {
    orgId: v.id("organizations"),
    title: v.string(),
    description: v.string(),
  },
  returns: v.object({ ticketId: v.id("tickets"), ticket: ticketDoc }),
  handler: async (ctx, args) => {
    const auth = await requireOrgMember(ctx, args.orgId);

    const now = Date.now();
    const ticketId = await ctx.db.insert("tickets", {
      orgId: args.orgId,
      title: args.title,
      description: args.description,
      status: "open",
      openedBy: auth.userId,
      // assigneeId omitted — an optional field is simply absent until assigned.
      createdAt: now,
      updatedAt: now,
    });

    await writeAuditLog(ctx, {
      orgId: args.orgId,
      userId: auth.userId,
      actionType: "ticket.created",
      targetType: "ticket",
      targetId: ticketId,
      details: { title: args.title },
      timestamp: now,
    });

    const ticket = await ctx.db.get(ticketId);
    if (!ticket) {
      throw new Error("Failed to load created ticket");
    }
    return { ticketId, ticket };
  },
});

// Paginated through by_orgId_status, never .collect()'d. Two reasons: an unbounded
// collect loads every ticket into one function's memory, and — because this is a
// live query — it re-runs whenever ANY ticket it read changes. Reading only one
// (orgId, status) index range keeps both the read and the reactive recompute small:
// flipping a ticket open->pending wakes the "open" subscription (the row left its
// range) but not other orgs' or other statuses' lists.
export const listTickets = query({
  args: {
    orgId: v.id("organizations"),
    status: ticketStatusUnion,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedTickets,
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.orgId);

    const result = await ctx.db
      .query("tickets")
      .withIndex("by_orgId_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status),
      )
      .paginate(args.paginationOpts);

    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listMyAssignedTickets = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedTickets,
  handler: async (ctx, args) => {
    const auth = await requireOrgMember(ctx, args.orgId);

    const result = await ctx.db
      .query("tickets")
      .withIndex("by_orgId_assigneeId", (q) =>
        q.eq("orgId", args.orgId).eq("assigneeId", auth.userId),
      )
      .paginate(args.paginationOpts);

    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getTicket = query({
  args: { ticketId: v.id("tickets") },
  returns: v.union(ticketDoc, v.null()),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) {
      return null;
    }
    await requireOrgMember(ctx, ticket.orgId);
    return ticket;
  },
});

export const updateTicketStatus = mutation({
  args: { ticketId: v.id("tickets"), newStatus: ticketStatusUnion },
  returns: v.object({ ticket: ticketDoc }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const auth = await requireOrgMember(ctx, ticket.orgId);

    await ctx.db.patch(args.ticketId, {
      status: args.newStatus,
      updatedAt: Date.now(),
    });

    await writeAuditLog(ctx, {
      orgId: ticket.orgId,
      userId: auth.userId,
      actionType: "ticket.status_changed",
      targetType: "ticket",
      targetId: ticket._id,
      details: { from: ticket.status, to: args.newStatus },
      timestamp: Date.now(),
    });

    const updated = await ctx.db.get(args.ticketId);
    if (!updated) {
      throw new Error("Failed to load updated ticket");
    }
    return { ticket: updated };
  },
});

// Admin/owner only; the assignee must belong to the same org.
export const assignTicket = mutation({
  args: { ticketId: v.id("tickets"), assigneeId: v.id("users") },
  returns: v.object({ ticket: ticketDoc }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const auth = await requireOrgAdmin(ctx, ticket.orgId);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", ticket.orgId).eq("userId", args.assigneeId),
      )
      .unique();
    if (!membership) {
      throw new Error("Assignee is not a member of this organization");
    }

    await ctx.db.patch(args.ticketId, {
      assigneeId: args.assigneeId,
      updatedAt: Date.now(),
    });

    await writeAuditLog(ctx, {
      orgId: ticket.orgId,
      userId: auth.userId,
      actionType: "ticket.assigned",
      targetType: "ticket",
      targetId: ticket._id,
      details: { assigneeId: args.assigneeId },
      timestamp: Date.now(),
    });

    const updated = await ctx.db.get(args.ticketId);
    if (!updated) {
      throw new Error("Failed to load updated ticket");
    }
    return { ticket: updated };
  },
});

/**
 * UNASSIGN TICKET — admin/owner only. Patching `assigneeId: undefined` removes
 * the optional field.
 */
export const unassignTicket = mutation({
  args: { ticketId: v.id("tickets") },
  returns: v.object({ ticket: ticketDoc }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const auth = await requireOrgAdmin(ctx, ticket.orgId);

    await ctx.db.patch(args.ticketId, {
      assigneeId: undefined,
      updatedAt: Date.now(),
    });

    await writeAuditLog(ctx, {
      orgId: ticket.orgId,
      userId: auth.userId,
      actionType: "ticket.unassigned",
      targetType: "ticket",
      targetId: ticket._id,
      details: {},
      timestamp: Date.now(),
    });

    const updated = await ctx.db.get(args.ticketId);
    if (!updated) {
      throw new Error("Failed to load updated ticket");
    }
    return { ticket: updated };
  },
});

// Internal, so only the webhook can call it. The trust boundary: normalizeId
// turns the external orgId string into a real Id or null (no unsafe cast), and a
// ticket is opened only if the sender is a known member of that org (tenancy).
export const ingestEmailAsTicket = internalMutation({
  args: {
    orgId: v.string(),
    senderEmail: v.string(),
    subject: v.string(),
    body: v.string(),
  },
  returns: v.object({
    created: v.boolean(),
    ticketId: v.union(v.id("tickets"), v.null()),
  }),
  handler: async (ctx, args) => {
    const orgId = ctx.db.normalizeId("organizations", args.orgId);
    if (!orgId) {
      return { created: false, ticketId: null };
    }

    const sender = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.senderEmail))
      .first();
    if (!sender) {
      return { created: false, ticketId: null };
    }

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", orgId).eq("userId", sender._id),
      )
      .unique();
    if (!membership) {
      // Sender exists but isn't in this org — refuse (tenancy boundary).
      return { created: false, ticketId: null };
    }

    const now = Date.now();
    const ticketId = await ctx.db.insert("tickets", {
      orgId,
      title: args.subject,
      description: args.body,
      status: "open",
      openedBy: sender._id,
      createdAt: now,
      updatedAt: now,
    });

    await writeAuditLog(ctx, {
      orgId,
      userId: sender._id,
      actionType: "ticket.created_from_email",
      targetType: "ticket",
      targetId: ticketId,
      details: { senderEmail: args.senderEmail, subject: args.subject },
      timestamp: now,
    });

    return { created: true, ticketId };
  },
});

// Cron body (internalMutation, so clients can't call it). The by_status_updatedAt
// RANGE (updatedAt < cutoff, per active status) reads ONLY the stale rows instead
// of scanning every org's tickets. Audit goes through the plain writeAuditLog
// helper because a mutation cannot call ctx.runMutation.
const STALE_DAYS = 30;
const STALE_STATUSES = ["open", "pending"] as const;

export const autoCloseStaleTickets = internalMutation({
  args: {},
  returns: v.object({ closed: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
    let closed = 0;

    for (const status of STALE_STATUSES) {
      const stale = await ctx.db
        .query("tickets")
        .withIndex("by_status_updatedAt", (q) =>
          q.eq("status", status).lt("updatedAt", cutoff),
        )
        .collect();

      for (const ticket of stale) {
        const now = Date.now();
        await ctx.db.patch(ticket._id, { status: "closed", updatedAt: now });
        await writeAuditLog(ctx, {
          orgId: ticket.orgId,
          userId: null, // system/automated event
          actionType: "ticket.auto_closed",
          targetType: "ticket",
          targetId: ticket._id,
          details: { previousStatus: status, staleDays: STALE_DAYS },
          timestamp: now,
        });
        closed += 1;
      }
    }

    return { closed };
  },
});
