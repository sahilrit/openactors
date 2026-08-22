import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // tests/smoke.ts is an end-to-end script that starts the MCP server and
        // hits the live network. It is run directly (`npx tsx tests/smoke.ts`),
        // not by vitest, which would otherwise treat it as a suite with no tests.
        include: ['tests/**/*.test.ts'],
    },
});
