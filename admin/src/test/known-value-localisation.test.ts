import { describe, expect, it } from 'vitest';
import { localiseKnownValue, localiseSystemSubject } from '../lib/format';

describe('known submitted and system values', () => {
  it('localises controlled booking values without translating client prose', () => {
    expect(localiseKnownValue('Email', 'ru')).toBe('Электронная почта');
    expect(localiseKnownValue('No', 'ru')).toBe('Нет');
    expect(localiseKnownValue('Black and grey realism', 'ru')).toBe('Black and grey realism');
  });

  it('localises the standard follow-up subject in either stored language', () => {
    expect(localiseSystemSubject('Chase this enquiry', 'ru')).toBe('Связаться по этой заявке');
    expect(localiseSystemSubject('Связаться по этой заявке', 'en')).toBe('Chase this enquiry');
  });
});
