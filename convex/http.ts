import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Inbound email-to-ticket webhook. An httpAction is an ACTION context, so it
// legitimately uses ctx.runMutation to reach the internal ingest mutation.
const http = httpRouter();

interface EmailPayload {
  orgId: string;
  senderEmail: string;
  subject: string;
  body: string;
}

// Hand-rolled because Convex value validators describe function args and have no
// runtime .parse() — deeper id/membership checks happen inside the ingest mutation.
function parseEmailPayload(raw: unknown): EmailPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.orgId !== "string" ||
    typeof r.senderEmail !== "string" ||
    typeof r.subject !== "string" ||
    typeof r.body !== "string"
  ) {
    return null;
  }
  return {
    orgId: r.orgId,
    senderEmail: r.senderEmail,
    subject: r.subject,
    body: r.body,
  };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

http.route({
  path: "/email-to-ticket",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse(400, { error: "Body is not valid JSON" });
    }

    const payload = parseEmailPayload(raw);
    if (!payload) {
      return jsonResponse(400, {
        error:
          "Expected { orgId, senderEmail, subject, body } as strings",
      });
    }

    const result = await ctx.runMutation(
      internal.tickets.ingestEmailAsTicket,
      payload,
    );

    if (!result.created) {
      // Validated request, but the org/sender/membership checks didn't pass.
      // 202 Accepted: the message was received and intentionally not actioned.
      return jsonResponse(202, { received: true, ticketCreated: false });
    }

    return jsonResponse(201, {
      received: true,
      ticketCreated: true,
      ticketId: result.ticketId,
    });
  }),
});

export default http;
