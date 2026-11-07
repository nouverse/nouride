---
name: react-tailwind-daisyui
description: React, Tailwind CSS 4 and daisyUI 5 for this repository's frontends — the module layout, daisyUI's own component, color and theme reference (read before using its class names), Lucide icons, Apple HIG principles, component recipes and accessibility. Use it whenever you write HTML or JSX, build or refine a React component, or do any Tailwind or daisyUI work — even when the request does not name it.
---

# React + Tailwind CSS + DaisyUI Skill (with Lucide Icons & Apple Design)

This skill provides comprehensive guidelines, architectural patterns, Apple Human Interface Design principles, Lucide React icon integration standards, and production-ready component recipes for crafting high-quality, responsive, accessible, and themeable frontend UIs.

---

## 1. Frontend Architecture — Modules + Commons

Code is organized by **feature module**, not by file kind. Everything one feature owns — its pages, its components, its hooks, its copy — sits in one directory, so a feature can be read, moved, or deleted in one place.

```
apps/{name}/src/
├── commons/                 # Reused by two or more modules
│   ├── components/
│   │   ├── layout/          # Navbar, Footer, app chrome
│   │   └── ui/              # App-level primitives NOT in @nouverse/ui
│   └── lib/                 # api.ts, auth-client.ts, hooks.tsx, constants, providers, utils.ts
├── modules/                 # One directory per feature
│   └── {module}/
│       ├── index.page.tsx   # The module's main page (default export)
│       ├── {name}.page.tsx  # Its other pages, e.g. privacy.page.tsx
│       ├── {name}.locales.ts# Page-level copy, next to the page it serves
│       ├── components/      # Components only this module uses
│       ├── hooks/           # Hooks only this module uses
│       └── services/        # Module-specific data access, if any
├── routes/                  # TanStack Router file-based routes — thin
│   ├── __root.tsx           # Root layout (providers, Navbar, Footer)
│   └── {path}.tsx           # Route definition only; imports a module page
├── main.tsx                 # App entry + router setup
└── index.css                # Global styles
```

### Rules:

1. **Pages live in modules, never in `routes/`.** A route file declares the route and nothing else — no page markup, no data logic, no `<Helmet>`. Those belong to the page component so the page can be rendered, moved, or reused without the router. Route-level config (`beforeLoad`, `validateSearch` and its search schema, `loader`) is a route concern and **stays in the route file**.
2. **Page files are `*.page.tsx` with a default export.** The module's main page is `index.page.tsx`; sibling pages are named for their path (`privacy.page.tsx` → `/privacy`).
3. **`commons/` is for what two or more modules share.** A component used by one module belongs to that module. Promote it to `commons/` at the second use, not in anticipation of one.
4. **Never import across modules.** `modules/flow` must not import from `modules/legal`. If two modules need the same thing, it moves to `commons/`.
5. **Copy sits next to what renders it** — `hero.locales.ts` beside `hero.tsx`, `privacy.locales.tsx` beside `privacy.page.tsx`. Module-wide copy goes at the module root (`flow.locales.tsx`).
6. **Import with the `@/` alias and full path**: `@/modules/flow/index.page`, `@/commons/components/ui/section`.

A route file is exactly this:

```tsx
// src/routes/flow.tsx
import { createFileRoute } from '@tanstack/react-router';
import FlowPage from '@/modules/flow/index.page';

export const Route = createFileRoute('/flow')({
  component: FlowPage,
});
```

### Route params and search

A page must not import `Route` from its route file — that is a circular import. Pick whichever fits:

**Params → props** (preferred: the page stays router-agnostic and testable):

```tsx
// src/routes/products.$slug.tsx
export const Route = createFileRoute('/products/$slug')({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { tier?: string } => ({
    tier: typeof search.tier === 'string' ? search.tier : undefined,
  }),
});

function RouteComponent() {
  const { slug } = Route.useParams();
  const { tier } = Route.useSearch();
  return <ProductDetailPage slug={slug} tier={tier} />;
}
```

