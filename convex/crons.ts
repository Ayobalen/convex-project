import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// The job is referenced via the generated `internal` API (a FunctionReference),
// NOT by importing the function object — that reference is what the scheduler
// requires. autoCloseStaleTickets is an internalMutation, so it isn't client-callable.
const crons = cronJobs();

crons.daily(
  "auto-close-stale-tickets",
  { hourUTC: 0, minuteUTC: 0 },
  internal.tickets.autoCloseStaleTickets,
);

export default crons;
