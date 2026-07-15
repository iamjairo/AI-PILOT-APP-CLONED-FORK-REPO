/**
 * @file DOM scraper source, ported from the AI-Chat-exporter browser
 * extension (`src/content/scrapers/*`).
 *
 * These are plain-JS *strings* that get injected into a service page via
 * `webContents.executeJavaScript(...)`. They must not reference anything from
 * the Node/Electron side — they run inside the page's own JS context, where
 * the DOM (and the user's logged-in session) is available.
 *
 * Faithfully reused from the reference repo, with two adaptations required to
 * run outside a Chrome extension:
 *   1. `export`/`import` keywords stripped (everything lives in one injected
 *      scope; functions are hoisted inside the async IIFE the capture engine
 *      wraps around them).
 *   2. `chrome.runtime.sendMessage(...)` in `extractUserImages` is guarded with
 *      `typeof chrome !== 'undefined'`; outside the extension it simply falls
 *      through to the blob/canvas path.
 *
 * Each `SCRAPER_JS[service]` value, once concatenated with `BASE_JS` and
 * `return await scrape();`, resolves to `{ title, messages, platform }` where
 * `messages` is `Array<{ role: 'user'|'model', htmlContent: string }>`.
 */

import type { ChatService } from '../../shared/types';

/** Shared DOM helpers (base.js), chrome-guarded, no export keywords. */
const BASE_JS = String.raw`
function cleanClone(node) {
  const clone = node.cloneNode(true);
  const uiElements = clone.querySelectorAll(
    'button, [role="button"], mat-icon, .action-buttons, [data-testid*="copy"], [data-testid*="thumb"], [data-testid*="share"]'
  );
  uiElements.forEach(el => el.remove());
  return clone;
}

function extractMath(clone) {
  const displayMathEls = clone.querySelectorAll('.math-block, .katex-display, .math-display');
  displayMathEls.forEach(el => {
    const tex = el.getAttribute('data-math')
      || (el.querySelector('annotation[encoding="application/x-tex"]') || {}).textContent
      || null;
    if (tex) {
      const marker = document.createElement('span');
      marker.className = 'math-tex math-display';
      marker.setAttribute('data-tex', tex.trim());
      marker.textContent = tex.trim();
      el.replaceWith(marker);
    }
  });
  const inlineMathEls = clone.querySelectorAll('.math-inline, .katex:not(.katex-display .katex)');
  inlineMathEls.forEach(el => {
    const tex = el.getAttribute('data-math')
      || (el.querySelector('annotation[encoding="application/x-tex"]') || {}).textContent
      || null;
    if (tex) {
      const marker = document.createElement('span');
      marker.className = 'math-tex';
      marker.setAttribute('data-tex', tex.trim());
      marker.textContent = tex.trim();
      el.replaceWith(marker);
    }
  });
}

function convertLatexDelimiters(html) {
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => {
    return '<span class="math-tex math-display" data-tex="' + escapeAttr(tex.trim()) + '">' + escapeHtml(tex.trim()) + '</span>';
  });
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (_, tex) => {
    return '<span class="math-tex" data-tex="' + escapeAttr(tex.trim()) + '">' + escapeHtml(tex.trim()) + '</span>';
  });
  return html;
}

function removeImages(clone) {
  clone.querySelectorAll('img').forEach(img => img.remove());
}

async function extractUserImages(originalNode) {
  const attachedImages = originalNode.querySelectorAll('img');
  let imagesHtml = '';
  for (const img of attachedImages) {
    const src = img.src || '';
    if (
      src &&
      !src.includes('/avatar/') &&
      !img.className.includes('avatar') &&
      !src.includes('data:image/svg') &&
      (img.naturalWidth || 0) > 32
    ) {
      let base64 = null;
      try {
        if (src.startsWith('blob:')) {
          const res = await fetch(src);
          const blob = await res.blob();
          base64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          const response = await chrome.runtime.sendMessage({ action: 'FETCH_IMAGE', url: src });
          if (response && response.base64) base64 = response.base64;
        }
        if (!base64) {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 100;
          canvas.height = img.naturalHeight || img.height || 100;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          if (!dataUrl.startsWith('data:image/png;base64,AAAA')) base64 = dataUrl;
        }
      } catch (e) {
        console.warn('[AI Exporter] Image extraction failed:', e && e.message);
      }
      if (base64) {
        imagesHtml += '<div style="margin-bottom: 12px;"><img src="' + base64 + '" alt="Attached image" style="max-width: 100%; height: auto;" /></div>';
      }
    }
  }
  return imagesHtml;
}

function getChatTitle(suffixPatterns, fallback) {
  const titleElement = document.querySelector('title');
  if (!titleElement) return fallback;
  let title = titleElement.innerText.trim();
  for (const pattern of suffixPatterns) {
    title = title.replace(new RegExp(pattern, 'i'), '').trim();
  }
  return title || fallback;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
`;

