/**
 * The words of a line, drawn from their tokens (`commons/lib/markdown/lex.ts`): bold, italic, struck out, marked, code,
 * a link, a formula, a picture, a footnote's number, a line's break.
 *
 * HTML in a line is never markup of the page. A short list of tags that only say how words look (`<kbd>`, `<sub>`,
 * `<sup>`, `<mark>`, `<u>`, `<del>` and the like) is drawn as those elements, with nothing of what the tag carried:
 * no attribute, no style, no handler. `<br>` is a line's break, `<a href>` a link held to the rule every link is
 * held to, a comment is not drawn, and any other tag is the characters that were written.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { InlineMath } from "@/commons/components/ui/viewers/InlineMath";
import { Picture } from "@/commons/components/ui/markdown/Picture";
import { useEmoji } from "@/commons/lib/markdown/emoji";
import { pageInDashboard } from "@/commons/lib/page-link";
import { underDataFolder } from "@/commons/lib/data-folder";
import { useDataFolder } from "@/commons/hooks/use-data-folder";
import { FilePath } from "@/commons/components/ui/FilePath";
import type { Token, Tokens } from "@/commons/lib/markdown/lex";

/**
 * How a block's plain words are drawn: as written, or as the page around it says (an agent's answer draws its agents'
 * tags in their colours, `TagsInMarkdown`). Code is never plain words, so a code span or block stays as it was written.
 */
export const PlainWords = createContext<((text: string) => ReactNode) | null>(null);

function Plain({ text }: { text: string }) {
  const draw = useContext(PlainWords);
  return draw ? draw(text) : text;
}

/** The numbers of a text's footnotes by their names, and what makes their anchors this text's own. */
export const Footnotes = createContext<{ numbers: ReadonlyMap<string, number>; scope: string }>({ numbers: new Map(), scope: "" });

const LINK = "text-primary hover:underline font-medium";

/**
 * A link in the text. To a page of this dashboard (`pageInDashboard`) it opens that page here, in place: the person
 * is in the dashboard already, and the chat that floats over its pages stays open over the one it opened. Any other
 * `http(s)` address opens in a new tab, and a `mailto:` one is the mail it names. What is none of these is drawn as
 * its label, with nothing to click: a `javascript:` link, or a path of the daemon's own, would act in the dashboard's
 * origin with the reader's session.
 *
 * Drawn outside the app's router (a test, a preview), a path is no page of anything, and stays its label.
 */