```tsx
// src/modules/products/detail.page.tsx
export default function ProductDetailPage({ slug, tier }: { slug: string; tier?: string }) {
  // ...
}
```

That wrapper is the **only** JSX a route file may contain.

**Or read it by route id** — `useSearch({ from: '/login' })` / `useParams({ from: ... })` from `@tanstack/react-router`. No import cycle, but the page is pinned to a route id string. Fine for search params a page already owns end to end.

### TanStack Router Guidelines

- Use `createFileRoute('/path')` in each route file.
- Export `Route` constant — the component comes from a module page.
- Access params via `Route.useParams()`.
- Navigate via `useNavigate()` or `<Link>` from `@tanstack/react-router`.
- Route tree is auto-generated — **never edit `routeTree.gen.ts`**.
- Register router type in `main.tsx`:
  ```ts
  declare module '@tanstack/react-router' {
    interface Register { router: typeof router }
  }
  ```

---

## 2. daisyUI 5 — the component reference

daisyUI 5 is a CSS library for Tailwind CSS 4: class names for common components, semantic colors and themes. Use it
whenever you write HTML or JSX here — for every Tailwind UI task, and whenever a request says daisyUI, component, UI,
Tailwind, layout, template, theme, color or design, even if it does not name this skill.

The reference below is daisyUI's own (`daisyui.com/SKILL.md`, 5.7.x), kept under `./daisyui/`. It was its own skill
until 2026-10-22 and is no longer synced from upstream: refresh it from that page when daisyUI moves.

### References you must read

| Task | Guide | Note |
|------|-------|------|
| Install daisyUI | [./daisyui/install.md](./daisyui/install.md) | If the project does not have daisyUI. |
| Use daisyUI class names | [./daisyui/usage.md](./daisyui/usage.md) | Read it before you use daisyUI class names in code. |
| Configure daisyUI | [./daisyui/config.md](./daisyui/config.md) | Themes, prefixes, logs and other options; not needed for basic use. |
| daisyUI colors and themes | [./daisyui/colors.md](./daisyui/colors.md) | Read it before you use daisyUI colors in code. |
| daisyUI components | [./daisyui/components/](./daisyui/components/) | Read the applicable component guides — more than one candidate — before you use a component. |

### Components

- [accordion](./daisyui/components/accordion.md)
- [aura](./daisyui/components/aura.md)
- [alert](./daisyui/components/alert.md)
- [avatar](./daisyui/components/avatar.md)
- [badge](./daisyui/components/badge.md)
- [breadcrumbs](./daisyui/components/breadcrumbs.md)
- [button](./daisyui/components/button.md)
- [calendar](./daisyui/components/calendar.md)
- [card](./daisyui/components/card.md)
- [carousel](./daisyui/components/carousel.md)
- [chat](./daisyui/components/chat.md)
- [checkbox](./daisyui/components/checkbox.md)
- [collapse](./daisyui/components/collapse.md)
- [countdown](./daisyui/components/countdown.md)
- [diff](./daisyui/components/diff.md)
- [divider](./daisyui/components/divider.md)
- [dock (app bar)](./daisyui/components/dock.md)
- [drawer (sidebar)](./daisyui/components/drawer.md)
- [dropdown](./daisyui/components/dropdown.md)
- [FAB](./daisyui/components/fab.md)
- [fieldset](./daisyui/components/fieldset.md)
- [file-input](./daisyui/components/file-input.md)
- [filter](./daisyui/components/filter.md)
- [footer](./daisyui/components/footer.md)
- [hero](./daisyui/components/hero.md)
- [hover-3d](./daisyui/components/hover-3d.md)
- [hover-gallery](./daisyui/components/hover-gallery.md)
- [indicator](./daisyui/components/indicator.md)
- [input](./daisyui/components/input.md)
- [join (group)](./daisyui/components/join.md)
- [kbd](./daisyui/components/kbd.md)
- [label](./daisyui/components/label.md)
- [link](./daisyui/components/link.md)
- [list](./daisyui/components/list.md)
- [loading](./daisyui/components/loading.md)
- [mask](./daisyui/components/mask.md)
- [megamenu](./daisyui/components/megamenu.md)
- [menu](./daisyui/components/menu.md)
- [mockup-browser](./daisyui/components/mockup-browser.md)
- [mockup-code](./daisyui/components/mockup-code.md)
- [mockup-phone](./daisyui/components/mockup-phone.md)
- [mockup-window](./daisyui/components/mockup-window.md)
- [modal](./daisyui/components/modal.md)
- [navbar](./daisyui/components/navbar.md)
- [otp](./daisyui/components/otp.md)
- [pagination](./daisyui/components/pagination.md)
- [progress](./daisyui/components/progress.md)
- [radial-progress](./daisyui/components/radial-progress.md)
- [radio](./daisyui/components/radio.md)
- [range](./daisyui/components/range.md)
- [rating](./daisyui/components/rating.md)
- [select](./daisyui/components/select.md)
- [skeleton](./daisyui/components/skeleton.md)
- [stack](./daisyui/components/stack.md)
- [stat](./daisyui/components/stat.md)
- [status](./daisyui/components/status.md)
- [steps](./daisyui/components/steps.md)
- [swap](./daisyui/components/swap.md)
- [tab](./daisyui/components/tab.md)
- [table](./daisyui/components/table.md)
- [text-rotate](./daisyui/components/text-rotate.md)
- [textarea](./daisyui/components/textarea.md)
- [theme-controller](./daisyui/components/theme-controller.md)
- [timeline](./daisyui/components/timeline.md)
- [toast](./daisyui/components/toast.md)
- [toggle (switch)](./daisyui/components/toggle.md)
- [tooltip](./daisyui/components/tooltip.md)
- [validator](./daisyui/components/validator.md)

