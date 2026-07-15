/**
 * @file DOM scrapers — ported BACK to a Chrome extension from the AI-Pilot
 * Electron app's `electron/services/chat-scrapers.ts`.
 *
 * The Electron file kept these as injected JS *strings* (BASE_JS + per-service
 * bodies concatenated and run through `webContents.executeJavaScript`). Here we
 * restore them to real content-script functions with the two adaptations
 * reversed:
 *   1. `export`/`import` reinstated (this is a real module, bundled by esbuild).
 *   2. `chrome.runtime.sendMessage({action:'FETCH_IMAGE', url})` is LIVE again —
 *      it routes user-uploaded image fetches to the background service worker,
 *      which bypasses the content script's page-CSP / CORS limits.
 *
 * Each `scrape()` resolves to
 *   `{ title, messages: Array<{role:'user'|'model', htmlContent}>, platform }`.
 *
 * The bodies are otherwise a faithful copy of the Electron scrapers, so output
 * is identical to the desktop app.
 */
import type { ChatService, ScrapeResult, ScrapedAttachment } from './types';

// ─── Shared DOM helpers (base.js) ──────────────────────────────────────────
function cleanClone(node: Element): Element {
  const clone = node.cloneNode(true) as Element;
  const uiElements = clone.querySelectorAll(
    'button, [role="button"], mat-icon, .action-buttons, [data-testid*="copy"], [data-testid*="thumb"], [data-testid*="share"]',
  );
  uiElements.forEach((el) => el.remove());
  return clone;
}

function extractMath(clone: Element): void {
  const displayMathEls = clone.querySelectorAll('.math-block, .katex-display, .math-display');
  displayMathEls.forEach((el) => {
    const tex =
      el.getAttribute('data-math') ||
      (el.querySelector('annotation[encoding="application/x-tex"]') || ({} as Element)).textContent ||
      null;
    if (tex) {
      const marker = document.createElement('span');
      marker.className = 'math-tex math-display';
      marker.setAttribute('data-tex', tex.trim());
      marker.textContent = tex.trim();
      el.replaceWith(marker);
    }
  });
  const inlineMathEls = clone.querySelectorAll('.math-inline, .katex:not(.katex-display .katex)');
  inlineMathEls.forEach((el) => {
    const tex =
      el.getAttribute('data-math') ||
      (el.querySelector('annotation[encoding="application/x-tex"]') || ({} as Element)).textContent ||
      null;
    if (tex) {
      const marker = document.createElement('span');
      marker.className = 'math-tex';
      marker.setAttribute('data-tex', tex.trim());
      marker.textContent = tex.trim();
      el.replaceWith(marker);
    }
  });
}

function convertLatexDelimiters(html: string): string {
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_m, tex) => {
    return (
      '<span class="math-tex math-display" data-tex="' +
      escapeAttr(tex.trim()) +
      '">' +
      escapeHtml(tex.trim()) +
      '</span>'
    );
  });
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (_m, tex) => {
    return '<span class="math-tex" data-tex="' + escapeAttr(tex.trim()) + '">' + escapeHtml(tex.trim()) + '</span>';
  });
  return html;
}

function removeImages(clone: Element): void {
  clone.querySelectorAll('img').forEach((img) => img.remove());
}

async function extractUserImages(originalNode: Element): Promise<string> {
  const attachedImages = originalNode.querySelectorAll('img');
  let imagesHtml = '';
  for (const img of Array.from(attachedImages)) {
    const src = img.src || '';
    if (
      src &&
      !src.includes('/avatar/') &&
      !img.className.includes('avatar') &&
      !src.includes('data:image/svg') &&
      (img.naturalWidth || 0) > 32
    ) {
      let base64: string | null = null;
      try {
        if (src.startsWith('blob:')) {
          const res = await fetch(src);
          const blob = await res.blob();
          base64 = await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          // LIVE in the extension: route cross-origin image fetch to the
          // background service worker (bypasses page CSP / content-script CORS).
          const response = await chrome.runtime.sendMessage({ action: 'FETCH_IMAGE', url: src });
          if (response && response.base64) base64 = response.base64;
        }
        if (!base64) {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 100;
          canvas.height = img.naturalHeight || img.height || 100;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL('image/png');
            if (!dataUrl.startsWith('data:image/png;base64,AAAA')) base64 = dataUrl;
          }
        }
      } catch (e) {
        console.warn('[AI Exporter] Image extraction failed:', e && (e as Error).message);
      }
      if (base64) {
        imagesHtml +=
          '<div style="margin-bottom: 12px;"><img src="' +
          base64 +
          '" alt="Attached image" style="max-width: 100%; height: auto;" /></div>';
      }
    }
  }
  return imagesHtml;
}

