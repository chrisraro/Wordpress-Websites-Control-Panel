/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * pdfkit loads its built-in font metrics from disk at runtime, by a path it
   * assembles rather than a static `require`. Next's output file tracer only
   * follows statically analysable imports, so those files were left out of
   * the deployed bundle and production threw:
   *
   *   Cannot find module '/var/task/node_modules/pdfkit/js/standard-fonts/Helvetica.cjs'
   *
   * That was not merely a broken PDF. `buildJobHandlers` imports the report
   * handler, which imports @react-pdf/renderer at module scope, so the throw
   * happened while *loading* the queue processor -- taking down
   * /api/cron/process with exit 128 and stopping every background job, not
   * just report generation.
   *
   * Keys are route patterns; both the queue route and the page whose server
   * action renders a report on demand need the files.
   */
  outputFileTracingIncludes: {
    "/api/cron/**": ["./node_modules/pdfkit/js/**/*"],
    "/sites/[id]/reports": ["./node_modules/pdfkit/js/**/*"],
    "/r/[token]/**": ["./node_modules/pdfkit/js/**/*"],
  },
};
module.exports = nextConfig;
