// next.config.ts
import type { NextConfig } from "next";
import withPWA from "next-pwa";

// Caching "sano": asset statici in SWR, chiamate Supabase in NetworkFirst
const runtimeCaching = [
  {
    // css/js/img/font generati da Next
    urlPattern: ({ request }: any) =>
      ["style", "script", "image", "font"].includes(request.destination),
    handler: "StaleWhileRevalidate",
    options: { cacheName: "static-assets" },
  },
  {
    // API Supabase (REST/realtime)
    urlPattern: ({ url }: any) => url.hostname.endsWith(".supabase.co"),
    handler: "NetworkFirst",
    options: { cacheName: "supabase", networkTimeoutSeconds: 5 },
  },
];

const baseConfig: NextConfig = {
  reactStrictMode: true,
  // Se vuoi testare via IP in locale, sblocca e metti il tuo IP:
  // experimental: { allowedDevOrigins: ["http://192.168.1.61:3000"] },
};

// PWA attiva SOLO in build/production (su Vercel)
export default withPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  runtimeCaching: runtimeCaching as any,
})(baseConfig);
