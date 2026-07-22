/**
 * components/marketing/FeatureGrid.tsx
 *
 * Server-only feature grid for the home page. Renders the FEATURES copy as a
 * responsive card grid using the globals.css glass/border tokens.
 */

import { Container } from "./Container";
import { FEATURES } from "@/content/marketing/copy";

export function FeatureGrid() {
  return (
    <section className="py-4">
      <Container>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border p-6"
              style={{
                borderColor: "var(--border-hairline)",
                backgroundColor: "var(--glass-ultrathin)",
              }}
            >
              <h3
                className="text-base font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                {feature.title}
              </h3>
              <p
                className="mt-2 text-sm leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
