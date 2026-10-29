import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { VNextError } from "./model.js";

function duplicates(node: Node): boolean {
  const keys = node.type === "object" ? (node.children ?? []).map(p => p.children?.[0]?.value) : [];
  return new Set(keys).size !== keys.length || (node.children ?? []).some(duplicates);
}
export function parseMetadata(bytes: Uint8Array): unknown {
  try {
    if (bytes.length > 4 * 1024 * 1024) throw new VNextError("capacity");
    const errors: ParseError[] = [];
    const tree = parseTree(new TextDecoder("utf-8", { fatal: true }).decode(bytes), errors, { disallowComments: true, allowTrailingComma: false });
    if (!tree || tree.type !== "object" || errors.length || duplicates(tree)) throw new VNextError("invalid-data");
    return getNodeValue(tree);
  } catch { throw new VNextError("invalid-data"); }
}
