/**
 * HTML to text (SPEC.md §8).
 *
 * "Drop <script>, <style>, HTML comments, hidden elements (display:none,
 * visibility:hidden, aria-hidden, zero font size), and zero-width and bidi
 * characters."
 *
 * §8 is explicit about why: "Comment stripping is not cosmetic — HTML comments
 * and hidden divs are where injected instructions actually live." Everything
 * removed here is text a human visitor never sees, which makes it the obvious
 * place to hide an instruction aimed at whatever reads the page next. The
 * output is still untrusted; this only removes the channels that exist purely
 * to be invisible.
 */
import { parseHTML } from 'linkedom';

/** Elements whose content is never page text. */
const DROPPED_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'head',
];

/**
 * Zero-width and bidi control characters.
 *
 * They render as nothing, so they can split a word a scanner looks for, or
 * reverse the apparent order of text a human reviews. Neither belongs in
 * extracted prose.
 */
const INVISIBLE_CHARACTERS =
  /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** C0 and C1 control characters, tab/newline excepted. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Inline styles that hide an element from a human but not from a parser. */
function isHiddenByStyle(style: string): boolean {
  const flat = style.toLowerCase().replace(/\s+/g, '');
  return (
    flat.includes('display:none') ||
    flat.includes('visibility:hidden') ||
    /font-size:0(?:\.0+)?(?:px|pt|em|rem|%)?(?:;|$)/.test(flat) ||
    /opacity:0(?:\.0+)?(?:;|$)/.test(flat) ||
    // Moved off-canvas, a classic way to hide text from people only.
    /(?:left|top):-\d{4,}px/.test(flat)
  );
}

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, '').replace(CONTROL_CHARACTERS, ' ');
}

function collapse(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

export interface HtmlToTextResult {
  readonly text: string;
  /** What was removed, for the fetch log. Counts only, never content. */
  readonly removed: {
    readonly comments: number;
    readonly hiddenElements: number;
    readonly droppedTags: number;
  };
}

/**
 * linkedom parses a bare fragment by making its first element the
 * documentElement and leaving document.body empty, so reading body would
 * silently extract nothing from any page that lacks <html> — a malformed page,
 * a fragment, or a server that returns a partial. Wrapping anything that is not
 * already a document means there is always a body to read.
 */
function asDocumentSource(html: string): string {
  return /<(?:html|body)[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><body>${html}</body></html>`;
}

export function htmlToText(html: string): HtmlToTextResult {
  const root = parseHTML(asDocumentSource(html)).document;
  let droppedTags = 0;
  let hiddenElements = 0;
  let comments = 0;

  for (const tag of DROPPED_TAGS) {
    for (const element of [...root.querySelectorAll(tag)]) {
      element.remove();
      droppedTags += 1;
    }
  }

  // Comments, at any depth. linkedom keeps them in the tree, and an instruction
  // inside one is invisible to every human who looks at the page.
  interface WalkableNode {
    readonly nodeType: number;
    readonly childNodes?: ArrayLike<WalkableNode>;
    remove?: () => void;
  }
  const walk = (node: WalkableNode): void => {
    const children =
      node.childNodes === undefined ? [] : Array.from<WalkableNode>(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 8) {
        child.remove?.();
        comments += 1;
        continue;
      }
      if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(root as unknown as WalkableNode);

  for (const element of [...root.querySelectorAll('[aria-hidden], [hidden], [style]')]) {
    const ariaHidden = element.getAttribute('aria-hidden');
    const hidden = element.hasAttribute('hidden');
    const style = element.getAttribute('style') ?? '';
    if (ariaHidden === 'true' || hidden || (style !== '' && isHiddenByStyle(style))) {
      element.remove();
      hiddenElements += 1;
    }
  }

  // Block elements become line breaks so the text keeps some shape.
  for (const element of [...root.querySelectorAll('br, p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, blockquote')]) {
    element.append(root.createTextNode('\n'));
  }

  const body = root.body ?? root.documentElement;
  const raw = body?.textContent ?? '';
  return {
    text: collapse(stripInvisible(raw)),
    removed: { comments, hiddenElements, droppedTags },
  };
}

/** text/plain needs no parsing, only the same character hygiene. */
export function plainToText(body: string): HtmlToTextResult {
  return {
    text: collapse(stripInvisible(body)),
    removed: { comments: 0, hiddenElements: 0, droppedTags: 0 },
  };
}
