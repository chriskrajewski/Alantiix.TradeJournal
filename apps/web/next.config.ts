import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is unused on Vercel; kept off so the Vercel Next builder owns tracing.
  transpilePackages: ["@luxalgo/journal-core", "@luxalgo/journal-importers"],
  // Runtime journal files belong on Turso / a local file URL, never in a deployable bundle.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "../../outputs/**/*", "../../.runtime-backup*/**/*"],
  },
};

export default nextConfig;
