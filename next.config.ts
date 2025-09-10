// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // NON bloccare la build per ESLint
  eslint: { ignoreDuringBuilds: true },

  // NON bloccare la build per errori TypeScript
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
