import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: "leyanxiu-content-security-policy",
      transformIndexHtml(html) {
        const apiBase = process.env.VITE_API_BASE || "";
        let connectSource = "";
        try {
          connectSource = new URL(apiBase).origin;
        } catch {
          connectSource = "";
        }
        return html.replaceAll("__API_CONNECT_SOURCE__", connectSource);
      },
    },
  ],
  server: {
    port: 3000,
    proxy: {
      "/api": process.env.VITE_DEV_API_PROXY || "http://127.0.0.1:8787",
      "/health": process.env.VITE_DEV_API_PROXY || "http://127.0.0.1:8787",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
