import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { requireOrgMember } from "./auth";
import { writeAuditLog } from "./internal";
import { commentDoc, paginatedComments } from "./types";

// Transitive auth: a comment's tenancy is its ticket's org, so every function
// loads the ticket first and gates on ticket.orgId.

export const addComment = mutation({
  args: { ticketId: v.id("tickets"), body: v.string() },
  returns: v.object({ commentId: v.id("comments"), comment: commentDoc }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const auth = await requireOrgMember(ctx, ticket.orgId);

    const now = Date.now();
    const commentId = await ctx.db.insert("comments", {
      ticketId: args.ticketId,
      author: auth.userId,
      body: args.body,
      createdAt: now,
    });

    await writeAuditLog(ctx, {
      orgId: ticket.orgId,
      userId: auth.userId,
      actionType: "comment.added",
      targetType: "comment",
      targetId: commentId,
      details: { ticketId: args.ticketId },
      timestamp: now,
    });

    const comment = await ctx.db.get(commentId);
    if (!comment) {
      throw new Error("Failed to load created comment");
    }
    return { commentId, comment };
  },
});

// by_ticketId already yields chronological order (Convex appends _creationTime),
// and pagination streams a long thread instead of .collect()-ing it whole.
export const listComments = query({
  args: {
    ticketId: v.id("tickets"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedComments,
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    await requireOrgMember(ctx, ticket.orgId);

    const result = await ctx.db
      .query("comments")
      .withIndex("by_ticketId", (q) => q.eq("ticketId", args.ticketId))
      .paginate(args.paginationOpts);

    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getComment = query({
  args: { commentId: v.id("comments") },
  returns: v.union(commentDoc, v.null()),
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) {
      return null;
    }
    const ticket = await ctx.db.get(comment.ticketId);
    if (!ticket) {
      throw new Error("Parent ticket not found");
    }
    await requireOrgMember(ctx, ticket.orgId);
    return comment;
  },
});
