// Tests for the feed handler's pure parse/render seam: feedToMarkdown turns
// RSS 2.0 / Atom / RDF XML into channel header + recent items. The HTTP layer
// (getText + curl retry) stays behind the handler interface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { feedToMarkdown, matchFeedPath } from "../handlers/feed.ts";

test("feed: parses RSS 2.0 with CDATA titles and item links", () => {
  const xml = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>
    <title><![CDATA[OpenAI News]]></title>
    <description><![CDATA[The OpenAI blog]]></description>
    <link>https://openai.com/news</link>
    <lastBuildDate>Fri, 18 Sep 2026 23:14:23 GMT</lastBuildDate>
    <item><title><![CDATA[How Cooley is accelerating IPO work]]></title><link>https://openai.com/index/cooley-gopublic</link><pubDate>Thu, 17 Sep 2026</pubDate></item>
    <item><title><![CDATA[Reimagining advertising with AI]]></title><link>https://openai.com/index/reimagining-advertising-with-ai</link><pubDate>Wed, 16 Sep 2026</pubDate></item>
  </channel></rss>`;
  const out = feedToMarkdown(xml);
  assert.ok(out);
  assert.equal(out.title, "OpenAI News");
  assert.match(out.content, /^# OpenAI News \(RSS feed\)/);
  assert.match(out.content, /The OpenAI blog/);
  assert.match(out.content, /Site: https:\/\/openai\.com\/news/);
  assert.match(out.content, /Recent items \(showing 2 of 2\):/);
  assert.match(out.content, /- \[How Cooley is accelerating IPO work\]\(https:\/\/openai\.com\/index\/cooley-gopublic\) -- Thu, 17 Sep 2026/);
  assert.match(out.content, /- \[Reimagining advertising with AI\]/);
});

test("feed: parses Atom with rel=alternate link preference", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <title>Haki Benita</title>
    <subtitle>Python, SQL, and Django</subtitle>
    <link rel="self" href="https://hakibenita.com/feeds/all.atom.xml"/>
    <link rel="alternate" href="https://hakibenita.com"/>
    <entry><title>Storing Money in Postgres</title>
      <link rel="alternate" href="https://hakibenita.com/posts/storing-money"/>
      <link rel="self" href="https://hakibenita.com/feeds/storing-money.atom"/>
      <updated>2026-08-01T00:00:00Z</updated></entry>
  </feed>`;
  const out = feedToMarkdown(xml);
  assert.ok(out);
  assert.equal(out.title, "Haki Benita");
  assert.match(out.content, /^# Haki Benita \(Atom feed\)/);
  assert.match(out.content, /Python, SQL, and Django/);
  assert.match(out.content, /- \[Storing Money in Postgres\]\(https:\/\/hakibenita\.com\/posts\/storing-money\) -- 2026-08-01T00:00:00Z/);
  assert.ok(!out.content.includes("/feeds/storing-money.atom")); // self link not picked
});

test("feed: caps items at 20 and reports the true total", () => {
  const items = Array.from({ length: 34 }, (_, i) =>
    `<item><title>Post ${i + 1}</title><link>https://example.com/${i + 1}</link></item>`).join("");
  const out = feedToMarkdown(`<rss version="2.0"><channel><title>Blog</title>${items}</channel></rss>`);
  assert.ok(out);
  assert.match(out.content, /Recent items \(showing 20 of 34\):/);
  assert.match(out.content, /- \[Post 20\]/);
  assert.ok(!out.content.includes("[Post 21]"));
});

test("feed: returns null for non-feed XML and malformed payloads", () => {
  assert.equal(feedToMarkdown(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x.com</loc></url></urlset>`), null);
  assert.equal(feedToMarkdown("<html><body>not xml at all</body></html>"), null);
  assert.equal(feedToMarkdown(""), null);
});

test("feed: URL match claims feed shapes and refuses sitemaps", () => {
  const u = (s: string) => new URL(`https://example.com${s}`);
  assert.equal(matchFeedPath(u("/news/rss.xml")), true);
  assert.equal(matchFeedPath(u("/feeds/all.atom.xml")), true);
  assert.equal(matchFeedPath(u("/feed.xml")), true);
  assert.equal(matchFeedPath(u("/feed")), true);
  assert.equal(matchFeedPath(u("/sitemap.xml")), false);
  assert.equal(matchFeedPath(u("/blog/hello-world")), false);
});
