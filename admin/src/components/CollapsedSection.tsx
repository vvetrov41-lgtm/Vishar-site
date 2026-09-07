// A section that says how much is in it before it is opened.
//
// The enquiry page used to spend most of a phone screen on sections that were
// empty: three headings, three "No notes yet" cards, and the reference images -
// the one thing an artist actually needs - somewhere below the fold. A count in
// the summary answers the only question a closed section has to answer, and
// costs one line instead of a card.
//
// Reference images are deliberately not one of these. They are what the artist
// came to look at.

import type { ReactNode } from 'react';

export function CollapsedSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Shown beside the title. Zero is worth saying: it means nothing is waiting. */
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="card collapsed-section" open={defaultOpen}>
      <summary>
        <span className="collapsed-section-title">{title}</span>
        <span className="collapsed-section-count">{count}</span>
      </summary>
      <div className="collapsed-section-body">{children}</div>
    </details>
  );
}
