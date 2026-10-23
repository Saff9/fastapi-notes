"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import type { VaultTreeNode } from "@/lib/vault";
import { cn } from "@/lib/utils";

interface SidebarTreeProps {
  nodes: VaultTreeNode[];
  /** Active slug (path without extension). */
  activeSlug: string | null;
  onSelect: (slug: string) => void;
}

export function SidebarTree({ nodes, activeSlug, onSelect }: SidebarTreeProps) {
  // Compute initial expanded set: expand the section containing the active note.
  const initialExpanded = useMemo(() => {
    const s = new Set<string>();
    if (activeSlug) {
      const parts = activeSlug.split("/");
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        s.add(acc);
      }
    } else {
      // Expand 00-Start-Here by default for first-time visitors.
      s.add("00-Start-Here");
    }
    return s;
  }, [activeSlug]);

  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const isActive = (slug: string) => slug === activeSlug;

  return (
    <nav className="text-sm" aria-label="Vault navigation">
      <ul className="space-y-0.5">
        {nodes.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onSelect={onSelect}
            isActive={isActive}
          />
        ))}
      </ul>
    </nav>
  );
}

interface TreeItemProps {
  node: VaultTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (slug: string) => void;
  isActive: (slug: string) => boolean;
}

function TreeItem({
  node,
  depth,
  expanded,
  onToggle,
  onSelect,
  isActive,
}: TreeItemProps) {
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.isDirectory) {
    const isOpen = expanded.has(node.path);
    const friendlyName = node.name.replace(/^\d{2}[a-z]?-/, "").replace(/-/g, " ");
    const numberPrefix = node.name.match(/^(\d{2}[a-z]?)-/)?.[1];
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          style={pad}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-accent/60"
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {isOpen ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-primary/70" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-primary/70" />
          )}
          <span className="truncate">
            {numberPrefix ? (
              <span className="text-muted-foreground mr-1">{numberPrefix} </span>
            ) : null}
            {friendlyName}
          </span>
        </button>
        {isOpen && node.children && node.children.length > 0 ? (
          <ul className="space-y-0.5">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                isActive={isActive}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  // File node.
  const slug = node.entry?.slug ?? node.path.replace(/\.md$/, "");
  const active = isActive(slug);
  const title = node.entry?.title ?? node.name.replace(/\.md$/, "").replace(/-/g, " ");
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(slug)}
        style={pad}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left",
          active
            ? "bg-primary/10 text-primary font-medium"
            : "hover:bg-accent/60",
        )}
      >
        <FileText
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-primary" : "text-muted-foreground/70",
          )}
        />
        <span className="truncate">{title}</span>
        {node.entry?.status === "stub" ? (
          <span className="ml-auto rounded bg-amber-500/15 px-1 text-[0.6rem] font-semibold text-amber-700 dark:text-amber-300">
            stub
          </span>
        ) : null}
      </button>
    </li>
  );
}
