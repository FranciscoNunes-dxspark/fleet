#!/usr/bin/env node
import '@fleet/kit/register.js';

// React's development build is several times slower and only adds warnings. React picks its build
// when first imported, so NODE_ENV is set for these imports only and then put back (what an app
// starts shouldn't inherit it). Only `fleet --run <app>` draws with React; the host doesn't.
if (process.argv[2] === '--run') {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === undefined) process.env.NODE_ENV = 'production';
  await import('react');
  await import('react/jsx-runtime');
  await import('ink');
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
}

await import('../src/main.js');
