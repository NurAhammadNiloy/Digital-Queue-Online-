"use client";
import { useId, useRef, useState } from "react";

export function PinField({ label }: { label: string }) {
  const input = useRef<HTMLInputElement>(null), id = useId();
  const [visible, setVisible] = useState(false), [message, setMessage] = useState("");
  function generate() {
    // Rejection sampling avoids modulo bias. This new credential is submitted
    // to the existing server-side hasher; no stored credential is read here.
    let pin = "";
    while (pin.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 250 && pin.length < 8) pin += String(byte % 10);
    }
    if (input.current) { input.current.value = pin; input.current.focus(); }
    setMessage("An 8-digit PIN was generated. Use Show PIN to review it.");
  }
  return <div className="space-y-2"><label className="block" htmlFor={id}>{label}<input ref={input} id={id} className="field font-mono" name="pin" type={visible ? "text" : "password"} inputMode="numeric" pattern="[0-9]{6,12}" minLength={6} maxLength={12} required autoComplete="new-password" aria-describedby={`${id}-help`} /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn" onClick={generate}>Generate PIN</button><button type="button" className="btn" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? "Hide PIN" : "Show PIN"}</button></div>
    <p id={`${id}-help`} className="muted">6–12 digits. Stored securely; existing PINs cannot be viewed.</p><span role="status" className="text-xs text-slate-600">{message}</span>
  </div>;
}
