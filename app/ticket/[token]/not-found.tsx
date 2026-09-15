import { CustomerShell } from "@/components/customer/shell";
import { Icon } from "@/components/ui/icon";
export default function TicketNotFound() {
  return <CustomerShell><main className="customer-page"><div className="card space-y-4"><Icon name="ticket" className="size-8 text-teal-800" /><h1>Ticket not found</h1><p>Please check your private ticket link.</p></div></main></CustomerShell>;
}
