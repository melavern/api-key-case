import type { BigIntStats } from "node:fs";

/** NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. Never round identities. */
export function physicalIdentity(stat: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">): { dev: string; ino: string; birthtimeNs: string } {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}
