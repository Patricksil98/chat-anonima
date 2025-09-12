import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chat Anonima — E2EE Realtime",
  description:
    "Chat privata, cifrata end-to-end e in tempo reale. Condividi un ID stanza e scrivi in totale anonimato.",
  openGraph: {
    title: "Chat Anonima — E2EE Realtime",
    description:
      "Chat privata, cifrata end-to-end e in tempo reale. Nessuno fuori dalla stanza può leggere i messaggi.",
    url: "https://tuo-dominio.vercel.app", // 🔹 sostituisci con il dominio reale
    siteName: "Chat Anonima",
    images: [
      {
        url: "/hero.png", // 🔹 l’immagine che hai messo in /public
        width: 1200,
        height: 630,
        alt: "Chat Anonima preview",
      },
    ],
    locale: "it_IT",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Chat Anonima — E2EE Realtime",
    description:
      "Chat privata, cifrata end-to-end e in tempo reale. Entra con un link, nessun account richiesto.",
    images: ["/hero.png"],
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0b0f14] text-slate-100`}
      >
        {children}
      </body>
    </html>
  );
}
