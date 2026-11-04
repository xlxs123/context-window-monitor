export interface SessionLabel {
  sessionId: string;
  title?: string | null;
  agentName?: string | null;
  model?: string | null;
}

export function isGuardianSession(session: SessionLabel): boolean {
  return session.model === "codex-auto-review" ||
    [session.title, session.agentName].some(value => /^guardian\s+review$/iu.test(value?.trim() ?? ""));
}

export function visibleSessions<T extends SessionLabel>(sessions: T[], showGuardianReviews: boolean): T[] {
  return showGuardianReviews ? sessions : sessions.filter(session => !isGuardianSession(session));
}

export function sessionLabel(session: SessionLabel): string {
  const title = session.title?.trim() || session.agentName?.trim();
  if (!title) return session.sessionId;
  const text = title.replace(/\s+/gu, " ");
  return `${text.length > 80 ? `${text.slice(0, 80)}…` : text} · ${session.sessionId.slice(0, 8)}`;
}
