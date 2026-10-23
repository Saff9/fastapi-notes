"use client";

import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "next-themes";
import { Mermaid } from "./mermaid";
import {
  CheckCircle2,
  Info,
  StickyNote,
  Lightbulb,
  Sparkles,
  AlertTriangle,
  AlertOctagon,
  HelpCircle,
  Quote as QuoteIcon,
  XCircle,
} from "lucide-react";

interface MarkdownViewerProps {
  /** Markdown content with frontmatter already stripped. */
  content: string;
  /** Current note slug, for deduping mermaid render ids. */
  currentSlug: string;
  /** Callback when the user clicks an internal wikilink. */
  onNavigate: (slug: string) => void;
}

// --- Obsidian-style callouts ----------------------------------------------
// Obsidian renders `> [!TYPE] Title` blockquotes with a colored left border,
// a colored background, an icon, and a title line. We replicate that here.

interface CalloutStyle {
  // Tailwind classes for the container.
  container: string;
  // Tailwind classes for the icon (color).
  icon: string;
  // Lucide icon component.
  Icon: React.ComponentType<{ className?: string }>;
}

const CALLOUT_STYLES: Record<string, CalloutStyle> = {
  success: {
    container:
      "border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-950 dark:text-emerald-100",
    icon: "text-emerald-600 dark:text-emerald-400",
    Icon: CheckCircle2,
  },
  info: {
    container:
      "border-blue-500/60 bg-blue-50 dark:bg-blue-950/30 text-blue-950 dark:text-blue-100",
    icon: "text-blue-600 dark:text-blue-400",
    Icon: Info,
  },
  note: {
    container:
      "border-slate-500/60 bg-slate-50 dark:bg-slate-900/40 text-slate-900 dark:text-slate-100",
    icon: "text-slate-600 dark:text-slate-400",
    Icon: StickyNote,
  },
  tip: {
    container:
      "border-cyan-500/60 bg-cyan-50 dark:bg-cyan-950/30 text-cyan-950 dark:text-cyan-100",
    icon: "text-cyan-600 dark:text-cyan-400",
    Icon: Lightbulb,
  },
  example: {
    container:
      "border-purple-500/60 bg-purple-50 dark:bg-purple-950/30 text-purple-950 dark:text-purple-100",
    icon: "text-purple-600 dark:text-purple-400",
    Icon: Sparkles,
  },
  warning: {
    container:
      "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30 text-amber-950 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-400",
    Icon: AlertTriangle,
  },
  danger: {
    container:
      "border-red-500/60 bg-red-50 dark:bg-red-950/30 text-red-950 dark:text-red-100",
    icon: "text-red-600 dark:text-red-400",
    Icon: AlertOctagon,
  },
  error: {
    container:
      "border-red-500/60 bg-red-50 dark:bg-red-950/30 text-red-950 dark:text-red-100",
    icon: "text-red-600 dark:text-red-400",
    Icon: XCircle,
  },
  question: {
    container:
      "border-orange-500/60 bg-orange-50 dark:bg-orange-950/30 text-orange-950 dark:text-orange-100",
    icon: "text-orange-600 dark:text-orange-400",
    Icon: HelpCircle,
  },
  quote: {
    container:
      "border-gray-500/60 bg-gray-50 dark:bg-gray-900/40 text-gray-900 dark:text-gray-100",
    icon: "text-gray-600 dark:text-gray-400",
    Icon: QuoteIcon,
  },
  abstract: {
    container:
      "border-violet-500/60 bg-violet-50 dark:bg-violet-950/30 text-violet-950 dark:text-violet-100",
    icon: "text-violet-600 dark:text-violet-400",
    Icon: StickyNote,
  },
  bug: {
    container:
      "border-rose-500/60 bg-rose-50 dark:bg-rose-950/30 text-rose-950 dark:text-rose-100",
    icon: "text-rose-600 dark:text-rose-400",
    Icon: AlertOctagon,
  },
  todo: {
    container:
      "border-sky-500/60 bg-sky-50 dark:bg-sky-950/30 text-sky-950 dark:text-sky-100",
    icon: "text-sky-600 dark:text-sky-400",
    Icon: Info,
  },
};

function getNodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return getNodeText(props.children);
  }
  return "";
}

// Strip the leading `[!TYPE]` marker (and any whitespace following it) from
// the first text-like child of a paragraph's children. Preserves the rest of
// the inline formatting (bold, code, links, etc.).
function stripCalloutMarker(children: ReactNode): {
  type: string | null;
  rest: ReactNode;
} {
  const arr = React.Children.toArray(children);
  if (arr.length === 0) return { type: null, rest: children };
  const first = arr[0];
  if (typeof first === "string") {
    const m = first.match(/^\s*\[!(\w+)\]\s*(.*)$/s);
    if (m) {
      const type = m[1].toLowerCase();
      const rest = m[2] || "";
      return { type, rest: [rest, ...arr.slice(1)] };
    }
  }
  // If the first child is an element, walk its text content to detect the
  // callout marker (rare, but happens when the marker is followed by an
  // inline element like `[!success] **Title**`).
  const fullText = getNodeText(children);
  const m = fullText.match(/^\s*\[!(\w+)\]\s*/);
  if (m) {
    const type = m[1].toLowerCase();
    // Best-effort strip: replace the marker in the first text string.
    let stripped = false;
    const newChildren = arr.map((child) => {
      if (stripped) return child;
      if (typeof child === "string") {
        const replaced = child.replace(m[0], "");
        if (replaced !== child) {
          stripped = true;
          return replaced;
        }
      }
      return child;
    });
    return { type, rest: newChildren };
  }
  return { type: null, rest: children };
}

