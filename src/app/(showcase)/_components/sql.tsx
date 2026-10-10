import { Fragment } from 'react';

const KEYWORD =
  /\b(perform|select|from|join|on|where|for|update|of|create|unique|index|in|and|insert|into|conflict|do|nothing|not|exists|is|null|set)\b/gi;

/**
 * A few lines of real SQL from the repository, set in mono with the keywords in coral and the
 * comments muted. A highlighter would be a dependency for twelve lines; this is enough.
 */
export function Sql({ code, source }: { code: string; source: string }) {
  return (
    <figure className="zx-sql">
      <pre>
        <code>
          {code.split('\n').map((line, index) => (
            <Fragment key={index}>
              {highlight(line)}
              {'\n'}
            </Fragment>
          ))}
        </code>
      </pre>
      <figcaption className="zx-sql__source">{source}</figcaption>
    </figure>
  );
}

function highlight(line: string): React.ReactNode {
  const at = line.indexOf('--');
  const code = at === -1 ? line : line.slice(0, at);
  const comment = at === -1 ? '' : line.slice(at);
  const parts = code.split(/('[^']*')/);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("'") ? (
          <span key={index} className="zx-sql__string">
            {part}
          </span>
        ) : (
          <Fragment key={index}>
            {part.split(KEYWORD).map((word, j) =>
              j % 2 === 1 ? (
                <span key={j} className="zx-sql__keyword">
                  {word}
                </span>
              ) : (
                word
              ),
            )}
          </Fragment>
        ),
      )}
      {comment && <span className="zx-sql__comment">{comment}</span>}
    </>
  );
}
