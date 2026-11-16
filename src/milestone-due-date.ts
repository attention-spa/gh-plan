/**
 * Milestone due dates are authored as UTC calendar dates. GitHub REST represents
 * them as ISO 8601 timestamps, possibly at a non-midnight time.
 *
 * Keep date comparison independent from the time of day and host timezone.
 * These helpers perform no I/O and are intentionally not public entrypoint exports.
 */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

export function toGithubMilestoneDueOn(value: string): string {
  if (!isIsoCalendarDate(value)) throw new RangeError("Expected a valid YYYY-MM-DD date.");
  return value + "T00:00:00Z";
}

/** Undefined means an invalid/unsupported response timestamp, not a missing date. */
export function fromGithubMilestoneDueOn(value: unknown): string | undefined {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  const day = parsed.toISOString().slice(0, 10);
  return isIsoCalendarDate(day) ? day : undefined;
}
