import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Monorepo root, so standalone output traces workspace deps (@ghostrider/shared).
const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
};

export default nextConfig;