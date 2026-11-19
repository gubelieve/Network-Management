import "server-only"
import { promises as fs } from "node:fs"
import path from "node:path"
import { DATA_DIR } from "./config-store"
import type { Site } from "./types"

// Sites added on the Add site page, kept in <DATA_DIR>/sites.json until the
// database is provisioned (they become rows of the `sites` table then, and
// only this file changes). The built-in sample sites are not stored here.

const FILE = path.join(DATA_DIR, "sites.json")

export async function readStoredSites(): Promise<Site[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Site[]
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
}

// One write at a time inside this process: two people adding a site at the
// same moment would otherwise both read the old list and one site would be lost.
let queue: Promise<unknown> = Promise.resolve()

export function appendSite(build: (existing: Site[]) => Site): Promise<Site> {
  const run = queue.then(async () => {
    const existing = await readStoredSites()
    const site = build(existing)
    await fs.mkdir(DATA_DIR, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify([...existing, site], null, 2), "utf8")
    await fs.rename(tmp, FILE)
    return site
  })
  queue = run.catch(() => undefined)
  return run
}
