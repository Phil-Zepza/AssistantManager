import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
}

/** In-content page header (H1 + optional subtitle). */
export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <header className="mb-4">
      <h1 className="text-xl font-bold tracking-tight text-primary">{title}</h1>
      {subtitle && <p className="mt-0.5 text-sm text-secondary">{subtitle}</p>}
    </header>
  );
}
