import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxies /api to the learn service; the production build (app/dist) is
// served by learn itself (see server/src/index.ts static handler).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:7900",
    },
  },
});
