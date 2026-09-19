import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: env.PORT ? Number(env.PORT) : undefined,
      allowedHosts: [".localhost"],
      proxy: {
        "/api": `http://127.0.0.1:${env.DJIT_DEV_API_PORT ?? "8001"}`,
      },
    },
  };
});