### Component discovery protocol

Before you write daisyUI code, do these steps in sequence:

1. Identify the intended function, behavior, and layout in the request. Do not use only the exact words.
2. Use the component list in this file to select the best candidate components.
3. If the choice is not clear, read the guides for the candidate components that can meet the request before you select one.
4. Compare the description, behavior, syntax, and rules of each candidate with the request.
5. Select the best component or component combination. Obey all its constraints.
6. Use the exact structure and constraints of the selected components.

You must match the meaning, even when the words are different from component names. A component with a different name can still be the best match. Always examine the intended function and meaning.

If the user requests a named component and a guide with that name exists, read that guide first.

---

## 3. Core Principles & Theme System

### Theme-Aware Colors (Crucial for DaisyUI)
DaisyUI comes with built-in theme support (e.g. light, dark, corporate, synthwave, etc.). **Never hardcode static Tailwind color utilities** like `bg-white`, `text-black`, `bg-slate-900`, or `text-gray-800` unless specifically required for an immutable element. Always use DaisyUI's semantic color variables so themes change seamlessly:

- **Backgrounds**: `bg-base-100` (main surface), `bg-base-200` (cards/sections), `bg-base-300` (borders/subtle highlights).
- **Text**: `text-base-content` (default text), `text-base-content/70` (muted text), `text-primary-content` (text on primary background).
- **Brand Colors**: `primary`, `secondary`, `accent`, `neutral`.
- **State Colors**: `info`, `success`, `warning`, `error`.

```tsx
// ❌ WRONG: Hardcoded colors break DaisyUI theme switching
<div className="bg-white text-gray-900 dark:bg-gray-900 dark:text-white p-4">
  <button className="bg-blue-500 text-white p-2">Submit</button>
</div>

// ✅ CORRECT: Semantic DaisyUI classes work across all themes automatically
<div className="bg-base-100 text-base-content p-4">
  <button className="btn btn-primary">Submit</button>
</div>
```

---

## 4. Lucide React Icon Integration Standards

When using **`lucide-react`** icons in React + DaisyUI components, adhere to these standards:

