/** @type {import('next').NextConfig} */
const lab = { "backtest-lab": "backtest", "proving-ground": "proving", scenario: "scenario", benchmark: "benchmark", "data-desk": "data" };
const bots = { "ccxt-bot": "strategy", "flow-bot": "flow", "gamma-pulse": "gamma", "stocks-bot": "stocks", "meme-bot": "meme", "weather-bot": "weather" };

const nextConfig = {
  reactStrictMode: true,
  // Old page URLs keep working: the five research pages became tabs of /lab and
  // the six bot pages became tabs of /bots.
  async redirects() {
    return [
      ...Object.entries(lab).map(([from, tab]) => ({ source: `/${from}`, destination: `/lab?tab=${tab}`, permanent: true })),
      ...Object.entries(bots).map(([from, tab]) => ({ source: `/${from}`, destination: `/bots?tab=${tab}`, permanent: true })),
      { source: "/gravia", destination: "/", permanent: true },
      { source: "/mirofish", destination: "/terminal", permanent: true },
      { source: "/brain", destination: "/mind", permanent: true },
      { source: "/jarvis", destination: "/mind", permanent: true },
    ];
  },
};
export default nextConfig;