// ── Per-service scrape() bodies (ported verbatim, imports/exports stripped) ──

const CHATGPT_JS = String.raw`
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function messageKey(node) {
  let id = node.getAttribute('data-message-id');
  if (!id) {
    const holder = node.closest('[data-message-id]');
    if (holder) id = holder.getAttribute('data-message-id');
  }
  if (id) return id;
  const role = node.getAttribute('data-message-author-role') || 'x';
  return role + ':' + (node.textContent || '').trim().slice(0, 80);
}

function findScrollContainer() {
  const anchor = document.querySelector('[data-message-author-role]');
  let el = anchor ? anchor.parentElement : null;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 40) return el;
    el = el.parentElement;
  }
  return null;
}

async function extractMessageHtml(node, role) {
  const contentNode = node.querySelector('.markdown, .whitespace-pre-wrap, [data-message-content]') || node;
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

async function scrape() {
  const chatTitle = getChatTitle(['\\s*-\\s*ChatGPT\\s*$', '\\s*\\|\\s*ChatGPT\\s*$'], 'Exported ChatGPT Chat');
  const collected = new Map();
  const collectVisible = async () => {
    const nodes = document.querySelectorAll('[data-message-author-role]');
    for (const node of nodes) {
      const key = messageKey(node);
      if (collected.has(key)) continue;
      const roleAttr = node.getAttribute('data-message-author-role');
      const role = roleAttr === 'user' ? 'user' : 'model';
      const htmlContent = await extractMessageHtml(node, role);
      if (htmlContent) collected.set(key, { role, htmlContent });
    }
  };
  const scroller = findScrollContainer();
  const getMetrics = () => scroller
    ? { top: scroller.scrollTop, h: scroller.clientHeight, max: scroller.scrollHeight }
    : { top: window.scrollY, h: window.innerHeight, max: document.documentElement.scrollHeight };
  const scrollTo = (y) => { if (scroller) scroller.scrollTop = y; else window.scrollTo(0, y); };
  const restore = getMetrics().top;
  scrollTo(0);
  await delay(250);
  await collectVisible();
  let lastMax = -1, stable = 0, guard = 0;
  const MAX_STEPS = 600;
  while (guard++ < MAX_STEPS) {
    const { top, h, max } = getMetrics();
    await collectVisible();
    if (top + h >= max - 4) {
      if (max === lastMax) { if (++stable >= 2) break; } else { stable = 0; }
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
    if (mainChat) messages.push({ role: 'model', htmlContent: '<p>Warning: ChatGPT DOM structure may have changed. Full page scrape executed.</p>' + mainChat.innerHTML });
  }
  return { title: chatTitle, messages, platform: 'chatgpt' };
}
`;

