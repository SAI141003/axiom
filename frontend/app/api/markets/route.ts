import { NextResponse } from "next/server";

// Server-side proxy — avoids any CORS issues with direct browser calls to Gamma API.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit") ?? "50";

  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&order=volume&ascending=false`,
      { next: { revalidate: 30 } },
    );
    if (!res.ok) return NextResponse.json([], { status: 200 });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