1. **Size Consistency**:
   - `xs` / Badge / Tag: `w-3.5 h-3.5` (14px)
   - `sm` / Compact Input / Small Button: `w-4 h-4` (16px)
   - `md` / Standard Button / Input / Nav Item: `w-5 h-5` (20px)
   - `lg` / Feature / Header Icon: `w-6 h-6` (24px) or `w-8 h-8` (32px)
2. **Component Prop Type**:
   Pass icons as `React.ComponentType<{ className?: string }>` or `LucideIcon` from `lucide-react`.
3. **Accessibility**:
   - Decorative icons (alongside text): add `aria-hidden="true"`.
   - Icon-only buttons: always add an `aria-label` or wrapping `<span className="sr-only">`.
4. **Micro-Interactions**:
   Add subtle hover animations on icons (e.g. `group-hover:translate-x-0.5 transition-transform`).

```tsx
import { ArrowRight } from 'lucide-react';

<button className="btn btn-primary group active:scale-[0.97] transition-all">
  <span>Continue</span>
  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" aria-hidden="true" />
</button>
```

---

## 5. Apple Design Principles for Web UI

> **In Nouride, the design rules decide how things look** (the `nouride-contributing` skill, `references/design-rules.md`) — palette, type, motion, and how much glass.
> This section is about feel: instant feedback and layering. Where the two disagree, that skill wins; its
> "Scope" section has the decision (2026-10-17) and what dashboard work keeps to since the re-theme (0.7.11).

Apple's Human Interface Guidelines (HIG) focus on instant feedback, direct physical manipulation, translucent materials, and spring-based motion:

### A. Instant Tactile Response
Respond on `pointerdown` / `active:`, not after release.
```tsx
<button className="btn btn-primary active:scale-[0.97] transition-transform duration-100 ease-out select-none">
  Tactile Button
</button>
```

### B. Translucent Materials & Frosted Glass (`backdrop-blur`)
Use translucent DaisyUI semantic backgrounds coupled with Tailwind backdrop filters:
```tsx
<header className="sticky top-0 z-40 bg-base-100/70 backdrop-blur-xl backdrop-saturate-180 border-b border-base-content/10 transition-colors">
  <div className="navbar container mx-auto">...</div>
</header>
```

### C. Apple Typography & Spatial Consistency
- **Heading tracking**: Use `tracking-tight` on large titles (`text-3xl font-bold tracking-tight`).
- **Category Labels**: Use `tracking-wider text-[11px] uppercase font-semibold text-base-content/60`.
- **Light Rim Highlighting**: Apply `border-t border-base-content/10` or `border border-base-content/10 shadow-sm`.

---

## 6. Class Merging (`cn` Helper)

### A. Recommended Setup (`clsx` + `tailwind-merge`)
If `clsx` and `tailwind-merge` are installed in the package:
```bash
# Install if not present
bun add clsx tailwind-merge
```

