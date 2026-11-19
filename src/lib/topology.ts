import { networkOf, ipToInt, type ParsedConfig, type ParsedInterface } from "./config-parser"
import { ifKey, portIsDown, sameIf, shortHostname, type CdpNeighbor, type DeviceData } from "./show-parser"
import type { DeviceRole } from "./types"

// Turns what was imported for one site into a diagram. Links are worked out
// from several kinds of evidence, strongest first, and each link keeps the
// list of evidence that produced it:
//
//   cdp          show cdp neighbors — both ends, exactly. Also brings in
//                neighbours whose own output was not imported.
//   ospf         show ip ospf neighbor — the neighbour's address is matched to
//                the device that owns it
//   subnet       both ends in the same /30 or /31 (show run)
//   description  an interface description names the other device
//   route        the default route's next hop (show ip route); a next hop no
//                imported device owns is drawn as a WAN cloud
//
// Port-channel members (show port-channel summary, or channel-group in the
// config) are folded into their port-channel, and a port that show interfaces
// status / description says is down never makes a link.

export interface TopologyInterface {
  name: string
  description: string | null
  address: string | null
  mode: string | null
  vlan: string | null
  shutdown: boolean
  status: string | null
}

export type NodeKind = "device" | "neighbor" | "endpoint" | "ospf-peer" | "wan"

export interface TopologyNode {
  id: string
  hostname: string
  role: DeviceRole
  kind: NodeKind
  mgmtIp: string | null
  imported: boolean
  platform: string | null
  version: string | null
  /** Where a node that was not imported came from, e.g. "CDP ของ HQ-CORE-01". */
  seenVia: string | null
  commands: string[]
  interfaces: TopologyInterface[]
  cdp: CdpNeighbor[]
  ospf: { routerId: string; state: string; address: string; localIf: string }[]
  routes: { total: number; byProtocol: Record<string, number>; defaultVia: string[] }
}

export type Evidence = "cdp" | "ospf" | "subnet" | "description" | "route"

export interface LinkPair { aIf: string | null; bIf: string | null; aMembers?: string[]; bMembers?: string[] }

export interface TopologyLink {
  id: string
  a: string
  b: string
  pairs: LinkPair[]
  sources: Evidence[]
  vlans: string | null
}

export interface TopologySegment {
  id: string
  label: string
  members: { node: string; ifName: string; ip: string }[]
}

export interface Topology {
  nodes: TopologyNode[]
  links: TopologyLink[]
  segments: TopologySegment[]
}

export interface ImportedDevice { hostname: string; data: DeviceData }
export interface KnownDevice { hostname: string; role: DeviceRole; mgmtIp: string | null }
export interface TopologyOptions { includeEndpoints?: boolean }

export function guessRole(hostname: string, cfg?: ParsedConfig): DeviceRole {
  const h = hostname.toUpperCase()
  const has = (re: RegExp) => re.test(h)
  if (has(/(^|[-_.])(FW|FIREWALL|FGT|ASA|PA)\d*([-_.]|$)/)) return "FIREWALL"
  if (has(/(^|[-_.])(WLC)\d*([-_.]|$)/)) return "WLC"
  if (has(/(^|[-_.])(AP)\d*([-_.]|$)/)) return "ACCESS_POINT"
  if (has(/(^|[-_.])(RTR|RT|ROUTER|WAN|CE|PE|BR)\d*([-_.]|$)/)) return "ROUTER"
  if (has(/(^|[-_.])(CORE|CS|DIST|DS|AGG|SPINE)\d*([-_.]|$)/)) return "CORE_SWITCH"
  if (has(/(^|[-_.])(ACC|AS|SW|TOR|LEAF|EDGE)\d*([-_.]|$)/)) return "ACCESS_SWITCH"
  if (cfg) {
    const switching = cfg.interfaces.some((i) => i.mode === "access" || i.mode === "trunk")
    if (!switching && cfg.routing.length) return "ROUTER"
    if (switching) return cfg.routing.length ? "CORE_SWITCH" : "ACCESS_SWITCH"
  }
  return "OTHER"
}

