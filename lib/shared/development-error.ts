// Never serialize arbitrary SDK errors: details/messages can contain request
// values, customer names, tokens or credentials. Only fixed labels and codes.
type Operation = "get_public_queue_location" | "get_public_queue_ticket" | "join_public_queue" | "cancel_public_queue_ticket" | "consume_auth_attempt";
class DatabaseDiagnostic extends Error {
  readonly operation: Operation;
  readonly code: string;
  constructor(operation: Operation, code: string) {
    super("Database request failed."); this.operation = operation; this.code = code;
  }
}
export function databaseFailure(operation: Operation, error: { code?: string; message?: string }) {
  const code = /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(error.code ?? "") ? error.code! :
    error.message?.includes("fetch failed") ? "CONNECTION_FAILED" : "UNKNOWN_DATABASE_ERROR";
  return new DatabaseDiagnostic(operation, code);
}
const configurationErrors = new Map([
  ["Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY before using Supabase. See .env.example.", "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; run local:setup."],
  ["NEXT_PUBLIC_SUPABASE_URL must be a valid HTTP(S) URL.", "Invalid NEXT_PUBLIC_SUPABASE_URL."],
  ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key (sb_publishable_...). Never use a secret or service-role key.", "Invalid publishable-key type; use the local PUBLISHABLE_KEY."],
  ["SUPABASE_SERVICE_ROLE_KEY is required for server authentication.", "Missing SUPABASE_SERVICE_ROLE_KEY."],
  ["Rate-limit secret is required.", "Missing or short AUTH_RATE_LIMIT_SECRET."],
]);
const databaseReasons: Record<string, string> = {
  "42501": "Database permission denied.", "42883": "Database function missing; check local migrations.",
  PGRST202: "RPC absent from schema cache; check local migrations.", PGRST301: "Database authentication failed; check local keys.",
  PGRST302: "Database authentication required; check local keys.", CONNECTION_FAILED: "Cannot connect to Supabase; check local runtime and URL.",
};
export function logDevelopmentError(error: unknown, context: "public-location-page" | "public-ticket-page" | "api") {
  if (process.env.NODE_ENV !== "development") return;
  if (error instanceof DatabaseDiagnostic) {
    console.error("[queue:development]", { context, operation: error.operation, code: error.code, reason: databaseReasons[error.code] ?? "Database request failed; inspect the local database for this error code." });
  } else {
    console.error("[queue:development]", { context, reason: error instanceof Error ? configurationErrors.get(error.message) ?? "Unexpected server failure (sensitive error details omitted)." : "Unexpected server failure (sensitive error details omitted)." });
  }
}