function getChatTitle(suffixPatterns: string[], fallback: string): string {
  const titleElement = document.querySelector('title');
  if (!titleElement) return fallback;
  let title = titleElement.innerText.trim();
  for (const pattern of suffixPatterns) {
    title = title.replace(new RegExp(pattern, 'i'), '').trim();
  }
  return title || fallback;
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Generated-file download cards ────────────────────────────────────────────
/**
 * Filename pattern for inline download cards / code-block headers. Anchored to
 * a single token so prose doesn't match.
 */
const FILE_CARD_RE =
  /^[\w.\-/]+\.(sh|bash|zsh|py|js|jsx|ts|tsx|mjs|cjs|json|ya?ml|zip|tar|gz|tgz|md|txt|conf|cfg|ini|env|toml|pl|rb|go|rs|sql|c|h|cpp|hpp|cc|cs|java|kt|swift|php|html?|css|scss|xml|csv|tsv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|webp)$/i;

function firstFileToken(text: string): string | null {
  if (!text) return null;
  for (const token of text.split(/[\s|·•,]+/)) {
    const t = token.trim();
    if (t.length >= 3 && t.length <= 160 && FILE_CARD_RE.test(t)) return t;
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetch a file's bytes as a base64 data URL. `blob:`/`data:` URLs are read in
 * the page context (a service worker can't read a page-scoped blob URL); all
 * other URLs are routed to the background worker (FETCH_FILE) so the user's
 * session cookies apply and the page CSP doesn't block the request.
 */
async function fetchFileAsDataUrl(url: string): Promise<string | null> {
  try {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const res = await fetch(url);
      const blob = await res.blob();
      return await blobToDataUrl(blob);
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const response = await chrome.runtime.sendMessage({ action: 'FETCH_FILE', url });
      if (response && response.base64) return response.base64 as string;
    }
  } catch (e) {
    console.warn('[AI Exporter] File fetch failed:', e && (e as Error).message);
  }
  return null;
}

/**
 * Detect inline generated-file download cards inside a message node and try to
 * capture their bytes. These are NOT `<pre>` code and NOT `<img>` — they are
 * cards with a filename plus a download affordance (an anchor with `download`
 * or an href to a `blob:` / `sandbox:` / files URL). Best-effort and defensive:
 * a card whose bytes can't be fetched is still returned with `fetched:false`
 * so its filename is recorded.
 *
 * SCOPE: only files rendered inline in the conversation are reachable. Files
 * that live solely in ChatGPT's Library are out of a content script's reach.
 */
async function extractFileCards(node: Element): Promise<ScrapedAttachment[]> {
  const out: ScrapedAttachment[] = [];
  const seen = new Set<string>();
  let candidates: Element[] = [];
  try {
    candidates = Array.from(
      node.querySelectorAll(
        'a[download], a[href^="blob:"], a[href^="sandbox:"], a[href*="/backend-api/"], a[href*="files"], [data-testid*="download"], [class*="download"]',
      ),
    );
  } catch {
    candidates = [];
  }
  for (const el of candidates) {
    try {
      // Resolve a URL: the element's own href, or the nearest anchor.
      let url =
        el.getAttribute('href') ||
        el.getAttribute('data-href') ||
        (el.closest('a[href]') || ({} as Element)).getAttribute?.('href') ||
        (el.querySelector('a[href]') || ({} as Element)).getAttribute?.('href') ||
        '';
      // Resolve a filename: explicit download attr, else element/anchor text,
      // else the nearest card container's text.
      let name = (el.getAttribute('download') || '').trim();
      if (!name || !FILE_CARD_RE.test(name)) {
        name =
          firstFileToken(el.textContent || '') ||
          firstFileToken((el.closest('[class*="attachment"], [class*="file"], [role="listitem"], div') || el).textContent || '') ||
          '';
      }
      if (!name || !FILE_CARD_RE.test(name)) continue;
      // Skip plain inline images already handled by extractUserImages.
      if (/^https?:.*\.(png|jpe?g|gif|svg|webp)$/i.test(url) && !el.hasAttribute('download')) {
        // still allow if it's clearly a download card; otherwise skip
      }
      const key = name + '|' + url;
      if (seen.has(key)) continue;
      seen.add(key);
      let fetched = false;
      let finalUrl = url;
      if (url) {
        const dataUrl = await fetchFileAsDataUrl(url);
        if (dataUrl) {
          finalUrl = dataUrl;
          fetched = true;
        }
      }
      out.push({ name, url: finalUrl, fetched });
    } catch {
      /* defensive: never let one bad card abort the scrape */
    }
  }
  return out;
}

type ScrapedMessage = {
  role: 'user' | 'model';
  htmlContent: string;
  attachments?: ScrapedAttachment[];
};

// ─── ChatGPT ────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function chatgptMessageKey(node: Element): string {
  let id = node.getAttribute('data-message-id');
  if (!id) {
    const holder = node.closest('[data-message-id]');
    if (holder) id = holder.getAttribute('data-message-id');
  }
  if (id) return id;
  const role = node.getAttribute('data-message-author-role') || 'x';
  return role + ':' + (node.textContent || '').trim().slice(0, 80);
}

function chatgptFindScrollContainer(): Element | null {
  const anchor = document.querySelector('[data-message-author-role]');
  let el: Element | null = anchor ? anchor.parentElement : null;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 40) return el;
    el = el.parentElement;
  }
  return null;
}

