import { networkOf, shortIfName } from "./config-parser"
import { parseDeviceText, type DeviceData } from "./show-parser"
import { guessRole } from "./topology"
import type { Device, Site, Subnet } from "./types"

// How an imported file UPDATES a site: the device with the same hostname takes
// its version and management address (a new hostname becomes a new device),
// and every addressed interface — plus every connected route from show ip
// route — contributes its subnet unless the site already lists that CIDR.
// Pure, so it is tested without a disk.

export interface ConfigInput { hostname: string; importedAt: string; raw: string }

const VENDOR: Record<string, string> = { ios: "Cisco", nxos: "Cisco", "aos-cx": "Aruba", unknown: "Unknown" }

export function mergeConfigs(site: Site, devices: Device[], subnets: Subnet[], configs: ConfigInput[]) {
  const parsed: { input: ConfigInput; data: DeviceData }[] = configs.map((input) => ({ input, data: parseDeviceText(input.raw) }))
  const outDevices = devices.map((d) => ({ ...d }))
  const outSubnets = subnets.map((s) => ({ ...s }))
  const addSubnet = (s: Omit<Subnet, "id" | "siteId">) => {
    if (outSubnets.some((x) => x.cidr === s.cidr)) return
    outSubnets.push({ id: -(site.id * 100000 + outSubnets.length + 1), siteId: site.id, ...s })
  }

  parsed.forEach(({ input, data }, n) => {
    const cfg = data.config
    const at = new Date(input.importedAt)
    const existing = outDevices.find((d) => d.hostname.toLowerCase() === input.hostname.toLowerCase())
    if (existing) {
      existing.osVersion = cfg.version ?? existing.osVersion
      existing.mgmtIp = cfg.mgmtIp ?? existing.mgmtIp
      existing.configImportedAt = at
    } else {
      outDevices.push({
        id: -(site.id * 1000 + n + 1),
        siteId: site.id,
        hostname: input.hostname,
        mgmtIp: cfg.mgmtIp ?? "—",
        role: guessRole(input.hostname, cfg),
        vendor: VENDOR[cfg.platform],
        model: "From imported config",
        serial: null,
        osVersion: cfg.version,
        status: "UNKNOWN",
        lastSeen: null,
        configImportedAt: at,
      })
    }

    const vlanName = new Map(cfg.vlans.map((v) => [v.id, v.name]))
    for (const i of cfg.interfaces) {
      if (!i.ip || i.prefix === null || i.prefix >= 32 || i.shutdown) continue
      const svi = /^vlan\s*(\d+)$/i.exec(i.name)
      const vlan = svi ? Number(svi[1]) : null
      addSubnet({
        cidr: networkOf(i.ip, i.prefix),
        vlan,
        name: (vlan !== null ? vlanName.get(vlan) : null) ?? i.description ?? `${input.hostname} ${shortIfName(i.name)}`,
        gateway: svi ? i.ip : null,
      })
    }
    for (const r of data.routes) {
      if (r.protocol !== "connected" || r.prefix >= 32) continue
      const iface = r.nextHops.find((h) => h.iface)?.iface ?? null
      const svi = iface ? /^vlan\s*(\d+)$/i.exec(iface) : null
      addSubnet({
        cidr: `${r.network}/${r.prefix}`,
        vlan: svi ? Number(svi[1]) : null,
        name: `${input.hostname} ${iface ? shortIfName(iface) : "connected"}`,
        gateway: null,
      })
    }
  })

  outSubnets.sort((a, b) => (a.vlan ?? 9999) - (b.vlan ?? 9999) || a.cidr.localeCompare(b.cidr, undefined, { numeric: true }))
  return { devices: outDevices, subnets: outSubnets, parsed }
}
