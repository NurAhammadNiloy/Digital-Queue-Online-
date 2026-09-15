import type { NextRequest } from "next/server";
import { login } from "@/lib/auth/login";

export const runtime = "nodejs";
export function POST(request: NextRequest) { return login(request, "staff"); }
