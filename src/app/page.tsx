"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type {
  RealtimePostgresInsertPayload,
  RealtimeChannel,
} from "@supabase/supabase-js";

/** Modello del messaggio in DB */
type Message = {
  id: string;
  room: string;
  author: string;
  content: string;
  created_at: string; // ISO
};

function initials(name: string) {
  return (name || "?")
    .split(/\s+/)
    .map((s) => s[0])
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
  const [infoMsg, setInfoMsg] = useState<string>("");

  // Presence (numero persone) + canale condiviso per presence/broadcast
  const [onlineUsers, setOnlineUsers] = useState<number>(0);
  const presenceRef = useRef<RealtimeChannel | null>(null);

  // Typing indicator
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const selfTypingRef = useRef<boolean>(false);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 🔑 Normalizza SEMPRE l’ID stanza (trim + lowercase)
  const normalizedRoom = useMemo(() => room.trim().toLowerCase(), [room]);
  const normalizedName = useMemo(() => name.trim(), [name]);

  // autoscroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ping iniziale
  useEffect(() => {
    (async () => {
      const { error } = await supabase.from("messages").select("id").limit(1);
      if (error) setErrMsg(`Ping DB fallito: ${error.message}`);
    })();
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      presenceRef.current?.unsubscribe();
      presenceRef.current = null;
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  async function joinRoom(e?: React.FormEvent) {
    e?.preventDefault?.();
    setErrMsg("");
    setInfoMsg("");

    if (!normalizedRoom || !normalizedName) {
      setErrMsg("Inserisci sia il nome sia l'ID stanza.");
      return;
    }

    setLoading(true);

    const { data, error } = await supabase
      .from("messages")
      .select("id, room, author, content, created_at")
      .eq("room", normalizedRoom) // ✅ usa la stanza normalizzata
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

    // realtime messaggi (canale legato alla stanza normalizzata)
    supabase
      .channel(`room:${normalizedRoom}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room=eq.${normalizedRoom}` },
        (payload: RealtimePostgresInsertPayload<Message>) => {
          setMessages((prev) => [...prev, payload.new]);
        }
      )
      .subscribe();

    // Presence + Broadcast (typing + room_cleared)
    const presenceCh = supabase.channel(`presence:${normalizedRoom}`, {
      config: { presence: { key: normalizedName } },
    });

    presenceCh
      // presenza: conteggio utenti
      .on("presence", { event: "sync" }, () => {
        const state = presenceCh.presenceState();
        setOnlineUsers(Object.keys(state).length);
      })
      // broadcast: typing degli altri
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const { name: who, typing } = payload as { name: string; typing: boolean };
        if (!who || who === normalizedName) return;
        setTypingUsers((prev) => {
          const next = new Set(prev);
          typing ? next.add(who) : next.delete(who);
          return next;
        });
      })
      // broadcast: stanza svuotata da qualcuno
      .on("broadcast", { event: "room_cleared" }, ({ payload }) => {
        setMessages([]);
        setTypingUsers(new Set());
        setInfoMsg(
          payload && (payload as any).by
            ? `Cronologia eliminata da ${(payload as any).by}.`
            : "Cronologia eliminata."
        );
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          presenceCh.track({ online_at: new Date().toISOString() });
        }
      });

    presenceRef.current = presenceCh;
  }

  async function sendMessage() {
    setErrMsg("");
    setInfoMsg("");
    const text = message.trim();
    if (!text || !normalizedRoom || !normalizedName) return;

    setMessage("");
    sendTyping(false);

    const { error } = await supabase.from("messages").insert({
      room: normalizedRoom,          // ✅ salva la stanza normalizzata
      author: normalizedName.trim(), // (nome già normalizzato)
      content: text,
    } satisfies Omit<Message, "id" | "created_at">);

    if (error) {
      setErrMsg(`Errore Supabase INSERT: ${error.message}`);
      setMessage(text);
      textareaRef.current?.focus();
    }
  }

  // 🔴 Elimina cronologia stanza (per tutti)
  async function clearRoomHistory() {
    if (!normalizedRoom) return;
    const ok = window.confirm(
      `Sei sicuro di voler eliminare tutti i messaggi della stanza "${normalizedRoom}"?`
    );
    if (!ok) return;

    setErrMsg("");
    setInfoMsg("");

    const { error } = await supabase.from("messages").delete().eq("room", normalizedRoom);

    if (error) {
      setErrMsg(`Errore DELETE: ${error.message}`);
      return;
    }

    // Verifica lato DB: se restano record (per vecchie maiuscole/spazi), fai una delete case-insensitive
    const { count, error: countErr } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("room", normalizedRoom);

    if (!countErr && count && count > 0) {
      // cleanup extra di sicurezza (case-insensitive / spazi)
      await supabase
        .from("messages")
        .delete()
        .ilike("room", normalizedRoom); // 'eq' con normalizzazione dovrebbe bastare, ma usiamo ilike come fallback
    }

    // svuota localmente
    setMessages([]);
    setTypingUsers(new Set());
    setInfoMsg("Cronologia della stanza eliminata.");

    // 🔔 avvisa gli altri client nella stanza (realtime)
    presenceRef.current?.send({
      type: "broadcast",
      event: "room_cleared",
      payload: { by: normalizedName, at: new Date().toISOString() },
    });
  }

  function copyInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", normalizedRoom); // ✅ link coerente
    url.searchParams.set("name", "");
    navigator.clipboard.writeText(url.toString());
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  }

  // ---- Typing indicator helpers ----
  function sendTyping(typing: boolean) {
    if (selfTypingRef.current === typing) return;
    selfTypingRef.current = typing;

    presenceRef.current?.send({
      type: "broadcast",
      event: "typing",
      payload: { name: normalizedName, typing },
    });
  }

  function handleTypingActivity() {
    sendTyping(true);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => sendTyping(false), 1500);
  }

  const you = useMemo(() => ({ name: normalizedName, avatar: initials(normalizedName) }), [normalizedName]);

  const typingLabel = useMemo(() => {
    const others = Array.from(typingUsers);
    if (others.length === 0) return "";
    if (others.length === 1) return `${others[0]} sta scrivendo…`;
    if (others.length === 2) return `${others[0]} e ${others[1]} stanno scrivendo…`;
    return "Più persone stanno scrivendo…";
  }, [typingUsers]);

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
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-sky-400"
                placeholder="ID stanza (es. codi)"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
              />
              <button
                type="submit"
                disabled={loading}
                className="h-10 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 disabled:opacity-60"
              >
                {loading ? "Carico..." : "Entra"}
              </button>
            </form>
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
                  <div className="font-semibold">{you.name}</div>
                  <div className="text-xs text-slate-500">Stanza: {normalizedRoom}</div>
                  <div className="text-xs text-slate-600 mt-1">👥 Persone nella stanza: {onlineUsers}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={copyInviteLink}
                  className="h-9 px-3 rounded-lg border hover:bg-slate-50 text-sm"
                >
                  {linkCopied ? "Link copiato!" : "Copia invito"}
                </button>
                <button
                  onClick={clearRoomHistory}
                  className="h-9 px-3 rounded-lg text-sm bg-red-600 text-white hover:bg-red-700"
                  title="Elimina tutti i messaggi della stanza"
                >
                  Elimina cronologia
                </button>
                <button
                  onClick={() => {
                    presenceRef.current?.unsubscribe();
                    presenceRef.current = null;
                    setJoined(false);
                    setOnlineUsers(0);
                    setTypingUsers(new Set());
                    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                    selfTypingRef.current = false;
                  }}
                  className="h-9 px-3 rounded-lg text-sm hover:bg-slate-50"
                >
                  Esci
                </button>
              </div>
            </div>

            {/* Banner messaggi */}
            {(errMsg || infoMsg) && (
              <div className="mx-4 mt-3 space-y-2">
                {errMsg && (
                  <div className="rounded-md border border-red-300 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {errMsg}
                  </div>
                )}
                {infoMsg && (
                  <div className="rounded-md border border-green-300 bg-green-50 text-green-700 px-3 py-2 text-sm">
                    {infoMsg}
                  </div>
                )}
              </div>
            )}

            {/* Messages */}
            <div className="p-4">
              <div className="h-[50vh] overflow-y-auto pr-2 space-y-3 border rounded-2xl p-3 bg-slate-50">
                {messages.map((m) => {
                  const mine = m.author === you.name;
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

              {/* Indicatore sta scrivendo */}
              {Array.from(typingUsers).length > 0 && (
                <div className="mt-2 text-xs text-slate-500 italic">
                  {Array.from(typingUsers).length === 1
                    ? `${Array.from(typingUsers)[0]} sta scrivendo…`
                    : "Più persone stanno scrivendo…"}
                </div>
              )}

              {/* Composer */}
              <div className="mt-2 flex gap-2 items-end">
                <textarea
                  ref={textareaRef}
                  placeholder="Scrivi un messaggio…"
                  value={message}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    handleTypingActivity();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    } else {
                      handleTypingActivity();
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
