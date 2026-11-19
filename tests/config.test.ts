import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { expandVlanList, networkOf, parseConfig } from "@/lib/config-parser"
import { parseDeviceText } from "@/lib/show-parser"
import { mergeConfigs } from "@/lib/site-merge"
import { buildTopology } from "@/lib/topology"
import { DEVICES, SITES, SUBNETS } from "@/lib/sample-data"

const SAMPLE_DIR = path.join(__dirname, "..", "samples", "configs", "BKK-HQ")
const samples = readdirSync(SAMPLE_DIR).map((f) => readFileSync(path.join(SAMPLE_DIR, f), "utf8"))
const sample = (host: string) => samples.find((s) => s.includes(`hostname ${host}\n`) || s.includes(`hostname ${host}\r\n`))!

describe("parseConfig", () => {
  it("reads hostname, version, interfaces, VLANs and the management address", () => {
    const cfg = parseDeviceText(sample("HQ-CORE-01")).config
    expect(cfg.hostname).toBe("HQ-CORE-01")
    expect(cfg.version).toBe("17.9")
    expect(cfg.platform).toBe("ios")
    expect(cfg.vlans.map((v) => [v.id, v.name])).toEqual([[10, "Management"], [20, "Users"], [30, "Voice"]])
    const te1 = cfg.interfaces.find((i) => i.name === "TenGigabitEthernet1/0/1")!
    expect([te1.ip, te1.prefix, te1.mode]).toEqual(["10.1.255.2", 30, "routed"])
    expect(cfg.interfaces.find((i) => i.name === "TenGigabitEthernet1/0/23")!.channelGroup).toBe(1)
    expect(cfg.mgmtIp).toBe("10.1.0.2") // Vlan10 is described "Management"
    expect(cfg.routing).toEqual(["OSPF"])
  })

  it("understands NX-OS prefix notation and switchname", () => {
    const cfg = parseConfig("switchname DC-LEAF-1\nfeature ospf\ninterface Ethernet1/1\n  no switchport\n  ip address 10.9.0.1/31\n  no shutdown\n")
    expect(cfg.hostname).toBe("DC-LEAF-1")
    expect(cfg.platform).toBe("nxos")
    expect(cfg.interfaces[0]).toMatchObject({ ip: "10.9.0.1", prefix: 31, mode: "routed", shutdown: false })
  })

  it("marks shut interfaces and ignores secondary addresses", () => {
    const cfg = parseConfig("hostname X\ninterface Gi0/1\n ip address 10.0.0.1 255.255.255.0\n ip address 10.0.1.1 255.255.255.0 secondary\n shutdown\n")
    expect(cfg.interfaces[0]).toMatchObject({ ip: "10.0.0.1", prefix: 24, shutdown: true })
  })

  it("helpers", () => {
    expect(networkOf("10.1.11.2", 23)).toBe("10.1.10.0/23")
    expect(expandVlanList("10,20-22, 5000")).toEqual([10, 20, 21, 22])
  })
})

describe("sample logs", () => {
  it("every sample is recognised with the commands it contains", () => {
    const found = Object.fromEntries(samples.map((s) => { const d = parseDeviceText(s); return [d.hostname, d.commands.sort()] }))
    expect(found["HQ-RTR-01"]).toEqual(["cdp", "ifDesc", "ospf", "route", "run"])
    expect(found["HQ-CORE-01"]).toEqual(["cdp", "ifStatus", "ospf", "portChannel", "route", "run", "trunk"])
    expect(found["HQ-ACC-01"]).toEqual(["cdp", "ifStatus", "run", "trunk"])
  })
})

