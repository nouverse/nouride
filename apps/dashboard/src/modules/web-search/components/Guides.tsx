/**
 * How to get what each provider needs, on the page that needs it.
 *
 * The step a person is most likely to give up on is the one that happens somewhere else — signing up
 * for a key, standing up a server — so the steps are here, with the links, and with the two SearXNG
 * settings that every fresh instance gets wrong.
 */

import type { ReactNode } from "react";
import { ExternalLink, Lightbulb } from "lucide-react";
import { Details } from "@/commons/components/ui/Details";

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-base-content/75 marker:font-semibold marker:text-base-content/50">{children}</ol>;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link link-primary inline-flex items-center gap-0.5 font-medium">
      {children}
      <ExternalLink size={11} />
    </a>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-base-content/[0.08] bg-base-200/60 p-3 font-mono text-[11px] leading-relaxed text-base-content/80">
      {children}
    </pre>
  );
}

function Guide({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-2xl border border-info/20 bg-info/5 p-4">
      <p className="flex items-center gap-2 text-xs font-semibold text-info">
        <Lightbulb size={14} /> {title}
      </p>
      {children}
    </div>
  );
}

export function BraveGuide() {
  return (
    <Guide title="Getting a Brave Search API key">
      <Steps>
        <li>
          Open <Link href="https://brave.com/search/api/">brave.com/search/api</Link> and sign in, or create an account.
        </li>
        <li>
          Subscribe to a plan. There is a free one; check the current limits on their pricing page. Brave may ask for a
          card to verify you even on the free plan.
        </li>
        <li>
          In the <Link href="https://api-dashboard.search.brave.com/app/keys">API keys</Link> section, add a key and copy it.
        </li>
        <li>Paste it below and press Test. It is stored in Secrets when you save.</li>
      </Steps>
    </Guide>
  );
}

export function SearxngGuide() {
  return (
    <Guide title="Running SearXNG beside Nouride">
      <p className="text-xs leading-relaxed text-base-content/75">
        SearXNG is a search engine you run yourself, beside Nouride. Whoever runs this server can set it up with the steps
        below, then enter its address here and press Test. Public ones almost always refuse, so it has to be your own.
      </p>
      {/* The set-up itself is for whoever runs the server (0.8.19). */}
      <Details>
      <Steps>
        <li>
          Add it to the same <code>docker-compose.yml</code> as Nouride, or follow the{" "}
          <Link href="https://docs.searxng.org/admin/installation-docker.html">SearXNG Docker guide</Link>:
        </li>
      </Steps>
      <Code>{`searxng:
  image: searxng/searxng
  environment:
    - SEARXNG_BASE_URL=http://searxng:8080/
  volumes:
    - ./searxng:/etc/searxng`}</Code>
      <Steps>
        <li value={2}>
          In its <code>settings.yml</code>, turn on JSON and turn off the rate limiter. A fresh instance answers HTML and
          refuses server-side callers with 429:
        </li>
      </Steps>
      <Code>{`search:
  formats: [html, json]
server:
  limiter: false`}</Code>
      <Steps>
        <li value={3}>
          Enter its search URL below, e.g. <code>http://searxng:8080/search</code>, and press Test. Public instances
          almost always block this, so use your own.
        </li>
      </Steps>
      </Details>
    </Guide>
  );
}

export function CustomGuide() {
  return (
    <Guide title="What another search service is for">
      <Steps>
        <li>Any service that works like Brave's search: one you run yourself, or one that adds the key for you.</li>
        <li>If the service adds the key itself, leave the key empty.</li>
        <li>For a SearXNG of your own, choose SearXNG instead. It works differently.</li>
      </Steps>
      <Details>
        <p>
          It accepts Brave Search API requests (<code>?q=…&amp;count=…</code>) and answers in Brave's JSON: a proxy you run, or a
          gateway that adds the key upstream.
        </p>
      </Details>
    </Guide>
  );
}

export function FreeGuide() {
  return (
    <Guide title="How the free sources work">
      <Steps>
        <li>
          Every search asks several public sources at once (DuckDuckGo, Bing, Google News, Wikipedia, Reddit) and
          merges what comes back, usually in about a second.
        </li>
        <li>
          Agents add GitHub, Stack Overflow, npm, MDN and Hacker News for programming questions, and arXiv for
          research.
        </li>
        <li>No image search, and scraped results can get thin when a source rate-limits. A Brave key fixes both.</li>
      </Steps>
    </Guide>
  );
}
