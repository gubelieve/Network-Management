import { describe, expect, it } from "vitest"
import {
  ifKey, parseCdp, parseDeviceText, parseIfDesc, parseIfStatus, parseOspf, parsePortChannels, parseRoutes, parseTrunks, splitSections,
} from "@/lib/show-parser"

const lines = (s: string) => s.replace(/^\n/, "").split("\n")

describe("splitSections", () => {
  it("finds each command by its prompt, abbreviated or not, and by bare show lines", () => {
    const { sections, prompts } = splitSections("SW1#sh run\nhostname SW1\nSW1#show cdp nei det\nDevice ID: X\n===== show ip ospf neighbor =====\n\nSW1#sh ip ro\n")
    expect(sections.map((s) => [s.key, s.detail])).toEqual([["run", false], ["cdp", true], ["ospf", false], ["route", false]])
    expect(prompts).toContain("SW1")
  })

  it("ignores commands it does not know", () => {
    expect(splitSections("SW1#show version\nCisco IOS\nSW1#show clock\n").sections).toEqual([])
  })
})

describe("interface names", () => {
  it("normalises every spelling", () => {
    expect(ifKey("Gig 1/0/1")).toBe(ifKey("GigabitEthernet1/0/1"))
    expect(ifKey("Ten 1/0/1")).toBe(ifKey("Te1/0/1"))
    expect(ifKey("Eth1/1")).toBe(ifKey("Ethernet1/1"))
    expect(ifKey("Po1")).toBe(ifKey("Port-channel1"))
  })
})

describe("show cdp neighbors", () => {
  it("IOS brief, including a long Device ID wrapped onto the next line", () => {
    const n = parseCdp(lines(`
Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID
HQ-CORE-01.lab.local
                 Gig 1/0/49        151             R S I  C9500-24Y Ten 1/0/10
SEP001122334455  Gig 1/0/2         170              H P M IP Phone  Port 1
`), false)
    expect(n).toEqual([
      { deviceId: "HQ-CORE-01", localIf: "Gig1/0/49", remoteIf: "Ten1/0/10", platform: "C9500-24Y", capabilities: ["R", "S", "I"], ip: null },
      { deviceId: "SEP001122334455", localIf: "Gig1/0/2", remoteIf: "Port 1", platform: "IP Phone", capabilities: ["H", "P", "M"], ip: null },
    ])
  })

  it("NX-OS brief with the serial in the Device ID", () => {
    const n = parseCdp(lines(`
Device-ID          Local Intrfce  Hldtme Capability  Platform      Port ID
DC-LEAF-2(FDO21340AAA)
                    Eth1/49        171    R S I s   N9K-C93180YC- Eth1/49
`), false)
    expect(n[0]).toMatchObject({ deviceId: "DC-LEAF-2", localIf: "Eth1/49", remoteIf: "Eth1/49", platform: "N9K-C93180YC-" })
  })

  it("detail, IOS and NX-OS wording", () => {
    const n = parseCdp(lines(`
-------------------------
Device ID: HQ-CORE-01.lab.local
Entry address(es):
  IP address: 10.1.0.2
Platform: cisco C9500-24Y4C,  Capabilities: Router Switch IGMP
Interface: GigabitEthernet1/0/49,  Port ID (outgoing port): GigabitEthernet1/0/10
----------------------------------------
Device ID:DC-SPINE-1(FDO1)
    IPv4 Address: 10.9.0.1
Platform: N9K-C9336C-FX2, Capabilities: Router Switch IGMP Filtering Supports-STP-Dispute
Interface: Ethernet1/50, Port ID (outgoing port): Ethernet1/1
`), true)
    expect(n).toEqual([
      { deviceId: "HQ-CORE-01", localIf: "GigabitEthernet1/0/49", remoteIf: "GigabitEthernet1/0/10", platform: "C9500-24Y4C", capabilities: ["R", "S", "I"], ip: "10.1.0.2" },
      expect.objectContaining({ deviceId: "DC-SPINE-1", localIf: "Ethernet1/50", remoteIf: "Ethernet1/1", ip: "10.9.0.1" }),
    ])
  })
})

