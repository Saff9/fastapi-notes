import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

function resolveVaultRoot(): string {
  // The vault lives inside the Next.js project root at /FastAPI-Engineering-Academy.
  const candidates = [
    path.join(process.cwd(), "FastAPI-Engineering-Academy"),
    path.join(process.cwd(), "..", "FastAPI-Engineering-Academy"),
  ];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsSync = require("node:fs");
      if (fsSync.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return candidates[0];
}

export const VAULT_DIR = resolveVaultRoot();

export interface VaultEntry {
  /** Path relative to vault root, without extension. e.g. "01-Python-Foundations/Values-Objects-Mutability" */
  slug: string;
  /** Display title from frontmatter, falling back to first H1, falling back to filename. */
  title: string;
  /** Section (top-level folder, no number prefix). */
  section: string;
  /** Section number (e.g. "01"). */
  sectionNumber: string;
  /** File name without extension. */
  fileBase: string;
  /** Relative path with extension. e.g. "01-Python-Foundations/Values-Objects-Mutability.md" */
  filePath: string;
  /** Aliases from frontmatter. */
  aliases: string[];
  /** Tags from frontmatter. */
  tags: string[];
  /** Status from frontmatter ("complete" / "stub" / "draft" / "in-progress"). */
  status: string | null;
  /** Course level from frontmatter. */
  courseLevel: string | null;
  /** Snippet of plain text for search. */
  excerpt: string;
}

export interface VaultTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: VaultTreeNode[];
  entry?: VaultEntry;
}

const SECTION_PATTERN = /^(\d{2})-(.+)$/;

function sectionFromPath(relPath: string): {
  section: string;
  sectionNumber: string;
} {
  const top = relPath.split("/")[0] ?? "";
  const m = top.match(SECTION_PATTERN);
  if (m) return { section: m[2], sectionNumber: m[1] };
  return { section: top, sectionNumber: "" };
}

function extractTitle(content: string, fileBase: string): string {
  // Try frontmatter title (handled by caller usually).
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fileBase.replace(/-/g, " ");
}

function buildExcerpt(content: string, max = 240): string {
  // Strip code blocks and frontmatter, collapse whitespace.
  const noCode = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  const noMatter = noCode.replace(/^---[\s\S]*?---/, " ");
  const collapsed = noMatter.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd() + "…";
}

async function walk(dir: string, base: string): Promise<VaultEntry[]> {
  const entries: VaultEntry[] = [];
  let list: string[] = [];
  try {
    list = await fs.readdir(dir);
  } catch {
    return entries;
  }
  for (const name of list) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const sub = await walk(abs, base);
      entries.push(...sub);
      continue;
    }
    if (!name.endsWith(".md")) continue;
    const relWithExt = path.relative(base, abs);
    const relNoExt = relWithExt.replace(/\.md$/, "");
    const fileBase = name.replace(/\.md$/, "");
    const { section, sectionNumber } = sectionFromPath(relWithExt);
    let raw = "";
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = matter(raw);
    } catch {
      parsed = { data: {} as Record<string, unknown>, content: raw };
    }
    const data = parsed.data as {
      title?: string;
      aliases?: string[];
      tags?: string[];
      status?: string;
      course_level?: string;
    };
    const title =
      data.title ?? extractTitle(parsed.content, fileBase);
    const aliases = Array.isArray(data.aliases)
      ? data.aliases.map((a) => String(a))
      : [];
    const tags = Array.isArray(data.tags)
      ? data.tags.map((t) => String(t))
      : [];
    entries.push({
      slug: relNoExt,
      title,
      section,
      sectionNumber,
      fileBase,
      filePath: relWithExt,
      aliases,
      tags,
      status: data.status ?? null,
      courseLevel: data.course_level ?? null,
      excerpt: buildExcerpt(parsed.content),
    });
  }
  return entries;
}

let cache: { ts: number; entries: VaultEntry[] } | null = null;
const TTL_MS = 60_000;

export async function getAllEntries(): Promise<VaultEntry[]> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.entries;
  const entries = await walk(VAULT_DIR, VAULT_DIR);
  // Stable order: by section number, then file path.
  entries.sort((a, b) => a.filePath.localeCompare(b.filePath));
  cache = { ts: now, entries };
  return entries;
}

