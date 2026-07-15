import { networkInterfaces } from "node:os";

const manual = process.env.TAILSCALE_HOST ?? process.env.SINAPSO_TAILSCALE_HOST;
if (manual && manual.trim()) {
  process.stdout.write(manual.trim());
  process.exit(0);
}

const ifaces = networkInterfaces();
const candidates = Object.values(ifaces).flatMap((entries) => entries ?? []);

const preferred = candidates.find(
  (entry) =>
    entry &&
    !entry.internal &&
    entry.family === "IPv4" &&
    /^100\./.test(entry.address),
);
if (preferred?.address) {
  process.stdout.write(preferred.address);
  process.exit(0);
}

const lan = candidates.find(
  (entry) =>
    entry &&
    !entry.internal &&
    entry.family === "IPv4" &&
    (/^192\.168\./.test(entry.address) ||
      /^10\./.test(entry.address) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)),
);
if (lan?.address) {
  process.stdout.write(lan.address);
  process.exit(0);
}

const any = candidates.find(
  (entry) => entry && !entry.internal && entry.family === "IPv4",
);
if (any?.address) {
  process.stdout.write(any.address);
  process.exit(0);
}

console.error(
  "Could not resolve a non-loopback IPv4. Set TAILSCALE_HOST manually.",
);
process.exit(1);
