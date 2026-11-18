/**
 * OpenTelemetry bootstrap. Load it before the app: `node --import ./dist/telemetry.js dist/main.js`.
 *
 * Configured with the standard OTEL_* environment variables, so any OTLP backend works. Without an
 * OTLP endpoint it does nothing, and the API's own spans and metrics become no-ops.
 */
import { register } from 'node:module';

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];

if (endpoint) {
  // Instrument ES modules (http, pg, undici) loaded after this point.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const [{ NodeSDK }, { OTLPTraceExporter }, { OTLPMetricExporter }, { PeriodicExportingMetricReader }, http, pg, undici] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-undici'),
  ]);

  const sdk = new NodeSDK({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'platform-api',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    instrumentations: [
      new http.HttpInstrumentation({ ignoreIncomingRequestHook: (request) => ['/healthz', '/readyz'].includes(request.url ?? '') }),
      new pg.PgInstrumentation(),
      new undici.UndiciInstrumentation(),
    ],
  });
  sdk.start();
  process.once('SIGTERM', () => {
    void sdk.shutdown();
  });
}
