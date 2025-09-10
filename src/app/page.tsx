"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { RealtimePostgresInsertPayload } from "@supabase/supabase-js";

/** Modello del messaggio in DB */
type Message = {
  id: string;
  room: string;
  author: string;
  content: string;
  created_at: string; // ISO
};

function initials(name: string) {
  // tipizza esplicitamente il parametro della map per evitare "implicit any"
  return (name || "?")
    .split(/\s+/)
    .map((s: string) => s[0] ?? "?")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatApp() {
  const [room, setRoom] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [joined, setJoined] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [linkCopied, setLinkCopied] = useState<boolean>(false);
  const [errMsg, setErrMsg] = useState<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // autoscroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ping iniziale (facoltativo) per segnalare errori di config
  useEffect(() => {
    (async () => {
      const { error } = await supabase.from("messages").select("id").limit(1);
      if (error) setErrMsg(`Ping DB fallito: ${error.message}`);
    })();
  }, []);

  async function joinRoom(e?: React.FormEvent<HTMLFormElement>) {
    e?.preventDefault?.();
    setErrMsg("");

    if (!room || !name) {
      setErrMsg("Inserisci sia il nome sia l'ID stanza.");
      return;
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      setErrMsg("Supabase non configurato: controlla .env.local e riavvia `npm run dev`.");
      return;
    }

    setLoading(true);

    const { data, error } = await supabase
      .from("messages")
      .select("id, room, author, content, created_at")
      .eq("room", room)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      setErrMsg(`Errore Supabase SELECT: ${error.message}`);
      setLoading(false);
      return;
    }

    setMessages((data ?? []) as Message[]);
    setJoined(true);
    setLoading(false);

    // realtime su INSERT (nessuna variabile inutilizzata)
    supabase
      .channel(`room:${room}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room=eq.${room}` },
        (payload: RealtimePostgresInsertPayload<Message>) => {
          setMessages((prev) => [...prev, payload.new]);
        }
      )
      .subscribe();
  }

  async function sendMessage() {
    setErrMsg("");
    const text = message.trim();
    if (!text || !room || !name) return;

    setMessage("");

    const { error } = await supabase.from("messages").insert({
      room,
      author: name,
      content: text,
    } satisfies Omit<Message, "id" | "created_at">);

    if (error) {
      setErrMsg(`Errore Supabase INSERT: ${error.message}`);
      setMessage(text); // ripristina
      textareaRef.current?.focus();
    }
  }

  function copyInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", room);
    url.searchParams.set("name", "");
    navigator.clipboard.writeText(url.toString());
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  }

  const you = useMemo(() => ({ name, avatar: initials(name) }), [name]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 text-slate-900 p-4">
      <div className="max-w-3xl mx-auto">
        {!joined ? (
          <div className="rounded-2xl border bg-white shadow-sm p-6">
            <h1 className="text-xl font-semibold mb-4">Crea/Entra in una stanza privata</h1>

            <form className="grid grid-cols-1 md:grid-cols-3 gap-3" onSubmit={joinRoom}>
              <input
                className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-sky-400"
                placeholder="Il tuo nome"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              />
              <input
                className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-sky-400"
                placeholder="ID stanza (es. amore12)"
                value={room}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRoom(e.target.value)}
              />
              <button
                type="submit"
                disabled={loading}
                className="h-10 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 disabled:opacity-60"
              >
                {loading ? "Carico..." : "Entra"}
              </button>
            </form>

            {/* Diagnostica e messaggi d'errore */}
            <div className="mt-4 text-xs text-slate-600 space-y-1">
              <div>
                <b>URL Supabase:</b>{" "}
                {process.env.NEXT_PUBLIC_SUPABASE_URL || "NON TROVATO"}
              </div>
              <div>
                <b>Anon key presente:</b>{" "}
                {process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "SÌ" : "NO"}
              </div>
              {errMsg && (
                <div className="mt-2 rounded-md border border-red-300 bg-red-50 text-red-700 px-3 py-2">
                  {errMsg}
                </div>
              )}
            </div>

            <p className="mt-3 text-sm text-slate-500">
              Suggerimento: inventa un ID stanza e condividilo con la tua ragazza.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border bg-white shadow-sm">
            {/* Header */}
            <div className="p-4 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-sky-600 text-white grid place-items-center font-semibold">
                  {you.avatar}
                </div>
                <div className="leading-tight">
                  <div className="font-semibold">{name}</div>
                  <div className="text-xs text-slate-500">Stanza: {room}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyInviteLink}
                  className="h-9 px-3 rounded-lg border hover:bg-slate-50 text-sm"
                >
                  {linkCopied ? "Link copiato!" : "Copia invito"}
                </button>
                <button
                  onClick={() => setJoined(false)}
                  className="h-9 px-3 rounded-lg text-sm hover:bg-slate-50"
                >
                  Esci
                </button>
              </div>
            </div>

            {/* Messaggio d'errore anche in chat */}
            {errMsg && (
              <div className="mx-4 mt-3 rounded-md border border-red-300 bg-red-50 text-red-700 px-3 py-2 text-sm">
                {errMsg}
              </div>
            )}

            {/* Messages */}
            <div className="p-4">
              <div className="h-[50vh] overflow-y-auto pr-2 space-y-3 border rounded-2xl p-3 bg-slate-50">
                {messages.map((m) => {
                  const mine = m.author === name;
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${
                          mine
                            ? "bg-sky-600 text-white rounded-br-sm"
                            : "bg-white rounded-bl-sm border"
                        }`}
                      >
                        <div className="text-xs mb-1 opacity-80">{mine ? "Tu" : m.author}</div>
                        <div className="whitespace-pre-wrap break-words">{m.content}</div>
                        <div className="text-[10px] opacity-60 mt-1 text-right">
                          {formatTime(m.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* Composer */}
              <div className="mt-3 flex gap-2 items-end">
                <textarea
                  ref={textareaRef}
                  placeholder="Scrivi un messaggio…"
                  value={message}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setMessage(e.target.value)
                  }
                  onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  className="min-h-[44px] w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-sky-400"
                />
                <button
                  onClick={sendMessage}
                  className="h-11 px-4 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700"
                >
                  Invia
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