describe("show interfaces status / description", () => {
  it("status keeps names with spaces and reads the state", () => {
    const s = parseIfStatus(lines(`
Port         Name               Status       Vlan       Duplex  Speed Type
Gi1/0/3      TO HQ-ACC-02 Gi1/0 notconnect   trunk        auto   auto 10/100/1000BaseTX
Gi1/0/5                         connected    10         a-full a-1000 10/100/1000BaseTX
Eth1/1        --                 connected trunk     full    10G     10Gbase-SR
`))
    expect(s.map((x) => [x.port, x.name, x.status, x.vlan])).toEqual([
      ["Gi1/0/3", "TO HQ-ACC-02 Gi1/0", "notconnect", "trunk"],
      ["Gi1/0/5", null, "connected", "10"],
      ["Eth1/1", "--", "connected", "trunk"],
    ])
  })

  it("description, IOS and NX-OS", () => {
    const d = parseIfDesc(lines(`
Interface                      Status         Protocol Description
Gi0/0/3                        admin down     down
Gi0/0/1                        up             up       TO HQ-CORE-01 Te1/0/1
Eth1/1        eth    10G     TO CORE-2
Eth1/2        eth    10G     --
`))
    expect(d.map((x) => [x.port, x.status, x.description])).toEqual([
      ["Gi0/0/3", "admin down", null], ["Gi0/0/1", "up", "TO HQ-CORE-01 Te1/0/1"], ["Eth1/1", "unknown", "TO CORE-2"], ["Eth1/2", "unknown", null],
    ])
  })
})

describe("show interfaces trunk", () => {
  it("joins the sections per port (IOS and NX-OS headers)", () => {
    const t = parseTrunks(lines(`
Port        Mode             Encapsulation  Status        Native vlan
Gi1/0/49    on               802.1q         trunking      1

Port        Vlans allowed on trunk
Gi1/0/49    10,20,30

Port          Native  Status        Port
              Vlan                  Channel
Eth1/1        1       trnk-bndl     Po1

Port          Vlans Allowed on Trunk
Eth1/1        1-4094
`))
    expect(t).toEqual([
      { port: "Gi1/0/49", status: "trunking", native: "1", allowed: "10,20,30", active: null },
      { port: "Eth1/1", status: "trnk-bndl", native: "1", allowed: "1-4094", active: null },
    ])
  })
})

describe("show port-channel / etherchannel summary", () => {
  it("reads members, including continuation lines", () => {
    const p = parsePortChannels(lines(`
1      Po1(SU)         LACP      Te1/0/23(P)     Te1/0/24(P)
10    Po10(SU)    Eth      LACP      Eth1/1(P)    Eth1/2(P)
                                     Eth1/3(D)
`))
    expect(p).toEqual([
      { name: "Po1", flags: "SU", protocol: "LACP", members: [{ name: "Te1/0/23", flag: "P" }, { name: "Te1/0/24", flag: "P" }] },
      { name: "Po10", flags: "SU", protocol: "LACP", members: [{ name: "Eth1/1", flag: "P" }, { name: "Eth1/2", flag: "P" }, { name: "Eth1/3", flag: "D" }] },
    ])
  })
})

