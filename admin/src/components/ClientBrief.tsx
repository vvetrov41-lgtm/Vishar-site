import { useState } from 'react';

/**
 * A long client message costs a whole phone screen. Show the opening and let
 * the reader ask for the rest; nothing is cut from the text itself.
 *
 * Restored from before f5ad43e3 (PR #1015), which replaced it with the full
 * text and dropped the toggle. Each instance keeps its own state, so opening
 * one message never opens another.
 */
export const BRIEF_PREVIEW_CHARS = 420;
export const BRIEF_PREVIEW_LINES = 8;

export function ClientBrief({
  text,
  language,
  lang,
}: {
  text: string | null;
  language: 'en' | 'ru';
  /** Language of the text itself, for screen readers (e.g. a translation). */
  lang?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <p style={{ margin: '4px 0 0' }}>—</p>;

  const long = text.length > BRIEF_PREVIEW_CHARS || text.split('\n').length > BRIEF_PREVIEW_LINES;
  return (
    <>
      <p
        lang={lang}
        className={long && !expanded ? 'client-brief clamped' : 'client-brief'}
        style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}
      >
        {text}
      </p>
      {long ? (
        <button type="button" className="link-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded
            ? (language === 'ru' ? 'Свернуть' : 'Show less')
            : (language === 'ru' ? 'Показать полностью' : 'Show full message')}
        </button>
      ) : null}
    </>
  );
}
