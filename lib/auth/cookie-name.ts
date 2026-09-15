// Distinct names allow manager and staff tabs in the same browser without
// replacing or revoking each other's sessions. Both need Path=/ for page + API.
export function sessionCookieName(role: "staff" | "manager") {
  return `${process.env.NODE_ENV === "production" ? "__Host-" : ""}queue-${role}-session`;
}
