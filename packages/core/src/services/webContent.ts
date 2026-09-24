import { load } from 'cheerio';
import TurndownService from 'turndown';
import { createHash } from 'node:crypto';
import { sanitizeUntrustedOutput } from '@wazir/shared';
import { parseWebUrl } from './webSecurity.js';
import { WebError, type Citation, type ContentExtractor, type ContentSanitizer, type FetchResponse } from '../types/web.js';

export const webHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export class CitationManager {
  createCitation(source: Omit<Citation, 'citationId'>): Citation {
    return { ...source, citationId: `web-${webHash(JSON.stringify(source)).slice(0, 20)}` };
  }
}
export class WebContentSanitizer implements ContentSanitizer {
  constructor(private readonly redact: (text: string) => string = sanitizeUntrustedOutput) {}
  sanitize(text: string): string {
    return this.redact(sanitizeUntrustedOutput(text)).replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }
}
export class HtmlContentExtractor implements ContentExtractor {
  extract(response: FetchResponse) {
    const type = response.contentType.split(';')[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'].includes(type)) throw new WebError('WEB_UNSUPPORTED_CONTENT_TYPE');
    try {
      // Parse even text/markdown to remove embedded active HTML. Plain text stays literal data.
      if (type === 'text/plain') return { title: '', content: response.body.replace(/</g, '&lt;').replace(/>/g, '&gt;') };
      const $ = load(response.body);
      const title = $('title').first().text().trim();
      $('script,style,noscript,template,iframe,object,embed,svg,canvas,form,nav,footer,header,aside,[hidden],[aria-hidden="true"],[role="navigation"],[role="banner"],[role="dialog"],.cookie-banner,#cookie-banner').remove();
      $('[style]').each((_, el) => { if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr('style') ?? '')) $(el).remove(); });
      $('img').remove();
      if (type === 'text/markdown') return { title, content: $('body').text().trim() };
      $('a').each((_, el) => {
        try { $(el).attr('href', parseWebUrl(new URL($(el).attr('href') ?? '', response.finalUrl).href).href); }
        catch { $(el).removeAttr('href'); }
      });
      const main = $('main,article').first();
      const html = main.length ? main.html()! : $('body').html()!;
      const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      converter.addRule('tables', { filter: 'table', replacement: (_content, node) => {
        const table = load(node.outerHTML);
        const rows = table('tr').toArray().map(row => table(row).find('th,td').toArray().map(cell => table(cell).text().trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')));
        if (!rows.length) return '';
        return '\n\n' + rows.map((row, i) => `| ${row.join(' | ')} |` + (i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n\n';
      } });
      return { title, content: converter.turndown(html).trim() };
    } catch (e) { if (e instanceof WebError) throw e; throw new WebError('WEB_EXTRACTION_FAILED'); }
  }
}
