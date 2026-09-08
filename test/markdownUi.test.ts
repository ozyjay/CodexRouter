import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { markdownScript } from "../src/markdownUi";

class Element {
  readonly tagName: string;
  textContent = "";
  className = "";
  href = "";
  title = "";
  children: Element[] = [];

  constructor(tagName: string, text = "") {
    this.tagName = tagName;
    this.textContent = text;
  }

  append(...children: Element[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: Element[]): void {
    this.children = children;
  }
}

test("assistant Markdown is rendered as safe DOM nodes", () => {
  const target = new Element("div");
  const document = {
    createElement: (tagName: string) => new Element(tagName),
    createTextNode: (text: string) => new Element("#text", text)
  };
  const context = { document, target, source: "**Context preview**\n\n- one\n- two\n\n<script>unsafe()</script>\n\n[blocked](javascript:alert(1)) [safe](https://example.com)" };
  runInNewContext(markdownScript + "renderMarkdown(target,source);", context);

  assert.equal(target.children[0].tagName, "p");
  assert.equal(target.children[0].children[0].tagName, "strong");
  assert.equal(target.children[1].tagName, "ul");
  assert.equal(target.children[1].children.length, 2);
  assert.equal(target.children.some(child => child.tagName === "script"), false);
  const finalParagraph = target.children.at(-1)!;
  assert.equal(finalParagraph.children.some(child => child.tagName === "a" && child.href.startsWith("javascript:")), false);
  assert.equal(finalParagraph.children.some(child => child.tagName === "a" && child.href === "https://example.com"), true);
});
