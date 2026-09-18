import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright can run beside a developer-owned Next process. Giving that
  // process a separate cache directory prevents both dev servers from racing
  // over manifests in `.next`.
  distDir: process.env.LOOMIC_NEXT_DIST_DIR?.trim() || ".next",
  // Keep static export as the default; local production uses `next start`.
  ...(process.env.LOOMIC_NEXT_SERVER_MODE === "true" ? {} : { output: "export" as const }),
  // Local builds share the machine with the API/worker and must not spawn a
  // CPU-sized pool of page workers, each with its own V8 heap allowance.
  ...(process.env.LOOMIC_LOCAL_BUILD_SERIAL === "true" ? { experimental: { cpus: 1 } } : {}),
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
    NEXT_PUBLIC_SERVER_BASE_URL: process.env.NEXT_PUBLIC_SERVER_BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};

export default nextConfig;