function roleFromCdp(n: CdpNeighbor): DeviceRole {
  const byName = guessRole(n.deviceId)
  if (byName !== "OTHER") return byName
  const p = (n.platform ?? "").toUpperCase()
  const c = new Set(n.capabilities)
  if (/AIR-|C91\d\dAX|CW91|\bAP\b|MR\d/.test(p)) return "ACCESS_POINT"
  if (/C98\d\d|AIR-CT|WLC/.test(p)) return "WLC"
  if (/ASA|FPR|FIREPOWER|FORTI/.test(p)) return "FIREWALL"
  if (/N[3579]K|C95\d\d|C68\d\d|C45\d\d|C65\d\d/.test(p)) return "CORE_SWITCH"
  if (c.has("R") && !c.has("S")) return "ROUTER"
  if (c.has("S")) return "ACCESS_SWITCH"
  return "OTHER"
}

function isEndpoint(n: CdpNeighbor): boolean {
  const c = new Set(n.capabilities)
  return ((c.has("P") || c.has("H")) && !c.has("R") && !c.has("S")) || /phone/i.test(n.platform ?? "") || /^SEP[0-9A-F]{12}$/i.test(n.deviceId)
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const IF_HINT = /\b(HundredGigE|FortyGigabitEthernet|TwentyFiveGigE|TenGigabitEthernet|GigabitEthernet|FastEthernet|Ethernet|Port-channel|Hu|Fo|Twe|Te|Gi|Fa|Eth|Et|Po)\s?(\d+(?:[/.:]\d+)*)\b/i

function inSubnet(ip: string, i: ParsedInterface): boolean {
  if (!i.ip || i.prefix === null) return false
  const size = 2 ** (32 - i.prefix)
  return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(i.ip) / size)
}

type Extra = Pick<TopologyNode, "id" | "hostname" | "role" | "kind" | "mgmtIp" | "platform" | "seenVia">

