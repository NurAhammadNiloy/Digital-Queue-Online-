"use client";
import { useEffect, useState } from "react";

export function CopyButton({ value, label = "Copy link" }: { value: string; label?: string }) {
  const [message, setMessage] = useState("");
  useEffect(() => { if (message) { const timer = setTimeout(() => setMessage(""), 4000); return () => clearTimeout(timer); } }, [message]);
  return <span className="inline-flex flex-wrap items-center gap-2"><button type="button" className="btn" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setMessage("Copied."); }
    catch { setMessage("Copy unavailable. Select and copy the displayed value."); }
  }}>{label}</button><span role="status" className="text-xs text-slate-600">{message}</span></span>;
}
