// Reads the output of the show commands an engineer collects from a device,
// usually one log file per device with every command in it:
//
//   show running-config            show interfaces trunk
//   show cdp neighbors [detail]    show port-channel summary / show etherchannel summary
//   show interfaces status         show ip route
//   show interfaces description    show ip ospf neighbor
//
// IOS / IOS-XE and NX-OS layouts are both handled. Each command's output is
// found by its prompt line ("HQ-CORE-01#show cdp nei") or by a bare
// "show ..." line, and abbreviations are accepted. Pure: runs in the browser
// for the Import preview and on the server on save.

import { isIpv4, parseConfig, type ParsedConfig, type ParsedInterface } from "./config-parser"

export type CommandKey = "run" | "cdp" | "ifStatus" | "ifDesc" | "trunk" | "portChannel" | "route" | "ospf"

export const COMMAND_LABEL: Record<CommandKey, string> = {
  run: "show run",
  cdp: "show cdp ne",
  ifStatus: "show int status",
  ifDesc: "show int desc",
  trunk: "show int trunk",
  portChannel: "show port-channel sum",
  route: "show ip route",
  ospf: "show ip ospf ne",
}

const COMMANDS: [CommandKey, RegExp][] = [
  ["run", /^sh(?:o|ow)?\s+run(?:n(?:i(?:n(?:g(?:-(?:c(?:o(?:n(?:f(?:i(?:g)?)?)?)?)?)?)?)?)?)?)?\b/],
  ["cdp", /^sh\w*\s+cdp\s+ne\w*/],
  ["ifStatus", /^sh\w*\s+int\w*\s+stat\w*/],
  ["ifDesc", /^sh\w*\s+int\w*\s+desc\w*/],
  ["trunk", /^sh\w*\s+int\w*\s+trun\w*/],
  ["portChannel", /^sh\w*\s+(?:port-ch\w*|ethercha\w*)\s+sum\w*/],
  ["route", /^sh\w*\s+ip\s+ro\w*/],
  ["ospf", /^sh\w*\s+ip\s+ospf\s+ne\w*/],
]

export interface CdpNeighbor {
  deviceId: string
  localIf: string
  remoteIf: string | null
  platform: string | null
  capabilities: string[]
  ip: string | null
}

export interface OspfNeighbor { routerId: string; state: string; address: string; localIf: string }
export interface IfStatus { port: string; name: string | null; status: string; vlan: string | null; speed: string | null; type: string | null }
export interface IfDescription { port: string; status: string; protocol: string; description: string | null }
export interface Trunk { port: string; status: string | null; native: string | null; allowed: string | null; active: string | null }
export interface PortChannel { name: string; flags: string; protocol: string | null; members: { name: string; flag: string }[] }
export interface Route {
  network: string
  prefix: number
  protocol: "connected" | "local" | "static" | "ospf" | "bgp" | "eigrp" | "rip" | "other"
  nextHops: { ip: string | null; iface: string | null }[]
}

export interface DeviceData {
  hostname: string | null
  commands: CommandKey[]
  config: ParsedConfig
  cdp: CdpNeighbor[]
  ospf: OspfNeighbor[]
  ifStatus: IfStatus[]
  ifDesc: IfDescription[]
  trunks: Trunk[]
  portChannels: PortChannel[]
  routes: Route[]
}

// ---------------------------------------------------------------------------
// Interface names

const IF_PREFIX: [RegExp, string][] = [
  [/^(hundredgige|hundredgigabitethernet|hun|hu)/, "hu"],
  [/^(fortygigabitethernet|fortygige|for|fo)/, "fo"],
  [/^(twentyfivegige|twentyfivegigabitethernet|twe)/, "twe"],
  [/^(tengigabitethernet|tengige|ten|te)/, "te"],
  [/^(gigabitethernet|gige|gig|gi)/, "gi"],
  [/^(fastethernet|fas|fa)/, "fa"],
  [/^(ethernet|eth|et|e)(?=\d)/, "eth"],
  [/^(port-channel|portchannel|po)/, "po"],
  [/^(loopback|lo)/, "lo"],
  [/^(vlan|vl)/, "vlan"],
  [/^(mgmt|management)/, "mgmt"],
]

/** One key for every spelling of an interface: "Gig 1/0/1", "Gi1/0/1", "GigabitEthernet1/0/1" -> "gi1/0/1". */
export function ifKey(name: string): string {
  const s = name.toLowerCase().replace(/\s+/g, "")
  for (const [re, p] of IF_PREFIX) if (re.test(s)) return s.replace(re, p)
  return s
}

