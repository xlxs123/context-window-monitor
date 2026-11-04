import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Read display names only, without opening message bodies or changing app state. */
export async function sessionTitles(ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!ids.length) return titles;
  const configured = process.env.CODEX_HOME?.trim();
  const home = configured && !configured.includes("${") ? configured : path.join(homedir(), ".codex");
  try {
    const files = (await fs.readdir(home)).filter(file => /^state_\d+\.sqlite$/u.test(file))
      .sort((a, b) => Number(b.match(/\d+/u)![0]) - Number(a.match(/\d+/u)![0]));
    if (!files[0]) return titles;
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(home, files[0]), { readOnly: true });
    try {
      const columns = database.prepare("PRAGMA table_info(threads)").all();
      const display = columns.some(column => column.name === "name")
        ? "COALESCE(NULLIF(TRIM(name), ''), title)" : "title";
      const query = database.prepare(`SELECT ${display} AS title FROM threads WHERE id = ?`);
      for (const id of ids) {
        const row = query.get(id);
        if (typeof row?.title === "string" && row.title.trim()) titles.set(id, row.title.trim());
      }
    } finally { database.close(); }
  } catch { /* Older clients, missing databases and locked stores retain ID selection. */ }
  return titles;
}
