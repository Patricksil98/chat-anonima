import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Se vuoi ignorare gli errori ESLint durante la build su Vercel
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Se stai usando immagini remote, puoi configurare qui i domini
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },

  // Opzionale: se usi Turbopack, puoi attivare feature sperimentali
  experimental: {
    // allowedDevOrigins: ["http://localhost:3000"], // puoi sbloccare se vuoi sviluppare su IP locale
  },
};

export default nextConfig;