function Linked({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  // A link an agent wrote to a file of the data folder, by its path: the file in Files.
  const file = underDataFolder(href, useDataFolder());
  const page = !router ? null : file !== null ? `/files?path=${encodeURIComponent(file)}` : pageInDashboard(href, { origin: window.location.origin, basepath: router.basepath });
  if (router && page) {
    return (
      <a
        href={`${router.basepath.replace(/\/+$/, "")}${page}`}
        className={`${LINK} break-words`}
        onClick={(event) => {
          // A plain click only: with a key held, or another button, the browser opens it its own way (a new tab).
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          void router.navigate({ href: page });
        }}
      >
        {children}
      </a>
    );
  }
  if (/^mailto:[^\s<>"']+@[^\s<>"']+$/i.test(href)) {
    return (
      <a href={href} className={`${LINK} break-all`}>
        {children}
      </a>
    );
  }
  if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={`${LINK} inline-flex items-center gap-0.5 break-all`}>
      <span>{children}</span>
      <ExternalLink size={11} className="shrink-0 opacity-70" />
    </a>
  );
}

/** An emoji by its name: the character once the list of names is here and has it, the name as written until then. */
function Emoji({ name, written }: { name: string; written: string }) {
  return useEmoji(name) ?? <Plain text={written} />;
}

/** A footnote where it is said: its number, which goes to the note. */
function NoteRef({ id, written }: { id: string; written: string }) {
  const { numbers, scope } = useContext(Footnotes);
  const number = numbers.get(id);
  // A name no note of this text has: the characters as written.
  if (number === undefined) return <Plain text={written} />;
  return (
    <sup>
      <a
        href={`#${scope}-note-${number}`}
        id={`${scope}-said-${number}`}
        className={`${LINK} px-0.5`}
        aria-label={`Footnote ${number}`}
        onClick={(event) => {
          // Scrolled to here: an address ending in `#..` is the router's to read, and it is no page.
          event.preventDefault();
          document.getElementById(`${scope}-note-${number}`)?.scrollIntoView({ block: "nearest" });
        }}
      >
        {number}
      </a>
    </sup>
  );
}

const CODE = "bg-base-200/90 text-base-content border border-base-content/10 rounded-md px-1.5 py-0.5 font-mono text-[0.85em]";

function code(text: string, key: string): ReactNode {
  const written = text.trim();
  if (/^https?:\/\//i.test(written)) {
    return (
      <a
        key={key}
        href={written}
        target="_blank"
        rel="noreferrer noopener"
        className="bg-base-200/90 text-primary hover:underline border border-base-content/10 rounded-md px-1.5 py-0.5 font-mono text-[0.85em] inline-flex items-center gap-1 break-all"
      >
        <span>{written}</span>
        <ExternalLink size={10} className="shrink-0 opacity-70" />
      </a>
    );
  }
  return (
    // Ink, not the brand blue: code is what was said, and the blue is for signals and actions (the Nouverse design rules).
    // A path of this machine's data folder is a link to that file in Files, for whoever may open it.
    <FilePath key={key} text={written} link="rounded-md outline-none hover:[&>code]:border-primary/50 hover:[&>code]:text-primary focus-visible:ring-2 focus-visible:ring-primary/50">
      <code className={CODE}>{written}</code>
    </FilePath>
  );
}

/** The long dash an agent names (`&mdash;`): by its number, since no words of the dashboard's own hold one. */
const DASH = String.fromCodePoint(0x2014);
/** The few names a writer of prose uses, and a character by its number. What is none of them stays as written. */
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: DASH, ndash: "\u2013", larr: "←", rarr: "→", uarr: "↑", darr: "↓", times: "×", divide: "÷", middot: "·", bull: "•", deg: "°", plusmn: "±", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", check: "✓", cross: "✗" };

function entities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name] ?? NAMED[name.toLowerCase()] ?? whole;
    const point = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
  });
}

/** The tags that say how words look, each drawn as itself with nothing it carried. */
const LOOKS: Record<string, (children: ReactNode, key: string) => ReactNode> = {
  kbd: (children, key) => <kbd key={key} className="kbd kbd-sm font-mono">{children}</kbd>,
  sub: (children, key) => <sub key={key}>{children}</sub>,
  sup: (children, key) => <sup key={key}>{children}</sup>,
  mark: (children, key) => <mark key={key} className="rounded-sm bg-warning/30 px-0.5 text-inherit">{children}</mark>,
  u: (children, key) => <u key={key}>{children}</u>,
  ins: (children, key) => <ins key={key}>{children}</ins>,
  s: (children, key) => <del key={key} className="text-base-content/65">{children}</del>,
  del: (children, key) => <del key={key} className="text-base-content/65">{children}</del>,
  strike: (children, key) => <del key={key} className="text-base-content/65">{children}</del>,
  b: (children, key) => <strong key={key} className="font-semibold text-base-content">{children}</strong>,
  strong: (children, key) => <strong key={key} className="font-semibold text-base-content">{children}</strong>,
  i: (children, key) => <em key={key} className="italic text-base-content/90">{children}</em>,
  em: (children, key) => <em key={key} className="italic text-base-content/90">{children}</em>,
  small: (children, key) => <small key={key}>{children}</small>,
  code: (children, key) => <code key={key} className={CODE}>{children}</code>,
  abbr: (children, key) => <span key={key}>{children}</span>,
  cite: (children, key) => <cite key={key}>{children}</cite>,
  q: (children, key) => <q key={key}>{children}</q>,
  span: (children, key) => <span key={key}>{children}</span>,
};

