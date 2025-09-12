"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type {
  RealtimePostgresInsertPayload,
  RealtimePostgresDeletePayload,
  RealtimeChannel,
} from "@supabase/supabase-js";

// 👇 Se hai creato il background Matrix, sblocca l'import e il componente nel JSX
// import MatrixBg from "@/components/MatrixBg";

/** Modello del messaggio (in chiaro lato UI) */
type Message = {
  id: string;
  room: string;
  author: string;
  content: string;
  created_at: string;
};

type CipherEnvelopeV1 = {
  v: "v1";
  alg: "AES-GCM";
  iv: string;   // base64
  salt: string; // base64
  ct: string;   // base64
};

/* ========== UI utils ========== */
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

/* ========== Crypto utils ========== */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function fromB64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function deriveKey(password: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", textEncoder.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptText(plain: string, password: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt.buffer);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plain));
  const env: CipherEnvelopeV1 = { v: "v1", alg: "AES-GCM", iv: toB64(iv.buffer), salt: toB64(salt.buffer), ct: toB64(ctBuf) };
  return env;
}
async function decryptTextFromEnvelope(contentField: string, password: string): Promise<string> {
  try {
    const env = JSON.parse(contentField) as CipherEnvelopeV1;
    if (env?.v !== "v1" || env?.alg !== "AES-GCM") throw new Error("not-v1");
    const iv = new Uint8Array(fromB64(env.iv));
    const salt = fromB64(env.salt);
    const key = await deriveKey(password, salt);
    const ct = fromB64(env.ct);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return textDecoder.decode(plainBuf);
  } catch {
    return contentField; // compat messaggi legacy o password errata
  }
}

/* ===================================================== */

