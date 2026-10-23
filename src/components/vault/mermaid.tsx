"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

interface MermaidProps {
  chart: string;
  id: string;
}

type MermaidModule = {
  default: {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, chart: string) => Promise<{ svg: string }>;
    parse: (chart: string) => Promise<unknown>;
  };
};

let mermaidPromise: Promise<MermaidModule["default"]> | null = null;

async function getMermaid(): Promise<MermaidModule["default"]> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m: MermaidModule) => {
      const mer = m.default;
      mer.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "default",
        fontFamily: "inherit",
        flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" },
        sequence: { useMaxWidth: true },
        er: { useMaxWidth: true },
      });
      return mer;
    });
  }
  return mermaidPromise;
}

export function Mermaid({ chart, id }: MermaidProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    const cleanChart = chart.replace(/\r\n/g, "\n").trim();
    getMermaid()
      .then(async (mer) => {
        mer.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: resolvedTheme === "dark" ? "dark" : "default",
          fontFamily: "inherit",
          flowchart: { useMaxWidth: true, htmlLabels: true },
          sequence: { useMaxWidth: true },
          er: { useMaxWidth: true },
        });
        try {
          await mer.parse(cleanChart);
          const { svg: rendered } = await mer.render(
            `mermaid-${id}`,
            cleanChart,
          );
          if (!cancelled) {
            setSvg(rendered);
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            const message =
              err instanceof Error ? err.message : "Mermaid render error";
            setError(message);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load mermaid");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (error) {
    return (
      <div className="my-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <div className="font-mono text-destructive mb-2">Mermaid error</div>
        <pre className="text-xs whitespace-pre-wrap text-muted-foreground">
          {error}
        </pre>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Source
          </summary>
          <pre className="mt-2 text-xs whitespace-pre-wrap rounded bg-muted p-2">
            {chart}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-6 overflow-x-auto rounded-md border bg-card p-4 [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    >
      {!svg ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
          Rendering diagram…
        </div>
      ) : null}
    </div>
  );
}
