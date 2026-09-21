import dynamic from "next/dynamic";
import TopNav from "@/components/TopNav";

export const metadata = { title: "The Eye — AXIOM" };
const Eye = dynamic(() => import("@/components/eye/Eye"), { ssr: false, loading: () => <div className="eye grid place-items-center font-mono text-[11px] tracking-[0.3em]" style={{ color: "var(--hud-muted)" }}>THE EYE · LOADING THE GLOBE…</div> });

// The Eye: the desk's god's-eye view. Live aircraft, military ADS-B,
// satellites, earthquakes, launches, radio, submarine cables, datacenters,
// dams, fires and vessels (with keys), the weather book's stations and the
// exchanges — on one globe, with AXIOM listening.
export default function WorldPage() {
  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <Eye />
    </div>
  );
}