const OPENING = /^<([a-z][a-z0-9]*)(\s[^<>]*)?>$/i;
const CLOSING = /^<\/([a-z][a-z0-9]*)\s*>$/i;
const attribute = (attributes: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes)?.slice(1).find((value) => value !== undefined) ?? null;

/** Where the tag opened at `from` is closed among `tokens`, past any of its own kind inside it, or -1. */
function closes(tokens: readonly Token[], from: number, name: string): number {
  let depth = 1;
  for (let at = from + 1; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.type !== "html") continue;
    if (OPENING.exec(token.raw.trim())?.[1]?.toLowerCase() === name) depth += 1;
    else if (CLOSING.exec(token.raw.trim())?.[1]?.toLowerCase() === name && --depth === 0) return at;
  }
  return -1;
}

/** A line's tokens as what is drawn. */
export function inline(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    const key = `${keyPrefix}-${at}`;
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens?.length) out.push(...inline(text.tokens, key));
        else out.push(<Plain key={key} text={entities(text.text)} />);
        break;
      }
      case "escape":
        out.push(<Plain key={key} text={(token as Tokens.Escape).text} />);
        break;
      case "strong":
        out.push(LOOKS.strong!(inline((token as Tokens.Strong).tokens, key), key));
        break;
      case "em":
        out.push(LOOKS.em!(inline((token as Tokens.Em).tokens, key), key));
        break;
      case "del":
        out.push(LOOKS.del!(inline((token as Tokens.Del).tokens, key), key));
        break;
      case "mark":
        out.push(LOOKS.mark!(inline(token.tokens ?? [], key), key));
        break;
      case "codespan":
        out.push(code((token as Tokens.Codespan).text, key));
        break;
      case "br":
        out.push(<br key={key} />);
        break;
      case "link": {
        const link = token as Tokens.Link;
        out.push(
          <Linked key={key} href={link.href}>
            {inline(link.tokens, key)}
          </Linked>,
        );
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        out.push(<Picture key={key} src={image.href} alt={image.text} />);
        break;
      }
      case "mathInline":
        out.push(<InlineMath key={key} tex={token.text as string} written={token.raw} />);
        break;
      case "emoji":
        out.push(<Emoji key={key} name={token.name as string} written={token.raw} />);
        break;
      case "footnoteRef":
        out.push(<NoteRef key={key} id={token.id as string} written={token.raw} />);
        break;
      case "checkbox":
        break;
      case "html": {
        const raw = token.raw.trim();
        if (raw.startsWith("<!--")) break;
        const opened = OPENING.exec(raw);
        const name = opened?.[1]?.toLowerCase() ?? "";
        if (/^<br\s*\/?>$/i.test(raw)) {
          out.push(<br key={key} />);
          break;
        }
        if (name === "img") {
          const src = attribute(opened![2] ?? "", "src");
          if (src) {
            out.push(<Picture key={key} src={src} alt={attribute(opened![2] ?? "", "alt") ?? ""} />);
            break;
          }
        }
        const end = opened && (LOOKS[name] || name === "a") ? closes(tokens, at, name) : -1;
        if (end < 0) {
          // No tag of the list, or one never closed: the characters that were written.
          out.push(<Plain key={key} text={token.raw} />);
          break;
        }
        const inside = inline(tokens.slice(at + 1, end), key);
        const href = name === "a" ? attribute(opened![2] ?? "", "href") : null;
        out.push(
          name === "a" ? (
            <Linked key={key} href={href ?? ""}>
              {inside}
            </Linked>
          ) : (
            LOOKS[name]!(inside, key)
          ),
        );
        at = end;
        break;
      }
      default:
        out.push(<Plain key={key} text={token.raw} />);
    }
  }
  return out;
}
