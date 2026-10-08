import { vulaDataRoot, vulaHostPath } from '../services/coolify.js';

describe('the host data tree', () => {
  it('puts stores under their client, and the Head Office beside them', () => {
    expect(vulaHostPath('store', 'urban-threads', 'urban-threads-sandton')).toBe(
      '/data/apps/vula-app/clients/urban-threads/stores/urban-threads-sandton',
    );
    expect(vulaHostPath('ho', 'urban-threads', 'demo-ho')).toBe(
      '/data/apps/vula-app/clients/urban-threads/head-office',
    );
  });

  it('honours VULA_DATA_ROOT', () => {
    process.env.VULA_DATA_ROOT = '/srv/vula-app';
    try {
      expect(vulaDataRoot()).toBe('/srv/vula-app');
      expect(vulaHostPath('store', 'c', 's')).toBe('/srv/vula-app/clients/c/stores/s');
    } finally {
      delete process.env.VULA_DATA_ROOT;
    }
  });
});
