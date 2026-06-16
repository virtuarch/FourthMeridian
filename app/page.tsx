import { redirect } from "next/navigation";

// Root entry point. Always send users through /dashboard/brief so that:
//   - authenticated users land on the Daily Brief (the intended post-login page)
//   - unauthenticated users get bounced to /login?callbackUrl=/dashboard/brief
//     by proxy.ts, so the login flow's callbackUrl honoring lands them back
//     on the Brief instead of skipping it (previously redirected to bare
//     /dashboard, which proxy.ts also gates, producing callbackUrl=/dashboard
//     and causing login to land on the dashboard overview instead of the Brief).
export default function Home() {
  redirect("/dashboard/brief");
}