export function sameIf(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && ifKey(a) === ifKey(b)
}

const IF_TOKEN = /^(?:[A-Za-z][A-Za-z-]*\s?\d+(?:[/.:]\d+)*)$/
const looksLikeIf = (s: string) => IF_TOKEN.test(s) && /\d/.test(s)

/** "HQ-CORE-01.lab.local" / "N9K-1(FDO2134)" -> "HQ-CORE-01" / "N9K-1". */
export function shortHostname(id: string): string {
  return id.replace(/\([^)]*\)$/, "").split(".")[0]
}

// ---------------------------------------------------------------------------
// Splitting a log into command outputs

const PROMPT = /^([A-Za-z0-9][\w.\-/]*)(?:\([\w-]+\))?[#>]\s*(.*)$/
const BARE = /^\s*(?:[-=*#]+\s*)?(sh(?:ow)?\s.+?)\s*(?:[-=*#]+)?\s*$/i

export function splitSections(text: string): { prompts: string[]; sections: { key: CommandKey; detail: boolean; lines: string[] }[] } {
  const lines = text.replace(/\r/g, "").split("\n")
  const sections: { key: CommandKey; detail: boolean; lines: string[] }[] = []
  const prompts: string[] = []
  let current: { key: CommandKey; detail: boolean; lines: string[] } | null = null

  for (const line of lines) {
    let cmd: string | null = null
    const p = PROMPT.exec(line)
    if (p && /^sh/i.test(p[2])) { cmd = p[2]; prompts.push(p[1]) }
    else if (p && p[2].trim() === "") { prompts.push(p[1]); current = null; continue }
    else {
      const b = BARE.exec(line)
      if (b && COMMANDS.some(([, re]) => re.test(b[1].toLowerCase().replace(/\s+/g, " ")))) cmd = b[1]
    }
    if (cmd !== null) {
      const norm = cmd.toLowerCase().replace(/\s+/g, " ").trim()
      const hit = COMMANDS.find(([, re]) => re.test(norm))
      current = hit ? { key: hit[0], detail: /\bdet\w*/.test(norm), lines: [] } : null
      if (current) sections.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return { prompts, sections }
}

// ---------------------------------------------------------------------------
// Per-command parsers

const CAP_WORDS: Record<string, string> = { router: "R", "trans-bridge": "T", "source-route-bridge": "B", switch: "S", host: "H", igmp: "I", repeater: "r", phone: "P", "remotely-managed-device": "D", "cvta": "C", "two-port-mac-relay": "M", "supports-stp-dispute": "s" }

export function parseCdp(lines: string[], detail: boolean): CdpNeighbor[] {
  const text = lines.join("\n")
  if (detail || /Device ID\s*:/i.test(text)) {
    return text.split(/^-{5,}\s*$|(?=^\s*Device ID\s*:)/m).map((block): CdpNeighbor | null => {
      const id = /Device ID\s*:\s*(\S+)/i.exec(block)
      const iface = /Interface\s*:\s*([^,\n]+),\s*Port ID \(outgoing port\)\s*:\s*(\S.*)$/im.exec(block)
      if (!id || !iface) return null
      const plat = /Platform\s*:\s*([^,\n]+)/i.exec(block)
      const caps = /Capabilities\s*:\s*(.+)$/im.exec(block)
      const ip = /(?:IP(?:v4)? address|IPv4 Address)\s*:\s*(\d+\.\d+\.\d+\.\d+)/i.exec(block)
      return {
        deviceId: shortHostname(id[1]),
        localIf: iface[1].trim(),
        remoteIf: iface[2].trim(),
        platform: plat ? plat[1].replace(/^cisco\s+/i, "").trim() : null,
        capabilities: caps ? caps[1].trim().split(/\s+/).map((w) => CAP_WORDS[w.toLowerCase()] ?? w) : [],
        ip: ip ? ip[1] : null,
      }
    }).filter((n): n is CdpNeighbor => !!n)
  }

  // Brief table. A long Device ID sits alone on its line with the rest wrapped below.
  const out: CdpNeighbor[] = []
  const start = lines.findIndex((l) => /^Device[- ]ID\s+Local\s+Intrfce/i.test(l.trim()))
  if (start < 0) return out
  let pendingId: string | null = null
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trimEnd()
    if (!line.trim() || /^Total cdp entries/i.test(line.trim()) || /^Capability Codes/i.test(line.trim())) continue
    const tokens = line.trim().split(/\s+/)
    if (!/^\s/.test(line) && tokens.length === 1) { pendingId = tokens[0]; continue }
    let rest = line.trim()
    let id: string
    if (/^\s/.test(line) && pendingId) { id = pendingId } else { id = tokens[0]; rest = rest.slice(id.length).trim() }
    pendingId = null
    const m = /^([A-Za-z][A-Za-z-]*\s?\d+(?:[/.:]\d+)*)\s+(\d+)\s+(.*)$/.exec(rest)
    if (!m) continue
    const tail = m[3]
    const port = /(?:^|\s)((?:[A-Za-z][A-Za-z-]*\s?\d+(?:[/.:]\d+)*)|Port\s+\d+)\s*$/.exec(tail)
    const middle = (port ? tail.slice(0, port.index) : tail).trim().split(/\s+/)
    const caps: string[] = []
    while (middle.length && /^[A-Za-z]$/.test(middle[0])) caps.push(middle.shift()!)
    out.push({
      deviceId: shortHostname(id),
      localIf: m[1].replace(/\s+/g, ""),
      // "Ten 1/0/10" -> "Ten1/0/10"; a phone's "Port 1" is not an interface name and stays as written.
      remoteIf: port ? (/^Port\s+\d+$/.test(port[1]) ? port[1] : port[1].replace(/^(\D+)\s+(?=\d)/, "$1")) : null,
      platform: middle.join(" ") || null,
      capabilities: caps,
      ip: null,
    })
  }
  return out
}

export function parseOspf(lines: string[]): OspfNeighbor[] {
  const out: OspfNeighbor[] = []
  for (const l of lines) {
    const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+\d+\s+([A-Z-]+(?:\/\s*[\w-]+)?)\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s*$/.exec(l)
    if (m) out.push({ routerId: m[1], state: m[2].replace(/\s+/g, ""), address: m[3], localIf: m[4] })
  }
  return out
}

const STATUS_WORDS = "connected|notconnec\\w*|disabled|err-disabled|sfpAbsent|xcvrAbsen\\w*|noOperMem\\w*|down|up|inactive|suspend\\w*|monitoring|linkFlapE\\w*|faulty|channelDo\\w*"

export function parseIfStatus(lines: string[]): IfStatus[] {
  const out: IfStatus[] = []
  const re = new RegExp(`^(\\S+)\\s+(.*?)\\s*\\b(${STATUS_WORDS})\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)(?:\\s+(.*))?$`)
  for (const l of lines) {
    const m = re.exec(l.trimEnd())
    if (!m || !looksLikeIf(m[1]) || /^port$/i.test(m[1])) continue
    out.push({ port: m[1], name: m[2].trim() || null, status: m[3], vlan: m[4], speed: m[6], type: m[7]?.trim() || null })
  }
  return out
}

export function parseIfDesc(lines: string[]): IfDescription[] {
  const out: IfDescription[] = []
  for (const l of lines) {
    const line = l.trimEnd()
    let m = /^(\S+)\s+(admin down|up|down|deleted)\s+(up|down|notpresent|dormant)\s*(.*)$/.exec(line)
    if (m && looksLikeIf(m[1])) { out.push({ port: m[1], status: m[2], protocol: m[3], description: m[4].trim() || null }); continue }
    m = /^(\S+)\s+(eth|po|mgmt|vlan|loopback|lo|tunnel|nve)\s+(\S+)\s*(.*)$/i.exec(line)
    if (m && looksLikeIf(m[1])) {
      const d = m[4].trim()
      out.push({ port: m[1], status: "unknown", protocol: "unknown", description: d && d !== "--" ? d : null })
    }
  }
  return out
}

export function parseTrunks(lines: string[]): Trunk[] {
  const by = new Map<string, Trunk>()
  const get = (port: string) => {
    const k = ifKey(port)
    if (!by.has(k)) by.set(k, { port, status: null, native: null, allowed: null, active: null })
    return by.get(k)!
  }
  let section: "status" | "allowed" | "active" | "other" = "other"
  for (const l of lines) {
    const t = l.trim()
    if (/^Port\s+/i.test(t)) {
      if (/allowed and active/i.test(t)) section = "active"
      else if (/allowed on trunk/i.test(t)) section = "allowed"
      else if (/forwarding|STP|err-disabled/i.test(t)) section = "other"
      else if (/Mode|Native|Status/i.test(t)) section = "status"
      continue
    }
    const tokens = t.split(/\s+/)
    if (!tokens[0] || !looksLikeIf(tokens[0])) continue
    const tr = get(tokens[0])
    if (section === "status") {
      tr.status = tokens.find((x) => /trunk|trnk|bndl|not-/i.test(x)) ?? tr.status
      tr.native = tokens.slice(1).find((x) => /^\d+$/.test(x)) ?? tr.native
    } else if (section === "allowed") tr.allowed = tokens.slice(1).join("") || "none"
    else if (section === "active") tr.active = tokens.slice(1).join("") || "none"
  }
  return [...by.values()]
}

export function parsePortChannels(lines: string[]): PortChannel[] {
  const out: PortChannel[] = []
  const member = /([A-Za-z][A-Za-z-]*\d+(?:[/.:]\d+)*)\((\w+)\)/g
  for (const l of lines) {
    const po = /\b((?:Po|Port-channel)\d+)\((\w+)\)/i.exec(l)
    if (po) {
      const after = l.slice(po.index + po[0].length)
      const proto = /\b(LACP|PAgP|NONE|-)\b/i.exec(after)
      const members = [...after.matchAll(member)].map((m) => ({ name: m[1], flag: m[2] }))
      out.push({ name: po[1], flags: po[2], protocol: proto && proto[1] !== "-" ? proto[1].toUpperCase() : null, members })
    } else if (out.length && /^\s+/.test(l)) {
      out[out.length - 1].members.push(...[...l.matchAll(member)].map((m) => ({ name: m[1], flag: m[2] })))
    }
  }
  return out
}

const IOS_CODE: Record<string, Route["protocol"]> = { C: "connected", L: "local", S: "static", O: "ospf", B: "bgp", D: "eigrp", R: "rip" }

export function parseRoutes(lines: string[]): Route[] {
  const out: Route[] = []
  let classfulPrefix: number | null = null
  let last: Route | null = null
  for (const raw of lines) {
    const l = raw.trimEnd()
    // NX-OS: "10.1.0.0/24, ubest/mbest: 1/0" then "    *via 10.1.255.1, Eth1/1, [110/41], 3d, ospf-1, intra"
    let m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+),\s+ubest/.exec(l)
    if (m) { last = { network: m[1], prefix: Number(m[2]), protocol: "other", nextHops: [] }; out.push(last); continue }
    m = /^\s+\*via\s+([^,\s]+),?(.*)$/.exec(l)
    if (m && last) {
      const parts = m[2].split(",").map((x) => x.trim())
      const iface = parts.find((x) => looksLikeIf(x)) ?? null
      const proto = parts.find((x) => /^(direct|local|static|ospf|bgp|eigrp|rip|hsrp|vrrp|am|isis)/i.test(x))?.toLowerCase() ?? ""
      if (last.protocol === "other") {
        last.protocol = proto.startsWith("direct") ? "connected" : proto.startsWith("local") || proto.startsWith("hsrp") ? "local"
          : proto.startsWith("static") ? "static" : proto.startsWith("ospf") ? "ospf" : proto.startsWith("bgp") ? "bgp"
          : proto.startsWith("eigrp") ? "eigrp" : proto.startsWith("rip") ? "rip" : "other"
      }
      last.nextHops.push({ ip: isIpv4(m[1]) ? m[1] : null, iface })
      continue
    }
    // IOS
    m = /^\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)\s+is\s+subnetted/.exec(l)
    if (m) { classfulPrefix = Number(m[2]); continue }
    if (/is variably subnetted/.test(l)) { classfulPrefix = null; continue }
    // The code column: "C", "S*", "O IA", "O E2", and "O*E2" with no space at all.
    m = /^([A-Za-z]{1,2}\*?(?:\s?(?:IA|E1|E2|N1|N2|L1|L2|EX|ia))?\*?)\s+(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?\s+(.*)$/.exec(l)
    if (m) {
      const code = m[1].replace(/[*\s].*$/, "").toUpperCase()
      const prefix = m[3] ? Number(m[3]) : classfulPrefix
      if (prefix === null) continue
      last = { network: m[2], prefix, protocol: IOS_CODE[code[0]] ?? (code === "IA" ? "ospf" : "other"), nextHops: [] }
      const rest = m[4]
      const conn = /is directly connected,\s*(\S+)/.exec(rest)
      if (conn) last.nextHops.push({ ip: null, iface: conn[1] })
      const via = /via\s+(\d+\.\d+\.\d+\.\d+)(?:,.*?,\s*(\S+))?/.exec(rest)
      if (via) last.nextHops.push({ ip: via[1], iface: via[2] && looksLikeIf(via[2]) ? via[2] : null })
      out.push(last)
      continue
    }
    m = /^\s+\[\d+\/\d+\]\s+via\s+(\d+\.\d+\.\d+\.\d+)(?:,.*?,\s*(\S+))?/.exec(l)
    if (m && last) last.nextHops.push({ ip: m[1], iface: m[2] && looksLikeIf(m[2]) ? m[2] : null })
  }
  return out
}

// ---------------------------------------------------------------------------

/**
 * Everything one device's log says. When there is no running-config, the
 * interface list is built from show int status / description / trunk so the
 * rest of the app (subnets, diagram, interface table) still has something.
 */
export function parseDeviceText(text: string): DeviceData {
  const { prompts, sections } = splitSections(text)
  const of = (k: CommandKey) => sections.filter((s) => s.key === k)
  const hasSections = sections.length > 0
  const runLines = of("run").flatMap((s) => s.lines)
  // A file with no recognisable command in it is taken to be a bare running-config.
  const config = parseConfig(hasSections ? runLines.join("\n") : text)

  const data: DeviceData = {
    hostname: config.hostname ?? mostCommon(prompts),
    commands: hasSections ? [...new Set(sections.map((s) => s.key))] : config.interfaces.length ? ["run"] : [],
    config,
    cdp: of("cdp").flatMap((s) => parseCdp(s.lines, s.detail)),
    ospf: of("ospf").flatMap((s) => parseOspf(s.lines)),
    ifStatus: of("ifStatus").flatMap((s) => parseIfStatus(s.lines)),
    ifDesc: of("ifDesc").flatMap((s) => parseIfDesc(s.lines)),
    trunks: of("trunk").flatMap((s) => parseTrunks(s.lines)),
    portChannels: of("portChannel").flatMap((s) => parsePortChannels(s.lines)),
    routes: of("route").flatMap((s) => parseRoutes(s.lines)),
  }
  if (!config.hostname && data.hostname) config.hostname = data.hostname
  fillInterfaces(data)
  return data
}

function mostCommon(xs: string[]): string | null {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function fillInterfaces(d: DeviceData) {
  const ifs = d.config.interfaces
  const find = (name: string) => ifs.find((i) => sameIf(i.name, name))
  const ensure = (name: string): ParsedInterface => {
    let i = find(name)
    if (!i) {
      i = { name, description: null, ip: null, prefix: null, mode: null, accessVlan: null, trunkVlans: null, shutdown: false, channelGroup: null }
      ifs.push(i)
    }
    return i
  }
  for (const s of d.ifDesc) {
    const i = ensure(s.port)
    i.description ??= s.description
    if (s.status === "admin down") i.shutdown = true
  }
  for (const s of d.ifStatus) {
    const i = ensure(s.port)
    i.description ??= s.name
    if (s.status === "disabled") i.shutdown = true
    if (s.vlan === "trunk") i.mode ??= "trunk"
    else if (s.vlan === "routed") i.mode ??= "routed"
    else if (s.vlan && /^\d+$/.test(s.vlan)) { i.mode ??= "access"; i.accessVlan ??= Number(s.vlan) }
  }
  for (const t of d.trunks) {
    const i = ensure(t.port)
    i.mode = "trunk"
    i.trunkVlans ??= t.allowed
  }
  d.portChannels.forEach((pc) => {
    const num = Number(/\d+/.exec(pc.name)?.[0])
    ensure(pc.name.replace(/^Po(?=\d)/i, "Port-channel"))
    for (const m of pc.members) ensure(m.name).channelGroup ??= num
  })
}

/** Whether a port is known to be down from show int status / description (not from config). */
export function portIsDown(d: DeviceData, name: string): boolean {
  const st = d.ifStatus.find((s) => sameIf(s.port, name))
  if (st) return !/^(connected|up|monitoring)$/i.test(st.status)
  const de = d.ifDesc.find((s) => sameIf(s.port, name))
  if (de && de.status !== "unknown") return de.status !== "up" || de.protocol !== "up"
  return false
}
