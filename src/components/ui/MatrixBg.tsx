"use client";
import React, { useEffect, useRef } from "react";

export default function MatrixBg({
  opacity = 0.08,   // scia
  speed = 28,       // ms tra i frame (più basso = più veloce)
  fontSize = 16,    // dimensione caratteri
  color = "#00ff7f" // verde
}: {
  opacity?: number; speed?: number; fontSize?: number; color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    let w = (c.width = window.innerWidth);
    let h = (c.height = window.innerHeight);

    const chars =
      "アァカサタナハマヤャラワン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const cols = Math.ceil(w / fontSize);
    const drops = new Array(cols).fill(0).map(() => Math.floor(Math.random() * 50));

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, w, h);

    const draw = () => {
      ctx.fillStyle = `rgba(0,0,0,${opacity})`;
      ctx.fillRect(0, 0, w, h);

      for (let i = 0; i < drops.length; i++) {
        const ch = chars.charAt(Math.floor(Math.random() * chars.length));
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fillStyle = color;
        ctx.fillText(ch, x, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        else drops[i]++;
      }
    };

    const tick = () => {
      draw();
      timerRef.current = window.setTimeout(() => {
        rafRef.current = requestAnimationFrame(tick);
      }, reduceMotion ? 250 : speed);
    };
    tick();

    const onResize = () => {
      w = c.width = window.innerWidth;
      h = c.height = window.innerHeight;
      ctx.font = `${fontSize}px monospace`;
    };
    window.addEventListener("resize", onResize);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [opacity, speed, fontSize, color]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 -z-10 pointer-events-none select-none"
      aria-hidden="true"
    />
  );
}
