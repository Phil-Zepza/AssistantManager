import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#37003c", // FPL purple
          accent: "#00ff87", // FPL green
        },
      },
    },
  },
  plugins: [],
};

export default config;
