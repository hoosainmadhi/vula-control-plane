import { fireEvent, render, screen } from '@testing-library/react';
import { StoreFormModal } from './storeModals';
import type { Store, StoreFormValues } from '../types';

/**
 * The store form is where a mis-sent field becomes a mis-configured store: it
 * produces the exact payload the API receives on create and on edit, and the
 * edit path can also move the push credential.
 *
 * The fixture is cast because the modal reads a handful of a large `Store`
 * record; listing all forty fields would obscure which ones this form actually
 * depends on.
 */
const store = {
  id: 7,
  name: 'Gardens Mall',
  slug: 'gardens-mall',
  vertical: 'general',
  environment: 'development',
  baseUrl: 'http://localhost:3299',
  terminalCount: 2,
  licensedTerminalCount: 4,
  terminalNames: ['Front counter', ''],
  companyId: 3,
} as unknown as Store;

const renderModal = (props: Partial<Parameters<typeof StoreFormModal>[0]> = {}) => {
  const onSubmit = jest.fn<void, [StoreFormValues]>();
  render(
    <StoreFormModal
      modal={{ mode: 'edit', store }}
      saving={false}
      error={null}
      companies={[]}
      onClose={() => {}}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onSubmit };
};

describe('StoreFormModal — editing an existing store', () => {
  it('prefills from the store and shows only what that store has', () => {
    renderModal();

    expect(screen.getByDisplayValue('Gardens Mall')).toBeTruthy();
    expect(screen.getByDisplayValue('gardens-mall')).toBeTruthy();
    expect(screen.getByDisplayValue('http://localhost:3299')).toBeTruthy();
    expect(screen.getByDisplayValue('2')).toBeTruthy();
    // Existing till names come back on the roster inputs.
    expect(screen.getByDisplayValue('Front counter')).toBeTruthy();
  });

  it('never echoes the stored control-plane token', () => {
    // The credential is stored for pushes and is never sent to the browser; the
    // field exists to REPLACE it, so it must start empty and say what blank means.
    renderModal();

    const token = screen.getByPlaceholderText('Blank — keep the token already on record');
    expect((token as HTMLInputElement).value).toBe('');
    expect(screen.queryByDisplayValue(/^[0-9a-f]{64}$/)).toBeNull();
  });

  it('emits the edited values, and leaves the untouched ones alone', () => {
    const { onSubmit } = renderModal();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    fireEvent.change(screen.getByPlaceholderText('Till 1'), {
      target: { value: 'Bakery counter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0];
    expect(values.terminalCount).toBe('4');
    expect(values.tillNames?.[0]).toBe('Bakery counter');
    // Untouched fields keep the store's own values, and the slug rides along
    // (the API treats it as immutable).
    expect(values.name).toBe('Gardens Mall');
    expect(values.slug).toBe('gardens-mall');
    expect(values.baseUrl).toBe('http://localhost:3299');
    expect(values.companyId).toBe('3');
    // No credential was typed, so none is offered — an empty string here is what
    // the callers guard on before sending a PUT.
    expect(values.controlPlaneToken).toBe('');
  });

  it('blocks a second submit while the save is in flight', () => {
    // A double-clicked save must not send two PUTs.
    const { onSubmit } = renderModal({ saving: true });

    const button = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses to submit a slug the API would reject anyway', () => {
    const { onSubmit } = renderModal();

    fireEvent.change(screen.getByDisplayValue('gardens-mall'), {
      target: { value: 'Not A Slug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('StoreFormModal — creating a store', () => {
  it('offers the token field, since a new row has none on record yet', () => {
    renderModal({ modal: { mode: 'create' } });

    expect(screen.getByPlaceholderText('64 hex chars — leave blank to generate')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create store' })).toBeTruthy();
    // Till names are an edit-time concern; a new store starts with the defaults.
    expect(screen.queryByPlaceholderText('Till 1')).toBeNull();
  });
});
