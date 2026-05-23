import Database from "better-sqlite3";
import { existsSync } from "fs";
import { activeStateDbPath } from "./utils";
import type { Attachment } from "../shared/attachments";
import { isImageMime } from "../shared/attachments";
import { removeSessionFromCache } from "./session-cache";

// Sentinel prefix used by hermes-agent's hermes_state.py to mark
// JSON-encoded multimodal content in the messages.content column.
// See agent source: hermes_state._CONTENT_JSON_PREFIX = "\x00json:".
const CONTENT_JSON_PREFIX = "\x00json:";

export interface SessionSummary {
  id: string;
  source: string;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  model: string;
  title: string | null;
  preview: string;
}

export interface SessionMessage {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  attachments?: Attachment[];
}

interface DecodedContent {
  text: string;
  attachments: Attachment[];
}

/**
 * Decode the agent's `messages.content` cell.  Plain strings are returned
 * verbatim; values with the agent's JSON-prefix sentinel are unpacked into
 * a text portion (concatenated `{type:"text"}` parts) plus an attachment
 * list (reconstituted from `{type:"image_url"}` parts).  Unknown or
 * malformed shapes fall through to the raw string.
 */
export function decodeContent(raw: string, messageId: number): DecodedContent {
  if (!raw || !raw.startsWith(CONTENT_JSON_PREFIX)) {
    return { text: raw || "", attachments: [] };
  }
  let parts: unknown;
  try {
    parts = JSON.parse(raw.slice(CONTENT_JSON_PREFIX.length));
  } catch {
    return { text: raw, attachments: [] };
  }
  if (!Array.isArray(parts)) {
    return { text: typeof parts === "string" ? parts : raw, attachments: [] };
  }

  const texts: string[] = [];
  const attachments: Attachment[] = [];
  let idx = 0;
  for (const p of parts) {
    if (typeof p === "string") {
      if (p) texts.push(p);
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const type = String(
      (p as Record<string, unknown>).type || "",
    ).toLowerCase();
    if (type === "text" || type === "input_text" || type === "output_text") {
      const t = (p as Record<string, unknown>).text;
      if (typeof t === "string" && t) texts.push(t);
    } else if (type === "image_url" || type === "input_image") {
      const ref = (p as Record<string, unknown>).image_url;
      let url = "";
      if (typeof ref === "string") url = ref;
      else if (ref && typeof ref === "object") {
        const u = (ref as Record<string, unknown>).url;
        if (typeof u === "string") url = u;
      }
      if (!url || !url.startsWith("data:image/")) continue;
      const mime = url.slice("data:".length, url.indexOf(";"));
      attachments.push({
        id: `db-${messageId}-${idx++}`,
        kind: "image",
        name: `image.${guessExtension(mime)}`,
        mime: isImageMime(mime) ? mime : "image/png",
        size: 0,
        dataUrl: url,
      });
    }
  }
  return { text: texts.join("\n\n"), attachments };
}

function guessExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

export interface SearchResult {
  sessionId: string;
  title: string | null;
  startedAt: number;
  source: string;
  messageCount: number;
  model: string;
  snippet: string;
}

function getDb(readonly = true): Database.Database | null {
  // Open the active profile's session DB — named profiles keep their
  // sessions under ~/.hermes/profiles/<name>/state.db (issue #311).
  const dbPath = activeStateDbPath();
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, readonly ? { readonly: true } : {});
}

export function listSessions(limit = 30, offset = 0): SessionSummary[] {
  const db = getDb();
  if (!db) return [];

  try {
    // Simple query without correlated subquery — titles come from session cache
    const rows = db
      .prepare(
        `SELECT
          s.id,
          s.source,
          s.started_at,
          s.ended_at,
          s.message_count,
          s.model,
          s.title
        FROM sessions s
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{
      id: string;
      source: string;
      started_at: number;
      ended_at: number | null;
      message_count: number;
      model: string;
      title: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      messageCount: r.message_count,
      model: r.model || "",
      title: r.title,
      preview: "",
    }));
  } finally {
    db.close();
  }
}

export function searchSessions(query: string, limit = 20): SearchResult[] {
  const db = getDb();
  if (!db) return [];

  try {
    // Check if FTS table exists
    const tableCheck = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'",
      )
      .get() as { name: string } | undefined;

    if (!tableCheck) return [];

    // Sanitize query for FTS5: wrap each word with quotes for safety, add * for prefix
    const sanitized = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, "")}"*`)
      .join(" ");

    if (!sanitized) return [];

    const rows = db
      .prepare(
        `SELECT DISTINCT
          m.session_id,
          s.title,
          s.started_at,
          s.source,
          s.message_count,
          s.model,
          snippet(messages_fts, 0, '<<', '>>', '...', 40) as snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{
      session_id: string;
      title: string | null;
      started_at: number;
      source: string;
      message_count: number;
      model: string;
      snippet: string;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title,
      startedAt: r.started_at,
      source: r.source,
      messageCount: r.message_count,
      model: r.model || "",
      snippet: r.snippet || "",
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = db
      .prepare(
        `SELECT id, role, content, timestamp
         FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL
         ORDER BY timestamp, id`,
      )
      .all(sessionId) as Array<{
      id: number;
      role: string;
      content: string;
      timestamp: number;
    }>;

    return rows.map((r) => {
      const decoded = decodeContent(r.content, r.id);
      return {
        id: r.id,
        role: r.role as "user" | "assistant",
        content: decoded.text,
        timestamp: r.timestamp,
        ...(decoded.attachments.length > 0
          ? { attachments: decoded.attachments }
          : {}),
      };
    });
  } finally {
    db.close();
  }
}

export function deleteSession(sessionId: string): void {
  const db = getDb(false);
  if (!db) return;

  try {
    const tx = db.transaction((id: string) => {
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
    tx(sessionId);
  } finally {
    db.close();
  }

  removeSessionFromCache(sessionId);
}
