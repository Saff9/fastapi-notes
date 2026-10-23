"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search } from "lucide-react";

interface SearchResult {
  slug: string;
  title: string;
  filePath: string;
  section: string;
  sectionNumber: string;
  status: string | null;
  excerpt: string;
}

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (slug: string) => void;
}

export function SearchDialog({
  open,
  onOpenChange,
  onSelect,
}: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      return;
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!cancelled) {
          setResults(data.results ?? []);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  const handleSelect = useCallback(
    (slug: string) => {
      onSelect(slug);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 sm:max-w-2xl overflow-hidden gap-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Search the vault</DialogTitle>
          <DialogDescription>
            Find lessons by title, alias, or content.
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="rounded-none">
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search lessons, concepts, projects…"
              className="h-12 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <CommandList className="max-h-[60vh] overflow-y-auto">
            <CommandEmpty>
              {loading ? "Searching…" : query ? "No matches." : "Start typing to search."}
            </CommandEmpty>
            {results.length > 0 ? (
              <CommandGroup heading={`${results.length} result${results.length === 1 ? "" : "s"}`}>
                {results.map((r) => (
                  <CommandItem
                    key={r.slug}
                    value={r.slug}
                    onSelect={() => handleSelect(r.slug)}
                    className="flex flex-col items-start gap-0.5 py-2"
                  >
                    <div className="flex w-full items-center gap-2">
                      <span className="text-xs font-mono text-muted-foreground">
                        {r.sectionNumber || "—"}
                      </span>
                      <span className="font-medium truncate">{r.title}</span>
                      {r.status === "stub" ? (
                        <span className="ml-auto rounded bg-amber-500/15 px-1 text-[0.6rem] font-semibold text-amber-700 dark:text-amber-300">
                          stub
                        </span>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground line-clamp-1">
                      {r.excerpt}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
