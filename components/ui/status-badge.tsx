export function StatusBadge({ active, enabled = false }: { active: boolean; enabled?: boolean }) {
  return <span className={`badge ${active ? "badge-active" : "badge-inactive"}`}>
    {enabled ? active ? "Enabled" : "Disabled" : active ? "Active" : "Inactive"}
  </span>;
}
