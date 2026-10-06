/**
 * SSRF enforcement (SPEC.md §8).
 *
 * "Resolve DNS first; reject 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
 * ::1, fc00::/7; re-validate on every redirect hop."
 *
 * Two rules decide the design:
 *
 *   1. Validation is on RESOLVED ADDRESSES, never on the hostname string. That
 *      is what makes decimal, octal and hex IP literals, "localhost." with a
 *      trailing dot, and any hostname an attacker controls fall out for free —
 *      whatever notation reaches us, the kernel resolver tells us where it
 *      actually points, and that is what gets judged.
 *
 *   2. If ANY address in a multi-address answer is blocked, the whole fetch is
 *      refused. Picking the "good" one would leave the choice to whichever
 *      address the connect happened to try first, which is the attacker's
 *      choice, not ours.
 */
import { isIP } from 'node:net';

/** Where a blocked range comes from, so the two can be told apart. */
export type RangeSource = 'spec' | 'same-class';

export interface BlockedRange {
  readonly cidr: string;
  readonly why: string;
  readonly source: RangeSource;
}

/**
 * The §8 list, plus ranges of exactly the same class as something §8 already
 * names. Each addition is marked, and tests assert the §8 entries separately
 * from the rest, so the frozen policy stays visible inside the stricter one.
 */
export const BLOCKED_IPV4: readonly BlockedRange[] = [
  { cidr: '10.0.0.0/8', why: 'RFC1918 private', source: 'spec' },
  { cidr: '172.16.0.0/12', why: 'RFC1918 private', source: 'spec' },
  { cidr: '192.168.0.0/16', why: 'RFC1918 private', source: 'spec' },
  { cidr: '127.0.0.0/8', why: 'loopback', source: 'spec' },
  {
    cidr: '169.254.0.0/16',
    why: 'link-local, and the cloud metadata service at 169.254.169.254',
    source: 'spec',
  },
  // §23 names 0.0.0.0 in the SSRF suite, which lives in this range.
  { cidr: '0.0.0.0/8', why: 'unspecified / "this host"', source: 'spec' },
  { cidr: '100.64.0.0/10', why: 'carrier NAT: not public, same class as RFC1918', source: 'same-class' },
  { cidr: '192.0.0.0/24', why: 'IETF protocol assignments', source: 'same-class' },
  { cidr: '198.18.0.0/15', why: 'benchmarking', source: 'same-class' },
  { cidr: '224.0.0.0/4', why: 'multicast', source: 'same-class' },
  { cidr: '240.0.0.0/4', why: 'reserved', source: 'same-class' },
  { cidr: '255.255.255.255/32', why: 'broadcast', source: 'same-class' },
];

export const BLOCKED_IPV6: readonly BlockedRange[] = [
  { cidr: '::1/128', why: 'loopback', source: 'spec' },
  { cidr: 'fc00::/7', why: 'unique local address', source: 'spec' },
  { cidr: '::/128', why: 'unspecified', source: 'same-class' },
  // §8 lists 169.254/16 for IPv4 but no v6 equivalent. fe80::/10 is the same
  // thing one protocol over, so it is blocked and marked as an addition.
  { cidr: 'fe80::/10', why: 'link-local, the v6 counterpart of 169.254/16', source: 'same-class' },
  { cidr: 'ff00::/8', why: 'multicast', source: 'same-class' },
];

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Expands any valid textual IPv6 to its 16 bytes. */
function ipv6ToBytes(address: string): Uint8Array | undefined {
  let text = address;

  // A zone index (fe80::1%eth0) is not part of the address.
  const zone = text.indexOf('%');
  if (zone !== -1) {
    text = text.slice(0, zone);
  }

  // A trailing IPv4 part, as in ::ffff:127.0.0.1, becomes two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const asInt = ipv4ToInt(tail);
    if (asInt === undefined) {
      return undefined;
    }
    const high = (asInt >>> 16).toString(16);
    const low = (asInt & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }

  const parse = (part: string): number[] | undefined => {
    if (part === '') {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        return undefined;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === undefined || rest === undefined) {
    return undefined;
  }

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) {
      return undefined;
    }
    groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) {
    return undefined;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >>> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function ipv4InCidr(value: number, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/') as [string, string];
  const base = ipv4ToInt(network);
  if (base === undefined) {
    return false;
  }
  const bits = Number(bitsText);
  if (bits === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function ipv6InCidr(bytes: Uint8Array, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/') as [string, string];
  const base = ipv6ToBytes(network);
  if (base === undefined) {
    return false;
  }
  let bits = Number(bitsText);
  for (let index = 0; index < 16 && bits > 0; index += 1) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) {
      return false;
    }
    bits -= take;
  }
  return true;
}

export interface AddressVerdict {
  readonly allowed: boolean;
  /** Present when blocked: the range that matched and why. */
  readonly reason?: string;
}

const ALLOWED: AddressVerdict = { allowed: true };

/**
 * Judges one literal IP address.
 *
 * An IPv4-mapped or NAT64-embedded address is unwrapped and its IPv4 judged on
 * its own terms: ::ffff:127.0.0.1 is loopback however it is spelled.
 */
export function classifyAddress(address: string): AddressVerdict {
  const kind = isIP(address);

  if (kind === 4) {
    const value = ipv4ToInt(address);
    if (value === undefined) {
      return { allowed: false, reason: `unparseable IPv4 address "${address}"` };
    }
    for (const range of BLOCKED_IPV4) {
      if (ipv4InCidr(value, range.cidr)) {
        return { allowed: false, reason: `${address} is in ${range.cidr} (${range.why})` };
      }
    }
    return ALLOWED;
  }

  if (kind === 6) {
    const bytes = ipv6ToBytes(address);
    if (bytes === undefined) {
      return { allowed: false, reason: `unparseable IPv6 address "${address}"` };
    }

    // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64) carry an IPv4
    // address in their last four bytes. Judge that address, not the wrapper.
    const isMapped = ipv6InCidr(bytes, '::ffff:0:0/96');
    const isNat64 = ipv6InCidr(bytes, '64:ff9b::/96');
    if (isMapped || isNat64) {
      const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      const verdict = classifyAddress(embedded);
      if (!verdict.allowed) {
        return {
          allowed: false,
          reason: `${address} embeds ${embedded}: ${verdict.reason ?? 'blocked'}`,
        };
      }
      return ALLOWED;
    }

    for (const range of BLOCKED_IPV6) {
      if (ipv6InCidr(bytes, range.cidr)) {
        return { allowed: false, reason: `${address} is in ${range.cidr} (${range.why})` };
      }
    }
    return ALLOWED;
  }

  return { allowed: false, reason: `"${address}" is not an IP address` };
}
