import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.cwd(), process.env.E2E_DIST_DIR || "dist");
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gz": "application/gzip",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function parseHeadersFile() {
  const rules = [];
  let current = null;
  for (const rawLine of readFileSync(resolve(root, "_headers"), "utf8").split(/\r?\n/u)) {
    if (!rawLine.trim()) continue;
    if (!/^\s/u.test(rawLine)) {
      current = { pattern: rawLine.trim(), set: new Map(), remove: new Set() };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    if (line.startsWith("! ")) {
      current.remove.add(line.slice(2).toLowerCase());
      continue;
    }
    const separator = line.indexOf(":");
    if (separator > 0) current.set.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return rules;
}

const headerRules = parseHeadersFile();

function matches(pattern, pathname) {
  if (pattern === "/*") return true;
  return pattern === pathname;
}

function localFixtureHeader(name, value) {
  if (name.toLowerCase() !== "content-security-policy") return value;
  // Production is HTTPS and must keep upgrade-insecure-requests. This server
  // is an explicitly loopback-only HTTP fixture; WebKit otherwise upgrades
  // its relative subresources to HTTPS and fails them before app code runs.
  return value
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.toLowerCase() !== "upgrade-insecure-requests")
    .join("; ");
}

function applyConfiguredHeaders(response, pathname) {
  for (const rule of headerRules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.set) response.setHeader(name, localFixtureHeader(name, value));
    for (const name of rule.remove) response.removeHeader(name);
  }
}

function resolveAsset(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  try {
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const index = resolve(candidate, "index.html");
      return statSync(index).isFile() ? index : null;
    }
    return stat.isFile() ? candidate : null;
  } catch (_) {
    return null;
  }
}

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  } catch (_) {
    response.writeHead(400).end("Bad Request");
    return;
  }

  let asset;
  try {
    asset = resolveAsset(pathname);
  } catch (_) {
    response.writeHead(400).end("Bad Request");
    return;
  }
  const found = Boolean(asset);
  if (!asset) asset = resolve(root, "404.html");
  response.statusCode = found ? 200 : 404;
  response.setHeader("Content-Type", mimeTypes[extname(asset)] || "application/octet-stream");
  response.setHeader("Content-Length", statSync(asset).size);
  applyConfiguredHeaders(response, pathname);

  if (request.method === "HEAD") {
    response.end();
    return;
  }
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET, HEAD");
    response.end();
    return;
  }
  createReadStream(asset).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`tailcat e2e server listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