```tsx
// lib/utils.ts (or components/ui.tsx)
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### B. Fallback Helper (Without external dependencies)
If `clsx` and `tailwind-merge` are not yet installed in the codebase:
```tsx
// Lightweight fallback without external packages
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
```

---

## 7. Reusable Component Recipes

### A. Button Component (`btn` with Lucide Icons)
Supports `leftIcon`, `rightIcon`, variants, sizes, loading state, and tactile press.

```tsx
import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'accent' | 'ghost' | 'link' | 'outline' | 'error' | 'success' | 'warning' | 'info';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: LucideIcon;
  rightIcon?: LucideIcon;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading, disabled, leftIcon: LeftIcon, rightIcon: RightIcon, children, ...props }, ref) => {
    const variantClasses = {
      primary: 'btn-primary shadow-sm border-t border-white/20',
      secondary: 'btn-secondary shadow-sm',
      accent: 'btn-accent shadow-sm',
      ghost: 'btn-ghost hover:bg-base-200/60',
      link: 'btn-link',
      outline: 'btn-outline',
      error: 'btn-error',
      success: 'btn-success',
      warning: 'btn-warning',
      info: 'btn-info',
    };

    const sizeClasses = {
      xs: 'btn-xs text-xs gap-1',
      sm: 'btn-sm text-sm gap-1.5',
      md: 'gap-2',
      lg: 'btn-lg text-lg gap-2.5',
    };

    const iconSizes = {
      xs: 'w-3.5 h-3.5',
      sm: 'w-4 h-4',
      md: 'w-5 h-5',
      lg: 'w-6 h-6',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          'btn group active:scale-[0.97] transition-all duration-100 ease-out select-none',
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {isLoading ? (
          <span className="loading loading-spinner loading-sm" />
        ) : (
          <>
            {LeftIcon && <LeftIcon className={cn(iconSizes[size], 'transition-transform group-hover:-translate-x-0.5')} aria-hidden="true" />}
            {children}
            {RightIcon && <RightIcon className={cn(iconSizes[size], 'transition-transform group-hover:translate-x-0.5')} aria-hidden="true" />}
          </>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
```

---

### B. Form Input Component with Lucide Icons
Supports left/right Lucide icons, label, helper text, and error states.

```tsx
import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  error?: string;
  leftIcon?: LucideIcon;
  rightIcon?: LucideIcon;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, helperText, error, leftIcon: LeftIcon, rightIcon: RightIcon, id, ...props }, ref) => {
    const inputId = id || React.useId();

    return (
      <div className="form-control w-full">
        {label && (
          <label className="label py-1.5" htmlFor={inputId}>
            <span className="label-text font-medium text-sm text-base-content/90 tracking-tight">{label}</span>
          </label>
        )}
        <div className="relative flex items-center">
          {LeftIcon && (
            <div className="absolute left-3 text-base-content/50 pointer-events-none">
              <LeftIcon className="w-5 h-5" aria-hidden="true" />
            </div>
          )}
          <input
            id={inputId}
            ref={ref}
            className={cn(
              'input input-bordered w-full bg-base-100/60 backdrop-blur-sm transition-all duration-150',
              'focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary',
              LeftIcon && 'pl-10',
              RightIcon && 'pr-10',
              error && 'input-error focus:ring-error/40',
              className
            )}
            {...props}
          />
          {RightIcon && (
            <div className="absolute right-3 text-base-content/50 pointer-events-none">
              <RightIcon className="w-5 h-5" aria-hidden="true" />
            </div>
          )}
        </div>
        {(error || helperText) && (
          <label className="label py-1">
            <span className={cn('label-text-alt text-xs', error ? 'text-error font-medium' : 'text-base-content/70')}>
              {error || helperText}
            </span>
          </label>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
```

---

### C. Alert Component (`alert` with Lucide Status Icons)

```tsx
import React from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  onDismiss?: () => void;
}

export function Alert({ variant = 'info', title, children, onDismiss, className, ...props }: AlertProps) {
  const iconMap = {
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    error: AlertCircle,
  };

  const variantClasses = {
    info: 'alert-info',
    success: 'alert-success',
    warning: 'alert-warning',
    error: 'alert-error',
  };

  const Icon = iconMap[variant];

  return (
    <div className={cn('alert shadow-sm rounded-xl', variantClasses[variant], className)} {...props}>
      <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        {title && <h3 className="font-bold text-sm leading-tight">{title}</h3>}
        <div className="text-xs opacity-90">{children}</div>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="btn btn-ghost btn-xs btn-circle opacity-70 hover:opacity-100"
          aria-label="Dismiss alert"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
```

---

### D. Stat Card Component (`stats` with Lucide Avatar & Trend Indicator)

```tsx
import React from 'react';
import { LucideIcon, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  change?: string;
  trend?: 'up' | 'down';
  icon?: LucideIcon;
  className?: string;
}

export function StatCard({ title, value, description, change, trend, icon: Icon, className }: StatCardProps) {
  return (
    <div className={cn('stat bg-base-100/70 backdrop-blur-xl border border-base-content/10 rounded-2xl shadow-sm', className)}>
      {Icon && (
        <div className="stat-figure text-primary bg-primary/10 p-3 rounded-2xl">
          <Icon className="w-6 h-6" aria-hidden="true" />
        </div>
      )}
      <div className="stat-title text-xs font-medium text-base-content/70 tracking-tight">{title}</div>
      <div className="stat-value text-3xl font-extrabold tracking-tight text-base-content my-1">{value}</div>
      {(description || change) && (
        <div className="stat-desc flex items-center gap-1.5 text-xs text-base-content/60">
          {change && (
            <span className={cn('inline-flex items-center gap-0.5 font-semibold px-1.5 py-0.5 rounded-full text-[11px]', trend === 'up' ? 'bg-success/15 text-success' : 'bg-error/15 text-error')}>
              {trend === 'up' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {change}
            </span>
          )}
          {description && <span>{description}</span>}
        </div>
      )}
    </div>
  );
}
```

---

### E. Apple Glass Header Component (`AppleGlassHeader`)

```tsx
import React from 'react';
import { Sun, Moon, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AppleGlassHeaderProps extends React.HTMLAttributes<HTMLElement> {
  title: React.ReactNode;
  actions?: React.ReactNode;
}

export function AppleGlassHeader({ title, actions, className, children, ...props }: AppleGlassHeaderProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full bg-base-100/70 backdrop-blur-xl backdrop-saturate-180 border-b border-base-content/10 transition-colors',
        className
      )}
      {...props}
    >
      <div className="navbar container mx-auto px-4 min-h-[3.5rem] justify-between">
        <div className="flex items-center gap-3">
          <span className="font-bold text-lg tracking-tight text-base-content">{title}</span>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
```

---

### F. Apple Action Sheet / Bottom Modal Component

```tsx
import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AppleBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function AppleBottomSheet({ isOpen, onClose, title, children, className }: AppleBottomSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [isOpen]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  return (
    <dialog ref={dialogRef} className="modal modal-bottom sm:modal-middle" onClick={handleBackdropClick} onCancel={onClose}>
      <div
        className={cn(
          'modal-box bg-base-100/90 backdrop-blur-2xl p-6 rounded-t-3xl sm:rounded-2xl border border-base-content/10 shadow-2xl transition-all',
          className
        )}
      >
        {/* iOS Drag Indicator Handle */}
        <div className="w-12 h-1.5 bg-base-content/20 rounded-full mx-auto mb-4 sm:hidden" />

        <button
          onClick={onClose}
          className="btn btn-sm btn-circle btn-ghost absolute right-4 top-4 focus:outline-none"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        {title && <h3 className="font-bold text-xl tracking-tight mb-4 text-base-content">{title}</h3>}
        {children}
      </div>
      <form method="dialog" className="modal-backdrop bg-neutral/40 backdrop-blur-xs">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
```

---

### G. Theme Switcher Component (`ThemeToggle`)

```tsx
import React, { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

export function ThemeToggle() {
  const [theme, setTheme] = useState<string>('light');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('theme', nextTheme);
  };

  return (
    <button
      onClick={toggleTheme}
      className="btn btn-ghost btn-circle active:scale-90 transition-transform"
      aria-label="Toggle theme"
      title="Toggle Theme"
    >
      {theme === 'dark' ? (
        <Sun className="w-5 h-5 text-warning transition-transform hover:rotate-45" />
      ) : (
        <Moon className="w-5 h-5 text-base-content transition-transform hover:-rotate-12" />
      )}
    </button>
  );
}
```

---

## 8. Best Practices Checklist

1. **Icon Integration**: Always use standard sizing (`w-4 h-4` for compact, `w-5 h-5` for standard) and pass `aria-hidden="true"` when decorative.
2. **DaisyUI Theme Variables**: Never hardcode colors. Use `bg-base-100`, `bg-base-200`, `text-base-content`, `btn-primary`.
3. **Apple Tactile & Glass Effects**: Combine `backdrop-blur-xl`, `bg-base-100/70`, `border-base-content/10`, and `active:scale-[0.97]` for premium feel.
4. **Accessibility**: Form controls must have labels, modals must support ESC key/backdrop click, and icon-only buttons must have `aria-label`.