const CLAUDE_JS = String.raw`
async function scrape() {
  const chatTitle = getChatTitle(['\\s*-\\s*Claude\\s*$', '\\s*\\|\\s*Claude\\s*$', '\\s*·\\s*Claude\\s*$'], 'Exported Claude Chat');
  const messages = [];
  const humanMsgs = document.querySelectorAll('[data-testid="human-message"]');
  const aiMsgs = document.querySelectorAll('.font-claude-response, .font-claude-message, [data-testid="ai-message"], [data-testid="message-assistant"]');
  let allNodes = [
    ...Array.from(humanMsgs).map(n => ({ node: n, role: 'user' })),
    ...Array.from(aiMsgs).map(n => ({ node: n, role: 'model' })),
  ];
  if (allNodes.length === 0) {
    const userByFont = document.querySelectorAll('.font-user-message, [data-testid="message-human"]');
    const aiByFont = document.querySelectorAll('.font-claude-message, .font-claude-response');
    allNodes = [
      ...Array.from(userByFont).map(n => ({ node: n, role: 'user' })),
      ...Array.from(aiByFont).map(n => ({ node: n, role: 'model' })),
    ];
  }
  if (allNodes.length === 0) {
    const markdownBlocks = document.querySelectorAll('.standard-markdown, .progressive-markdown, .markdown');
    for (const md of markdownBlocks) {
      const container = md.closest('[class*="message"], [class*="turn"], [class*="response"]') || md.parentElement;
      if (!container) continue;
      const prevSibling = container.previousElementSibling;
      if (prevSibling && !prevSibling.querySelector('.standard-markdown, .progressive-markdown, .markdown')) {
        allNodes.push({ node: prevSibling, role: 'user' });
      }
      allNodes.push({ node: container, role: 'model' });
    }
    const seen = new Set();
    allNodes = allNodes.filter(item => { if (seen.has(item.node)) return false; seen.add(item.node); return true; });
  }
  allNodes.sort((a, b) => {
    const pos = a.node.compareDocumentPosition(b.node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  for (const { node, role } of allNodes) {
    const contentNode = node.querySelector('.standard-markdown, .progressive-markdown, .markdown, .prose, [class*="message-content"]') || node;
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
    if (chatArea) messages.push({ role: 'model', htmlContent: '<p>Warning: Claude DOM structure may have changed. Full page scrape executed.</p>' + chatArea.innerHTML });
  }
  return { title: chatTitle, messages, platform: 'claude' };
}
`;

const GEMINI_JS = String.raw`
async function scrape() {
  const chatTitle = getChatTitle(['\\s*-\\s*Google Gemini\\s*$', '\\s*-\\s*Gemini\\s*$'], 'Exported Gemini Chat');
  const messages = [];
  const chatNodes = document.querySelectorAll('user-query, model-response');
  for (const node of chatNodes) {
    const isUser = node.tagName.toLowerCase() === 'user-query';
    let contentNode;
    if (isUser) contentNode = node.querySelector('.query-text, [data-test-id="user-query"]') || node;
    else contentNode = node.querySelector('.markdown, .message-content') || node;
    const clone = cleanClone(contentNode);
    const allElements = clone.querySelectorAll('*');
    allElements.forEach(el => { if (el.textContent.trim() === 'You said') el.remove(); });
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
    if (mainChat) messages.push({ role: 'model', htmlContent: '<p>Warning: Gemini DOM structure changed. Full page scrape executed.</p>' + mainChat.innerHTML });
  }
  return { title: chatTitle, messages, platform: 'gemini' };
}
`;

const DEEPSEEK_JS = String.raw`
function findMessagePairs() {
  const results = [];
  const markdownBlocks = document.querySelectorAll('.ds-markdown');
  if (markdownBlocks.length > 0) {
    for (const mdBlock of markdownBlocks) {
      let aiContainer = mdBlock.closest('[class*="message"], [class*="chat"], [class*="turn"]') || mdBlock.parentElement;
      let prevSibling = aiContainer && aiContainer.previousElementSibling;
      if (prevSibling && !prevSibling.querySelector('.ds-markdown')) results.push({ node: prevSibling, role: 'user' });
      results.push({ node: aiContainer, role: 'model' });
    }
  }
  const seen = new Set();
  return results.filter(item => { if (seen.has(item.node)) return false; seen.add(item.node); return true; });
}

async function scrape() {
  const chatTitle = getChatTitle(['\\s*-\\s*DeepSeek\\s*$', '\\s*\\|\\s*DeepSeek\\s*$'], 'Exported DeepSeek Chat');
  const messages = [];
  const pairs = findMessagePairs();
  if (pairs.length > 0) {
    for (const { node, role } of pairs) {
      let contentNode;
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
        const role = hasMarkdown ? 'model' : 'user';
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
`;

