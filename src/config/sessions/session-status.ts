import type { SessionEntry } from "./types.js";

export function isTerminalSessionStatus(
  status: unknown,
): status is Exclude<NonNullable<SessionEntry["status"]>, "running"> {
  return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}
