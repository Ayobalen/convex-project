import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  getAuthenticatedUser,
  requireOrgMember,
  requireOrgAdmin,
} from "./auth";
import { writeAuditLog } from "./internal";
import {
  roleUnion,
  organizationDoc,
  membershipDoc,
  paginatedMemberships,
  paginatedAuditLog,
} from "./types";

// Invariant across this module: an org always keeps at least one owner —
// demote/remove/leave all refuse to drop the last one.

// No org gate: the org doesn't exist yet, so authenticate only. Creator = owner.
export const createOrganization = mutation({
  args: { name: v.string() },
  returns: v.object({
    orgId: v.id("organizations"),
    organization: organizationDoc,
    membershipId: v.id("memberships"),
  }),
  handler: async (ctx, args) => {
    const { userId } = await getAuthenticatedUser(ctx);

    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      name: args.name,
      createdAt: now,
      createdBy: userId,
    });

    const membershipId = await ctx.db.insert("memberships", {
      userId,
      orgId,
      role: "owner",
      joinedAt: now,
    });

    await writeAuditLog(ctx, {
      orgId,
      userId,
      actionType: "organization.created",
      targetType: "organization",
      targetId: orgId,
      details: { name: args.name },
      timestamp: now,
    });

    const organization = await ctx.db.get(orgId);
    if (!organization) {
      throw new Error("Failed to load created organization");
    }

    return { orgId, organization, membershipId };
  },
});

// Paginated through the ["orgId"] prefix of by_orgId_userId — index-backed without
// a dedicated by_orgId index, and never .collect()'d (an org may have thousands).
export const listOrgMembers = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedMemberships,
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.orgId);

    const result = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) => q.eq("orgId", args.orgId))
      .paginate(args.paginationOpts);

    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * ADD MEMBER — admin/owner only. Rejects duplicates via the unique by_orgId_userId
 * lookup.
 */
export const addMember = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: roleUnion,
  },
  returns: v.object({
    membershipId: v.id("memberships"),
    membership: membershipDoc,
  }),
  handler: async (ctx, args) => {
    const auth = await requireOrgAdmin(ctx, args.orgId);

    const targetUser = await ctx.db.get(args.userId);
    if (!targetUser) {
      throw new Error("User not found");
    }

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.userId),
      )
      .unique();
    if (existing) {
      throw new Error("User is already a member of this organization");
    }

    const now = Date.now();
    const membershipId = await ctx.db.insert("memberships", {
      userId: args.userId,
      orgId: args.orgId,
      role: args.role,
      joinedAt: now,
    });

    await writeAuditLog(ctx, {
      orgId: args.orgId,
      userId: auth.userId,
      actionType: "membership.added",
      targetType: "membership",
      targetId: membershipId,
      details: { memberUserId: args.userId, role: args.role },
      timestamp: now,
    });

    const membership = await ctx.db.get(membershipId);
    if (!membership) {
      throw new Error("Failed to load created membership");
    }

    return { membershipId, membership };
  },
});

// Bounded internal invariant check (one org's members), not a public listing —
// so .collect() here is intentional, not the unbounded-scan anti-pattern.
async function countOwners(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
): Promise<number> {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_orgId_userId", (q) => q.eq("orgId", orgId))
    .collect();
  return members.filter((m) => m.role === "owner").length;
}

export const updateMemberRole = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    newRole: roleUnion,
  },
  returns: v.object({ membership: membershipDoc }),
  handler: async (ctx, args) => {
    const auth = await requireOrgAdmin(ctx, args.orgId);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.userId),
      )
      .unique();
    if (!membership) {
      throw new Error("User is not a member of this organization");
    }

    if (
      membership.role === "owner" &&
      args.newRole !== "owner" &&
      (await countOwners(ctx, args.orgId)) === 1
    ) {
      throw new Error("Cannot demote the only owner. Transfer ownership first.");
    }

    await ctx.db.patch(membership._id, { role: args.newRole });

    await writeAuditLog(ctx, {
      orgId: args.orgId,
      userId: auth.userId,
      actionType: "membership.role_changed",
      targetType: "membership",
      targetId: membership._id,
      details: { from: membership.role, to: args.newRole },
      timestamp: Date.now(),
    });

    const updated = await ctx.db.get(membership._id);
    if (!updated) {
      throw new Error("Failed to load updated membership");
    }
    return { membership: updated };
  },
});

export const removeMember = mutation({
  args: { orgId: v.id("organizations"), userId: v.id("users") },
  returns: v.object({ removedMembershipId: v.id("memberships") }),
  handler: async (ctx, args) => {
    const auth = await requireOrgAdmin(ctx, args.orgId);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.userId),
      )
      .unique();
    if (!membership) {
      throw new Error("User is not a member of this organization");
    }

    if (
      membership.role === "owner" &&
      (await countOwners(ctx, args.orgId)) === 1
    ) {
      throw new Error("Cannot remove the only owner. Transfer ownership first.");
    }

    await ctx.db.delete(membership._id);

    await writeAuditLog(ctx, {
      orgId: args.orgId,
      userId: auth.userId,
      actionType: "membership.removed",
      targetType: "membership",
      targetId: membership._id,
      details: { memberUserId: args.userId },
      timestamp: Date.now(),
    });

    return { removedMembershipId: membership._id };
  },
});

export const leaveOrganization = mutation({
  args: { orgId: v.id("organizations") },
  returns: v.object({ leftOrgId: v.id("organizations") }),
  handler: async (ctx, args) => {
    const auth = await requireOrgMember(ctx, args.orgId);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", args.orgId).eq("userId", auth.userId),
      )
      .unique();
    if (!membership) {
      throw new Error("Not a member of this organization");
    }

    if (
      membership.role === "owner" &&
      (await countOwners(ctx, args.orgId)) === 1
    ) {
      throw new Error(
        "You cannot leave as the only owner. Transfer ownership first.",
      );
    }

    await ctx.db.delete(membership._id);

    await writeAuditLog(ctx, {
      orgId: args.orgId,
      userId: auth.userId,
      actionType: "membership.left",
      targetType: "membership",
      targetId: membership._id,
      details: {},
      timestamp: Date.now(),
    });

    return { leftOrgId: args.orgId };
  },
});

export const getOrganization = query({
  args: { orgId: v.id("organizations") },
  returns: v.union(organizationDoc, v.null()),
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.orgId);
    return await ctx.db.get(args.orgId);
  },
});

// Admin-only. Scoped to the caller's org via by_orgId_timestamp (no full scan).
export const listAuditLog = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedAuditLog,
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.orgId);

    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_orgId_timestamp", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
