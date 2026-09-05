import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Bloomberg terminal palette — primary design language
        bb: {
          bg:       "#000000",
          surface:  "#080808",
          panel:    "#0d0d0d",
          header:   "#111111",
          border:   "#2a2a2a",
          hover:    "#181818",
          amber:    "#FF8C00",     // field labels (the Bloomberg "orange")
          yellow:   "#FFE000",     // selected / highlighted values
          green:    "#00CC44",     // up / buy / positive
          red:      "#FF2222",     // down / sell / negative
          cyan:     "#00CCCC",     // special / links
          magenta:  "#CC44CC",     // consensus / special
          white:    "#EAEAEA",     // primary data values
          dim:      "#707070",     // secondary text
          muted:    "#404040",     // tertiary / borders text
        },
        // Legacy aliases — existing components still compile
        terminal: {
          bg:      "#000000",
          panel:   "#0d0d0d",
          card:    "#0d0d0d",
          header:  "#111111",
          border:  "#2a2a2a",
          hover:   "#181818",
        },
        neon: {
          green:  "#00CC44",
          red:    "#FF2222",
          cyan:   "#00CCCC",
          yellow: "#FFE000",
          orange: "#FF8C00",
          purple: "#CC44CC",
        },
        txt: {
          primary: "#EAEAEA",
          dim:     "#707070",
          muted:   "#404040",
        },
      },
      fontFamily: {
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "IBM Plex Mono", "Fira Code", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", "14px"],
        xs:    ["11px", "15px"],
        sm:    ["12px", "16px"],
        base:  ["13px", "18px"],
      },
      animation: {
        "flash-green": "flashGreen 0.4s ease-out",
        "flash-red":   "flashRed 0.4s ease-out",
        "pulse-dot":   "pulseDot 2s ease-in-out infinite",
        "scroll-log":  "scrollLog 0.15s ease-out",
        "blink":       "blink 1s step-end infinite",
      },
      keyframes: {
        flashGreen: { "0%": { backgroundColor: "rgba(0,204,68,0.2)" },  "100%": { backgroundColor: "transparent" } },
        flashRed:   { "0%": { backgroundColor: "rgba(255,34,34,0.2)" }, "100%": { backgroundColor: "transparent" } },
        pulseDot:   { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.3" } },
        scrollLog:  { from: { opacity: "0", transform: "translateY(-4px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        blink:      { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0" } },
      },
      boxShadow: {
        "bb-focus": "0 0 0 1px rgba(255,140,0,0.5)",
        "panel":    "inset 0 1px 0 rgba(255,255,255,0.03)",
      },
    },
  },
  plugins: [],
};

export default config;
