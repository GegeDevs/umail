import { escapeHtml } from './html.js';

// Renders the small Markdown subset AI models commonly return. Everything is
// escaped first; only the tags created below are allowed. No links on purpose.
export function renderAiMarkdown(text) {
  const inline = (value) => escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[13px]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  const lines = String(text || '').split(/\r?\n/);
  let html = '';
  let list = '';
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (list !== tag) {
        if (list) html += `</${list}>`;
        list = tag;
        html += `<${tag} class="${tag === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 space-y-1">`;
      }
      html += `<li>${inline((bullet || numbered)[1])}</li>`;
      continue;
    }
    if (list) {
      html += `</${list}>`;
      list = '';
    }
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (list) html += `</${list}>`;
  return html;
}