describe("show ip route", () => {
  it("IOS: default, connected, OSPF with a second next hop, classful 'is subnetted'", () => {
    const r = parseRoutes(lines(`
S*    0.0.0.0/0 [1/0] via 203.0.113.1
      10.0.0.0/8 is variably subnetted, 6 subnets, 3 masks
C        10.1.255.0/30 is directly connected, GigabitEthernet0/0/1
O        10.1.0.0/24 [110/2] via 10.1.255.2, 01:10:11, GigabitEthernet0/0/1
                     [110/2] via 10.1.255.6, 01:10:11, GigabitEthernet0/0/2
      172.16.0.0/24 is subnetted, 1 subnets
O IA     172.16.5.0 [110/3] via 10.1.255.2, 00:01:00, GigabitEthernet0/0/1
`))
    expect(r).toEqual([
      { network: "0.0.0.0", prefix: 0, protocol: "static", nextHops: [{ ip: "203.0.113.1", iface: null }] },
      { network: "10.1.255.0", prefix: 30, protocol: "connected", nextHops: [{ ip: null, iface: "GigabitEthernet0/0/1" }] },
      { network: "10.1.0.0", prefix: 24, protocol: "ospf", nextHops: [{ ip: "10.1.255.2", iface: "GigabitEthernet0/0/1" }, { ip: "10.1.255.6", iface: "GigabitEthernet0/0/2" }] },
      { network: "172.16.5.0", prefix: 24, protocol: "ospf", nextHops: [{ ip: "10.1.255.2", iface: "GigabitEthernet0/0/1" }] },
    ])
  })

  it("an OSPF external default route written 'O*E2' with no space", () => {
    const r = parseRoutes(lines(`
O*E2  0.0.0.0/0 [110/1] via 10.1.255.1, 01:10:02, TenGigabitEthernet1/0/1
`))
    expect(r).toEqual([{ network: "0.0.0.0", prefix: 0, protocol: "ospf", nextHops: [{ ip: "10.1.255.1", iface: "TenGigabitEthernet1/0/1" }] }])
  })

  it("NX-OS", () => {
    const r = parseRoutes(lines(`
0.0.0.0/0, ubest/mbest: 1/0
    *via 10.9.255.1, Eth1/49, [110/41], 3d01h, ospf-1, type-2
10.9.10.0/24, ubest/mbest: 1/0, attached
    *via 10.9.10.2, Vlan10, [0/0], 3d01h, direct
`))
    expect(r).toEqual([
      { network: "0.0.0.0", prefix: 0, protocol: "ospf", nextHops: [{ ip: "10.9.255.1", iface: "Eth1/49" }] },
      { network: "10.9.10.0", prefix: 24, protocol: "connected", nextHops: [{ ip: "10.9.10.2", iface: "Vlan10" }] },
    ])
  })
})

describe("show ip ospf neighbor", () => {
  it("IOS and NX-OS", () => {
    const o = parseOspf(lines(`
Neighbor ID     Pri   State           Dead Time   Address         Interface
10.1.254.11       1   FULL/BDR        00:00:35    10.1.255.2      GigabitEthernet0/0/1
 Neighbor ID     Pri State            Up Time  Address         Interface
 10.9.254.1        1 FULL/ -          3d01h    10.9.255.1      Eth1/49
`))
    expect(o).toEqual([
      { routerId: "10.1.254.11", state: "FULL/BDR", address: "10.1.255.2", localIf: "GigabitEthernet0/0/1" },
      { routerId: "10.9.254.1", state: "FULL/-", address: "10.9.255.1", localIf: "Eth1/49" },
    ])
  })
})

describe("parseDeviceText", () => {
  it("takes the hostname from the prompt and builds interfaces when there is no running-config", () => {
    const d = parseDeviceText("SW9#show interfaces status\nPort Name Status Vlan Duplex Speed Type\nGi1/0/1  UPLINK  connected  trunk  full  1000  SFP\nSW9#show cdp neighbors\nDevice ID        Local Intrfce     Holdtme    Capability  Platform  Port ID\nCORE-1           Gig 1/0/1         150             R S I  C9500     Ten 1/0/9\n")
    expect(d.hostname).toBe("SW9")
    expect(d.commands).toEqual(["ifStatus", "cdp"])
    expect(d.config.interfaces[0]).toMatchObject({ name: "Gi1/0/1", description: "UPLINK", mode: "trunk" })
    expect(d.cdp[0]).toMatchObject({ deviceId: "CORE-1", remoteIf: "Ten1/0/9" })
  })

  it("still reads a bare running-config with no prompts", () => {
    const d = parseDeviceText("hostname R1\ninterface Gi0/0\n ip address 10.0.0.1 255.255.255.252\n")
    expect(d.hostname).toBe("R1")
    expect(d.commands).toEqual(["run"])
  })
})
