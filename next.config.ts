import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: `output: "standalone"` is intentionally omitted for Vercel.
  // Vercel handles the Next.js build output format automatically. Reserve
  // `output: "standalone"` for self-hosted Docker deploys (it copies the
  // server to .next/standalone, which is not how Vercel ships functions).
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Bundle the markdown vault with the serverless API routes so the
  // filesystem reads in src/lib/vault.ts (which resolves the vault at
  // process.cwd()/FastAPI-Engineering-Academy) work on Vercel. Without
  // this, the routes would deploy without the .md files and every
  // /api/vault-tree, /api/vault-note/*, /api/search call would 404.
  outputFileTracingIncludes: {
    "/api/vault-tree": ["./FastAPI-Engineering-Academy/**/*"],
    "/api/vault-note/**": ["./FastAPI-Engineering-Academy/**/*"],
    "/api/search": ["./FastAPI-Engineering-Academy/**/*"],
  },
};

export default nextConfig;
