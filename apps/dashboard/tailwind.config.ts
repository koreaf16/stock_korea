import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        tactical: {
          bg: "#0F172A",
          panel: "#111D33",
          border: "#1E293B",
          terminal: "#22C55E",
          buy: "#EF4444",
          sell: "#3B82F6",
          alert: "#EAB308"
        }
      },
      boxShadow: {
        panel: "0 10px 25px rgba(2, 8, 23, 0.45)"
      }
    }
  },
  plugins: []
};

export default config;