export function buildTopology(imported: ImportedDevice[], known: KnownDevice[] = [], opts: TopologyOptions = {}): Topology {
  const dev = new Map(imported.map((d) => [d.hostname.toLowerCase(), d]))
  const knownBy = new Map(known.map((k) => [k.hostname.toLowerCase(), k]))
  const live = (d: ImportedDevice) => d.data.config.interfaces.filter((i) => !i.shutdown && !portIsDown(d.data, i.name))

  // Nodes that were not imported, with what we learnt about them.
  const extra = new Map<string, Extra>()
  /** The display name for a host: the imported one, else the site's, else as first seen. */
  const canon = (name: string) =>
    dev.get(name.toLowerCase())?.hostname ?? knownBy.get(name.toLowerCase())?.hostname ?? extra.get(name.toLowerCase())?.hostname ?? name

  // --- links ----------------------------------------------------------------
  const links = new Map<string, TopologyLink>()
  const linkFor = (x: string, y: string) => {
    const [a, b] = [x, y].sort((p, q) => p.localeCompare(q))
    const id = `${a}__${b}`
    if (!links.has(id)) links.set(id, { id, a, b, pairs: [], sources: [], vlans: null })
    return links.get(id)!
  }

  /** A LAG member stands for its port-channel: the interface to draw, and the member it came from. */
  const bundle = (host: string, ifName: string | null): { name: string | null; member: string | null } => {
    const d = dev.get(host.toLowerCase())
    if (!d || !ifName) return { name: ifName, member: null }
    const pc = d.data.portChannels.find((p) => p.members.some((m) => sameIf(m.name, ifName)))
    if (pc) {
      const po = d.data.config.interfaces.find((i) => sameIf(i.name, pc.name))
      return { name: po?.name ?? pc.name, member: ifName }
    }
    const cg = d.data.config.interfaces.find((i) => sameIf(i.name, ifName))?.channelGroup
    if (cg !== null && cg !== undefined) {
      const po = d.data.config.interfaces.find((i) => ifKey(i.name) === `po${cg}`)
      return { name: po?.name ?? `Port-channel${cg}`, member: ifName }
    }
    return { name: ifName, member: null }
  }

  /** The device's own spelling of an interface ("Gig 0/0/1" from CDP -> "GigabitEthernet0/0/1" from its config). */
  const ownName = (host: string, ifName: string | null) =>
    ifName ? dev.get(host.toLowerCase())?.data.config.interfaces.find((i) => sameIf(i.name, ifName))?.name ?? ifName : null

  const addPair = (x0: string, xIfRaw: string | null, y0: string, yIfRaw: string | null, source: Evidence) => {
    const x = canon(x0), y = canon(y0)
    if (x.toLowerCase() === y.toLowerCase()) return
    const bx = bundle(x, ownName(x, xIfRaw)), by = bundle(y, ownName(y, yIfRaw))
    const link = linkFor(x, y)
    const [aIf, bIf, aM, bM] = link.a === x ? [bx.name, by.name, bx.member, by.member] : [by.name, bx.name, by.member, bx.member]
    // Same pair when one end agrees and the other agrees or is unknown on either side.
    const fits = (p: string | null, q: string | null) => sameIf(p, q) || !p || !q
    let pair = link.pairs.find((p) => fits(p.aIf, aIf) && fits(p.bIf, bIf) && (sameIf(p.aIf, aIf) || sameIf(p.bIf, bIf) || (!p.aIf && !aIf) || (!p.bIf && !bIf)))
    if (!pair) { pair = { aIf, bIf }; link.pairs.push(pair) }
    pair.aIf ??= aIf
    pair.bIf ??= bIf
    for (const [k, m] of [["aMembers", aM], ["bMembers", bM]] as const) {
      if (!m) continue
      const list = (pair[k] ??= [])
      if (!list.some((z) => sameIf(z, m))) list.push(m)
    }
    if (!link.sources.includes(source)) link.sources.push(source)
  }

  const linkOn = (host: string, ifName: string) => [...links.values()].find((l) =>
    (l.a === host && l.pairs.some((p) => sameIf(p.aIf, ifName) || p.aMembers?.some((m) => sameIf(m, ifName)))) ||
    (l.b === host && l.pairs.some((p) => sameIf(p.bIf, ifName) || p.bMembers?.some((m) => sameIf(m, ifName)))))

  const addExtra = (e: Extra) => {
    if (!dev.has(e.hostname.toLowerCase()) && !extra.has(e.hostname.toLowerCase())) extra.set(e.hostname.toLowerCase(), e)
  }

  // 1. CDP
  for (const d of imported) {
    for (const n of d.data.cdp) {
      const endpoint = isEndpoint(n)
      if (endpoint && !opts.includeEndpoints) continue
      const name = shortHostname(n.deviceId)
      const k = knownBy.get(name.toLowerCase())
      const e = extra.get(name.toLowerCase())
      if (e) { e.mgmtIp ??= n.ip; e.platform ??= n.platform }
      addExtra({
        id: k?.hostname ?? name, hostname: k?.hostname ?? name, role: k?.role ?? roleFromCdp(n),
        kind: endpoint ? "endpoint" : "neighbor", mgmtIp: n.ip ?? k?.mgmtIp ?? null, platform: n.platform, seenVia: `CDP ของ ${d.hostname}`,
      })
      addPair(d.hostname, n.localIf, name, n.remoteIf, "cdp")
    }
  }

  // Who owns an address, among the imported devices.
  const ownerOf = (ip: string): { host: string; ifName: string } | null => {
    for (const d of imported) {
      const i = d.data.config.interfaces.find((x) => x.ip === ip)
      if (i) return { host: d.hostname, ifName: i.name }
    }
    return null
  }

  // 2. OSPF neighbours
  for (const d of imported) {
    for (const n of d.data.ospf) {
      const owner = ownerOf(n.address)
      if (owner) {
        // An adjacency over an SVI, loopback or tunnel is not a cable: it backs
        // up a link that is already drawn, and only draws one if there is none.
        const logical = /^(vlan|lo|tunnel|nve)/.test(ifKey(n.localIf))
        const existing = links.get([canon(d.hostname), canon(owner.host)].sort((p, q) => p.localeCompare(q)).join("__"))
        if (logical && existing) { if (!existing.sources.includes("ospf")) existing.sources.push("ospf"); continue }
        addPair(d.hostname, n.localIf, owner.host, owner.ifName, "ospf")
        continue
      }
      const existing = linkOn(d.hostname, n.localIf)
      if (existing) { if (!existing.sources.includes("ospf")) existing.sources.push("ospf"); continue }
      const id = `OSPF ${n.routerId}`
      addExtra({ id, hostname: id, role: "ROUTER", kind: "ospf-peer", mgmtIp: n.address, platform: null, seenVia: `OSPF neighbor ของ ${d.hostname}` })
      addPair(d.hostname, n.localIf, id, null, "ospf")
    }
  }

  // 3. Point-to-point subnets, and shared LAN segments
  const byNet = new Map<string, { node: string; iface: ParsedInterface }[]>()
  for (const d of imported) {
    for (const i of live(d)) {
      if (!i.ip || i.prefix === null || i.prefix >= 32) continue
      const net = networkOf(i.ip, i.prefix)
      byNet.set(net, [...(byNet.get(net) ?? []), { node: d.hostname, iface: i }])
    }
  }
  const segments: TopologySegment[] = []
  for (const [net, members] of byNet) {
    if (new Set(members.map((m) => m.node)).size < 2) continue
    const prefix = Number(net.split("/")[1])
    if (prefix >= 30 && members.length === 2) {
      addPair(members[0].node, members[0].iface.name, members[1].node, members[1].iface.name, "subnet")
      continue
    }
    const vlan = members.map((m) => /^vlan\s*(\d+)$/i.exec(m.iface.name)?.[1]).find(Boolean)
    segments.push({
      id: `seg:${net}`,
      label: vlan ? `VLAN ${vlan} · ${net}` : net,
      members: members.map((m) => ({ node: m.node, ifName: m.iface.name, ip: m.iface.ip! })),
    })
  }

  // 4. Descriptions naming another device, for ports nothing above explained
  const names = [...new Set([
    ...imported.map((d) => d.hostname),
    ...known.map((k) => k.hostname),
    ...[...extra.values()].filter((e) => e.kind === "neighbor").map((e) => e.hostname),
  ])]
  const matchers = names.sort((a, b) => b.length - a.length)
    .map((name) => ({ name, re: new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}(?=$|[^A-Za-z0-9_-])`, "i") }))
  type Half = { from: string; fromIf: string; to: string; toIfHint: string | null }
  const halves: Half[] = []
  for (const d of imported) {
    for (const i of live(d)) {
      if (!i.description || linkOn(d.hostname, i.name)) continue
      const hit = matchers.find((m) => m.name.toLowerCase() !== d.hostname.toLowerCase() && m.re.test(i.description!))
      if (!hit) continue
      const after = i.description.slice(i.description.toLowerCase().indexOf(hit.name.toLowerCase()) + hit.name.length)
      const hint = IF_HINT.exec(after)
      halves.push({ from: d.hostname, fromIf: i.name, to: hit.name, toIfHint: hint ? `${hint[1]}${hint[2]}` : null })
    }
  }
  const used = new Set<number>()
  halves.forEach((h, i) => {
    if (used.has(i)) return
    const j = halves.findIndex((o, k) => k !== i && !used.has(k) && o.from === h.to && o.to === h.from &&
      (!h.toIfHint || sameIf(h.toIfHint, o.fromIf)) && (!o.toIfHint || sameIf(o.toIfHint, h.fromIf)))
    used.add(i)
    const k = knownBy.get(h.to.toLowerCase())
    addExtra({ id: h.to, hostname: h.to, role: k?.role ?? guessRole(h.to), kind: "neighbor", mgmtIp: k?.mgmtIp ?? null, platform: null, seenVia: `description ของ ${h.from}` })
    if (j >= 0) { used.add(j); addPair(h.from, h.fromIf, h.to, halves[j].fromIf, "description") }
    else addPair(h.from, h.fromIf, h.to, h.toIfHint, "description")
  })

  // 5. Default route next hops
  for (const d of imported) {
    for (const r of d.data.routes.filter((x) => x.network === "0.0.0.0" && x.prefix === 0)) {
      for (const nh of r.nextHops) {
        if (!nh.ip) continue
        const egress = nh.iface ?? live(d).find((i) => inSubnet(nh.ip!, i))?.name ?? null
        const owner = ownerOf(nh.ip)
        if (owner) { addPair(d.hostname, egress, owner.host, owner.ifName, "route"); continue }
        const id = `WAN ${nh.ip}`
        addExtra({ id, hostname: id, role: "OTHER", kind: "wan", mgmtIp: nh.ip, platform: null, seenVia: `default route ของ ${d.hostname}` })
        addPair(d.hostname, egress, id, null, "route")
      }
    }
  }

  // VLANs carried, from the trunk at either end.
  const trunkOf = (host: string, ifName: string | null) =>
    ifName ? dev.get(host.toLowerCase())?.data.config.interfaces.find((i) => sameIf(i.name, ifName))?.trunkVlans ?? null : null
  for (const l of links.values()) {
    l.vlans = l.pairs.map((p) => trunkOf(l.a, p.aIf) ?? trunkOf(l.b, p.bIf)).find(Boolean) ?? null
    l.pairs.sort((p, q) => (p.aIf ?? "").localeCompare(q.aIf ?? "", undefined, { numeric: true }))
  }

  // --- nodes ----------------------------------------------------------------
  const nodes: TopologyNode[] = imported.map((d) => {
    const cfg = d.data.config
    const k = knownBy.get(d.hostname.toLowerCase())
    const byProtocol: Record<string, number> = {}
    for (const r of d.data.routes) byProtocol[r.protocol] = (byProtocol[r.protocol] ?? 0) + 1
    return {
      id: d.hostname,
      hostname: d.hostname,
      role: k?.role ?? guessRole(d.hostname, cfg),
      kind: "device",
      mgmtIp: cfg.mgmtIp ?? k?.mgmtIp ?? null,
      imported: true,
      platform: cfg.platform === "unknown" ? null : cfg.platform,
      version: cfg.version,
      seenVia: null,
      commands: d.data.commands,
      interfaces: cfg.interfaces.map((i) => ({
        name: i.name,
        description: i.description,
        address: i.ip ? `${i.ip}/${i.prefix}` : null,
        mode: i.mode,
        vlan: i.mode === "trunk" ? (i.trunkVlans ?? "all") : i.accessVlan !== null ? String(i.accessVlan) : null,
        shutdown: i.shutdown,
        status: d.data.ifStatus.find((s) => sameIf(s.port, i.name))?.status
          ?? d.data.ifDesc.find((s) => sameIf(s.port, i.name) && s.status !== "unknown")?.status ?? null,
      })),
      cdp: d.data.cdp,
      ospf: d.data.ospf,
      routes: {
        total: d.data.routes.length,
        byProtocol,
        defaultVia: d.data.routes.filter((r) => r.network === "0.0.0.0" && r.prefix === 0).flatMap((r) => r.nextHops.map((h) => h.ip ?? h.iface ?? "?")),
      },
    }
  })
  const linked = new Set<string>()
  for (const l of links.values()) { linked.add(l.a); linked.add(l.b) }
  for (const e of extra.values()) {
    if (!linked.has(e.hostname)) continue
    nodes.push({ ...e, imported: false, version: null, commands: [], interfaces: [], cdp: [], ospf: [], routes: { total: 0, byProtocol: {}, defaultVia: [] } })
  }

  return {
    nodes: nodes.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    links: [...links.values()],
    segments: segments.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  }
}
