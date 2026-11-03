// Typosquats: a package whose name is one slip away from a well-known one it isn't (lodahs, crossenv,
// Newtonsoft.Jsom), the way malicious packages catch a mistyped install. Pure: the popular names are a
// modest list written here, not asked of a registry.

// The most installed npm packages, and the ones attackers have imitated. A name here is never a
// suspect itself, so pairs a slip apart that are both real (color and colors, tslib and tslint,
// mysql and mysql2) are both listed.
export const POPULAR_NPM = [
  'react', 'react-dom', 'preact', 'vue', 'vue-router', 'vuex', 'pinia', 'svelte', 'next', 'nuxt', 'jquery', 'bootstrap', 'd3', 'three', 'chart.js',
  'redux', 'react-redux', 'redux-thunk', 'mobx', 'immer', 'immutable', 'formik', 'react-hook-form', 'react-router', 'react-router-dom', 'styled-components', 'classnames', 'clsx', 'prop-types', 'swr',
  'express', 'koa', 'fastify', 'hapi', 'restify', 'body-parser', 'cookie-parser', 'cookie', 'cookies', 'cookie-session', 'express-session', 'multer', 'busboy', 'compression', 'serve-static', 'cors', 'helmet', 'morgan', 'connect', 'http-proxy', 'http-proxy-middleware', 'http-server', 'serve',
  'axios', 'node-fetch', 'cross-fetch', 'isomorphic-fetch', 'got', 'superagent', 'request', 'ws', 'socket.io', 'socket.io-client', 'form-data', 'follow-redirects', 'proxy-from-env', 'tough-cookie',
  'lodash', 'underscore', 'ramda', 'moment', 'dayjs', 'date-fns', 'luxon', 'uuid', 'nanoid', 'shortid', 'rxjs', 'zod', 'yup', 'joi', 'ajv', 'validator', 'qs', 'querystring',
  'chalk', 'colors', 'color', 'kleur', 'picocolors', 'ansi-styles', 'ansi-regex', 'strip-ansi', 'supports-color', 'has-flag', 'debug', 'ms', 'ora', 'commander', 'yargs', 'yargs-parser', 'minimist', 'inquirer', 'prompts', 'dotenv', 'cross-env', 'config', 'semver',
  'mongoose', 'mongodb', 'pg', 'mysql', 'mysql2', 'sqlite', 'sqlite3', 'better-sqlite3', 'redis', 'ioredis', 'sequelize', 'knex', 'typeorm', 'prisma', 'tedious', 'mssql', 'graphql',
  'jsonwebtoken', 'jwt-decode', 'passport', 'passport-local', 'bcrypt', 'bcryptjs', 'argon2', 'crypto-js', 'node-forge', 'aws-sdk', 'firebase', 'stripe', 'twilio', 'nodemailer',
  'handlebars', 'ejs', 'pug', 'mustache', 'nunjucks', 'marked', 'markdown-it', 'highlight.js', 'cheerio', 'jsdom', 'puppeteer', 'playwright', 'cypress', 'sharp', 'jimp', 'canvas', 'electron',
  'typescript', 'ts-node', 'tslib', 'tslint', 'eslint', 'prettier', 'stylelint', 'babel-core', 'babel-loader', 'core-js', 'regenerator-runtime', 'esbuild', 'rollup', 'webpack', 'webpack-cli', 'vite', 'parcel', 'terser', 'uglify-js', 'uglify-es',
  'css-loader', 'style-loader', 'file-loader', 'url-loader', 'html-webpack-plugin', 'postcss', 'autoprefixer', 'tailwindcss', 'sass', 'node-sass', 'less',
  'jest', 'mocha', 'chai', 'sinon', 'vitest', 'jasmine', 'karma', 'supertest', 'nock', 'nyc', 'faker',
  'nodemon', 'pm2', 'concurrently', 'npm-run-all', 'husky', 'lint-staged', 'rimraf', 'mkdirp', 'glob', 'globby', 'minimatch', 'micromatch', 'chokidar', 'fs-extra', 'graceful-fs', 'cross-spawn', 'execa', 'shelljs', 'open', 'which',
  'async', 'bluebird', 'inherits', 'safe-buffer', 'buffer', 'events', 'readable-stream', 'once', 'iconv-lite', 'mime', 'mime-types', 'object-assign', 'object.assign', 'global', 'globals', 'source-map', 'source-map-support',
  'js-yaml', 'yaml', 'xml2js', 'fast-xml-parser', 'jszip', 'archiver', 'tar', 'node-gyp', 'node-pre-gyp', 'prebuild-install', 'acorn', 'esprima', 'lru-cache', 'winston', 'pino', 'bunyan', 'event-stream', 'electron-builder',
];

