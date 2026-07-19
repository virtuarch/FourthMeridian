# Atlas Primitive Hardening — GlassPanel polymorphic semantics

Status: **complete**
Date: 2026-07-19
Scope: `components/atlas/GlassPanel.tsx` only. No material-system change, no new primitives, no consumer migration required.

---

## 1. Issue

`GlassPanel` is polymorphic via `as`. For `as="button"` it emitted:

```html
<button class="relative overflow-hidden atlas-fresnel-edge" style="…">
  <div aria-hidden class="… absolute inset-0 z-0"></div>   <!-- bloom   -->
  <div aria-hidden class="… absolute inset-0 z-0"></div>   <!-- glow    -->
  <div aria-hidden class="… absolute h-px z-[1]"></div>    <!-- specular -->
  <div class="relative z-10">…children…</div>              <!-- content -->
</button>
```

`<button>`'s content model is **phrasing content**. `<div>` is flow content, so every one of those four children was invalid there. Browsers tolerate it, but it is a real defect: HTML validators fail it, and the parser's behaviour with flow content inside phrasing context is not something to rely on.

Three call sites render `as="button"`: `PerspectiveSwitcher.tsx:102`, `InlineFilter.tsx:143`, `TimelineLens.tsx:52` — plus `PerspectivesWidget.tsx:123` (`as={clickable ? "button" : "div"}`) and `DataCard.tsx:97` (`as={as}` pass-through), either of which can resolve to `button`.

---

## 2. Investigation

**32 call sites.** Classification:

| Class | Count | Detail |
|---|---|---|
| Safe — no layout classes on `className` | 28 | padding / width / colour only |
| **Layout classes on `className`** | **4** | `SpaceComingSoonPanel` (`flex flex-col items-center`), `InlineFilter` (`flex items-center gap-1.5`), `OverlaySurface` (`flex flex-col`), `Panel` (`relative flex w-full flex-col`) |
| Needed migration | **0** | see §3 |

`as` targets in use: `div` (default, 17), explicit `div` (6), `button` (3), `Link` (3), `aside` (1), plus two dynamic (`DataCard`, `PerspectivesWidget`).

`.atlas-fresnel-edge` is referenced **only** by `GlassPanel` — it is effectively a private utility, not a shared one.

### Why the wrapper exists

The four decorative layers are **positioned** (`absolute`, at `z-0`, `z-0`, `z-[1]`, and `.atlas-fresnel-edge::after` at `z-auto`). In CSS paint order, positioned elements paint **above** in-flow siblings in the same stacking context. So unwrapped children would render *underneath* the decoration. Only `position: relative; z-index: 10` lifts them clear — which requires an element to carry it.

---

## 3. Resolution

**Change the wrapper's element, not its existence.** All four internal elements are now `<span>`:

```html
<button class="relative overflow-hidden atlas-fresnel-edge" style="…">
  <span aria-hidden class="… absolute inset-0 z-0"></span>
  <span aria-hidden class="… absolute inset-0 z-0"></span>
  <span aria-hidden class="… absolute h-px z-[1]"></span>
  <span class="relative z-10 block">…children…</span>
</button>
```

`<span>` is phrasing content, so the markup is valid for **every** `as` target. Layout is unchanged:

- the three decorative layers are `position: absolute`, which **blockifies** them — `span` and `div` compute identically;
- the content wrapper carries an explicit `block`, so it lays out exactly as the previous `<div>`.

Stacking is untouched: the wrapper keeps `relative z-10`, the decorative layers keep their `z-0` / `z-[1]`.

**Zero consumer migration.** None of the 4 layout-class consumers changed behaviour, because the wrapper still exists and still forms the same box.

### Why NOT "no wrapper at all"

The originally proposed remedy — apply styling directly to the button with no nested wrapper — is not reachable without changing the material system:

1. Unwrapped children would paint **below** all four decorative layers.
2. Fixing that means pushing bloom / glow / specular / fresnel to negative `z-index` and re-tuning their relative order — i.e. editing the glass paint order.
3. That is explicitly out of scope for this slice ("do not change material system").
4. It would additionally *activate* currently-inert `flex` on `SpaceComingSoonPanel` and `InlineFilter` (today their flex applies to a single wrapper child and does nothing), changing their rendering. Both look like latent bugs worth fixing — but as a deliberate visual change, not a side effect of a semantics fix.

