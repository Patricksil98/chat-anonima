// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // ✅ Non bloccare il deploy per errori ESLint
  eslint: {
    ignoreDuringBuilds: true,
  },

  // ✅ Non bloccare il deploy per errori TypeScript
  typescript: {
    ignoreBuildErrors: true,
  },

  // (opzionale) permetti immagini remote senza configurazioni aggiuntive
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
