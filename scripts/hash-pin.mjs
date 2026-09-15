// Run with Node 24: node --conditions=react-server scripts/hash-pin.mjs
// Prompt masks input; do not pass credentials as command-line arguments.
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { hashPin } from "../lib/auth/pin.ts";

let muted = false;
const output = new Writable({ write(chunk, encoding, callback) {
  if (!muted) process.stdout.write(chunk, encoding);
  callback();
} });
if (!process.stdin.isTTY) throw new Error("Use an interactive terminal for the masked PIN prompt.");
const prompt = createInterface({ input: process.stdin, output, terminal: true });
process.stdout.write("PIN (6–12 digits, hidden): ");
muted = true;
try {
  const pin = await prompt.question("");
  const hash = await hashPin(pin);
  process.stdout.write(`\n${hash}\n`);
} catch {
  process.stderr.write("\nCould not hash PIN. Use 6–12 digits.\n");
  process.exitCode = 1;
} finally { prompt.close(); }
