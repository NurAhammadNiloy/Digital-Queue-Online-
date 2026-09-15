import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, HttpError } from "@/lib/auth/http";
import { readSession, sessionCookieName } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { customerDigest } from "@/lib/customer/rate-limit";

export function checkStreamRequest(request: NextRequest) {
  // Same-origin EventSource GETs may omit Origin. Cross-site fetch metadata
  // and explicit foreign/null origins are still rejected; no CORS is enabled.
  const origin = request.headers.get("origin");
  if ((origin !== null && origin !== appOrigin()) || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Request origin is not allowed.");
}

export async function limitStream(identity: string) {
  const { data, error } = await createAdminClient().rpc("consume_auth_attempt", {
    p_key_hash: customerDigest(`realtime:${identity}`), p_limit: 12, p_window_seconds: 60,
  });
  if (error) throw new Error("Realtime admission unavailable.");
  if (!data) throw new HttpError(429, "Too many live connections. Polling remains available.", 60);
}

export function sessionAccess(request: NextRequest, role: "staff" | "manager", locationId: string, serviceId?: string) {
  const token = request.cookies.get(sessionCookieName(role))?.value;
  return async () => {
    const session = await readSession(token);
    if (!session || session.role !== role) return false;
    if (session.role === "staff") return session.assignments.some((a) => a.locationId === locationId && a.serviceId === serviceId);
    const { data, error } = await createAdminClient().from("locations").select("id").eq("id", locationId).eq("organization_id", session.organizationId).maybeSingle();
    if (error) throw new Error("Location validation unavailable.");
    return Boolean(data);
  };
}

/** One narrowly scoped Supabase private Broadcast channel per bounded stream.
 * Every forwarded signal revalidates current access. No Supabase payload or
 * credential crosses this boundary; all UI data comes from protected reads. */
export function queueEventStream(request: NextRequest, topic: string, allowed: () => Promise<boolean>) {
  const client = createAdminClient();
  const encoder = new TextEncoder();
  let closed = false, subscribed = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let setup: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<boolean> | undefined;
  const channel = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
  const emit = (event: string) => { if (!closed) output.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`)); };
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); clearTimeout(lifetime); clearTimeout(setup); clearTimeout(pending);
    request.signal.removeEventListener("abort", close);
    void client.removeChannel(channel).finally(() => client.realtime.disconnect()).catch(() => {});
    try { output.close(); } catch { /* Consumer already cancelled. */ }
  }
  async function validate() {
    if (closed) return false;
    // Transient validation failure closes the transport for a backed-off retry;
    // only a confirmed revocation marks this scope as permanently inaccessible.
    checking ??= allowed().catch(() => { close(); return false; }).finally(() => { checking = undefined; });
    const valid = await checking;
    if (!valid && !closed) { emit("access-changed"); close(); }
    return valid && !closed;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      output.enqueue(encoder.encode("retry: 4000\n\n"));
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      lifetime = setTimeout(close, 45000); // Renew below the route's 60s ceiling.
      setup = setTimeout(close, 8000); // Offline Realtime cannot hang the stream.
      heartbeat = setInterval(() => { void validate().then((valid) => { if (valid) emit("keepalive"); }); }, 5000);
      channel.on("broadcast", { event: "queue_changed" }, () => {
        if (closed || !subscribed || pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          void validate().then((valid) => { if (valid) emit("queue-changed"); });
        }, 250);
      }).subscribe((status) => {
        if (closed) return;
        if (status === "SUBSCRIBED") {
          subscribed = true; clearTimeout(setup);
          // Close the fetch/subscription race by asking for one fresh snapshot.
          void validate().then((valid) => { if (valid) emit("ready"); });
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) close();
      });
    },
    cancel() { close(); },
  });
  return new NextResponse(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "private, no-store, no-transform",
    "X-Accel-Buffering": "no", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  } });
}
