import test from "node:test";
import assert from "node:assert/strict";
import { databaseFailure, logDevelopmentError } from "../lib/shared/development-error.ts";
import { getSupabaseConfig } from "../lib/supabase/config.ts";

test("development logs retain operation/database codes and configuration diagnosis without secrets", () => {
  const oldEnv = process.env.NODE_ENV, oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, oldLog = console.error, logs = [];
  console.error = (...args) => logs.push(args);
  try {
    process.env.NODE_ENV = "development";
    const secret = "never-log-this-customer-token-password-or-key";
    logDevelopmentError(databaseFailure("get_public_queue_location", { code: "42501", message: secret, details: secret }), "public-location-page");
    logDevelopmentError(databaseFailure("consume_auth_attempt", { code: "PGRST202", message: secret }), "api");
    logDevelopmentError(databaseFailure("get_public_queue_ticket", { code: secret, message: `fetch failed ${secret}` }), "public-ticket-page");
    logDevelopmentError(new Error(secret), "api");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    try { getSupabaseConfig(); assert.fail("Missing configuration must fail"); }
    catch (error) { logDevelopmentError(error, "public-location-page"); }
    const text = JSON.stringify(logs);
    for (const value of ["get_public_queue_location", "42501", "Database permission denied", "PGRST202", "CONNECTION_FAILED", "Missing NEXT_PUBLIC_SUPABASE_URL"]) assert.ok(text.includes(value));
    assert.ok(!text.includes(secret));
    const count = logs.length;
    for (const mode of ["production", "test"]) { process.env.NODE_ENV = mode; logDevelopmentError(databaseFailure("get_public_queue_location", { code: "42501" }), "api"); }
    assert.equal(logs.length, count);
  } finally {
    console.error = oldLog;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
  }
});
