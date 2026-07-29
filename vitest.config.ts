import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // Thoughtbox forced fileParallelism: false because its Supabase
    // integration tests shared one database. Nothing here shares state across
    // files — filesystem tests use per-test temp dirs — so the default
    // parallelism stands.
  },
});