async function chatgptExtractMessageHtml(node: Element, role: 'user' | 'model'): Promise<string> {
  const contentNode =
    node.querySelector('.markdown, .whitespace-pre-wrap, [data-message-content]') || node;
  const clone = cleanClone(contentNode);
  extractMath(clone);
  removeImages(clone);
  let htmlString = clone.innerHTML.trim();
  htmlString = convertLatexDelimiters(htmlString);
  if (role === 'user') {
    const imagesHtml = await extractUserImages(node);
    if (imagesHtml) htmlString = imagesHtml + htmlString;
  }
  return htmlString;
}

async function scrapeChatgpt(): Promise<ScrapeResult> {
  const chatTitle = getChatTitle(['\\s*-\\s*ChatGPT\\s*$', '\\s*\\|\\s*ChatGPT\\s*$'], 'Exported ChatGPT Chat');
  const collected = new Map<string, ScrapedMessage>();
  const collectVisible = async () => {
    const nodes = document.querySelectorAll('[data-message-author-role]');
    for (const node of Array.from(nodes)) {
      const key = chatgptMessageKey(node);
      if (collected.has(key)) continue;
      const roleAttr = node.getAttribute('data-message-author-role');
      const role: 'user' | 'model' = roleAttr === 'user' ? 'user' : 'model';
      const htmlContent = await chatgptExtractMessageHtml(node, role);
      if (!htmlContent) continue;
      const entry: ScrapedMessage = { role, htmlContent };
      // Inline generated-file download cards are assistant-only.
      if (role === 'model') {
        const cards = await extractFileCards(node);
        if (cards.length) entry.attachments = cards;
      }
      collected.set(key, entry);
    }
  };
  const scroller = chatgptFindScrollContainer();
  const getMetrics = () =>
    scroller
      ? { top: scroller.scrollTop, h: scroller.clientHeight, max: scroller.scrollHeight }
      : { top: window.scrollY, h: window.innerHeight, max: document.documentElement.scrollHeight };
  const scrollTo = (y: number) => {
    if (scroller) scroller.scrollTop = y;
    else window.scrollTo(0, y);
  };
  const restore = getMetrics().top;
  scrollTo(0);
  await delay(250);
  await collectVisible();
  let lastMax = -1;
  let stable = 0;
  let guard = 0;
  const MAX_STEPS = 600;
  while (guard++ < MAX_STEPS) {
    const { top, h, max } = getMetrics();
    await collectVisible();
    if (top + h >= max - 4) {
      if (max === lastMax) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
      }
      lastMax = max;
      await delay(220);
      continue;
    }
    scrollTo(Math.min(top + Math.floor(h * 0.85), max));
    lastMax = max;
    await delay(180);
  }
  await collectVisible();
  scrollTo(restore);
  const messages = Array.from(collected.values());
  if (messages.length === 0) {
    const mainChat = document.querySelector('main, [role="main"]');
    if (mainChat)
      messages.push({
        role: 'model',
        htmlContent:
          '<p>Warning: ChatGPT DOM structure may have changed. Full page scrape executed.</p>' +
          mainChat.innerHTML,
      });
  }
  return { title: chatTitle, messages, platform: 'chatgpt' };
}

