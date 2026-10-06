// Regression: f5ad43e3 (PR #1015) made a long enquiry message render in full
// with no way to fold it, stretching the card across a whole phone screen.

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ClientBrief } from '../components/ClientBrief';

const LONG = 'I would like a large botanical piece across the upper back. '.repeat(10);
const MANY_LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n');

describe('ClientBrief', () => {
  it('shows a short message whole, with no toggle', () => {
    render(<ClientBrief text="A small raven on the wrist." language="ru" />);
    expect(screen.getByText('A small raven on the wrist.').className).toBe('client-brief');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('folds a long message by default, opens it, and folds it again', () => {
    render(<ClientBrief text={LONG} language="ru" />);
    const paragraph = screen.getByText(LONG.trim(), { normalizer: (s) => s.trim() });
    expect(paragraph.className).toBe('client-brief clamped');

    const toggle = screen.getByRole('button', { name: 'Показать полностью' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(paragraph.className).toBe('client-brief');
    expect(screen.getByRole('button', { name: 'Свернуть' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Свернуть' }));
    expect(paragraph.className).toBe('client-brief clamped');
    expect(screen.getByRole('button', { name: 'Показать полностью' })).toBeTruthy();
  });

  it('folds a message with many short lines', () => {
    render(<ClientBrief text={MANY_LINES} language="en" />);
    expect(screen.getByRole('button', { name: 'Show full message' })).toBeTruthy();
  });

  it('opening one message leaves another folded', () => {
    render(
      <>
        <div data-testid="original"><ClientBrief text={LONG} language="ru" /></div>
        <div data-testid="translation"><ClientBrief text={LONG} language="ru" lang="ru" /></div>
      </>,
    );
    fireEvent.click(within(screen.getByTestId('original')).getByRole('button', { name: 'Показать полностью' }));
    expect(within(screen.getByTestId('original')).getByRole('button', { name: 'Свернуть' })).toBeTruthy();
    expect(within(screen.getByTestId('translation')).getByRole('button', { name: 'Показать полностью' })).toBeTruthy();
    expect(within(screen.getByTestId('translation')).getByText(LONG.trim(), { normalizer: (s) => s.trim() }).className)
      .toBe('client-brief clamped');
  });
});
