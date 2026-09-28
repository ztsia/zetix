/**
 * Proposes a wide sheet's seat groups from its headers (spec/v3.md §25.7):
 * numbered name columns — "Guest 1 Name", "Guest 2 Name" — each paired with
 * the email column of the same number and pattern, if there is one.
 *
 * A proposal only: the mapping step shows every group, each can be turned
 * off, and the staging grid shows every row they produce before commit.
 */
export type DetectedSeatGroup = { name: string; email: string | null };

const NUMBERED = /^(.*?)(\d+)(.*)$/;

export function detectSeatGroups(headers: readonly string[]): DetectedSeatGroup[] {
  const families = new Map<string, { number: number; header: string }[]>();
  for (const header of headers) {
    const match = NUMBERED.exec(header);
    if (!match) continue;
    const key = `${match[1].trim().toLowerCase()}#${match[3].trim().toLowerCase()}`;
    families.set(key, [...(families.get(key) ?? []), { number: Number(match[2]), header }]);
  }
  const isName = (key: string) => /name/.test(key) && !/e-?mail/.test(key);
  const isEmail = (key: string) => /e-?mail/.test(key);
  const nameFamily = [...families.entries()].find(([key, members]) => isName(key) && members.length >= 2);
  if (!nameFamily) return [];
  const [nameKey, names] = nameFamily;
  const prefix = nameKey.split('#')[0];
  const emailFamily = [...families.entries()].find(([key]) => isEmail(key) && key.split('#')[0] === prefix);
  return names
    .sort((a, b) => a.number - b.number)
    .map((member) => ({
      name: member.header,
      email: emailFamily?.[1].find((e) => e.number === member.number)?.header ?? null,
    }));
}