// NuGet's most downloaded packages. NuGet names are compared without case.
export const POPULAR_NUGET = [
  'Newtonsoft.Json', 'System.Text.Json', 'Serilog', 'Serilog.AspNetCore', 'Serilog.Sinks.Console', 'Serilog.Sinks.File', 'NLog', 'log4net', 'AutoMapper', 'Dapper', 'Polly', 'MediatR', 'FluentValidation', 'FluentAssertions',
  'xunit', 'xunit.runner.visualstudio', 'NUnit', 'NUnit3TestAdapter', 'MSTest.TestFramework', 'MSTest.TestAdapter', 'Moq', 'NSubstitute', 'Microsoft.NET.Test.Sdk', 'coverlet.collector', 'Bogus',
  'Swashbuckle.AspNetCore', 'Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.SqlServer', 'Microsoft.EntityFrameworkCore.Design', 'Microsoft.EntityFrameworkCore.Tools', 'Npgsql', 'Npgsql.EntityFrameworkCore.PostgreSQL',
  'Microsoft.Data.SqlClient', 'System.Data.SqlClient', 'StackExchange.Redis', 'RestSharp', 'Humanizer', 'Castle.Core', 'Autofac', 'CsvHelper', 'HtmlAgilityPack', 'AngleSharp', 'MassTransit', 'RabbitMQ.Client',
  'Azure.Identity', 'Azure.Storage.Blobs', 'Azure.Security.KeyVault.Secrets', 'Microsoft.Identity.Client', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Logging', 'Microsoft.Extensions.Configuration', 'Microsoft.Extensions.Http',
  'Microsoft.AspNetCore.Authentication.JwtBearer', 'System.IdentityModel.Tokens.Jwt', 'Grpc.Net.Client', 'Google.Protobuf', 'AWSSDK.Core', 'AWSSDK.S3', 'BouncyCastle.Cryptography', 'Portable.BouncyCastle', 'Quartz', 'Hangfire.Core', 'SixLabors.ImageSharp',
];

// Real packages a slip away from a popular one, which would otherwise be suspects.
const KNOWN = new Set(['colour', 'inherit', 'buffers', 'event', 'sync', 'jsonc', 'ejs-lint', 'pug-lint', 'react-is', 'reacts']);

const LISTS = { npm: POPULAR_NPM, nuget: POPULAR_NUGET.map((n) => n.toLowerCase()) };
const SETS = { npm: new Set(LISTS.npm), nuget: new Set(LISTS.nuget) };
const lists = (ecosystem) => (String(ecosystem).toLowerCase() === 'nuget' ? 'nuget' : 'npm');

/** A name without its separators (-, _, .), so cross-env and crossenv are the same. */
const skeleton = (s) => s.replace(/[-_.]/g, '');

/**
 * How `a` and `b` differ when they're one slip apart: 'swapped' (two letters next to each other
 * changed places), 'one letter' (one changed, added or dropped), or null when they're further apart.
 */
export function slip(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return null;
  if (a.length === b.length) {
    const diff = [];
    for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return 'one letter';
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return 'swapped';
    return null;
  }
  // One letter added or dropped: the longer one with a letter taken out is the shorter.
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  return long.slice(i + 1) === short.slice(i) ? 'one letter' : null;
}

/**
 * The well-known package `name` looks like and isn't: { like, how } ('separators' when only -, _ or .
 * differ, 'swapped', 'one letter'), or null. A scoped npm package (@scope/name) is its publisher's and
 * isn't compared. Short names are only compared for swapped letters and separators, as many real
 * short names are a letter apart (ms, qs; glob, blob).
 */
export function typosquatOf(name, ecosystem = 'npm') {
  const which = lists(ecosystem);
  const n = String(name ?? '').toLowerCase();
  if (!n || n.startsWith('@') || SETS[which].has(n) || KNOWN.has(n)) return null;
  for (const popular of LISTS[which]) {
    if (Math.abs(popular.length - n.length) > 2) continue;
    if (popular.length >= 4 && skeleton(popular) === skeleton(n)) return { like: original(which, popular), how: 'separators' };
    const how = slip(n, popular);
    if (how === 'swapped' && popular.length >= 4) return { like: original(which, popular), how };
    if (how === 'one letter' && popular.length >= 5) return { like: original(which, popular), how };
  }
  return null;
}

// NuGet's names as they're written (Newtonsoft.Json), for the sentence.
const original = (which, lower) => (which === 'nuget' ? POPULAR_NUGET.find((n) => n.toLowerCase() === lower) : lower);