describe("buildTopology (sample BKK-HQ logs)", () => {
  const imported = samples.map((s) => { const d = parseDeviceText(s); return { hostname: d.hostname!, data: d } })
  const known = DEVICES.filter((d) => d.siteId === 1).map((d) => ({ hostname: d.hostname, role: d.role, mgmtIp: d.mgmtIp }))
  const t = buildTopology(imported, known)
  const link = (a: string, b: string) => t.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))
  const ends = (a: string, b: string) => {
    const l = link(a, b)!
    return l.pairs.map((p) => (l.a === a ? [p.aIf, p.bIf] : [p.bIf, p.aIf]))
  }

  it("router ↔ core: one link backed by CDP, OSPF, the shared /30 and the core's default route", () => {
    expect(ends("HQ-RTR-01", "HQ-CORE-01")).toEqual([["GigabitEthernet0/0/1", "TenGigabitEthernet1/0/1"]])
    expect(link("HQ-RTR-01", "HQ-CORE-01")!.sources.sort()).toEqual(["cdp", "ospf", "route", "subnet"])
  })

  it("core ↔ core: CDP on each member folds into the port-channel", () => {
    const l = link("HQ-CORE-01", "HQ-CORE-02")!
    expect(l.pairs).toHaveLength(1)
    expect(l.pairs[0]).toMatchObject({ aIf: "Port-channel1", bIf: "Port-channel1" })
    expect(l.pairs[0].aMembers?.map((m) => m.replace(/\s/g, ""))).toHaveLength(2)
    expect(l.vlans).toBe("10,20,30")
  })

  it("core ↔ access: from CDP, although the descriptions do not name the device", () => {
    expect(ends("HQ-CORE-01", "HQ-ACC-01")).toEqual([["GigabitEthernet1/0/10", "GigabitEthernet1/0/49"]])
    expect(link("HQ-CORE-01", "HQ-ACC-01")!.sources).toEqual(["cdp"])
  })

  it("brings in CDP neighbours that were not imported, and leaves phones out by default", () => {
    expect(t.nodes.find((n) => n.hostname === "HQ-ACC-02")).toMatchObject({ imported: false, kind: "neighbor", platform: "C9300-48P" })
    expect(t.nodes.find((n) => n.hostname === "HQ-AP-01")).toMatchObject({ imported: false, role: "ACCESS_POINT", mgmtIp: "10.1.0.51" })
    expect(t.nodes.some((n) => n.hostname.startsWith("SEP"))).toBe(false)
    const withPhones = buildTopology(imported, known, { includeEndpoints: true })
    expect(withPhones.nodes.find((n) => n.hostname.startsWith("SEP"))).toMatchObject({ kind: "endpoint" })
  })

  it("a port that show interfaces status says is down makes no link", () => {
    // Gi1/0/3 is described "TO HQ-ACC-02 ..." but is notconnect.
    expect(link("HQ-ACC-01", "HQ-ACC-02")).toBeUndefined()
  })

  it("an OSPF neighbour over an SVI links the two cores' Vlan10 as well", () => {
    expect(link("HQ-CORE-01", "HQ-CORE-02")!.sources).toContain("cdp")
    expect(t.links.filter((l) => l.sources.includes("ospf")).length).toBeGreaterThanOrEqual(3)
  })

  it("the default route's next hop nobody owns becomes a WAN node", () => {
    expect(t.nodes.find((n) => n.id === "WAN 203.0.113.1")).toMatchObject({ kind: "wan" })
    expect(ends("HQ-RTR-01", "WAN 203.0.113.1")).toEqual([["GigabitEthernet0/0/0", null]])
  })

  it("description-only links still work when there is no CDP", () => {
    const rtr = parseDeviceText("hostname R1\ninterface Gi0/1\n description TO SW1 Gi1/0/1\n")
    const sw = parseDeviceText("hostname SW1\ninterface Gi1/0/1\n description UPLINK R1 Gi0/1\n switchport mode trunk\n")
    const t2 = buildTopology([{ hostname: "R1", data: rtr }, { hostname: "SW1", data: sw }])
    expect(t2.links).toHaveLength(1)
    expect(t2.links[0]).toMatchObject({ sources: ["description"], pairs: [{ aIf: "Gi0/1", bIf: "Gi1/0/1" }] })
  })

  it("turns shared LAN subnets into segments", () => {
    const mgmt = t.segments.find((s) => s.id === "seg:10.1.0.0/24")!
    expect(mgmt.label).toBe("VLAN 10 · 10.1.0.0/24")
    expect(mgmt.members.map((m) => m.node).sort()).toEqual(["HQ-ACC-01", "HQ-CORE-01", "HQ-CORE-02"])
  })
})

describe("mergeConfigs", () => {
  it("updates the matching device and adds new devices and subnets", () => {
    const site = SITES[0]
    const configs = [
      { hostname: "HQ-CORE-01", importedAt: "2026-11-19T04:00:00Z", raw: sample("HQ-CORE-01") },
      { hostname: "HQ-NEW-SW", importedAt: "2026-11-19T04:00:00Z", raw: "hostname HQ-NEW-SW\ninterface Vlan99\n ip address 10.1.99.5 255.255.255.0\n" },
      { hostname: "HQ-RTR-01", importedAt: "2026-11-19T04:00:00Z", raw: sample("HQ-RTR-01") },
    ]
    const { devices, subnets } = mergeConfigs(site, DEVICES.filter((d) => d.siteId === 1), SUBNETS.filter((s) => s.siteId === 1), configs)
    const core = devices.find((d) => d.hostname === "HQ-CORE-01")!
    expect(core.mgmtIp).toBe("10.1.0.2")
    expect(core.configImportedAt?.toISOString()).toBe("2026-11-19T04:00:00.000Z")
    expect(devices.find((d) => d.hostname === "HQ-NEW-SW")).toMatchObject({ role: "ACCESS_SWITCH", status: "UNKNOWN" })
    expect(subnets.find((s) => s.cidr === "10.1.99.0/24")).toMatchObject({ vlan: 99, gateway: "10.1.99.5" })
    // The WAN /30 comes from both the config and show ip route; it is listed once.
    expect(subnets.filter((s) => s.cidr === "203.0.113.0/30")).toHaveLength(1)
    expect(subnets.filter((s) => s.cidr === "10.1.0.0/24")).toHaveLength(1)
  })
})
