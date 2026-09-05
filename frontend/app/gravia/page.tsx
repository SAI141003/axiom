import { redirect } from "next/navigation";

// Gravia was used as design reference — all live trading is on the main dashboard.
export default function GraviaPage() {
  redirect("/");
}
