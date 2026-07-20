# ADR-001 — The Space is the universal container primitive

**Status:** accepted · **Doctrine:** [SPACE_ARCHITECTURE](../architecture/SPACE_ARCHITECTURE.md)

## Context

A user's financial life is not one thing — it is personal money, a household, a
business, a property, a debt-payoff goal. Internally, Fourth Meridian also needs
operating surfaces for its own teams (platform ops, security, growth, customer
success). Every one of these needs navigation, a frame, workspaces, time controls,
and identity.

## Problem

Do we build a bespoke application per domain (a "personal finance app," a separate
"admin app," a separate "business view"), or one primitive that composes all of them?
Bespoke apps drift: each grows its own navigation, its own URL handling, its own auth
shortcuts, its own idea of "a workspace." The internal admin surface, in particular,
tends to become a privileged monolith with its own rules.

## Decision

**A Space is the single universal container primitive.** A Personal Finance Space and
a Platform Operations Space are the *same architectural primitive* — same `SpaceShell`,
same workspace/navigation architecture, same URL and time authorities — differing only
in domain, composition, data, and permitted presentation. A Space is an **identity
container · membership container · permission boundary · composition container**. It
is explicitly **NOT** a calculation engine, an authorization shortcut, a
domain-specific application, a database authority, or a command centre.

## Alternatives considered

- **A separate admin/internal application.** Rejected: it would fork navigation and,
  worse, invite privileged data to live inside a bespoke surface with its own auth.
  Instead, internal HQ areas are *real Spaces* rendered through the same shell but
  gated on a **separate authorization plane** (see [ADR-003](./ADR-003-visibility-model.md)) —
  same primitives, separate authz.
- **A generic "WorkspaceManager/DataProviderFactory" framework** to abstract over
  domains. Rejected as over-engineering (the "anti-framework clause"): the authorities
  already exist — one registry, one renderer map, one time authority, one trust
  resolver, per-workspace data authorities. A seventh abstraction adds no capability.
- **Per-domain time/URL/trust handling.** Rejected: it produced the exact drift the
  SD-7/8/9 decompositions removed — multiple URL writers, duplicate time state, hosts
  assembling workspace data inline.

## Consequences

- New domains (including non-finance) plug in by **registration**, not by editing the
  host. The dashboard is a *composition root*, not a controller.
- The Space abstraction stays domain-neutral: `SpaceShell` cannot name a financial
  concept. Financial truth and authorization are *composed* by a Space, never *owned*
  by it.
- A Perspective is "a question, not a dashboard": Overview owns the scalar, a
  Perspective owns the decomposition. This is why the product navigates by questions,
  not objects.
- The cost: the shell/workspace/shared-service ownership boundaries must be held
  strictly (a workspace that writes the URL, or a shell that computes a figure, is a
  boundary violation) — enforced by tests, not convention.
