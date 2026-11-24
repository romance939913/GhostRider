/**
 * Accessible names, normalized for icon fonts.
 *
 * Icon fonts (Font Awesome and friends) put Unicode Private Use Area
 * characters into an element's text, so a sign-in button's accessible name
 * can be "\uf090 Login". The model can't reliably reproduce those
 * characters, and they carry no meaning for a human. So:
 * - observe() strips them from names in the snapshot (the model sees "Login")
 * - execute() matches names exactly, except it ignores icon glyphs and
 *   surrounding whitespace.
 * The M2 compiler must use the same matcher so replays find the same element.
 */

const PRIVATE_USE = /[\uE000-\uF8FF]/g;
// A /g regex keeps lastIndex between .test() calls; use a separate one.
const HAS_PRIVATE_USE = /[\uE000-\uF8FF]/;
const ICON_OR_SPACE = "[\\s\\uE000-\\uF8FF]*";

/** "\uf090  Login" → "Login". */
export function cleanAccessibleName(name: string): string {
  return name.replace(PRIVATE_USE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Matches an accessible name exactly (case-sensitive, whole string), except
 * for icon glyphs and whitespace. "" matches only unnamed elements.
 */
export function accessibleNameMatcher(name: string): RegExp {
  const words = cleanAccessibleName(name)
    .split(" ")
    .filter((word) => word.length > 0)
    .map(escapeRegExp);
  return new RegExp(`^${ICON_OR_SPACE}${words.join("\\s+")}${ICON_OR_SPACE}$`);
}

/** Cleans every `role "name"` in an ARIA snapshot. Other text is untouched. */
export function cleanSnapshotNames(snapshot: string): string {
  return snapshot.replace(
    /^(\s*- [a-z]+ )"((?:[^"\\]|\\.)*)"/gm,
    (line, prefix: string, name: string) =>
      HAS_PRIVATE_USE.test(name)
        ? `${prefix}"${cleanAccessibleName(name)}"`
        : line,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
