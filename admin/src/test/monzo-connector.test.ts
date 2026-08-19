import { describe, expect, it } from 'vitest';
import {
  canManageMonzoConnection,
  MONZO_CONNECTOR_ALIASES,
  monzoConnectionResultNotice,
  monzoConnectorAlias,
  monzoSetupUrl,
  readMonzoConnectorOrigin,
} from '../lib/monzo-connector';

describe('Monzo CRM connector boundary', () => {
  it('accepts only the exact production/staging connector hosts and safe local development roots', () => {
    expect(readMonzoConnectorOrigin({
      VITE_MONZO_CONNECTOR_ORIGIN: 'https://monzo.vishartattoo.com/',
    })).toBe('https://monzo.vishartattoo.com');
    expect(readMonzoConnectorOrigin({
      VITE_MONZO_CONNECTOR_ORIGIN: 'https://monzo-staging.vishartattoo.com/',
    })).toBe('https://monzo-staging.vishartattoo.com');
    expect(readMonzoConnectorOrigin({
      VITE_MONZO_CONNECTOR_ORIGIN: 'http://127.0.0.1:8787/',
    }, true)).toBe('http://127.0.0.1:8787');
    expect(readMonzoConnectorOrigin({})).toBe('');

    for (const unsafe of [
      'http://monzo.vishartattoo.com/',
      'https://evil.vishartattoo.com/',
      'https://monzo.vishartattoo.com:8443/',
      'https://user:pass@monzo.vishartattoo.com/',
      'https://monzo.vishartattoo.com/oauth/monzo/setup/vladimir',
      'https://monzo.vishartattoo.com/?next=evil',
      'https://monzo.vishartattoo.com/#fragment',
      'https://monzo.vishartattoo.com.evil.example/',
    ]) {
      expect(() => readMonzoConnectorOrigin({ VITE_MONZO_CONNECTOR_ORIGIN: unsafe })).toThrow(
        'VITE_MONZO_CONNECTOR_ORIGIN must be a permitted Monzo connector root URL.',
      );
    }
  });

  it('builds only closed artist setup routes and never accepts arbitrary slugs', () => {
    expect(monzoConnectorAlias('vladimir')).toBe('vladimir');
    expect(monzoConnectorAlias('kristina')).toBe('kristina');
    expect(monzoConnectorAlias('other')).toBeNull();
    expect(monzoConnectorAlias('../vladimir')).toBeNull();
    expect(monzoConnectorAlias(null)).toBeNull();
    expect(monzoSetupUrl('https://monzo-staging.vishartattoo.com', 'vladimir')).toBe(
      'https://monzo-staging.vishartattoo.com/oauth/monzo/setup/vladimir',
    );
    expect(monzoSetupUrl('https://monzo.vishartattoo.com', 'kristina')).toBe(
      'https://monzo.vishartattoo.com/oauth/monzo/setup/kristina',
    );
  });

  it('keeps bank-account connection management owner-only in the browser affordance', () => {
    expect(canManageMonzoConnection('owner')).toBe(true);
    expect(canManageMonzoConnection('booking_manager')).toBe(false);
    expect(canManageMonzoConnection('read_only')).toBe(false);
    expect(canManageMonzoConnection(null)).toBe(false);
  });

  it('accepts only closed safe CRM return notices for the selected artist', () => {
    expect(
      monzoConnectionResultNotice('?monzo=authorized&artist=vladimir', 'vladimir', 'Vladimir'),
    ).toMatch(/Monzo login is authorised/);
    expect(
      monzoConnectionResultNotice('?monzo=connected&artist=kristina', 'kristina', 'Kristina'),
    ).toBe('Kristina’s Monzo account connection is active.');
    expect(
      monzoConnectionResultNotice('?monzo=disconnected&artist=vladimir', 'vladimir', 'Vladimir'),
    ).toBe('Vladimir’s Monzo account connection is disconnected.');
    expect(
      monzoConnectionResultNotice('?monzo=connected&artist=kristina', 'vladimir', 'Vladimir'),
    ).toBeNull();
    expect(
      monzoConnectionResultNotice('?monzo=token&artist=vladimir', 'vladimir', 'Vladimir'),
    ).toBeNull();
    expect(
      monzoConnectionResultNotice('?monzo=connected&artist=unknown', 'vladimir', 'Vladimir'),
    ).toBeNull();
  });

  it('never invents an artist name when the CRM record has none', () => {
    expect(
      monzoConnectionResultNotice('?monzo=connected&artist=kristina', 'kristina', '   '),
    ).toBeNull();
  });

  it('exposes every routable alias without naming one artist as the default', () => {
    expect([...MONZO_CONNECTOR_ALIASES]).toEqual(['vladimir', 'kristina']);
    for (const alias of MONZO_CONNECTOR_ALIASES) {
      expect(monzoConnectorAlias(alias)).toBe(alias);
      expect(monzoSetupUrl('https://monzo.vishartattoo.com', alias)).toBe(
        `https://monzo.vishartattoo.com/oauth/monzo/setup/${alias}`,
      );
    }
    expect(monzoConnectorAlias('someone-else')).toBeNull();
  });
});