// Recursively walk a React node tree and strip the first occurrence of the
// given marker string from the first text node encountered. Preserves all
// inline formatting (bold, code, links, etc.) and all sibling nodes.
function stripMarkerFromNode(node: ReactNode, marker: string): { result: ReactNode; stripped: boolean } {
  if (typeof node === "string") {
    if (node.includes(marker)) {
      return { result: node.replace(marker, ""), stripped: true };
    }
    return { result: node, stripped: false };
  }
  if (typeof node === "number") {
    return { result: node, stripped: false };
  }
  if (Array.isArray(node)) {
    let stripped = false;
    const mapped = node.map((child) => {
      if (stripped) return child;
      const r = stripMarkerFromNode(child, marker);
      if (r.stripped) stripped = true;
      return r.result;
    });
    return { result: mapped, stripped };
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    const inner = stripMarkerFromNode(props.children ?? "", marker);
    if (inner.stripped) {
      return {
        result: React.cloneElement(node, { ...props, children: inner.result }),
        stripped: true,
      };
    }
    return { result: node, stripped: false };
  }
  return { result: node, stripped: false };
}

function BlockquoteRenderer({ children }: { children?: ReactNode }) {
  const arr = React.Children.toArray(children);
  if (arr.length === 0) {
    return (
      <blockquote className="my-4 border-l-4 border-muted-foreground/40 pl-4 italic text-muted-foreground">
        {children}
      </blockquote>
    );
  }
  // Skip leading whitespace-only string children (react-markdown inserts
  // newlines between block elements). Find the first content-bearing child.
  let firstIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    const text = getNodeText(arr[i]);
    if (text.trim().length > 0) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) {
    return (
      <blockquote className="my-4 border-l-4 border-muted-foreground/40 pl-4 italic text-muted-foreground">
        {children}
      </blockquote>
    );
  }
  // Try to detect a callout marker `[!TYPE]` at the start of the first
  // content-bearing child's text content.
  const first = arr[firstIdx];
  const firstText = getNodeText(first);
  const m = firstText.match(/^\s*\[!(\w+)\]\s*/);
  if (m) {
    const type = m[1].toLowerCase();
    const style = CALLOUT_STYLES[type] || CALLOUT_STYLES.note;
    const { Icon, icon, container } = style;
    const { result: strippedFirst } = stripMarkerFromNode(first, m[0]);
    return (
      <div
        className={`my-4 rounded-md border-l-4 px-4 py-3 ${container}`}
        data-callout={type}
      >
        <div className={`mb-1 flex items-center gap-2 font-semibold ${icon}`}>
          <Icon className="h-4 w-4 shrink-0" />
          <span className="text-xs uppercase tracking-wide opacity-80">
            {type}
          </span>
        </div>
        <div className="callout-body text-sm leading-relaxed [&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
          {strippedFirst}
          {arr.slice(0, firstIdx)}
          {arr.slice(firstIdx + 1)}
        </div>
      </div>
    );
  }
  // Plain blockquote (not a callout).
  return (
    <blockquote className="my-4 border-l-4 border-muted-foreground/40 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  );
}

const ALIASES: Record<string, string> = {
  "00-Start-Header": "00-Start-Here",
};

function normalizeTarget(rawTarget: string): string {
  let t = rawTarget.replace(/\.md$/, "").trim();
  if (ALIASES[t]) t = ALIASES[t];
  return t;
}

function extractWikiParts(raw: string): { target: string; display: string } {
  const [target, display] = raw.split("|");
  const t = normalizeTarget(target);
  return { target: t, display: (display ?? target).trim() };
}

