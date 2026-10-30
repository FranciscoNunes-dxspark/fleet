// The entry point, from a checkout (bin/fleet.js) and in the compiled build. It imports nothing up
// front: `fleet --run <app> [args]`, which is how the compiled build starts an app (it holds all eight),
// makes this process that app, and the app's cli must be the first to say which app the process is
// (the kit's configureApp). `fleet mcp` is the MCP server for Claude Code (mcp/server.js). Anything else is the host (cli.js).
const RUN = {
  splice: () => import('../../splice/src/cli.jsx'),
  trawl: () => import('../../trawl/src/cli.jsx'),
  sonar: () => import('../../sonar/src/cli.jsx'),
  bosun: () => import('../../bosun/src/cli.jsx'),
  hail: () => import('../../hail/src/cli.jsx'),
  locker: () => import('../../locker/src/cli.jsx'),
  mooring: () => import('../../mooring/src/cli.jsx'),
  bilge: () => import('../../bilge/src/cli.jsx'),
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
} else if (process.argv[2] === 'mcp') {
  const { serve } = await import('./mcp/server.js');
  serve(process.argv.slice(3));
} else {
  await import('./cli.js');
}
