import { LocalProxyCandidate } from "./contracts";
import { ProxyCandidate, ProxyCandidateError } from "./modelDeck";

export function prepareSelectionProxyCandidate(candidate: ProxyCandidate, file: string, selectedContent: string): LocalProxyCandidate {
  if (candidate.patches.length !== 1) throw new ProxyCandidateError("invalid-contract");
  const patch = candidate.patches[0];
  if (patch.file !== file) throw new ProxyCandidateError("invalid-contract");
  if (countOccurrences(selectedContent, patch.search) !== 1) {
    throw new ProxyCandidateError("invalid-contract");
  }
  return {
    model: candidate.model.publicModelId,
    file,
    search: patch.search,
    replacement: patch.replacement
  };
}

export function renderProxyCandidateMarkdown(candidate: LocalProxyCandidate): string {
  return [
    "## Experimental ModelDeck proxy candidate",
    "",
    `Model: ${inlineCode(candidate.model)}`,
    "",
    `File: ${inlineCode(candidate.file)}`,
    "",
    "This is an advisory candidate only. It has not changed the workspace. If routed onwards, Codex must review it independently and normal App Server approvals still apply.",
    "",
    "### Search",
    "",
    indentCode(candidate.search),
    "",
    "### Replacement",
    "",
    candidate.replacement.length > 0 ? indentCode(candidate.replacement) : "_(delete the search text)_",
    ""
  ].join("\n");
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const found = content.indexOf(search, offset);
    if (found < 0) break;
    count++;
    offset = found + search.length;
  }
  return count;
}

function indentCode(value: string): string {
  return value.split("\n").map((line) => `    ${line}`).join("\n");
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}
