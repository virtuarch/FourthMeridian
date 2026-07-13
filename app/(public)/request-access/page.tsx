/**
 * app/(public)/request-access/page.tsx — the beta-access request page.
 *
 * The page shell is server-only; the interactive form
 * (components/marketing/RequestAccessForm) is the single "use client" island.
 * It degrades gracefully if POST /api/access-request isn't live yet (Wave 1②).
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/marketing/PageHeader";
import { Container } from "@/components/marketing/Container";
import { RequestAccessForm } from "@/components/marketing/RequestAccessForm";
import { REQUEST_ACCESS } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "Request access — Fourth Meridian",
  description:
    "Fourth Meridian is invite-only while in beta. Leave your email and we'll " +
    "reach out when a spot opens.",
};

export default function RequestAccessPage() {
  return (
    <>
      <PageHeader heading={REQUEST_ACCESS.heading} intro={REQUEST_ACCESS.intro} />

      <Container className="pb-8">
        <div className="max-w-md">
          <RequestAccessForm />
        </div>
      </Container>
    </>
  );
}
