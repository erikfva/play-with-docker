#!/usr/bin/env node
'use strict';

/**
 * check-codespace-status.js
 *
 * Verifies codespace status via HTTP. Uses the suspend form presence
 * as a reliable indicator: present = active, absent = stopped.
 *
 * Usage: node check-codespace-status.js <github.json> [slug]
 */

const fs = require('fs');
const path = require('path');

const credPath = process.argv[2] || process.env.GITHUB_AUTH_FILE;
if (!credPath) {
  console.error('Usage: node check-codespace-status.js <github.json> [slug]');
  process.exit(1);
}

const targetSlug = process.argv[3];

const state = JSON.parse(fs.readFileSync(path.resolve(credPath), 'utf8'));
const cookies = state.cookies
  .filter((c) => c.domain === '.github.com' || c.domain === 'github.com')
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

(async () => {
  const res = await fetch('https://github.com/codespaces', {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
      Cookie: cookies,
    },
    redirect: 'manual',
  });

  if (res.status === 302 || res.status === 301) {
    console.error(`Redirected to ${res.headers.get('location')} — session may be expired`);
    process.exit(1);
  }

  const html = await res.text();

  // Parse codespace list
  const slugRegex = /(?:href|action)=["']\/codespaces\/([a-z0-9][a-z0-9-]+)["']/gi;
  const seen = new Set();
  const codespaces = [];
  let match;

  while ((match = slugRegex.exec(html)) !== null) {
    const slug = match[1];
    if (slug === 'templates' || slug === 'new' || seen.has(slug)) continue;
    seen.add(slug);

    // Check for suspend form — indicates the codespace is active
    const suspendForm = html.includes(`/codespaces/${slug}/suspend`);

    // Extract display name
    const slugPos = html.indexOf(`/codespaces/${slug}`);
    const ctx = html.slice(Math.max(0, slugPos - 2000), slugPos + 2000);
    const nameMatch = ctx.match(/<span[^>]*class=["'][^"']*\bh5\b[^"']*["'][^>]*>\s*([^<]+)/i);
    const name = nameMatch ? nameMatch[1].trim() : slug;

    codespaces.push({
      name,
      slug,
      status: suspendForm ? 'active' : 'stopped',
    });
  }

  if (codespaces.length === 0) {
    console.log('No codespaces found. The page may have redirected to login.');
    process.exit(1);
  }

  // If a specific slug was requested, check only that one
  if (targetSlug) {
    const target = codespaces.find((c) => c.slug === targetSlug || c.slug.startsWith(targetSlug));
    if (!target) {
      console.log(`Codespace "${targetSlug}" not found.`);
      console.log('Available:', codespaces.map((c) => c.slug).join(', '));
      process.exit(1);
    }
    const icon = target.status === 'active' ? '[ACTIVE]' : '[STOPPED]';
    console.log(`Codespace status check:`);
    console.log('─'.repeat(80));
    console.log(`  ${icon.padEnd(12)} ${target.name} (${target.slug}) — ${target.status}`);
    console.log('─'.repeat(80));
    console.log(
      `\n  Suspend form ${target.status === 'active' ? 'present' : 'absent'} in HTML → codespace is ${target.status}.`
    );
    if (target.status === 'active') {
      console.log('  The stop/suspend action may take 10-20 minutes to take effect.');
    }
  } else {
    console.log('Codespace status check:');
    console.log('─'.repeat(80));
    for (const cs of codespaces) {
      const icon = cs.status === 'active' ? '[ACTIVE]' : '[STOPPED]';
      console.log(`  ${icon.padEnd(12)} ${cs.name} (${cs.slug}) — ${cs.status}`);
    }
    console.log('─'.repeat(80));
    console.log(
      `\nStatus determined by suspend form presence in raw HTML.\nActive = suspend form present, Stopped = suspend form absent.`
    );
  }
})();