const LECHAT_JS = String.raw`
function findMessages() {
  const results = [];
  const roleMessages = document.querySelectorAll('[data-role], [data-testid*="message"]');
  if (roleMessages.length > 0) {
    for (const msg of roleMessages) {
      const role = msg.getAttribute('data-role');
      if (role === 'user' || role === 'human') results.push({ node: msg, role: 'user' });
      else if (role === 'assistant' || role === 'model') results.push({ node: msg, role: 'model' });
      else {
        const testId = msg.getAttribute('data-testid') || '';
        if (testId.includes('user')) results.push({ node: msg, role: 'user' });
        else if (testId.includes('assistant') || testId.includes('bot')) results.push({ node: msg, role: 'model' });
      }
    }
  }
  if (results.length === 0) {
    const proseBlocks = document.querySelectorAll('.prose, .markdown, [class*="markdown"]');
    for (const prose of proseBlocks) {
      const container = prose.closest('[class*="message"], [class*="turn"], [class*="chat-item"]') || prose.parentElement;
      if (!container) continue;
      const prevSibling = container.previousElementSibling;
      if (prevSibling && !prevSibling.querySelector('.prose, .markdown, [class*="markdown"]')) results.push({ node: prevSibling, role: 'user' });
      results.push({ node: container, role: 'model' });
    }
  }
  const seen = new Set();
  return results.filter(item => { if (seen.has(item.node)) return false; seen.add(item.node); return true; });
}

async function scrape() {
  const chatTitle = getChatTitle(['\\s*-\\s*Le Chat\\s*$', '\\s*\\|\\s*Mistral\\s*$', '\\s*-\\s*Mistral\\s*$'], 'Exported Le Chat Conversation');
  const messages = [];
  const foundMessages = findMessages();
  for (const { node, role } of foundMessages) {
    const contentNode = node.querySelector('.prose, .markdown, [class*="markdown"], [class*="content"]') || node;
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
    if (chatArea) messages.push({ role: 'model', htmlContent: '<p>Warning: Le Chat DOM structure may have changed. Full page scrape executed.</p>' + chatArea.innerHTML });
  }
  return { title: chatTitle, messages, platform: 'lechat' };
}
`;

const QWEN_JS = String.raw`
function cleanMonacoCodeBlocks(clone) {
  const codeBlocks = clone.querySelectorAll('.qwen-markdown-code, pre.qwen-markdown-code');
  codeBlocks.forEach(block => {
    const header = block.querySelector('.qwen-markdown-code-header');
    const lang = (header && header.textContent && header.textContent.trim().split(/\s/)[0]) || '';
    const viewLines = block.querySelectorAll('.view-line');
    let codeText = '';
    if (viewLines.length > 0) codeText = Array.from(viewLines).map(line => line.textContent).join('\n');
    else { const codeArea = block.querySelector('code, .monaco-editor, [class*="lines-content"]') || block; codeText = codeArea.textContent || ''; }
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (lang) code.className = 'language-' + lang.toLowerCase();
    code.textContent = codeText;
    pre.appendChild(code);
    block.replaceWith(pre);
  });
}

function removeQwenUI(clone) {
  clone.querySelectorAll('.qwen-chat-thinking-tool-status-card-wraper, [class*="thinking-tool"]').forEach(el => el.remove());
  clone.querySelectorAll('.qwen-markdown-table-header').forEach(el => el.remove());
  clone.querySelectorAll('.qwen-markdown-code-header').forEach(el => el.remove());
}

async function scrape() {
  const chatTitle = getChatTitle(['\\s*-\\s*Qwen\\s*$', '\\s*\\|\\s*Qwen\\s*$'], 'Exported Qwen Chat');
  const messages = [];
  const userNodes = document.querySelectorAll('.qwen-chat-message-user');
  const aiNodes = document.querySelectorAll('.qwen-chat-message-assistant');
  let allNodes = [
    ...Array.from(userNodes).map(n => ({ node: n, role: 'user' })),
    ...Array.from(aiNodes).map(n => ({ node: n, role: 'model' })),
  ];
  if (allNodes.length === 0) {
    const userFallback = document.querySelectorAll('[class*="message-user"], [data-role="user"]');
    const aiFallback = document.querySelectorAll('[class*="message-assistant"], [data-role="assistant"]');
    allNodes = [
      ...Array.from(userFallback).map(n => ({ node: n, role: 'user' })),
      ...Array.from(aiFallback).map(n => ({ node: n, role: 'model' })),
    ];
  }
  allNodes.sort((a, b) => {
    const pos = a.node.compareDocumentPosition(b.node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  for (const { node, role } of allNodes) {
    let contentNode;
    if (role === 'user') contentNode = node.querySelector('.user-message-content') || node;
    else contentNode = node.querySelector('.custom-qwen-markdown, .qwen-markdown') || node;
    const clone = cleanClone(contentNode);
    removeQwenUI(clone);
    cleanMonacoCodeBlocks(clone);
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
    if (chatArea) messages.push({ role: 'model', htmlContent: '<p>Warning: Qwen DOM structure may have changed. Full page scrape executed.</p>' + chatArea.innerHTML });
  }
  return { title: chatTitle, messages, platform: 'qwen' };
}
`;

