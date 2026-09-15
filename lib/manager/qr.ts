import "server-only";
import encodeQR from "qr";
import { appOrigin } from "@/lib/auth/http";

export function publicLocationUrl(slug: string) {
  return `${appOrigin()}/q/${encodeURIComponent(slug)}`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapLabel(value: string, max = 34) {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

export function locationQr(slug: string, size = 320) {
  return encodeQR(publicLocationUrl(slug), "svg", { ecc: "medium", border: 4, scale: 1, optimize: false })
    .replace("<svg ", `<svg width="${size}" height="${size}" shape-rendering="crispEdges" `)
    .replace(">", '><rect width="100%" height="100%" fill="#fff"/>');
}

export function locationQrPoster(slug: string, locationName: string) {
  const url = publicLocationUrl(slug);
  const marker = "/q/";
  const markerIndex = url.indexOf(marker);
  const urlLine1 = markerIndex >= 0 ? url.slice(0, markerIndex + marker.length) : url;
  const urlLine2 = markerIndex >= 0 ? url.slice(markerIndex + marker.length) : "";
  const nameLines = wrapLabel(locationName);
  const nameTspans = nameLines
    .map((line, index) => `<tspan x="397" dy="${index === 0 ? 0 : 38}">${escapeXml(line)}</tspan>`)
    .join("");

  const qr = encodeQR(url, "svg", { ecc: "medium", border: 4, scale: 1, optimize: false })
    .replace("<svg ", '<svg x="137" y="326" width="520" height="520" shape-rendering="crispEdges" ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 794 1123">
  <rect width="794" height="1123" fill="#ffffff"/>
  <rect width="794" height="152" fill="#183c31"/>
  <circle cx="72" cy="76" r="27" fill="#33765a"/>
  <path d="M58 65h28M58 76h28M58 87h18" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <text x="116" y="88" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700">Digital Queue</text>
  <text x="397" y="214" text-anchor="middle" fill="#173e2e" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="2.5">SCAN TO JOIN THE QUEUE</text>
  <text x="397" y="265" text-anchor="middle" fill="#111827" font-family="Segoe UI, Arial, sans-serif" font-size="31" font-weight="700">${nameTspans}</text>
  <rect x="116" y="305" width="562" height="562" rx="34" fill="#f7faf7" stroke="#d6e4d8" stroke-width="2"/>
  ${qr}
  <text x="397" y="930" text-anchor="middle" fill="#374151" font-family="Segoe UI, Arial, sans-serif" font-size="19">Open your camera and scan the QR code</text>
  <text x="397" y="970" text-anchor="middle" fill="#6b7280" font-family="Segoe UI, Arial, sans-serif" font-size="15">or visit</text>
  <text x="397" y="1002" text-anchor="middle" fill="#245844" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="600">${escapeXml(urlLine1)}</text>
  ${urlLine2 ? `<text x="397" y="1027" text-anchor="middle" fill="#245844" font-family="Segoe UI, Arial, sans-serif" font-size="13">${escapeXml(urlLine2)}</text>` : ""}
  <line x1="116" y1="1065" x2="678" y2="1065" stroke="#e5ebe6"/>
  <text x="397" y="1094" text-anchor="middle" fill="#8a948d" font-family="Segoe UI, Arial, sans-serif" font-size="12">Powered by Digital Queue</text>
</svg>`;
}
