// Writes src-tauri/ci.json: what the Desktop workflow adds to a build from the secrets it was given, and
// nothing for a secret it wasn't (a build without any is the plain, unsigned one, as before).
//   TAURI_UPDATER_PUBKEY + FLEET_UPDATE_URL  the updater switched on: its public key and where it
//                                            looks ({{target}}, {{arch}}, {{current_version}} filled
//                                            in), and the bundle's signed update files made
//   WINDOWS_CERT_THUMBPRINT                  the Windows installers signed with that certificate,
//                                            imported into the runner's store by the step before
// macOS signing and notarisation need no setting here: the Tauri CLI reads APPLE_CERTIFICATE and the
// rest from the environment. The updater's private key is read the same way (TAURI_SIGNING_PRIVATE_KEY).
import { writeFileSync } from 'node:fs';

const env = process.env;
const config = { bundle: {}, plugins: {} };
const said = [];

if (env.TAURI_UPDATER_PUBKEY && env.FLEET_UPDATE_URL) {
  config.bundle.createUpdaterArtifacts = true;
  config.plugins.updater = { pubkey: env.TAURI_UPDATER_PUBKEY, endpoints: [env.FLEET_UPDATE_URL] };
  said.push('the updater');
}
if (env.WINDOWS_CERT_THUMBPRINT) {
  config.bundle.windows = { certificateThumbprint: env.WINDOWS_CERT_THUMBPRINT, digestAlgorithm: 'sha256', timestampUrl: env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com' };
  said.push('Windows signing');
}
if (env.APPLE_CERTIFICATE) said.push('macOS signing');
if (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID) said.push('notarisation');

writeFileSync(new URL('../src-tauri/ci.json', import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
console.log(said.length ? `This build has ${said.join(', ')}.` : 'This build is unsigned and has no updater: no secrets for them.');