/** Shape returned by every injected `scrape()`. */
export interface ScrapeResult {
  title: string;
  messages: { role: 'user' | 'model'; htmlContent: string }[];
  platform: string;
}

const SERVICE_BODIES: Record<ChatService, string> = {
  chatgpt: CHATGPT_JS,
  claude: CLAUDE_JS,
  gemini: GEMINI_JS,
  deepseek: DEEPSEEK_JS,
  lechat: LECHAT_JS,
  qwen: QWEN_JS,
};

/**
 * Build the full self-contained async IIFE to inject via executeJavaScript.
 * Resolves to a {@link ScrapeResult}. Wrapped in try/catch so a selector break
 * in the page never rejects the executeJavaScript promise.
 */
export function buildScrapeScript(service: ChatService): string {
  const body = SERVICE_BODIES[service];
  return (
    '(async () => { try {' +
    BASE_JS +
    body +
    ' return await scrape(); } catch (e) { return { title: document.title || "Exported Chat", messages: [], platform: "' +
    service +
    '", error: String(e && e.message || e) }; } })()'
  );
}

/**
 * Per-service regex (as a source string) matching sidebar conversation links.
 * Used for best-effort "list my conversations" DOM scraping where no clean
 * list API exists.
 */
const SIDEBAR_LINK_RE: Record<ChatService, string> = {
  // chatgpt uses an API replay instead; this is only a fallback.
  chatgpt: '/c/[0-9a-f-]{8,}',
  claude: '/chat/[0-9a-f-]{8,}',
  // Gemini conversations are not cleanly URL-addressable from the sidebar.
  gemini: '/app/[0-9a-z]{8,}',
  deepseek: '/a/chat/s/[0-9a-f-]{6,}',
  lechat: '/chat/[0-9a-z-]{6,}',
  qwen: '/c/[0-9a-f-]{6,}',
};

/**
 * Build a script that reads conversation links out of the current page's
 * sidebar. Returns `Array<{ id, title, updatedAt }>` where `id` is the FULL
 * absolute conversation URL (so import can navigate straight to it).
 */
export function buildSidebarListScript(service: ChatService): string {
  const re = SIDEBAR_LINK_RE[service];
  return (
    '(function(){ try {' +
    'var out=[]; var seen=new Set();' +
    'var re=new RegExp(' + JSON.stringify(re) + ');' +
    "var anchors=document.querySelectorAll('a[href]');" +
    'anchors.forEach(function(a){' +
    " var href=a.getAttribute('href')||'';" +
    ' if(!re.test(href)) return;' +
    ' var url; try { url=new URL(a.href, location.origin).href; } catch(_) { return; }' +
    ' if(seen.has(url)) return; seen.add(url);' +
    " var title=(a.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200)||url;" +
    ' out.push({ id:url, title:title });' +
    '});' +
    ' return out; } catch (e) { return []; } })()'
  );
}

/**
 * Build a script that describes the *currently open* conversation as a single
 * summary item (used as the import-current-conversation-only fallback).
 * Returns `{ id, title } | null`.
 */
export function buildCurrentConversationScript(): string {
  return (
    '(function(){ try {' +
    ' var url=location.href;' +
    " var title=(document.title||'Current conversation').replace(/\\s+/g,' ').trim();" +
    ' return { id:url, title:title }; } catch (e) { return null; } })()'
  );
}
