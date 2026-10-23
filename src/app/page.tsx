"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Github,
  Loader2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/vault/theme-toggle";
import { SidebarTree } from "@/components/vault/sidebar-tree";
import { MarkdownViewer } from "@/components/vault/markdown-viewer";
import { SearchDialog } from "@/components/vault/search-dialog";
import { Breadcrumbs } from "@/components/vault/breadcrumbs";
import type { VaultTreeNode } from "@/lib/vault";

interface NotePayload {
  entry: {
    slug: string;
    title: string;
    section: string;
    sectionNumber: string;
    fileBase: string;
    filePath: string;
    aliases: string[];
    tags: string[];
    status: string | null;
    courseLevel: string | null;
    excerpt: string;
  };
  body: string;
  frontmatter: Record<string, unknown>;
}

const DEFAULT_SLUG = "00-Start-Here/Welcome";

export default function Home() {
  const [tree, setTree] = useState<VaultTreeNode[]>([]);
  const [note, setNote] = useState<NotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Load tree once.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/vault-tree")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setTree(data.tree ?? []);
      })
      .catch(() => {
        if (!cancelled) setTree([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cmd+K / Ctrl+K opens search.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const navigate = useCallback(async (slug: string) => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    // Update URL hash for shareability and browser-history navigation.
    // Use pushState so each navigation is a new history entry (back button
    // walks through visited notes). The hashchange listener picks up external
    // hash changes (e.g. shared links, manual edits).
    try {
      window.history.pushState(null, "", `#/${slug}`);
    } catch {
      // ignore
    }
    try {
      const res = await fetch(`/api/vault-note/${slug}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data: NotePayload = await res.json();
      setNote(data);
      setActiveSlug(slug);
      // Scroll content to top on navigation.
      const main = document.getElementById("vault-content");
      if (main) main.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load note");
      setNote(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: read URL hash, fall back to default. Also listen for
  // hashchange so external navigations (browser back/forward, shared links)
  // update the displayed note.
  useEffect(() => {
    const loadFromHash = () => {
      const hash = window.location.hash.replace(/^#\/?/, "");
      const target = hash || DEFAULT_SLUG;
      void navigate(target);
    };
    loadFromHash();
    window.addEventListener("hashchange", loadFromHash);
    return () => window.removeEventListener("hashchange", loadFromHash);
  }, [navigate]);

  const currentSlug = note?.entry.slug ?? activeSlug ?? DEFAULT_SLUG;
  const slugParts = currentSlug.split("/");

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 shrink-0">
        <div className="flex h-14 items-center gap-2 px-4">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-5 w-5" />
            ) : (
              <PanelLeftClose className="h-5 w-5" />
            )}
          </Button>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 font-semibold"
          >
            <img
              src="/logo.svg"
              alt="FastAPI Engineering Academy"
              className="h-7 w-7"
              width={28}
              height={28}
            />
            <span className="hidden sm:inline">FastAPI Engineering Academy</span>
            <span className="sm:hidden">FEA</span>
          </a>
          <span className="ml-1 hidden rounded-full bg-primary/10 px-2 py-0.5 text-[0.65rem] font-medium text-primary sm:inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            2026 edition
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchOpen(true)}
              className="gap-2"
            >
              <Search className="h-4 w-4" />
              <span className="hidden md:inline text-muted-foreground">
                Search…
              </span>
              <kbd className="hidden md:inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1 text-[0.65rem] font-mono">
                ⌘K
              </kbd>
            </Button>
            <ThemeToggle />
            <Separator orientation="vertical" className="mx-1 h-6" />
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"
              aria-label="GitHub repository"
            >
              <Github className="h-4 w-4" />
            </a>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop sidebar */}
        <aside
          className={`hidden md:flex shrink-0 flex-col min-h-0 border-r bg-sidebar/40 transition-all ${
            sidebarCollapsed ? "w-0 overflow-hidden" : "w-80"
          }`}
        >
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            <SidebarTree
              nodes={tree}
              activeSlug={activeSlug}
              onSelect={navigate}
            />
          </div>
          <div className="border-t p-3 text-xs text-muted-foreground shrink-0">
            <p className="font-medium text-foreground mb-1">Vault Browser</p>
            <p>
              Browse the curriculum in your browser. The same Markdown works in
              Obsidian and on GitHub.
            </p>
          </div>
        </aside>

        {/* Mobile sidebar */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-80 p-0">
            <SheetHeader className="px-3 py-3 border-b">
              <SheetTitle className="flex items-center gap-2">
                <img
                  src="/logo.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-5 w-5"
                  width={20}
                  height={20}
                />
                Curriculum
              </SheetTitle>
            </SheetHeader>
            <div className="overflow-y-auto p-3 h-[calc(100vh-4rem)]">
              <SidebarTree
                nodes={tree}
                activeSlug={activeSlug}
                onSelect={(slug) => {
                  void navigate(slug);
                  setSidebarOpen(false);
                }}
              />
            </div>
          </SheetContent>
        </Sheet>

        {/* Main content */}
        <main
          id="vault-content"
          className="flex-1 min-h-0 overflow-y-auto"
        >
          <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
                <p className="font-semibold text-destructive mb-1">
                  Could not load that note
                </p>
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => navigate(DEFAULT_SLUG)}
                >
                  Go to Welcome
                </Button>
              </div>
            ) : note ? (
              <article>
                <Breadcrumbs parts={slugParts} onSelect={navigate} />
                <div className="mb-6 flex flex-wrap items-center gap-2">
                  {note.entry.sectionNumber ? (
                    <Badge variant="secondary">
                      Section {note.entry.sectionNumber}
                    </Badge>
                  ) : null}
                  {note.entry.courseLevel ? (
                    <Badge variant="outline" className="capitalize">
                      {note.entry.courseLevel}
                    </Badge>
                  ) : null}
                  {note.entry.status ? (
                    <Badge
                      variant={note.entry.status === "complete" ? "default" : "outline"}
                      className="capitalize"
                    >
                      {note.entry.status}
                    </Badge>
                  ) : null}
                  {note.entry.tags.slice(0, 4).map((t) => (
                    <Badge key={t} variant="outline" className="text-muted-foreground">
                      #{t}
                    </Badge>
                  ))}
                </div>
                <MarkdownViewer
                  content={note.body}
                  currentSlug={note.entry.slug}
                  onNavigate={navigate}
                />
                <div className="mt-12 rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
                  <p>
                    Path: <code className="font-mono">{note.entry.filePath}</code>
                  </p>
                  <p className="mt-1">
                    Open this file in Obsidian for the best note-taking experience.
                  </p>
                </div>
              </article>
            ) : null}
          </div>
        </main>
      </div>

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={navigate}
      />
    </div>
  );
}
