---
name: cdp-browser
description: Use Chrome DevTools Protocol to search the web and fetch page contents with a real browser. Use when direct browser-based search, rendered page text, or JS-dependent pages are needed.
---

# CDP Browser

Use a Chromium-based browser through the Chrome DevTools Protocol (CDP) for web search and page fetching.

This skill is useful when:
- you need browser-rendered content rather than raw HTTP fetches
- the page depends on JavaScript
- you want to search with a real browser session
- you want readable text from a loaded page
- you need to inspect or navigate a page before extracting content

This skill now uses a more robust multi-script layout inspired by Armin Ronacher's `agent-stuff` web browser skill:
- a reusable CDP client module
- a browser startup script
- separate scripts for navigation, evaluation, search, fetch, and screenshots
- the `cdp-browser.js` wrapper for convenience

## Setup

Install the local dependency once:

```bash
cd skills/cdp-browser && npm install
```

Start Chrome or Chromium with remote debugging enabled.

### Recommended

Use the included starter script:

```bash
node scripts/start.js
```

To copy your Chrome profile first:

```bash
node scripts/start.js --profile
```

### Manual macOS examples

Google Chrome:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pi-cdp-profile
```

Chromium:
```bash
/Applications/Chromium.app/Contents/MacOS/Chromium \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pi-cdp-profile
```

Then verify CDP is available:

```bash
curl http://127.0.0.1:9222/json/version
```

## Commands

All commands run from this skill directory.

### Search the web

```bash
node scripts/search.js "chrome devtools protocol"
node scripts/cdp-browser.js search "pi coding agent skills" --limit 8 --timeout 20000
```

### Fetch a page

```bash
node scripts/fetch.js https://example.com
node scripts/cdp-browser.js fetch https://example.com --max-chars 12000 --timeout 25000
node scripts/cdp-browser.js fetch https://example.com --selector article
```

Use `--reuse-tab` to fetch into the active browser tab instead of a temporary one.

### Navigate a tab

```bash
node scripts/nav.js https://example.com
node scripts/nav.js https://example.com --new
```

### Evaluate JavaScript in the active tab

```bash
node scripts/eval.js 'document.title'
node scripts/eval.js 'Array.from(document.querySelectorAll("a")).slice(0, 10).map(a => ({ text: a.textContent.trim(), href: a.href }))'
```

### Screenshot the active tab

```bash
node scripts/screenshot.js
```

Returns a temporary PNG path.

## Environment variables

- `CDP_BROWSER_URL` — default `http://127.0.0.1:9222`
- `CDP_SEARCH_URL_TEMPLATE` — default `https://html.duckduckgo.com/html/?q=%s`
- `BROWSER_BIN` — optional explicit path to Chrome/Chromium for `start.js`

The `%s` token in `CDP_SEARCH_URL_TEMPLATE` is replaced with the URL-encoded query.

Examples:

```bash
CDP_BROWSER_URL=http://127.0.0.1:9333 node scripts/search.js "site:developer.chrome.com cdp"
CDP_SEARCH_URL_TEMPLATE='https://www.google.com/search?q=%s' node scripts/search.js "pi coding agent"
BROWSER_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/start.js
```

## Workflow guidance

1. Ensure Chrome is running with CDP enabled.
2. Run `search` with a specific query.
3. Review the returned titles, URLs, and snippets.
4. Run `fetch` on the most relevant result.
5. If needed, use `nav`, `eval`, or `screenshot` for deeper inspection.
6. Summarize and cite the URLs you used.

## Notes

- The search and fetch scripts use a temporary tab by default so they do not disturb your main browser session.
- `nav`, `eval`, and `screenshot` operate on the active tab unless you request a new one.
- For dynamic pages, prefer `fetch` over plain HTTP tools because the browser executes page JavaScript.
- If a site requires login or cookie consent, start Chrome with `--profile` and then use `nav` or `eval` in that browser session.
