export type AddressableCoordinate = {
  kind: number;
  owner: string;
  dtag: string;
};

const HEX64_RE = /^[a-fA-F0-9]{64}$/;

/**
 * Split an addressable coordinate (`<kind>:<owner>:<d>`). Only the first two
 * separators are structural because d-tags may contain colons.
 */
export function parseAddressableCoordinate(
  address: string | null | undefined,
): AddressableCoordinate | null {
  if (!address) return null;

  const kindEnd = address.indexOf(":");
  if (kindEnd < 1) return null;
  const ownerEnd = address.indexOf(":", kindEnd + 1);
  if (ownerEnd < 0) return null;

  const kind = Number(address.slice(0, kindEnd));
  const owner = address.slice(kindEnd + 1, ownerEnd);
  const dtag = address.slice(ownerEnd + 1);
  if (!Number.isInteger(kind) || !HEX64_RE.test(owner) || dtag.length === 0) {
    return null;
  }

  return { kind, owner: owner.toLowerCase(), dtag };
}
