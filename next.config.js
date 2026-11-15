/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // instrumentation.js (boot hook) is still behind a flag in Next 14.2
    instrumentationHook: true,
    // Do NOT bundle the native better-sqlite3 addon into the server/RSC bundles — keep it
    // external so `output: "standalone"` traces the real .node binary instead.
    // Step 6 (E3): OpenTelemetry stays external too. Its packages load modules dynamically (webpack
    // warns and can break them), and the API must be ONE copy shared with Next's own tracer, which
    // require()s @opentelemetry/api from node_modules.
    serverComponentsExternalPackages: [
      "better-sqlite3",
      "@opentelemetry/api",
      "@opentelemetry/sdk-node",
      "@opentelemetry/exporter-trace-otlp-http",
    ],
  },
};

export default nextConfig;
