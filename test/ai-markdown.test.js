import { test, expect } from 'bun:test';
import { renderAiMarkdown } from '../client/lib/ai-markdown.js';

test('renders bullets, bold, and inline code', () => {
  const html = renderAiMarkdown('Poin:\n\n- **Status**: berhasil.\n- ID `QRS123`\n- Total Rp 37.141');
  expect(html).toContain('<ul class="list-disc pl-5 space-y-1">');
  expect(html).toContain('<strong>Status</strong>');
  expect(html).toContain('<code class="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[13px]">QRS123</code>');
  expect((html.match(/<li>/g) || []).length).toBe(3);
  expect(html).toContain('</ul>');
});

test('renders numbered lists and paragraphs', () => {
  const html = renderAiMarkdown('1. Archive it\n2. Call the bank');
  expect(html).toContain('<ol class="list-decimal pl-5 space-y-1">');
  expect(html).toContain('<li>Archive it</li>');
  expect(html).toContain('<li>Call the bank</li>');
});

test('escapes HTML and does not create links', () => {
  const html = renderAiMarkdown('- <img src=x onerror=alert(1)> https://evil.test');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<a ');
  expect(html).toContain('https://evil.test');
});
