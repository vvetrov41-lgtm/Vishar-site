import { describe, expect, it } from 'vitest';
import { readConfig } from '../lib/supabase';

function jwtWithRole(role: string) {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role })}.test-signature`;
}

describe('CRM Supabase configuration', () => {
  it('prefers the current publishable key format', () => {
    expect(readConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    })).toEqual({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      configured: true,
    });
  });

  it('keeps the legacy anon JWT available during migration', () => {
    const key = jwtWithRole('anon');
    expect(readConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_ANON_KEY: key,
    }).publishableKey).toBe(key);
  });

  it('rejects a secret key even when it is put in a publishable variable', () => {
    expect(() => readConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_' + 'secret_leaked',
    })).toThrow(/privileged Supabase key/i);
  });

  it('rejects a legacy service-role JWT even when it is labelled anon', () => {
    expect(() => readConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_ANON_KEY: jwtWithRole('service_role'),
    })).toThrow(/privileged Supabase key/i);
  });

  it('rejects ambiguous key configuration', () => {
    expect(() => readConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      VITE_SUPABASE_ANON_KEY: jwtWithRole('anon'),
    })).toThrow(/either/i);
  });

  it('only sends staff credentials to a hosted Supabase project origin in a production build', () => {
    for (const url of [
      'http://project.supabase.co',
      'https://project.supabase.co.evil.example',
      'https://evil.example',
      'https://user:pass@project.supabase.co',
      'https://project.supabase.co/auth/v1',
    ]) {
      expect(() => readConfig({
        VITE_SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      })).toThrow(/permitted Supabase project root URL/i);
    }

    expect(readConfig({
      VITE_SUPABASE_URL: 'https://Project-Ref.supabase.co/',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    }).url).toBe('https://project-ref.supabase.co');
  });

  it('allows only the standard loopback Supabase URL in Vite development', () => {
    expect(readConfig({
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    }, true).url).toBe('http://127.0.0.1:54321');

    for (const url of [
      'http://127.0.0.1:54321/auth/v1',
      'http://127.0.0.1:8000',
      'http://192.168.1.20:54321',
      'https://localhost:54321',
    ]) {
      expect(() => readConfig({
        VITE_SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }, true)).toThrow(/permitted Supabase project root URL/i);
    }
  });
});
