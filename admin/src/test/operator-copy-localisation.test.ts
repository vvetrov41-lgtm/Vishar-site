import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { translate } from '../lib/i18n';

const sources = import.meta.glob([
  '../pages/**/*.tsx',
  '../components/**/*.tsx',
], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const TECHNICAL_OR_BRAND_LITERALS = new Set([
  'CRM',
  'EN',
  'Gmail',
  'Google Calendar',
  'Instagram',
  'Meta Cloud API',
  'Monzo',
  'OAuth',
  'RU',
  'Telegram',
  'V',
  'Vishar',
  'Vishar CRM',
  'WhatsApp',
  'https://example.com',
  'https://monzo.com/pay/r/…',
  'meta_review_permission_demo',
  'vishar_crm_bot',
]);

const STRING_UI_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'alt']);

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isAllowedStaticLiteral(value: string): boolean {
  const text = normalise(value);
  if (/^(?:·\s*)?v$/i.test(text)) return true;
  return text.length === 0 || !/[A-Za-z]/.test(text) || TECHNICAL_OR_BRAND_LITERALS.has(text);
}

function sourceFile(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function rawOperatorCopy(path: string, source: string): string[] {
  const file = sourceFile(path, source);
  const failures: string[] = [];

  function add(value: string) {
    const text = normalise(value);
    if (!isAllowedStaticLiteral(text)) failures.push(`${path}: ${text}`);
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) add(node.text);

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file);
      if (STRING_UI_ATTRIBUTES.has(name) && node.initializer && ts.isStringLiteral(node.initializer)) {
        add(node.initializer.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return failures;
}

function missingRussianKeys(path: string, source: string): string[] {
  const file = sourceFile(path, source);
  const failures: string[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 't'
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const key = node.arguments[0].text;
      if (translate('ru', key) === key) failures.push(`${path}: ${key}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return failures;
}

describe('operator-facing localisation boundary', () => {
  it('does not hard-code English UI prose in pages or shared components', () => {
    const failures = Object.entries(sources).flatMap(([path, source]) => rawOperatorCopy(path, source));
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('has a Russian translation for every literal t() key used by operator UI', () => {
    const failures = Object.entries(sources).flatMap(([path, source]) => missingRussianKeys(path, source));
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
