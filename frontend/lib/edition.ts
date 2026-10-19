// Which desk this build is. "stocks" = AXIOM 2.0: stocks, ETFs, options, the
// AXIOM brain and the Council — no Polymarket, no crypto or weather bots, no
// paper trading. Set at build time by NEXT_PUBLIC_EDITION in frontend/.env.production.
export const EDITION = process.env.NEXT_PUBLIC_EDITION === "stocks" ? "stocks" : "desk";
export const STOCKS_ONLY = EDITION === "stocks";

// the pages AXIOM 2.0 keeps
export const STOCK_PAGES = new Set(["/", "/mind", "/council", "/invest", "/stocks", "/options", "/premarket", "/ai", "/intel", "/news", "/world", "/settings", "/about"]);
