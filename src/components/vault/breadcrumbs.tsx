"use client";

import { ChevronRight } from "lucide-react";

interface BreadcrumbsProps {
  /** Path parts (without extensions), e.g. ["01-Python-Foundations", "Values-Objects-Mutability"]. */
  parts: string[];
  onSelect: (slug: string) => void;
}

function friendly(name: string): string {
  return name.replace(/^\d{2}-/, "").replace(/-/g, " ");
}

export function Breadcrumbs({ parts, onSelect }: BreadcrumbsProps) {
  if (parts.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {parts.map((part, i) => {
        const slug = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <span key={slug} className="flex items-center gap-1">
            {i > 0 ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
            ) : null}
            {isLast ? (
              <span className="font-medium text-foreground">{friendly(part)}</span>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(slug)}
                className="hover:text-foreground"
              >
                {friendly(part)}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
