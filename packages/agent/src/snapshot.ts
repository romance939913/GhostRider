/**
 * Shrinks a Playwright ARIA snapshot to fit a character budget, without ever
 * dropping an element the agent could act on (until the last-resort pass).
 */

export const DEFAULT_SNAPSHOT_BUDGET_CHARS = 12_000;

/** Roles the agent can act on. These are never removed before the last pass. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "option",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

/** Leaf roles that are just content: dropped once the page is over budget. */
const CONTENT_LEAF_ROLES = new Set([
  "text",
  "paragraph",
  "img",
  "time",
  "status",
  "blockquote",
  "strong",
  "emphasis",
]);

/** Wrapper roles with no meaning of their own when unnamed: replaced by their children. */
const STRUCTURAL_ROLES = new Set([
  "list",
  "listitem",
  "group",
  "generic",
  "figure",
  "paragraph",
  "strong",
  "emphasis",
  "blockquote",
  "region",
  "article",
  "section",
]);

const MAX_VALUE_CHARS = 80;
const INDENT = "  ";

export interface CompactOptions {
  budgetChars?: number;
}

export interface CompactResult {
  snapshot: string;
  /** True when anything was removed or shortened. */
  truncated: boolean;
}

interface SnapshotNode {
  /** The line without indentation, "- " prefix or trailing ":", e.g. `button "Login"`. */
  head: string;
  children: SnapshotNode[];
}

export function compactSnapshot(
  raw: string,
  options: CompactOptions = {},
): CompactResult {
  const budget = options.budgetChars ?? DEFAULT_SNAPSHOT_BUDGET_CHARS;
  if (raw.length <= budget) return { snapshot: raw, truncated: false };

  let nodes = parse(raw);
  const passes: Array<(nodes: SnapshotNode[]) => SnapshotNode[]> = [
    removeUrls,
    shortenValues,
    removeContentLeaves,
    unwrapStructural,
  ];
  for (const pass of passes) {
    nodes = pass(nodes);
    const snapshot = serialize(nodes);
    if (snapshot.length <= budget) return { snapshot, truncated: true };
  }

  return { snapshot: keepInteractiveOnly(nodes, budget), truncated: true };
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/** Pass 1: link targets. The agent clicks links by name, not by URL. */
function removeUrls(nodes: SnapshotNode[]): SnapshotNode[] {
  return mapTree(nodes, (node) =>
    node.head.startsWith("/url:") ? [] : [node],
  );
}

/** Pass 2: long inline text, e.g. `paragraph: <a whole paragraph>`. Names are never shortened. */
function shortenValues(nodes: SnapshotNode[]): SnapshotNode[] {
  return mapTree(nodes, (node) => {
    const split = splitValue(node.head);
    if (!split || split.value.length <= MAX_VALUE_CHARS) return [node];
    return [{ ...node, head: `${split.key}: ${truncateValue(split.value)}` }];
  });
}

/** Pass 3: content-only leaves (text, paragraphs, images). Headings stay as landmarks. */
function removeContentLeaves(nodes: SnapshotNode[]): SnapshotNode[] {
  return mapTree(nodes, (node) =>
    node.children.length === 0 && CONTENT_LEAF_ROLES.has(roleOf(node.head))
      ? []
      : [node],
  );
}

/** Pass 4: unnamed wrappers (list, listitem, group, ...) are replaced by their children. */
function unwrapStructural(nodes: SnapshotNode[]): SnapshotNode[] {
  return mapTree(nodes, (node) => {
    if (
      !STRUCTURAL_ROLES.has(roleOf(node.head)) ||
      nameOf(node.head) !== undefined
    )
      return [node];
    return node.children;
  });
}

/** Last resort: a flat list of interactive elements and headings, cut at the budget. */
function keepInteractiveOnly(nodes: SnapshotNode[], budget: number): string {
  const lines: string[] = [];
  const walk = (list: SnapshotNode[]) => {
    for (const node of list) {
      const role = roleOf(node.head);
      if (INTERACTIVE_ROLES.has(role) || role === "heading")
        lines.push(`- ${node.head}`);
      walk(node.children);
    }
  };
  walk(nodes);

  const marker = "- text: … (snapshot cut to fit the budget)";
  const kept: string[] = [];
  let length = marker.length;
  for (const line of lines) {
    if (length + line.length + 1 > budget) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, marker].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parse(raw: string): SnapshotNode[] {
  const root: SnapshotNode = { head: "", children: [] };
  const stack: Array<{ indent: number; node: SnapshotNode }> = [
    { indent: -1, node: root },
  ];

  for (const line of raw.split("\n")) {
    const match = /^( *)- (.*)$/.exec(line);
    if (!match) continue;
    const indent = (match[1] ?? "").length;
    const node: SnapshotNode = { head: match[2] ?? "", children: [] };

    while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    stack.at(-1)?.node.children.push(node);
    stack.push({ indent, node });
  }

  // A line ending in ":" introduced children; the ":" is re-added on serialize.
  const stripColons = (list: SnapshotNode[]) => {
    for (const node of list) {
      if (node.children.length > 0 && node.head.endsWith(":"))
        node.head = node.head.slice(0, -1);
      stripColons(node.children);
    }
  };
  stripColons(root.children);
  return root.children;
}

function serialize(nodes: SnapshotNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(
      `${INDENT.repeat(depth)}- ${node.head}${node.children.length > 0 ? ":" : ""}`,
    );
    if (node.children.length > 0)
      lines.push(serialize(node.children, depth + 1));
  }
  return lines.join("\n");
}

/** Applies `fn` bottom-up: children first, so a node sees its already-transformed children. */
function mapTree(
  nodes: SnapshotNode[],
  fn: (node: SnapshotNode) => SnapshotNode[],
): SnapshotNode[] {
  return nodes.flatMap((node) =>
    fn({ ...node, children: mapTree(node.children, fn) }),
  );
}

/** `button "Login" [disabled]` → "button". */
function roleOf(head: string): string {
  return /^[a-z]+/.exec(head)?.[0] ?? "";
}

/** `button "Login" [disabled]` → "Login"; `list` → undefined. */
function nameOf(head: string): string | undefined {
  return /^[a-z]+ "((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
}

/** `text: hello` → { key: "text", value: "hello" }; `button "Login"` → undefined. */
function splitValue(head: string): { key: string; value: string } | undefined {
  const match = /^([a-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*): (.+)$/.exec(
    head,
  );
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { key: match[1], value: match[2] };
}

function truncateValue(value: string): string {
  const quoted = value.startsWith('"') && value.endsWith('"');
  const inner = quoted ? value.slice(1, -1) : value;
  const cut = `${inner.slice(0, MAX_VALUE_CHARS).trimEnd()}…`;
  return quoted ? `"${cut}"` : cut;
}
