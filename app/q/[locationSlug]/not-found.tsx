import { CustomerShell } from "@/components/customer/shell";
import { Icon } from "@/components/ui/icon";
export default function LocationNotFound() {
  return <CustomerShell><main className="customer-page"><div className="card space-y-4"><Icon name="location" className="size-8 text-teal-800" /><h1>Location unavailable</h1><p>This location could not be found or is not currently accepting visitors.</p></div></main></CustomerShell>;
}