export default function ChatApp() {
  // Theme
  const [dark, setDark] = useState(true);

  // Join & stato app
  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState(""); // 🔐 E2EE
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);

  // Chat
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState(0);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());

  // UI feedback
  const [errMsg, setErrMsg] = useState("");
  const [infoMsg, setInfoMsg] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);

  // Refs canali realtime
  const presenceRef = useRef<RealtimeChannel | null>(null);
  const msgChannelRef = useRef<RealtimeChannel | null>(null);

  const selfTypingRef = useRef(false);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Normalizza
  const normalizedRoom = useMemo(() => room.trim().toLowerCase(), [room]);
  const normalizedName = useMemo(() => name.trim(), [name]);

  // autoscroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      msgChannelRef.current?.unsubscribe();
      presenceRef.current?.unsubscribe();
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  /* ========== JOIN ========== */
  async function joinRoom(e?: React.FormEvent) {
    e?.preventDefault?.();
    setErrMsg("");
    setInfoMsg("");

    if (!normalizedRoom || !normalizedName || !pass) {
      setErrMsg("Inserisci nome, ID stanza e password.");
      return;
    }

    // chiudi canali precedenti e reset
    msgChannelRef.current?.unsubscribe();
    presenceRef.current?.unsubscribe();
    setMessages([]);

    setLoading(true);

    const { data, error } = await supabase
      .from("messages")
      .select("id, room, author, content, created_at")
      .eq("room", normalizedRoom)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      setErrMsg(`Errore Supabase SELECT: ${error.message}`);
      setLoading(false);
      return;
    }

    // decrypt batch
    const dec = await Promise.all(
      (data ?? []).map(async (m) => ({
        id: m.id as string,
        room: m.room as string,
        author: m.author as string,
        content: await decryptTextFromEnvelope(m.content as string, pass),
        created_at: m.created_at as string,
      }))
    );

    setMessages(dec);
    setJoined(true);
    setLoading(false);

    // Realtime messaggi
    const msgCh = supabase
      .channel(`room:${normalizedRoom}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room=eq.${normalizedRoom}` },
        async (payload: RealtimePostgresInsertPayload<any>) => {
          const plain = await decryptTextFromEnvelope(payload.new.content as string, pass);
          const newMsg: Message = {
            id: payload.new.id as string,
            room: payload.new.room as string,
            author: payload.new.author as string,
            content: plain,
            created_at: payload.new.created_at as string,
          };
          setMessages((prev) => [...prev, newMsg]);
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "messages", filter: `room=eq.${normalizedRoom}` },
        () => setMessages([])
      )
      .subscribe();
    msgChannelRef.current = msgCh;

    // Presence + broadcast
    const presenceCh = supabase.channel(`presence:${normalizedRoom}`, {
      config: { presence: { key: normalizedName } },
    });

    presenceCh
      .on("presence", { event: "sync" }, () => {
        const state = presenceCh.presenceState();
        setOnlineUsers(Object.keys(state).length);
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const { name: who, typing } = payload as { name: string; typing: boolean };
        if (!who || who === normalizedName) return;
        setTypingUsers((prev) => {
          const next = new Set(prev);
          typing ? next.add(who) : next.delete(who);
          return next;
        });
      })
      .on("broadcast", { event: "room_cleared" }, ({ payload }) => {
        setMessages([]);
        setTypingUsers(new Set());
        setInfoMsg(payload && (payload as any).by ? `Cronologia eliminata da ${(payload as any).by}.` : "Cronologia eliminata.");
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") presenceCh.track({ online_at: new Date().toISOString() });
      });

    presenceRef.current = presenceCh;
  }

  /* ========== SEND ========== */
  async function sendMessage() {
    setErrMsg("");
    setInfoMsg("");
    const text = message.trim();
    if (!text || !normalizedRoom || !normalizedName || !pass) return;

    setMessage("");
    sendTyping(false);

    try {
      const env = await encryptText(text, pass);
      const { error } = await supabase.from("messages").insert({
        room: normalizedRoom,
        author: normalizedName,
        content: JSON.stringify(env),
      });
      if (error) {
        setErrMsg(`Errore Supabase INSERT: ${error.message}`);
        setMessage(text);
        textareaRef.current?.focus();
      }
    } catch {
      setErrMsg("Errore durante la cifratura del messaggio.");
      setMessage(text);
      textareaRef.current?.focus();
    }
  }

  /* ========== CLEAR ========== */
  async function clearRoomHistory() {
    if (!normalizedRoom) return;
    if (!window.confirm(`Eliminare tutti i messaggi della stanza "${normalizedRoom}"?`)) return;

    setErrMsg("");
    setInfoMsg("");

    const { error } = await supabase.from("messages").delete().eq("room", normalizedRoom);
    if (error) {
      setErrMsg(`Errore DELETE: ${error.message}`);
      return;
    }

    setMessages([]);
    setTypingUsers(new Set());
    setInfoMsg("Cronologia della stanza eliminata.");

    presenceRef.current?.send({
      type: "broadcast",
      event: "room_cleared",
      payload: { by: normalizedName, at: new Date().toISOString() },
    });
  }

  /* ========== UX helpers ========== */
  function copyInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", normalizedRoom);
    url.searchParams.set("name", "");
    navigator.clipboard.writeText(url.toString());
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  }
  function sendTyping(typing: boolean) {
    if (selfTypingRef.current === typing) return;
    selfTypingRef.current = typing;
    presenceRef.current?.send({ type: "broadcast", event: "typing", payload: { name: normalizedName, typing } });
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

  /* ========== UI ========== */
  return (
    <div className={["min-h-screen transition-colors", dark ? "bg-[#0b0f14] text-slate-100" : "bg-gradient-to-b from-white to-slate-50 text-slate-900"].join(" ")}>
      {/* Matrix background opzionale */}
      {/* <MatrixBg opacity={dark ? 0.08 : 0.04} speed={28} fontSize={16} color="#00ff7f" /> */}

      {/* Topbar */}
      <header className="sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-white/5">
        <div className="max-w-3xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl font-semibold">Chat Anonima</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/30">
              Realtime · E2EE
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-70 hidden sm:inline">Stanza</span>
            <span className="text-xs font-medium px-2 py-1 rounded bg-slate-800/50 border border-slate-700/50">
              {normalizedRoom || "—"}
            </span>
            <button
              onClick={() => setDark((v) => !v)}
              className="ml-2 h-8 px-3 rounded-lg border border-slate-600/50 hover:bg-white/5 text-xs"
              title="Toggle tema"
            >
              {dark ? "☀️ Light" : "🌙 Dark"}
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 py-6">
        <div className="max-w-3xl mx-auto">
          {!joined ? (
            /* ===== HERO / JOIN CARD ===== */
            <div className={["rounded-3xl border shadow-sm p-6 sm:p-8",
              dark ? "bg-white/5 border-white/10 backdrop-blur" : "bg-white border-slate-200"].join(" ")}>
              <h1 className="text-2xl font-semibold mb-2">Crea o entra in una stanza privata</h1>
              <p className="text-sm opacity-70 mb-6">
                Invia messaggi cifrati end-to-end. Condividi l’ID stanza e la password con chi vuoi.
              </p>

              <form className="grid grid-cols-1 sm:grid-cols-4 gap-3" onSubmit={joinRoom}>
                <input
                  className="h-11 rounded-xl border px-3 outline-none focus:ring-2 focus:ring-sky-400/70 bg-transparent"
                  placeholder="Il tuo nome"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  className="h-11 rounded-xl border px-3 outline-none focus:ring-2 focus:ring-sky-400/70 bg-transparent"
                  placeholder="ID stanza (es. amore12)"
                  value={room}
                  onChange={(e) => setRoom(e.target.value)}
                />
                <input
                  type="password"
                  className="h-11 rounded-xl border px-3 outline-none focus:ring-2 focus:ring-sky-400/70 bg-transparent"
                  placeholder="Password stanza (E2EE)"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="h-11 rounded-xl bg-gradient-to-r from-sky-600 to-cyan-500 text-white font-medium hover:opacity-95 disabled:opacity-60"
                >
                  {loading ? "Carico…" : "Entra"}
                </button>
              </form>

              {(errMsg || infoMsg) && (
                <div className="mt-4 space-y-2">
                  {errMsg && <div className="rounded-lg border border-red-400/30 bg-red-500/10 text-red-300 px-3 py-2 text-sm">{errMsg}</div>}
                  {infoMsg && <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-300 px-3 py-2 text-sm">{infoMsg}</div>}
                </div>
              )}

              <div className="mt-5 text-xs opacity-60">
                Suggerimento: il link d’invito non include la password (per sicurezza). Condividila a voce.
              </div>
            </div>
          ) : (
            /* ===== CHAT CARD ===== */
            <div className={["rounded-3xl border shadow-sm",
              dark ? "bg-white/5 border-white/10 backdrop-blur" : "bg-white border-slate-200"].join(" ")}>
              {/* Header chat */}
              <div className="p-4 sm:p-5 border-b border-white/10 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-sky-600 text-white grid place-items-center font-semibold">
                    {initials(you.name)}
                  </div>
                  <div className="leading-tight">
                    <div className="font-semibold">{you.name}</div>
                    <div className="text-xs opacity-70 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1">
                        🗝️ <span className="tracking-tight">E2EE attiva</span>
                      </span>
                      <span>•</span>
                      <span>Stanza: <b>{normalizedRoom}</b></span>
                      <span>•</span>
                      <span>👥 {onlineUsers}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={copyInviteLink}
                    className="h-9 px-3 rounded-lg border border-slate-600/40 hover:bg-white/5 text-sm"
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
                      msgChannelRef.current?.unsubscribe();
                      presenceRef.current?.unsubscribe();
                      setJoined(false);
                      setOnlineUsers(0);
                      setTypingUsers(new Set());
                      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                      selfTypingRef.current = false;
                      setMessages([]);
                    }}
                    className="h-9 px-3 rounded-lg text-sm border border-slate-600/40 hover:bg-white/5"
                  >
                    Esci
                  </button>
                </div>
              </div>

              {/* Banner info/error */}
              {(errMsg || infoMsg) && (
                <div className="px-4 sm:px-5 pt-3 space-y-2">
                  {errMsg && <div className="rounded-lg border border-red-400/30 bg-red-500/10 text-red-300 px-3 py-2 text-sm">{errMsg}</div>}
                  {infoMsg && <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-300 px-3 py-2 text-sm">{infoMsg}</div>}
                </div>
              )}

              {/* Lista messaggi */}
              <div className="p-4 sm:p-5">
                <div className={["h-[56vh] sm:h-[60vh] overflow-y-auto pr-2 space-y-3 rounded-2xl p-3",
                  dark ? "bg-black/20 border border-white/10" : "bg-slate-50 border"].join(" ")}>
                  {messages.map((m) => {
                    const mine = m.author === you.name;
                    return (
                      <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div
                          className={[
                            "max-w-[85%] sm:max-w-[75%] rounded-2xl px-3 py-2 shadow-sm",
                            mine
                              ? "bg-gradient-to-br from-sky-600 to-cyan-600 text-white rounded-br-sm"
                              : dark
                              ? "bg-white/5 border border-white/10 rounded-bl-sm"
                              : "bg-white border rounded-bl-sm",
                          ].join(" ")}
                        >
                          <div className={`text-[11px] mb-1 ${mine ? "opacity-90" : "opacity-80"}`}>
                            {mine ? "Tu" : m.author}
                          </div>
                          <div className="whitespace-pre-wrap break-words">{m.content}</div>
                          <div className={`text-[10px] mt-1 text-right ${mine ? "opacity-90" : "opacity-70"}`}>
                            {formatTime(m.created_at)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>

                {/* Sta scrivendo */}
                {!!typingLabel && (
                  <div className="mt-2 text-xs italic opacity-70 flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    {typingLabel}
                  </div>
                )}

                {/* Composer */}
                <div className="mt-3 flex gap-2 items-end">
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
                    className={[
                      "min-h-[48px] w-full rounded-xl border px-3 py-3 outline-none focus:ring-2",
                      dark ? "bg-white/5 border-white/10 focus:ring-sky-400/60" : "bg-white border-slate-300 focus:ring-sky-400",
                    ].join(" ")}
                  />
                  <button
                    onClick={sendMessage}
                    className="h-12 px-5 rounded-xl bg-gradient-to-r from-sky-600 to-cyan-500 text-white font-medium hover:opacity-95"
                  >
                    Invia ➤
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer mini */}
      <footer className="py-6 text-center text-xs opacity-60">
        {joined ? "Chat privata in tempo reale · E2EE" : "Pronta a chattare in modo sicuro · E2EE"}
      </footer>
    </div>
  );
}