export async function getTree(): Promise<VaultTreeNode[]> {
  const entries = await getAllEntries();
  const root: VaultTreeNode = {
    name: "root",
    path: "",
    isDirectory: true,
    children: [],
  };
  for (const entry of entries) {
    const parts = entry.filePath.split("/");
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!cursor.children) cursor.children = [];
      let next = cursor.children.find((c) => c.name === part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDirectory: !isLast,
          children: !isLast ? [] : undefined,
          entry: isLast ? entry : undefined,
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
  }
  // Sort: directories first by natural numerical order (01 < 02 < 02b < 03);
  // files inside a directory sorted by lesson number (parsed from the title
  // "Lesson NN — ...") when present, falling back to natural name sort.
  // MOCs (no "Lesson NN" in title) sort first (lesson number 0).
  function getLessonNumber(entry?: VaultEntry): number {
    if (!entry?.title) return 0;
    const m = entry.title.match(/^Lesson\s+(\d+)/i);
    if (m) return parseInt(m[1], 10);
    return 0;
  }
  function sortNode(node: VaultTreeNode) {
    if (!node.children) return;
    node.children.sort((a, b) => {
      // Directories first.
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (a.isDirectory) {
        // Top-level folders: natural numerical sort (01 < 02 < 02b < 03 < 10).
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }
      // Files: sort by lesson number first (MOC=0, Lesson 01=1, Lesson 02=2, ...),
      // then by name as a tiebreaker.
      const aLesson = getLessonNumber(a.entry);
      const bLesson = getLessonNumber(b.entry);
      if (aLesson !== bLesson) return aLesson - bLesson;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    node.children.forEach(sortNode);
  }
  sortNode(root);
  return root.children ?? [];
}

export interface NoteContent {
  entry: VaultEntry;
  /** Markdown content with frontmatter stripped. */
  body: string;
  /** Raw frontmatter object. */
  frontmatter: Record<string, unknown>;
}

export async function getNoteBySlug(
  slug: string,
): Promise<NoteContent | null> {
  // slug is path without extension, relative to vault root.
  const safe = slug.replace(/[^a-zA-Z0-9_\-/]/g, "");
  const candidate = path.join(VAULT_DIR, `${safe}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(candidate, "utf8");
  } catch {
    // Try resolving by alias or by fileBase only.
    const entries = await getAllEntries();
    const match =
      entries.find((e) => e.aliases.includes(slug)) ??
      entries.find((e) => e.fileBase === slug) ??
      entries.find((e) => e.slug === slug);
    if (!match) return null;
    try {
      raw = await fs.readFile(
        path.join(VAULT_DIR, match.filePath),
        "utf8",
      );
    } catch {
      return null;
    }
  }
  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    parsed = { data: {} as Record<string, unknown>, content: raw };
  }
  const relPath = path.relative(VAULT_DIR, candidate);
  const { section, sectionNumber } = sectionFromPath(relPath);
  const fileBase = path.basename(candidate, ".md");
  const data = parsed.data as {
    title?: string;
    aliases?: string[];
    tags?: string[];
    status?: string;
    course_level?: string;
  };
  const entry: VaultEntry = {
    slug: relPath.replace(/\.md$/, ""),
    title: data.title ?? extractTitle(parsed.content, fileBase),
    section,
    sectionNumber,
    fileBase,
    filePath: relPath,
    aliases: Array.isArray(data.aliases)
      ? data.aliases.map((a) => String(a))
      : [],
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t)) : [],
    status: data.status ?? null,
    courseLevel: data.course_level ?? null,
    excerpt: buildExcerpt(parsed.content),
  };
  return {
    entry,
    body: parsed.content.trimStart(),
    frontmatter: parsed.data as Record<string, unknown>,
  };
}

export interface SearchResult {
  slug: string;
  title: string;
  filePath: string;
  section: string;
  sectionNumber: string;
  status: string | null;
  excerpt: string;
}

export async function search(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const entries = await getAllEntries();
  const results: SearchResult[] = [];
  for (const e of entries) {
    const hay = `${e.title} ${e.aliases.join(" ")} ${e.tags.join(" ")} ${e.excerpt}`.toLowerCase();
    if (hay.includes(q)) {
      results.push({
        slug: e.slug,
        title: e.title,
        filePath: e.filePath,
        section: e.section,
        sectionNumber: e.sectionNumber,
        status: e.status,
        excerpt: e.excerpt,
      });
    }
  }
  // Title matches rank higher.
  results.sort((a, b) => {
    const at = a.title.toLowerCase().includes(q) ? 0 : 1;
    const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
    if (at !== bt) return at - bt;
    return a.title.localeCompare(b.title);
  });
  return results.slice(0, 30);
}

/**
 * Resolve an Obsidian wikilink target to a vault slug.
 * Supports [[Note]], [[folder/Note]], and [[folder/Note|Display]].
 */
export async function resolveWikiLink(
  target: string,
): Promise<string | null> {
  const clean = target.replace(/\.md$/, "");
  // Direct path match.
  const entries = await getAllEntries();
  const direct =
    entries.find((e) => e.slug === clean) ??
    entries.find((e) => e.slug.endsWith(`/${clean}`)) ??
    entries.find((e) => e.fileBase === clean) ??
    entries.find((e) => e.aliases.includes(clean));
  return direct?.slug ?? null;
}
