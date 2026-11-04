#!/usr/bin/env node
// Pilot's entry point (and the build's): the app's names first, then the command line.
await import('../src/app.js');
const { run } = await import('../src/cli.js');
const code = await run(process.argv.slice(2));
// `pilot mcp` keeps running (null); everything else exits with its code.
if (code != null) process.exitCode = code;