The defect was **invalid markup**, and that is fully resolved. Removing the wrapper is a separate, larger piece of work; see §6.

---

## 4. Supported polymorphic behaviour

| `as` | Renders | Notes |
|---|---|---|
| *(omitted)* | `<div>` | default |
| `"div"` / `"section"` / `"aside"` / `"header"` / … | that element | any flow-content container |
| `"button"` | `<button>` | valid: all internals are phrasing content. `disabled`, `type`, `aria-*` pass through; native keyboard behaviour retained |
| `"a"` / `Link` | `<a>` | `href` passes through |

Contract in all cases:

- `className` → the **root** element (the panel box: padding, width, colour, radius overrides).
- `contentClassName` → the **content wrapper** (content layout: grid, flex, gap).
- Children never render as direct descendants of the root — this is by design, per §2.

---

## 5. Tests

`components/atlas/GlassPanel.test.ts` — **41 checks**. Unlike the sibling Atlas guards this renders the component for real (`renderToStaticMarkup`) and asserts the emitted HTML; source scanning cannot answer "is this markup valid?".

1. **Polymorphic root** — default/`div`/`section`/`aside`/`button`/`a` each emit that element.
2. **Semantic output** — `as="button"` contains no `<div>`, no flow content of any kind, exactly one `<button>`, no nested interactive element; the wrapper is a `<span>` that still carries `relative z-10 block`.
3. **Accessibility** — `disabled`, `type`, `aria-label`, `aria-expanded`, `aria-haspopup`, `aria-describedby` all pass through; no imposed `tabindex="-1"`; no `role` override masking native button semantics.
4. **Material unchanged** — radius/depth-fill/backdrop-filter/elevation/border tokens, fresnel default-on and opt-out, all five depths, specular layer, `interactive` hover lift, glow opt-in, bloom depth defaults.
5. **`className` vs `contentClassName`** — each lands on its own element and does not bleed.

The `<div>`-inside-`<button>` check is what caught the decorative layers; the first fix only converted the content wrapper. A source-scan test would have missed it.

**Browser-verified** on a live page: `as="button"` → root `<button>`, wrappers `<span>`, no flow-content child, `backdrop-filter: blur(22px) saturate(1.72)`, shadow present, `border-radius: 20px`, wrapper `z-index: 10`, keyboard-focusable. `as="aside"` (Panel) → root `<aside>`, wrapper `<span>` with `display: block`, and Panel's documented-fragile height chain still bounded (scroll region 489px). Rendering is pixel-identical.

---

## 6. Future rules

1. **Any new internal element inside `GlassPanel` must be phrasing content** (`<span>`), because the root can be a `<button>`. The test enforces this.
2. **Content layout goes in `contentClassName`**, never `className`. Layout on `className` styles the panel box and silently does not reach children — `Panel.tsx` hit this with its height chain, and TimelineLens hit it with a grid.
3. **`GlassPanel` consumers must not pass interactive children when `as="button"`** — a nested `<button>`/`<a>` is invalid regardless of the wrapper. The primitive adds none; callers own their own children.
4. **Removing the wrapper remains open**, and would be worth doing as a scoped slice. It requires: negative-`z` for all four decorative layers with their relative order preserved, retiring `contentClassName`, and deliberately accepting the activation of currently-inert `flex` on `SpaceComingSoonPanel` and `InlineFilter`. Estimated blast radius: every glass surface in the app, since `Panel` and `OverlaySurface` are in the affected set.

---

## 7. Outcome

- **Files changed:** `components/atlas/GlassPanel.tsx` (4 elements `div`→`span`), plus new `components/atlas/GlassPanel.test.ts`.
- **Consumers affected:** 0 required changes; 32 call sites verified unchanged.
- **Tests added:** 41 rendering assertions.
- **TimelineLens promotion:** **unblocked.** Slices 1–2 stand as committed; the component's own guard (295 checks) and the adapter parity proof (117 checks) are unaffected. Slice 3 can proceed.
