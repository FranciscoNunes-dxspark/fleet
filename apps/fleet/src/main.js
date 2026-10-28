// The entry point, from a checkout (bin/fleet.js) and in the compiled build. It imports nothing up
// front: `fleet --run <app> [args]`, which is how the compiled build starts an app (it holds all eight),
// makes this process that app, and the app's cli must be the first to say which app the process is
// (the kit's configureApp). `fleet mcp` is the MCP server for Claude Code (mcp/server.js), and
// `fleet --mcp-worker <app>` one app's part of it, in a process that is that app. `fleet gui` is the
// fleet in a window (gui/cli.js). Anything else is the host (cli.js).
const RUN = {
  splice: () => import('../../splice/src/cli.jsx'),
  trawl: () => import('../../trawl/src/cli.jsx'),
  sonar: () => import('../../sonar/src/cli.jsx'),
  bosun: () => import('../../bosun/src/cli.jsx'),
  hail: () => import('../../hail/src/cli.jsx'),
  keel: () => import('../../keel/cli/cli.jsx'),
  wharf: () => import('../../wharf/src/cli.jsx'),
  locker: () => import('../../locker/src/cli.jsx'),
};

if (process.argv[2] === '--run') {
  const id = process.argv[3];
  if (!RUN[id]) {
    process.stderr.write(`fleet --run: there's no app called ${id ?? '(none)'}; the apps are ${Object.keys(RUN).join(', ')}.\n`);
    process.exit(2);
  }
  // The app reads its own arguments from process.argv, as when it runs by itself.
  process.argv.splice(2, 2);
  await RUN[id]();
} else if (process.argv[2] === 'gui') {
  // The fleet in a window (gui/cli.js): Fleet's own process, so it says which app it is first.
  await import('./app.js');
  const { runGui } = await import('./gui/cli.js');
  await runGui(process.argv.slice(3));
} else if (process.argv[2] === 'mcp') {
  const { serve } = await import('./mcp/server.js');
  serve(process.argv.slice(3));
} else if (process.argv[2] === '--mcp-worker') {
  // The app's configureApp first, as its own cli would; Keel's is the only worker so far.
  const id = process.argv[3];
  if (id === 'keel') await import('../../keel/cli/app.js');
  const { runWorker } = await import('./mcp/worker.js');
  await runWorker(id, process.argv.slice(4));
} else {
  await import('./cli.js');
}