let mermaidCounter = 0;
function nextMermaidId(): string {
  mermaidCounter += 1;
  return `m${mermaidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function MarkdownViewer({
  content,
  currentSlug,
  onNavigate,
}: MarkdownViewerProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [hoverLink, setHoverLink] = useState<string | null>(null);

  const handleAnchorClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, href: string) => {
      e.preventDefault();
      const slug = href.replace(/^obsidian:/, "");
      onNavigate(slug);
    },
    [onNavigate],
  );

  const components: Components = useMemo(
    () => ({
      a({ href, children, ...props }) {
        if (!href) {
          return (
            <a {...props}>{children}</a>
          );
        }
        // External link.
        if (/^https?:\/\//.test(href) || href.startsWith("mailto:")) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4 hover:opacity-80"
              {...props}
            >
              {children}
            </a>
          );
        }
        // Anchor link in the same note.
        if (href.startsWith("#")) {
          return (
            <a
              href={href}
              className="text-primary underline underline-offset-4 hover:opacity-80"
              {...props}
            >
              {children}
            </a>
          );
        }
        // Internal wikilink we preprocessed into obsidian:scheme.
        if (href.startsWith("obsidian:")) {
          const slug = href.replace(/^obsidian:/, "");
          return (
            <button
              type="button"
              onClick={(e) => handleAnchorClick(e, href)}
              onMouseEnter={() => setHoverLink(slug)}
              onMouseLeave={() => setHoverLink(null)}
              className="text-primary underline underline-offset-4 hover:opacity-80 text-left"
              title={`Navigate to ${slug}`}
              {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
            >
              {children}
            </button>
          );
        }
        // Fallback: render as plain anchor.
        return (
          <a
            href={href}
            className="text-primary underline underline-offset-4 hover:opacity-80"
            {...props}
          >
            {children}
          </a>
        );
      },
      code({ className, children, ...props }) {
        const text = String(children).replace(/\n$/, "");
        const match = /language-(\w+)/.exec(className || "");
        if (match && match[1] === "mermaid") {
          return <Mermaid chart={text} id={nextMermaidId()} />;
        }
        // Inline code (no language class and single line).
        if (!match && !text.includes("\n")) {
          return (
            <code
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
              {...props}
            >
              {children}
            </code>
          );
        }
        const lang = match?.[1] ?? "text";
        return (
          <SyntaxHighlighter
            language={lang}
            style={isDark ? oneDark : oneLight}
            customStyle={{
              margin: 0,
              background: "transparent",
              padding: "1rem",
              fontSize: "0.85rem",
              borderRadius: "0.5rem",
            }}
            codeTagProps={{
              style: { fontFamily: "var(--font-geist-mono), monospace" },
            }}
          >
            {text}
          </SyntaxHighlighter>
        );
      },
      pre({ children }) {
        return (
          <pre className="my-4 overflow-x-auto rounded-md border bg-card">
            {children}
          </pre>
        );
      },
      table({ children }) {
        return (
          <div className="my-6 overflow-x-auto">
            <table className="w-full border-collapse text-sm">{children}</table>
          </div>
        );
      },
      thead({ children }) {
        return <thead className="border-b bg-muted/40">{children}</thead>;
      },
      th({ children }) {
        return (
          <th className="px-3 py-2 text-left font-semibold">{children}</th>
        );
      },
      td({ children }) {
        return (
          <td className="border-t px-3 py-2 align-top">{children}</td>
        );
      },
      blockquote({ children }) {
        return <BlockquoteRenderer>{children}</BlockquoteRenderer>;
      },
      h1({ children }) {
        return (
          <h1 className="mt-2 mb-4 text-3xl font-bold tracking-tight">
            {children}
          </h1>
        );
      },
      h2({ children }) {
        return (
          <h2 className="mt-8 mb-3 text-2xl font-semibold tracking-tight border-b pb-1">
            {children}
          </h2>
        );
      },
      h3({ children }) {
        return (
          <h3 className="mt-6 mb-2 text-xl font-semibold">{children}</h3>
        );
      },
      h4({ children }) {
        return (
          <h4 className="mt-4 mb-2 text-lg font-semibold">{children}</h4>
        );
      },
      p({ children }) {
        return <p className="my-3 leading-7">{children}</p>;
      },
      ul({ children }) {
        return <ul className="my-3 ml-6 list-disc space-y-1">{children}</ul>;
      },
      ol({ children }) {
        return <ol className="my-3 ml-6 list-decimal space-y-1">{children}</ol>;
      },
      li({ children }) {
        return <li className="leading-7">{children}</li>;
      },
      hr() {
        return <hr className="my-8 border-t" />;
      },
      img({ src, alt }) {
        return (
          <img
            src={typeof src === "string" ? src : undefined}
            alt={alt ?? ""}
            className="my-4 rounded-md border max-w-full h-auto"
          />
        );
      },
    }),
    [isDark, handleAnchorClick],
  );

  // Preprocess: turn [[...]] wikilinks into markdown links so react-markdown
  // passes them through our `a` handler. Format: [[Target]] | [[Target|Display]]
  // | [[folder/Target]]. We emit `obsidian:` URIs that our `a` handler routes
  // back through onNavigate.
  const processed = useMemo(() => {
    return content.replace(/\[\[([^\]]+)\]\]/g, (full, inner: string) => {
      const { target, display } = extractWikiParts(inner);
      if (!target) return full;
      // Escape any parentheses in display so markdown link text isn't broken.
      const safeDisplay = display.replace(/([()])/g, "\\$1");
      return `[${safeDisplay}](obsidian:${target})`;
    });
  }, [content]);

  return (
    <div className="prose-vault max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {processed}
      </ReactMarkdown>
      {/* hoverLink is just for the title attribute; unused but kept for hover-state UI */}
      <span className="hidden" aria-hidden>
        {hoverLink}
      </span>
    </div>
  );
}
