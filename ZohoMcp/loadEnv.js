/**
 * loadEnv.js
 *
 * Minimal, dependency-free .env loader for local development.
 *
 * Reads .env.local then .env from the project directory. Values already present
 * in process.env always win, so the env block in a Claude Desktop MCP config
 * takes precedence over any file left lying around on disk.
 *
 * Supports: KEY=value, quoted values, "export KEY=value", # comments, blank
 * lines. Not a full dotenv implementation - no variable interpolation.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(fileURLToPath(import.meta.url));

function parseEnvFile(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    // Strip matching surrounding quotes; leave inner content untouched.
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Only strip trailing comments on unquoted values, and only when the # is
      // clearly separated - Zoho secrets will not contain " #".
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    result[key] = value;
  }
  return result;
}

/**
 * Load .env.local and .env into process.env without overwriting existing values.
 * @returns {{ loadedFrom: string[], keys: string[] }}
 */
export function loadEnvFiles(files = [".env.local", ".env"]) {
  const loadedFrom = [];
  const keys = new Set();

  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(resolve(projectDir, file), "utf8");
    } catch {
      continue; // absent or unreadable - not an error
    }
    loadedFrom.push(file);

    for (const [key, value] of Object.entries(parseEnvFile(contents))) {
      keys.add(key);
      // Real environment variables win over file values.
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  }

  return { loadedFrom, keys: [...keys] };
}
