# FinTracker — Workspace Feature Status
*Last updated: June 11, 2026*

---

## What We Built

FinTracker started as a personal finance dashboard — one user, one view, tracking net worth, accounts, investments, debt, and crypto. We've since layered a full multi-user workspace system on top of it. The idea: you can invite a partner, spouse, financial advisor, or family member into a shared "workspace" where you selectively expose your financial picture and collaborate on goals.

---

## Core Architecture

### Personal vs. Shared Workspaces
Every user gets a **Personal workspace** automatically on signup. This is the original FinTracker dashboard — full account access, AI advice engine, net worth tracking, all of it. Shared workspaces are created on top and exist alongside it.

### Workspace Types & Categories
When you create a shared workspace, you pick a category that determines what sections and tools are pre-loaded:

- **Household** — joint budgeting, shared debt, household goals
- **Partnership** — business finances, shared expenses, revenue tracking
- **Investment Club** — portfolio tracking, investment goals, allocation analysis
- **Family** — cross-generation planning, education savings, estate basics
- **Advisory** — advisor/client relationship, read-only views, planning tools
- And more (Real Estate, Business, Retirement, Travel, etc.)

Each category comes with a curated set of dashboard sections as defaults.

### Role System
Four roles with enforced permissions at both the API and UI level:
- **Owner** — full control, can delete workspace, manage all members
- **Admin** — can invite/remove members, manage goals and sections
- **Member** — can share their own accounts into the workspace
- **Viewer** — read-only access

### Account Sharing
The financial privacy model is the core design feature. You never automatically expose your accounts. Instead, you explicitly share individual accounts into a workspace with two visibility levels:

- **Full Access** — balance + transaction history visible to workspace members
- **Balance Only** — balance visible, transactions private

Shares can be revoked at any time. The underlying account data stays in your personal workspace — the share is just a pointer.

---

## What's Implemented (Technical)

### Database (PostgreSQL via Prisma)
- `Workspace` model with type, category, visibility
- `WorkspaceMember` with role + soft-delete status (`ACTIVE`, `REMOVED`, `LEFT`)
- `WorkspaceAccountShare` with visibility enum + revocation tracking
- `WorkspaceDashboardSection` for per-workspace UI configuration
- `WorkspaceGoal` with progress tracking, categories, completion timestamps
- `WorkspaceInvite` for pending invitations
- `AuditLog` covering all sensitive actions (member changes, account shares, deletions, logins)

### APIs
- `GET/POST /api/workspaces` — list workspaces (ACTIVE memberships only), create new
- `GET/PATCH/DELETE /api/workspaces/[id]` — workspace detail, update settings, delete
- `GET /api/workspaces/[id]/accounts` — shared account view for workspace members
- `POST /api/workspaces/[id]/accounts/share` — share an account into a workspace
- `GET /api/workspaces/[id]/members`, `PATCH/DELETE /api/workspaces/[id]/members/[userId]` — member management with role enforcement
- `GET/POST /api/workspaces/[id]/invites`, invite accept/decline, rescind
- `GET/PATCH/DELETE /api/workspaces/[id]/goals/[goalId]` — goals CRUD
- `GET/PATCH /api/workspaces/[id]/sections/[sectionId]` — dashboard section toggles
- `POST /api/workspace/switch` — active workspace switching with session cookie

### Frontend
- **WorkspacesClient** — workspace card grid with create, switch, and manage flows
- **CreateWorkspaceModal** — multi-step: name/description → category → template preview → confirm
- **ManageWorkspaceModal** — 6-tab management panel (General, Members, Goals, Finances, Dashboard, Delete)
- **WorkspaceDashboard** — section-driven dashboard for non-personal workspaces, with real content cards for Overview, Goals, Accounts, Debt, Investments, Activity
- **Sidebar** — workspace switcher dropdown, live-updates via custom DOM events
- **DashboardClient** — original personal finance dashboard (unchanged)

### Routing
The `/dashboard` page checks the active workspace type:
- Personal → renders the original `DashboardClient`
- Shared → renders `WorkspaceDashboard` driven by that workspace's sections

---

## Current State: Debugging Pass

The core feature is built and rendering. We're in a stabilization pass fixing edge cases found during live testing. Bugs fixed so far:

**Done:**
- Sidebar dropdown going stale after workspace switch
- Finances tab form not resetting after sharing an account (it was retaining "Balance Only" selection)
- Dashboard cards showing raw snake_case section keys (`net_worth`, `cash_flow`) in the UI
- "Danger Zone" tab renamed to "Delete"
- Workspace Overview not refreshing after account share/revoke from the Manage modal
- Stale Turbopack cache causing ChunkLoadError and auth endpoint returning HTML instead of JSON
- ESLint `react-hooks/set-state-in-effect` errors across ManageWorkspaceModal, WorkspacesClient, and Sidebar
- **Member removal not working** — three-part bug:
  1. `GET /api/workspaces` and `GET /api/workspaces/[id]` were not filtering members by `status: ACTIVE`, so removed members still appeared in lists and the manage modal
  2. The `activeMembers` client-side filter had a `|| true` making it a no-op
  3. `handleRemove` and `handleRoleChange` both called `onRefresh()` which closed the modal instead of refreshing in place — no visual feedback, no error handling

**Still needs testing:**
- Re-add a member after removal (should work now that ACTIVE filter is in place)
- Invite flow end-to-end (invite → accept → appears in member list)
- Goal creation and progress tracking
- Dashboard section toggles persisting across reloads

---

## What's Left (Upcoming Milestones)

### Near-term (Milestone 5 — Polish & Invite Flow)
- Invite acceptance UI (email link or in-app notification)
- Workspace activity feed (real data — who shared what, goal updates, member changes)
- Confirmation dialogs before destructive actions (member remove, account revoke)
- Better empty states (no accounts shared yet, no goals created)
- Mobile layout review for workspace dashboard

### Medium-term (Milestone 6 — AI Integration)
- AI advice engine awareness of workspace context (shared accounts, joint goals)
- "Play/no play" readiness for shared portfolios
- Workspace-level net worth snapshot (aggregated across shared accounts)
- Historical snapshots for workspace

### Longer-term
- Real-time updates (WebSocket or polling) so multiple users see changes without refresh
- Workspace templates marketplace (pre-configured sections and goal templates by category)
- Advisor workspace type — read-only account views with structured reporting
- Transfer workspace ownership

---

## The Potential

The workspace system turns FinTracker from a solo tool into a collaborative financial platform. The privacy model (explicit account sharing, balance-only mode, role-gated access) is the differentiator — it's designed for real trust relationships, not just permission toggles. A couple can share household debt visibility without exposing personal accounts. An advisor can get a read-only view of a client's portfolio without touching credentials. An investment club can track collective performance with individual position privacy.

Most personal finance tools are either fully solo or fully merged. This sits in between.
