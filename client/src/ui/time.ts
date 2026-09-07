/**
 * Shared timestamp formatting utilities.
 *
 * - `fmtRel`: pure relative ("just now", "5m ago", "3h ago", "2d ago")
 * - `fmtHybrid`: relative for <24h, then "M/D HH:MM" with TZ abbreviation
 * - `fmtNext`: future relative ("in 5m", "in 2h", "in 3d")
 */

/** Relative time elapsed, e.g. "5m ago", "3h ago", "2d ago". */
export function fmtRel(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Hybrid: relative for recent (<24h), absolute "M/D HH:MM" with TZ
 * abbreviation for older entries. Best for activity feeds where you
 * want "5m ago" now but "Aug 20, 2:45 PM EDT" for last week.
 */
export function fmtHybrid(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  if (diff < 86_400_000) return fmtRel(ts);
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Compact time-only "HH:MM" with TZ abbreviation for log-style displays. */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Future relative, e.g. "in 5m", "in 2h", "in 3d". */
export function fmtNext(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return "now";
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / 86_400_000)}d`;
}
