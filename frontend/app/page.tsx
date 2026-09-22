import TopNav from "@/components/TopNav";
import HudHome from "@/components/home/HudHome";

export const metadata = { title: "AXIOM — quant research & paper-trading desk" };


export default function Home() {
  return (
    <div className="hud-bg min-h-screen relative">
      <div className="hud-ambient" aria-hidden />
      <TopNav />
      <main className="relative hud-screen font-mono">
        <h1 className="sr-only">AXIOM — the desk</h1>
        <HudHome />
      </main>
    </div>
  );
}
