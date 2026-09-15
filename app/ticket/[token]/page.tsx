import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/auth/http";
import { publicTicket } from "@/lib/customer/queue";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";
import { TicketStatus } from "@/components/customer/ticket-status";
import { logDevelopmentError } from "@/lib/shared/development-error";
import { CustomerShell } from "@/components/customer/shell";

export const dynamic = "force-dynamic";
export default async function PublicTicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ticket = await (async () => {
    try { await consumePublicAttempt(await headers(), "read"); return await publicTicket(token); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) notFound();
      if (!(error instanceof HttpError)) logDevelopmentError(error, "public-ticket-page");
      return null;
    }
  })();
  return <CustomerShell><main className="customer-page">
    {ticket ? <TicketStatus token={token} initial={ticket} /> : <><h1 className="text-3xl font-semibold tracking-tight">Status temporarily unavailable</h1><p>Please wait a moment and refresh this page. You don’t need to join again.</p></>}
  </main></CustomerShell>;
}
