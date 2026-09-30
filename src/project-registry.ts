import { promises as fs } from "node:fs";
import path from "node:path";

export interface CodexProject { id: string; name: string; root: string }
export interface ProjectSnapshot { projects: CodexProject[]; source: string; complete: boolean }

/** Read only the app's registered projects; never scan drives or revive saved history. */
export async function discoverProjects(codexHome: string): Promise<ProjectSnapshot> {
  const files = await fs.readdir(codexHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const databases = files.filter(file => /^state_\d+\.sqlite$/u.test(file))
    .sort((a, b) => Number(b.match(/\d+/u)![0]) - Number(a.match(/\d+/u)![0]));
  if (databases.length) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(codexHome, databases[0]!), { readOnly: true });
    try {
      const hasProjects = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
      if (hasProjects) {
        const rows = database.prepare("SELECT p.id, p.name, r.path FROM projects p JOIN project_roots r ON r.project_id=p.id WHERE r.position=0 ORDER BY p.position").all();
        const projects = rows.map(row => {
          if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.path !== "string" || !path.isAbsolute(row.path)) throw new Error("Invalid project registry entry");
          return { id: row.id, name: row.name, root: path.resolve(row.path) };
        });
        return { projects, source: databases[0]!, complete: true };
      }
    } finally { database.close(); }
  }
  const stateFile = path.join(codexHome, ".codex-global-state.json");
  let raw;
  try { raw = await fs.readFile(stateFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [], source: "unavailable", complete: false };
    throw error;
  }
  const state = JSON.parse(raw);
  if (!state["local-projects"] || typeof state["local-projects"] !== "object" || Array.isArray(state["local-projects"])) throw new Error("Unrecognized project registry");
  const projects: CodexProject[] = [];
  for (const [id, value] of Object.entries(state["local-projects"])) {
    const project = value as { name?: unknown; rootPaths?: unknown };
    if (!Array.isArray(project.rootPaths) || typeof project.rootPaths[0] !== "string" || !path.isAbsolute(project.rootPaths[0])) throw new Error("Invalid legacy project entry");
    projects.push({ id, name: typeof project.name === "string" ? project.name : id, root: path.resolve(project.rootPaths[0]) });
  }
  return { projects, source: ".codex-global-state.json", complete: true };
}
