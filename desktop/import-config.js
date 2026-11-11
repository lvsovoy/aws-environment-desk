import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importConfig } from './config.js';

export async function runImport(args = process.argv.slice(2)) {
  const source = args[0];
  if (!source) {
    throw new Error('Usage: npm run config:import <path-to-config.json>');
  }
  const config = await importConfig(resolve(process.cwd(), source));
  console.log(`Successfully imported configuration for "${config.name}" to config/config.json.`);
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runImport().catch(error => {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  });
}
