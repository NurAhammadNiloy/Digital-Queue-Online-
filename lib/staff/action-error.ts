// Shared by the dashboard and regression tests. Only 401 means the staff
// session is absent/expired. Authorization, CSRF and service errors stay visible.
export function staffResponseError(status: number, serverMessage?: string) {
  if (status === 401) return { expired: true, message: "Your staff session has expired. Sign in again." };
  if (status === 403) return { expired: false, message: `${serverMessage ?? "Access denied."} Refresh the queue and ask your manager to check your active staff account and service assignment. If your browser is signed into another role, sign in as staff.` };
  if (status === 409) return { expired: false, message: `${serverMessage ?? "The ticket changed."} Review the refreshed queue before trying again.` };
  if (status >= 500) return { expired: false, message: "The queue service is temporarily unavailable. Refresh to check the result before retrying; no action was automatically repeated." };
  return { expired: false, message: `${serverMessage ?? "The request was not accepted."} Refresh the page and try again.` };
}
