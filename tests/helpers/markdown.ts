/**
 * @fileoverview Read text as a CommonMark client would, independently of the server formatter.
 * @module tests/helpers/markdown
 */
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt('commonmark');

/** Decode authored Markdown, preserving hard breaks and code-block text. */
export function markdownText(source: string): string {
  return markdown
    .parse(source, {})
    .flatMap((token) => {
      if (token.type === 'fence' || token.type === 'code_block')
        return [token.content.replace(/\n$/, '')];
      if (token.type !== 'inline') return [];
      return [
        (token.children ?? [])
          .map((child) => {
            if (child.type === 'softbreak' || child.type === 'hardbreak') return '\n';
            return child.type === 'text' || child.type === 'code_inline' ? child.content : '';
          })
          .join(''),
      ];
    })
    .join('\n');
}
