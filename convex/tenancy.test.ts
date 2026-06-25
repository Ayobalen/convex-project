import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

/**
 * TENANCY BOUNDARY TESTS
 *
 * These prove the core security property of a multi-tenant system: a user who is
 * not a member of an org CANNOT read or write that org's data, even with a valid
 * identity and a valid (guessed) ticket id. They exercise the real functions
 * end-to-end through `convex-test`, including the auth helpers and indexes.
 *
 * Convex needs the module map for `convex-test`; `import.meta.glob` is provided
 * by the Vite-based vitest runner (see vitest.config.ts).
 */
const modules = import.meta.glob("./**/*.*s");

/** Seed two users and give each an authenticated handle keyed by tokenIdentifier. */
async function seedUsers(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      tokenIdentifier: "test|alice",
      email: "alice@example.com",
      createdAt: 0,
    });
    const bobId = await ctx.db.insert("users", {
      tokenIdentifier: "test|bob",
      email: "bob@example.com",
      createdAt: 0,
    });
    const carolId = await ctx.db.insert("users", {
      tokenIdentifier: "test|carol",
      email: "carol@example.com",
      createdAt: 0,
    });
    return { aliceId, bobId, carolId };
  });

  const alice = t.withIdentity({
    tokenIdentifier: "test|alice",
    subject: "alice",
    issuer: "test",
  });
  const bob = t.withIdentity({
    tokenIdentifier: "test|bob",
    subject: "bob",
    issuer: "test",
  });
  const carol = t.withIdentity({
    tokenIdentifier: "test|carol",
    subject: "carol",
    issuer: "test",
  });

  return { ...ids, alice, bob, carol };
}

describe("tenancy boundary", () => {
  test("a non-member cannot READ another org's ticket", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);

    const orgA = await alice.mutation(api.orgs.createOrganization, {
      name: "Org A",
    });
    const ticket = await alice.mutation(api.tickets.createTicket, {
      orgId: orgA.orgId,
      title: "Secret ticket in Org A",
      description: "Only Org A members may see this",
    });

    // Bob is a real, authenticated user — but not a member of Org A.
    await expect(
      bob.query(api.tickets.getTicket, { ticketId: ticket.ticketId }),
    ).rejects.toThrow(/not a member/i);
  });

  test("a non-member cannot WRITE (change status of) another org's ticket", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);

    const orgA = await alice.mutation(api.orgs.createOrganization, {
      name: "Org A",
    });
    const ticket = await alice.mutation(api.tickets.createTicket, {
      orgId: orgA.orgId,
      title: "Org A ticket",
      description: "x",
    });

    await expect(
      bob.mutation(api.tickets.updateTicketStatus, {
        ticketId: ticket.ticketId,
        newStatus: "closed",
      }),
    ).rejects.toThrow(/not a member/i);
  });

  test("a non-member cannot LIST another org's tickets", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seedUsers(t);

    const orgA = await alice.mutation(api.orgs.createOrganization, {
      name: "Org A",
    });

    await expect(
      bob.query(api.tickets.listTickets, {
        orgId: orgA.orgId,
        status: "open",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/not a member/i);
  });

  test("a member CAN read their own org's ticket (positive control)", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);

    const orgA = await alice.mutation(api.orgs.createOrganization, {
      name: "Org A",
    });
    const created = await alice.mutation(api.tickets.createTicket, {
      orgId: orgA.orgId,
      title: "Visible to Alice",
      description: "x",
    });

    const fetched = await alice.query(api.tickets.getTicket, {
      ticketId: created.ticketId,
    });
    expect(fetched?.title).toBe("Visible to Alice");
  });

  test("a plain member cannot assign tickets (role gate)", async () => {
    const t = convexTest(schema, modules);
    const { alice, carol, carolId } = await seedUsers(t);

    const orgA = await alice.mutation(api.orgs.createOrganization, {
      name: "Org A",
    });
    // Alice (owner) adds Carol as a plain member.
    await alice.mutation(api.orgs.addMember, {
      orgId: orgA.orgId,
      userId: carolId,
      role: "member",
    });
    const ticket = await alice.mutation(api.tickets.createTicket, {
      orgId: orgA.orgId,
      title: "Needs assignment",
      description: "x",
    });

    // Carol is a member, so this is NOT a tenancy failure — it's a role failure.
    await expect(
      carol.mutation(api.tickets.assignTicket, {
        ticketId: ticket.ticketId,
        assigneeId: carolId,
      }),
    ).rejects.toThrow(/admin privileges required/i);
  });

  test("an unauthenticated caller is rejected", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedUsers(t);
    const orgA = await alice.mutation(api.orgs.createOrganization, {
      name: "Org A",
    });

    // No identity attached → getUserIdentity() returns null.
    await expect(
      t.query(api.orgs.getOrganization, { orgId: orgA.orgId }),
    ).rejects.toThrow(/not authenticated/i);
  });
});
