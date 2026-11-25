import { RUN_LIFETIME_MS } from "./syncPlan.js";
export const NEW_REVIEW_MS = 30 * 60 * 1000;
// Fixed at creation/capture, never extended by reading. Import expiry is untouched.
export function newReviewDeadline(run, fetchedAt) {
  const started = run.startedAt == null ? +new Date(run.expiresAt) - RUN_LIFETIME_MS : +new Date(run.startedAt);
  return Math.min(started + NEW_REVIEW_MS, fetchedAt == null ? Infinity : +new Date(fetchedAt) + NEW_REVIEW_MS);
}
