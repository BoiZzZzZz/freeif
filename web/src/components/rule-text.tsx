// Gemini's rule for a result, word for word. Gemini writes the one link in it the Markdown way,
// "[full rules](https://...)": it is shown here as a link.
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function RuleText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    parts.push(text.slice(from, match.index));
    parts.push(
      <a key={match.index} className="underline underline-offset-2" href={match[2]} target="_blank" rel="noreferrer">
        {match[1]}
      </a>,
    );
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
