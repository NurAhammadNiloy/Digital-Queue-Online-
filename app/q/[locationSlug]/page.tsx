import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/auth/http";
import { publicLocation } from "@/lib/customer/queue";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";
import { JoinForm } from "@/components/customer/join-form";
import { logDevelopmentError } from "@/lib/shared/development-error";
import { CustomerShell } from "@/components/customer/shell";
import { QueueIllustration } from "@/components/ui/queue-illustration";

export const dynamic = "force-dynamic";
export default async function PublicQueuePage({ params }: { params: Promise<{ locationSlug: string }> }) {
  const { locationSlug } = await params;
  const location = await (async () => {
    try { await consumePublicAttempt(await headers(), "read"); return await publicLocation(locationSlug); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) notFound();
      if (!(error instanceof HttpError)) logDevelopmentError(error, "public-location-page");
      return null;
    }
  })();
  return <CustomerShell><main className="customer-page">
    {location ? <><header className="customer-header customer-welcome space-y-3 text-center"><p className="eyebrow">{location.name.replace(/(^|[\s-])(\p{L})/gu, (_, separator: string, letter: string) => separator + letter.toLocaleUpperCase("en-US"))} Services</p><QueueIllustration /><h1>{location.name}</h1></header><JoinForm location={location} /></> : <div className="card space-y-3"><h1>Queue temporarily unavailable</h1><p>Please wait a minute and refresh this page.</p></div>}
  </main></CustomerShell>;
}
