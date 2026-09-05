import MiroFishDashboard from "@/components/MiroFishDashboard";
import TopNav from "@/components/TopNav";

export const metadata = { title: "MiroFish — Polymarket HFT" };

export default function MiroFishPage() {
  return (
    <div className="min-h-screen" style={{ background: "#0a0f1e" }}>
      <TopNav />
      <MiroFishDashboard />
    </div>
  );
}
