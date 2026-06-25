import { QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Convex enforces no tenant isolation at the DB layer, so it lives here: every
// public function gates through these helpers before touching org data. They are
// the single implementation of authn + authz, throw on failure, and return the
// typed context callers need — so no handler re-implements the membership lookup.

export interface AuthContext {
  userId: Id<"users">;
  tokenIdentifier: string;
  orgId: Id<"organizations">;
  role: "owner" | "admin" | "member";
}

export async function getAuthenticatedUser(
  ctx: QueryCtx | MutationCtx,
): Promise<{ userId: Id<"users">; tokenIdentifier: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized: not authenticated");
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();

  if (!user) {
    throw new Error("Unauthorized: user not found (sign up first)");
  }

  return { userId: user._id, tokenIdentifier: identity.tokenIdentifier };
}

// Core gate. Authenticates once (no duplicate lookups), then resolves the single
// membership row via by_orgId_userId. The role helpers below layer on top so the
// membership check is written exactly once.
export async function requireOrgMember(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
): Promise<AuthContext> {
  const { userId, tokenIdentifier } = await getAuthenticatedUser(ctx);

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_orgId_userId", (q) =>
      q.eq("orgId", orgId).eq("userId", userId),
    )
    .unique();

  if (!membership) {
    throw new Error("Unauthorized: not a member of this organization");
  }

  return { userId, tokenIdentifier, orgId, role: membership.role };
}

export async function requireOrgAdmin(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
): Promise<AuthContext> {
  const auth = await requireOrgMember(ctx, orgId);
  if (auth.role !== "admin" && auth.role !== "owner") {
    throw new Error("Unauthorized: admin privileges required");
  }
  return auth;
}

export async function requireOrgOwner(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
): Promise<AuthContext> {
  const auth = await requireOrgMember(ctx, orgId);
  if (auth.role !== "owner") {
    throw new Error("Unauthorized: owner privileges required");
  }
  return auth;
}
