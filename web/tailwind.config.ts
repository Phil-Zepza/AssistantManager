import type { Config } from "tailwindcss";

// Utility classes map onto the CSS custom properties defined in
// app/globals.css (the single source of truth for the dark design system).
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces
        base: "var(--bg-base)",
        raised: "var(--bg-raised)",
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
        },
        // Borders
        subtle: "var(--border)",
        strong: "var(--border-strong)",
        // Text
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        muted: "var(--text-muted)",
        // Accent + hot
        accent: {
          DEFAULT: "var(--accent)",
          press: "var(--accent-press)",
        },
        "on-accent": "var(--on-accent)",
        hot: "var(--accent-2)",
        // Semantic
        success: "var(--success)",
        warning: "var(--warning)",
        "on-warning": "var(--on-warning)",
        danger: "var(--danger)",
        info: "var(--info)",
        // Positions
        "pos-gk": "var(--pos-gk)",
        "pos-def": "var(--pos-def)",
        "pos-mid": "var(--pos-mid)",
        "pos-fwd": "var(--pos-fwd)",
        // Pitch
        "pitch-top": "var(--pitch-top)",
        "pitch-bottom": "var(--pitch-bottom)",
        // Legacy FPL brand (kept so any un-migrated markup still compiles).
        brand: {
          DEFAULT: "#37003c",
          accent: "#00ff87",
        },
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        sheet: "var(--shadow-sheet)",
        dock: "var(--shadow-dock)",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      transitionTimingFunction: {
        "out-soft": "var(--ease-out)",
      },
      transitionDuration: {
        micro: "150ms",
      },
    },
  },
  plugins: [],
};

export default config;