// ─── Claude ──────────────────────────────────────────────────────────────────
async function scrapeClaude(): Promise<ScrapeResult> {
  const chatTitle = getChatTitle(
    ['\\s*-\\s*Claude\\s*$', '\\s*\\|\\s*Claude\\s*$', '\\s*·\\s*Claude\\s*$'],
    'Exported Claude Chat',
  );
  const messages: ScrapedMessage[] = [];
  const humanMsgs = document.querySelectorAll('[data-testid="human-message"]');
  const aiMsgs = document.querySelectorAll(
    '.font-claude-response, .font-claude-message, [data-testid="ai-message"], [data-testid="message-assistant"]',
  );
  let allNodes: { node: Element; role: 'user' | 'model' }[] = [
    ...Array.from(humanMsgs).map((n) => ({ node: n, role: 'user' as const })),
    ...Array.from(aiMsgs).map((n) => ({ node: n, role: 'model' as const })),
  ];
  if (allNodes.length === 0) {
    const userByFont = document.querySelectorAll('.font-user-message, [data-testid="message-human"]');
    const aiByFont = document.querySelectorAll('.font-claude-message, .font-claude-response');
    allNodes = [
      ...Array.from(userByFont).map((n) => ({ node: n, role: 'user' as const })),
      ...Array.from(aiByFont).map((n) => ({ node: n, role: 'model' as const })),
    ];
  }
  if (allNodes.length === 0) {
    const markdownBlocks = document.querySelectorAll('.standard-markdown, .progressive-markdown, .markdown');
    for (const md of Array.from(markdownBlocks)) {
      const container =
        md.closest('[class*="message"], [class*="turn"], [class*="response"]') || md.parentElement;
      if (!container) continue;
      const prevSibling = container.previousElementSibling;
      if (prevSibling && !prevSibling.querySelector('.standard-markdown, .progressive-markdown, .markdown')) {
        allNodes.push({ node: prevSibling, role: 'user' });
      }
      allNodes.push({ node: container, role: 'model' });
    }
    const seen = new Set<Element>();
    allNodes = allNodes.filter((item) => {
      if (seen.has(item.node)) return false;
      seen.add(item.node);
      return true;
    });
  }
  allNodes.sort((a, b) => {
    const pos = a.node.compareDocumentPosition(b.node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  for (const { node, role } of allNodes) {
    const contentNode =
      node.querySelector(
        '.standard-markdown, .progressive-markdown, .markdown, .prose, [class*="message-content"]',
      ) || node;
    const clone = cleanClone(contentNode);
    extractMath(clone);
    removeImages(clone);
    let htmlString = clone.innerHTML.trim();
    htmlString = convertLatexDelimiters(htmlString);
    if (role === 'user') {
      const imagesHtml = await extractUserImages(node);
      if (imagesHtml) htmlString = imagesHtml + htmlString;
    }
    if (htmlString) messages.push({ role, htmlContent: htmlString });
  }
  if (messages.length === 0) {
    const chatArea = document.querySelector('[class*="conversation"], main, [role="main"]');
    if (chatArea)
      messages.push({
        role: 'model',
        htmlContent:
          '<p>Warning: Claude DOM structure may have changed. Full page scrape executed.</p>' +
          chatArea.innerHTML,
      });
  }
  return { title: chatTitle, messages, platform: 'claude' };
}

// ─── Gemini ──────────────────────────────────────────────────────────────────
async function scrapeGemini(): Promise<ScrapeResult> {
  const chatTitle = getChatTitle(
    ['\\s*-\\s*Google Gemini\\s*$', '\\s*-\\s*Gemini\\s*$'],
    'Exported Gemini Chat',
  );
  const messages: ScrapedMessage[] = [];
  const chatNodes = document.querySelectorAll('user-query, model-response');
  for (const node of Array.from(chatNodes)) {
    const isUser = node.tagName.toLowerCase() === 'user-query';
    let contentNode: Element;
    if (isUser) contentNode = node.querySelector('.query-text, [data-test-id="user-query"]') || node;
    else contentNode = node.querySelector('.markdown, .message-content') || node;
    const clone = cleanClone(contentNode);
    const allElements = clone.querySelectorAll('*');
    allElements.forEach((el) => {
      if (el.textContent && el.textContent.trim() === 'You said') el.remove();
    });
    extractMath(clone);
    removeImages(clone);
    let htmlString = clone.innerHTML.trim();
    if (isUser) {
      const imagesHtml = await extractUserImages(node);
      if (imagesHtml) htmlString = imagesHtml + htmlString;
    }
    messages.push({ role: isUser ? 'user' : 'model', htmlContent: htmlString });
  }
  if (messages.length === 0) {
    const mainChat = document.querySelector('main, .conversation-container');
    if (mainChat)
      messages.push({
        role: 'model',
        htmlContent:
          '<p>Warning: Gemini DOM structure changed. Full page scrape executed.</p>' + mainChat.innerHTML,
      });
  }
  return { title: chatTitle, messages, platform: 'gemini' };
}

// ─── DeepSeek ────────────────────────────────────────────────────────────────
function deepseekFindMessagePairs(): { node: Element; role: 'user' | 'model' }[] {
  const results: { node: Element; role: 'user' | 'model' }[] = [];
  const markdownBlocks = document.querySelectorAll('.ds-markdown');
  if (markdownBlocks.length > 0) {
    for (const mdBlock of Array.from(markdownBlocks)) {
      const aiContainer =
        mdBlock.closest('[class*="message"], [class*="chat"], [class*="turn"]') || mdBlock.parentElement;
      const prevSibling = aiContainer && aiContainer.previousElementSibling;
      if (prevSibling && !prevSibling.querySelector('.ds-markdown'))
        results.push({ node: prevSibling, role: 'user' });
      if (aiContainer) results.push({ node: aiContainer, role: 'model' });
    }
  }
  const seen = new Set<Element>();
  return results.filter((item) => {
    if (seen.has(item.node)) return false;
    seen.add(item.node);
    return true;
  });
}

async function scrapeDeepseek(): Promise<ScrapeResult> {
  const chatTitle = getChatTitle(['\\s*-\\s*DeepSeek\\s*$', '\\s*\\|\\s*DeepSeek\\s*$'], 'Exported DeepSeek Chat');
  const messages: ScrapedMessage[] = [];
  const pairs = deepseekFindMessagePairs();
  if (pairs.length > 0) {
    for (const { node, role } of pairs) {
      let contentNode: Element;
      if (role === 'model') contentNode = node.querySelector('.ds-markdown') || node;
      else contentNode = node;
      const clone = cleanClone(contentNode);
      extractMath(clone);
      removeImages(clone);
      let htmlString = clone.innerHTML.trim();
      htmlString = convertLatexDelimiters(htmlString);
      if (role === 'user') {
        const imagesHtml = await extractUserImages(node);
        if (imagesHtml) htmlString = imagesHtml + htmlString;
      }
      if (htmlString) messages.push({ role, htmlContent: htmlString });
    }
  }
  if (messages.length === 0) {
    const chatArea = document.querySelector('[class*="conversation"], [class*="chat-list"], main');
    if (chatArea) {
      const children = Array.from(chatArea.children);
      children.forEach((child) => {
        const hasMarkdown = child.querySelector('.ds-markdown');
        const role: 'user' | 'model' = hasMarkdown ? 'model' : 'user';
        const clone = cleanClone(child);
        removeImages(clone);
        let htmlString = clone.innerHTML.trim();
        htmlString = convertLatexDelimiters(htmlString);
        if (htmlString) messages.push({ role, htmlContent: htmlString });
      });
    }
  }
  return { title: chatTitle, messages, platform: 'deepseek' };
}

// ─── Le Chat / Mistral ────────────────────────────────────────────────────────
function lechatFindMessages(): { node: Element; role: 'user' | 'model' }[] {
  const results: { node: Element; role: 'user' | 'model' }[] = [];
  const roleMessages = document.querySelectorAll('[data-role], [data-testid*="message"]');
  if (roleMessages.length > 0) {
    for (const msg of Array.from(roleMessages)) {
      const role = msg.getAttribute('data-role');
      if (role === 'user' || role === 'human') results.push({ node: msg, role: 'user' });
      else if (role === 'assistant' || role === 'model') results.push({ node: msg, role: 'model' });
      else {
        const testId = msg.getAttribute('data-testid') || '';
        if (testId.includes('user')) results.push({ node: msg, role: 'user' });
        else if (testId.includes('assistant') || testId.includes('bot'))
          results.push({ node: msg, role: 'model' });
      }
    }
  }
  if (results.length === 0) {
    const proseBlocks = document.querySelectorAll('.prose, .markdown, [class*="markdown"]');
    for (const prose of Array.from(proseBlocks)) {
      const container =
        prose.closest('[class*="message"], [class*="turn"], [class*="chat-item"]') || prose.parentElement;
      if (!container) continue;
      const prevSibling = container.previousElementSibling;
      if (prevSibling && !prevSibling.querySelector('.prose, .markdown, [class*="markdown"]'))
        results.push({ node: prevSibling, role: 'user' });
      results.push({ node: container, role: 'model' });
    }
  }
  const seen = new Set<Element>();
  return results.filter((item) => {
    if (seen.has(item.node)) return false;
    seen.add(item.node);
    return true;
  });
}

async function scrapeLechat(): Promise<ScrapeResult> {
  const chatTitle = getChatTitle(
    ['\\s*-\\s*Le Chat\\s*$', '\\s*\\|\\s*Mistral\\s*$', '\\s*-\\s*Mistral\\s*$'],
    'Exported Le Chat Conversation',
  );
  const messages: ScrapedMessage[] = [];
  const foundMessages = lechatFindMessages();
  for (const { node, role } of foundMessages) {
    const contentNode =
      node.querySelector('.prose, .markdown, [class*="markdown"], [class*="content"]') || node;
    const clone = cleanClone(contentNode);
    extractMath(clone);
    removeImages(clone);
    let htmlString = clone.innerHTML.trim();
    htmlString = convertLatexDelimiters(htmlString);
    if (role === 'user') {
      const imagesHtml = await extractUserImages(node);
      if (imagesHtml) htmlString = imagesHtml + htmlString;
    }
    if (htmlString) messages.push({ role, htmlContent: htmlString });
  }
  if (messages.length === 0) {
    const chatArea = document.querySelector('main, [role="main"], [class*="conversation"]');
    if (chatArea)
      messages.push({
        role: 'model',
        htmlContent:
          '<p>Warning: Le Chat DOM structure may have changed. Full page scrape executed.</p>' +
          chatArea.innerHTML,
      });
  }
  return { title: chatTitle, messages, platform: 'lechat' };
}

// ─── Qwen ────────────────────────────────────────────────────────────────────
function qwenCleanMonacoCodeBlocks(clone: Element): void {
  const codeBlocks = clone.querySelectorAll('.qwen-markdown-code, pre.qwen-markdown-code');
  codeBlocks.forEach((block) => {
    const header = block.querySelector('.qwen-markdown-code-header');
    const lang = (header && header.textContent && header.textContent.trim().split(/\s/)[0]) || '';
    const viewLines = block.querySelectorAll('.view-line');
    let codeText = '';
    if (viewLines.length > 0) codeText = Array.from(viewLines).map((line) => line.textContent).join('\n');
    else {
      const codeArea = block.querySelector('code, .monaco-editor, [class*="lines-content"]') || block;
      codeText = codeArea.textContent || '';
    }
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (lang) code.className = 'language-' + lang.toLowerCase();
    code.textContent = codeText;
    pre.appendChild(code);
    block.replaceWith(pre);
  });
}

function qwenRemoveUI(clone: Element): void {
  clone
    .querySelectorAll('.qwen-chat-thinking-tool-status-card-wraper, [class*="thinking-tool"]')
    .forEach((el) => el.remove());
  clone.querySelectorAll('.qwen-markdown-table-header').forEach((el) => el.remove());
  clone.querySelectorAll('.qwen-markdown-code-header').forEach((el) => el.remove());
}

async function scrapeQwen(): Promise<ScrapeResult> {
  const chatTitle = getChatTitle(['\\s*-\\s*Qwen\\s*$', '\\s*\\|\\s*Qwen\\s*$'], 'Exported Qwen Chat');
  const messages: ScrapedMessage[] = [];
  const userNodes = document.querySelectorAll('.qwen-chat-message-user');
  const aiNodes = document.querySelectorAll('.qwen-chat-message-assistant');
  let allNodes: { node: Element; role: 'user' | 'model' }[] = [
    ...Array.from(userNodes).map((n) => ({ node: n, role: 'user' as const })),
    ...Array.from(aiNodes).map((n) => ({ node: n, role: 'model' as const })),
  ];
  if (allNodes.length === 0) {
    const userFallback = document.querySelectorAll('[class*="message-user"], [data-role="user"]');
    const aiFallback = document.querySelectorAll('[class*="message-assistant"], [data-role="assistant"]');
    allNodes = [
      ...Array.from(userFallback).map((n) => ({ node: n, role: 'user' as const })),
      ...Array.from(aiFallback).map((n) => ({ node: n, role: 'model' as const })),
    ];
  }
  allNodes.sort((a, b) => {
    const pos = a.node.compareDocumentPosition(b.node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  for (const { node, role } of allNodes) {
    let contentNode: Element;
    if (role === 'user') contentNode = node.querySelector('.user-message-content') || node;
    else contentNode = node.querySelector('.custom-qwen-markdown, .qwen-markdown') || node;
    const clone = cleanClone(contentNode);
    qwenRemoveUI(clone);
    qwenCleanMonacoCodeBlocks(clone);
    extractMath(clone);
    removeImages(clone);
    let htmlString = clone.innerHTML.trim();
    htmlString = convertLatexDelimiters(htmlString);
    if (role === 'user') {
      const imagesHtml = await extractUserImages(node);
      if (imagesHtml) htmlString = imagesHtml + htmlString;
    }
    if (htmlString) messages.push({ role, htmlContent: htmlString });
  }
  if (messages.length === 0) {
    const chatArea = document.querySelector('main, [role="main"], [class*="conversation"]');
    if (chatArea)
      messages.push({
        role: 'model',
        htmlContent:
          '<p>Warning: Qwen DOM structure may have changed. Full page scrape executed.</p>' +
          chatArea.innerHTML,
      });
  }
  return { title: chatTitle, messages, platform: 'qwen' };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
const SCRAPERS: Record<ChatService, () => Promise<ScrapeResult>> = {
  chatgpt: scrapeChatgpt,
  claude: scrapeClaude,
  gemini: scrapeGemini,
  deepseek: scrapeDeepseek,
  lechat: scrapeLechat,
  qwen: scrapeQwen,
};

/**
 * Run the correct scraper for a service. Wrapped in try/catch so a selector
 * break never rejects — it returns an empty-message result with `error` set,
 * exactly like the Electron `buildScrapeScript` wrapper did.
 */
export async function runScrape(service: ChatService): Promise<ScrapeResult> {
  try {
    return await SCRAPERS[service]();
  } catch (e) {
    return {
      title: document.title || 'Exported Chat',
      messages: [],
      platform: service,
      error: String((e && (e as Error).message) || e),
    };
  }
}
