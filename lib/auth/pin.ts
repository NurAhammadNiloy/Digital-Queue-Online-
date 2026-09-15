import "server-only";

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP scrypt baseline: N=2^17, r=8, p=1 (~128 MiB per verification).
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const prefix = "$scrypt$ln=17,r=8,p=1$";
const dummy = `${prefix}${"00".repeat(16)}$${"00".repeat(64)}`;
export const isValidPin = (pin: string) => pin.length >= 6 && pin.length <= 12 && !/[^0-9]/.test(pin);

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, 64, options, (error, result) => error ? reject(error) : resolve(result));
  });
}

export async function hashPin(pin: string): Promise<string> {
  if (!isValidPin(pin)) throw new Error("PIN must contain 6 to 12 digits.");
  const salt = randomBytes(16);
  return `${prefix}${salt.toString("hex")}$${(await derive(pin, salt)).toString("hex")}`;
}

export async function verifyPin(pin: string, encoded?: string | null): Promise<boolean> {
  const pattern = /^\$scrypt\$ln=17,r=8,p=1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
  const parsed = encoded?.match(pattern);
  const parts = parsed ?? dummy.match(pattern)!;
  // Unknown/inactive IDs and invalid hashes still pay the full KDF cost.
  const candidate = await derive(isValidPin(pin) ? pin : "000000", Buffer.from(parts[1], "hex"));
  const matches = timingSafeEqual(candidate, Buffer.from(parts[2], "hex"));
  return Boolean(parsed) && isValidPin(pin) && matches;
}
