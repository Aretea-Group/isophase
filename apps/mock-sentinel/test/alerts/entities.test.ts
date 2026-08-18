import { describe, expect, test } from "bun:test";

import { EntityBag, decodeEntities, encodeEntities } from "../../src/alerts/entities.ts";

describe("EntityBag", () => {
  test("allocates sequential ids and links siblings by $ref", () => {
    const bag = new EntityBag();
    const host = bag.host({ hostName: "win11a" });
    bag.account({ name: "mirage", ntDomain: "PKWORK", host });

    expect(bag.toArray()).toEqual([
      { $id: "1", type: "host", hostName: "win11a" },
      { $id: "2", type: "account", name: "mirage", ntDomain: "PKWORK", host: { $ref: "1" } },
    ]);
  });

  test("de-duplicates identical entities", () => {
    const bag = new EntityBag();
    bag.host({ hostName: "win11a" });
    bag.host({ hostName: "win11a" });

    expect(bag.size).toBe(1);
  });

  /**
   * Real Sentinel behaviour: an Account identified only by a generic built-in
   * name is dropped from its alert, because the value distinguishes nothing.
   * The headline scenario targets `\ADMINISTRATOR`, so a regression here would
   * silently empty that alert's entity list.
   */
  test("drops a generic account name with no qualifier", () => {
    const bag = new EntityBag();

    expect(bag.account({ name: "ADMINISTRATOR" })).toBeUndefined();
    expect(bag.account({ name: "system" })).toBeUndefined();
    expect(bag.account({ name: "Local System" })).toBeUndefined();
    expect(bag.size).toBe(0);
  });

  test("keeps a generic account name once it is qualified", () => {
    const withHost = new EntityBag();
    const host = withHost.host({ hostName: "SOC-FW-RDP" });
    expect(withHost.account({ name: "ADMINISTRATOR", host })).toBeDefined();

    const withDomain = new EntityBag();
    expect(withDomain.account({ name: "ADMINISTRATOR", ntDomain: "PKWORK" })).toBeDefined();
  });

  test("keeps ordinary account names unqualified", () => {
    const bag = new EntityBag();

    expect(bag.account({ name: "mirage" })).toBeDefined();
  });
});

describe("entity encoding", () => {
  test("writes the exact casing Sentinel uses, including initialisms", () => {
    const encoded = encodeEntities([
      { $id: "1", type: "host", hostName: "h", ntDomain: "D", osFamily: "Windows" },
      { $id: "2", type: "account", name: "u", upnSuffix: "contoso.com" },
    ]);

    // A naive capitalise-first-letter rule would produce NtDomain / OsFamily /
    // UpnSuffix, none of which Sentinel uses.
    expect(encoded).toContain('"NTDomain"');
    expect(encoded).toContain('"OSFamily"');
    expect(encoded).toContain('"UPNSuffix"');
    expect(encoded).toContain('"HostName"');
  });

  test("round-trips through the table representation", () => {
    const entities = [
      { $id: "1", type: "host" as const, hostName: "win11a" },
      { $id: "2", type: "ip" as const, address: "198.51.100.42" },
      { $id: "3", type: "filehash" as const, algorithm: "SHA256" as const, value: "abc" },
    ];

    expect(decodeEntities(encodeEntities(entities))).toEqual(entities);
  });

  test("returns an empty list for empty or malformed input", () => {
    expect(decodeEntities("")).toEqual([]);
    expect(decodeEntities("   ")).toEqual([]);
    expect(decodeEntities("{not json")).toEqual([]);
    expect(decodeEntities('{"not":"an array"}')).toEqual([]);
  });
});
