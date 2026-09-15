import "server-only";
import encodeQR from "qr";
import { appOrigin } from "@/lib/auth/http";

export function publicLocationUrl(slug: string) {
  return `${appOrigin()}/q/${encodeURIComponent(slug)}`;
}
export function locationQr(slug: string) {
  // SVG scales without expanding every module into many individual pixel rects.
  // An opaque quiet zone keeps downloaded codes usable on dark backgrounds.
  return encodeQR(publicLocationUrl(slug), "svg", { ecc: "medium", border: 4, scale: 1, optimize: false })
    .replace("<svg ", '<svg width="320" height="320" shape-rendering="crispEdges" ')
    .replace(">", '><rect width="100%" height="100%" fill="#fff"/>');
}
