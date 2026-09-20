import type { LucideIcon } from "lucide-react";

export default function PageHeader({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: React.ReactNode }) {
  return (
    <header className="hud-page-head">
      <span className="hud-page-icon" aria-hidden><Icon size={22} strokeWidth={1.8} /></span>
      <h1>{title}</h1>
      {children && <p className="prose-sans">{children}</p>}
    </header>
  );
}
