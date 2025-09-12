"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { supabase } from "@/lib/supabase";
import type {
  RealtimePostgresInsertPayload,
  RealtimePostgresDeletePayload,
  RealtimeChannel,
} from "@supabase/supabase-js";

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
  iv: string;
  salt: string;
  ct: string;
};

/* ================= UI utils ================= */
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

/* ================= Crypto utils ================= */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(b64: string): ArrayBuffer {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
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

async function encryptText(plain: string, password: string): Promise<CipherEnvelopeV1> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt.buffer);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plain));
  return { v: "v1", alg: "AES-GCM", iv: toB64(iv.buffer), salt: toB64(salt.buffer), ct: toB64(ctBuf) };
}

async function decryptTextFromEnvelope(contentField: string, password: string): Promise<string> {
  try {
    const env = JSON.parse(contentField) as CipherEnvelopeV1;
    if (env?.v !== "v1") throw new Error("not-v1");
    const key = await deriveKey(password, fromB64(env.salt));
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(fromB64(env.iv)) }, key, fromB64(env.ct));
    return textDecoder.decode(plainBuf);
  } catch {
    return contentField; // fallback se password sbagliata o messaggi legacy
  }
}

/* ================= COMPONENT ================= */
export default function ChatApp() {
  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState(0);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());

  const [errMsg, setErrMsg] = useState("");
  const [infoMsg, setInfoMsg] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);

  const presenceRef = useRef<RealtimeChannel | null>(null);
  const msgChannelRef = useRef<RealtimeChannel | null>(null);

  const selfTypingRef = useRef(false);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const normalizedRoom = useMemo(() => room.trim().toLowerCase(), [room]);
  const normalizedName = useMemo(() => name.trim(), [name]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      msgChannelRef.current?.unsubscribe();
      presenceRef.current?.unsubscribe();
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  /* JOIN */
  async function joinRoom(e?: React.FormEvent) {
    e?.preventDefault?.();
    setErrMsg("");
    setInfoMsg("");
    if (!normalizedRoom || !normalizedName || !pass) {
      setErrMsg("Inserisci nome, ID stanza e password.");
      return;
    }

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
      setErrMsg(`Errore SELECT: ${error.message}`);
      setLoading(false);
      return;
    }

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

    const msgCh = supabase
      .channel(`room:${normalizedRoom}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `room=eq.${normalizedRoom}` }, async (payload: RealtimePostgresInsertPayload<any>) => {
        const plain = await decryptTextFromEnvelope(payload.new.content as string, pass);
        setMessages((prev) => [...prev, { id: payload.new.id, room: payload.new.room, author: payload.new.author, content: plain, created_at: payload.new.created_at }]);
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages", filter: `room=eq.${normalizedRoom}` }, () => setMessages([]))
      .subscribe();
    msgChannelRef.current = msgCh;

    const presenceCh = supabase.channel(`presence:${normalizedRoom}`, { config: { presence: { key: normalizedName } } });
    presenceCh
      .on("presence", { event: "sync" }, () => {
        setOnlineUsers(Object.keys(presenceCh.presenceState()).length);
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
      .subscribe((s) => {
        if (s === "SUBSCRIBED") presenceCh.track({ online_at: new Date().toISOString() });
      });
    presenceRef.current = presenceCh;
  }

  /* SEND */
  async function sendMessage() {
    const text = message.trim();
    if (!text || !normalizedRoom || !normalizedName || !pass) return;
    setMessage("");
    sendTyping(false);
    try {
      const env = await encryptText(text, pass);
      await supabase.from("messages").insert({ room: normalizedRoom, author: normalizedName, content: JSON.stringify(env) });
    } catch {
      setErrMsg("Errore cifratura messaggio.");
    }
  }

  /* CLEAR */
  async function clearRoomHistory() {
    if (!window.confirm(`Eliminare tutti i messaggi della stanza "${normalizedRoom}"?`)) return;
    await supabase.from("messages").delete().eq("room", normalizedRoom);
    setMessages([]);
    setTypingUsers(new Set());
    presenceRef.current?.send({ type: "broadcast", event: "room_cleared", payload: { by: normalizedName } });
  }

  function copyInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", normalizedRoom);
    url.searchParams.set("name", "");
    navigator.clipboard.writeText(url.toString());
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
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

  const typingLabel = useMemo(() => {
    const others = Array.from(typingUsers);
    if (others.length === 0) return "";
    if (others.length === 1) return `${others[0]} sta scrivendo…`;
    if (others.length === 2) return `${others[0]} e ${others[1]} stanno scrivendo…`;
    return "Più persone stanno scrivendo…";
  }, [typingUsers]);

  /* =============== RENDER =============== */
  return (
    <div className="min-h-screen bg-[#0b0f14] text-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-white/5">
        <div className="max-w-3xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl font-semibold">Chat Anonima</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/30">
              Realtime · E2EE
            </span>
          </div>
        </div>
      </header>

      {/* 🔥 HERO con immagine */}
      <section className="px-4 pt-6">
        <div className="max-w-4xl mx-auto relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-xl">
          <div className="absolute inset-0">
            <Image src="/hero.png" alt="Illustrazione Chat Anonima" fill className="object-cover opacity-75" priority />
            <div className="absolute inset-0 bg-black/35" />
          </div>
          <div className="relative z-10 p-8 sm:p-12">
            <span className="inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full bg-emerald-400/15 text-emerald-300 border border-emerald-400/30">
              🔐 E2EE • Realtime • Anonimo
            </span>
            <h1 className="mt-4 text-3xl sm:text-4xl font-semibold leading-tight">
              Chat privata, cifrata end-to-end.<br />Veloce, semplice, anonima.
            </h1>
            <p className="mt-3 text-sm opacity-80">
              Condividi l’ID stanza e la password. Nessuno fuori dalla stanza può leggere i messaggi.
            </p>
          </div>
        </div>
      </section>

      {/* MAIN */}
      <main className="px-4 py-6">
        <div className="max-w-3xl mx-auto">
          {!joined ? (
            <div className="rounded-2xl border bg-white/5 p-6 shadow-sm">
              <h1 className="text-xl font-semibold mb-4">Crea/Entra in una stanza privata</h1>
              <form className="grid grid-cols-1 sm:grid-cols-4 gap-3" onSubmit={joinRoom}>
                <input className="h-10 rounded-lg border px-3 bg-transparent" placeholder="Il tuo nome" value={name} onChange={(e) => setName(e.target.value)} />
                <input className="h-10 rounded-lg border px-3 bg-transparent" placeholder="ID stanza" value={room} onChange={(e) => setRoom(e.target.value)} />
                <input type="password" className="h-10 rounded-lg border px-3 bg-transparent" placeholder="Password stanza" value={pass} onChange={(e) => setPass(e.target.value)} />
                <button type="submit" disabled={loading} className="h-10 rounded-lg bg-sky-600 text-white">{loading ? "Carico…" : "Entra"}</button>
              </form>
              {errMsg && <div className="mt-3 text-red-400">{errMsg}</div>}
              {infoMsg && <div className="mt-3 text-green-400">{infoMsg}</div>}
            </div>
          ) : (
            <div className="rounded-2xl border bg-white/5 shadow-sm">
              <div className="p-4 border-b flex items-center justify-between">
                <div>
                  <div className="font-semibold">{name}</div>
                  <div className="text-xs opacity-70">Stanza: {normalizedRoom} | 👥 {onlineUsers}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={copyInviteLink} className="h-9 px-3 rounded-lg border">{linkCopied ? "Link copiato!" : "Copia invito"}</button>
                  <button onClick={clearRoomHistory} className="h-9 px-3 rounded-lg bg-red-600 text-white">Elimina cronologia</button>
                  <button onClick={() => setJoined(false)} className="h-9 px-3 rounded-lg border">Esci</button>
                </div>
              </div>

              <div className="p-4 h-[50vh] overflow-y-auto space-y-3">
                {messages.map((m) => {
                  const mine = m.author === normalizedName;
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3 py-2 ${mine ? "bg-sky-600 text-white" : "bg-white/10"}`}>
                        <div className="text-xs opacity-70 mb-1">{mine ? "Tu" : m.author}</div>
                        <div>{m.content}</div>
                        <div className="text-[10px] opacity-50 mt-1 text-right">{formatTime(m.created_at)}</div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {!!typingLabel && <div className="px-4 text-xs italic opacity-70">{typingLabel}</div>}

              <div className="p-4 flex gap-2">
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
                  className="flex-1 h-12 rounded-lg border px-3 bg-transparent"
                />
                <button onClick={sendMessage} className="h-12 px-4 rounded-lg bg-sky-600 text-white">Invia</button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
