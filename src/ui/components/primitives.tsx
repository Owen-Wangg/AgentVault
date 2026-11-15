import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

/**
 * Small components in the style of shadcn/ui (Button, Card, Badge),
 * written here instead of generated, so the dashboard needs no Radix
 * dependency. Colors come from the theme tokens in app/globals.css.
 */

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-text hover:opacity-90",
  secondary: "border border-border bg-surface text-text hover:bg-surface-muted",
  danger: "border border-deny bg-surface text-deny hover:bg-surface-muted",
  ghost: "text-text hover:bg-surface-muted",
};

export function Button({ variant = "primary", className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60",
        BUTTON[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("rounded-card border border-border bg-surface p-4", className)} {...props} />;
}

export function CardTitle({ children, as: Tag = "h2" }: { children: ReactNode; as?: "h2" | "h3" }) {
  return <Tag className="text-sm font-medium text-text-muted">{children}</Tag>;
}

type BadgeTone = "neutral" | "allow" | "hold" | "deny" | "accent";

const BADGE: Record<BadgeTone, string> = {
  neutral: "border-border text-text-muted",
  allow: "border-allow text-allow",
  hold: "border-hold text-hold",
  deny: "border-deny text-deny",
  accent: "border-accent text-accent",
};

export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full border bg-surface px-2 py-0.5 text-xs font-medium", BADGE[tone], className)}>{children}</span>;
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold">{children}</h1>
      {actions}
    </div>
  );
}
