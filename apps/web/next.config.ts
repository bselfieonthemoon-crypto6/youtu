import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright can run beside a developer-owned Next process. Giving that
  // process a separate cache directory prevents both dev servers from racing
  // over manifests in `.next`.
  distDir: process.env.LOOMIC_NEXT_DIST_DIR?.trim() || ".next",
  output: "export",
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
