// Matches SQLite's own datetime('now') format — no T, no Z, no milliseconds —
// so the `${x}Z`-as-UTC parse trick and raw SQL comparisons both work correctly.
export function toSqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
