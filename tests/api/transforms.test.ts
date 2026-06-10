import { formDataToApiPayload, apiResponseToFormData } from '../../src/api/transforms';
import { FigureFormData, Figure } from '../../src/types';

describe('formDataToApiPayload', () => {
  const minimal: FigureFormData = { manufacturer: 'GSC', name: 'Saber', scale: '1/7' };

  it('maps only the required core fields when nothing optional is set', () => {
    expect(formDataToApiPayload(minimal)).toEqual({
      manufacturer: 'GSC',
      name: 'Saber',
      scale: '1/7',
    });
  });

  it('copies optional string fields when present', () => {
    const payload = formDataToApiPayload({ ...minimal, mfcLink: 'https://x', note: 'hi' });
    expect(payload.mfcLink).toBe('https://x');
    expect(payload.note).toBe('hi');
  });

  it('drops empty-string optional fields (truthiness gate)', () => {
    const payload = formDataToApiPayload({ ...minimal, mfcLink: '', note: '' });
    expect(payload).not.toHaveProperty('mfcLink');
    expect(payload).not.toHaveProperty('note');
  });

  it('preserves numeric zero values (uses !== undefined, not truthiness)', () => {
    const payload = formDataToApiPayload({
      ...minimal,
      rating: 0,
      quantity: 0,
      mfcId: 0,
      wishRating: 0,
    });
    expect(payload.rating).toBe(0);
    expect(payload.quantity).toBe(0);
    expect(payload.mfcId).toBe(0);
    expect(payload.wishRating).toBe(0);
  });

  describe('releases', () => {
    it('maps a provided releases array and defaults isRerelease to false', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        releases: [{ date: '2024-01', price: 12000, currency: 'JPY' }],
      });
      expect(payload.releases).toEqual([
        { date: '2024-01', price: 12000, currency: 'JPY', isRerelease: false },
      ]);
    });

    it('preserves an explicit isRerelease=true', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        releases: [{ date: '2024-01', isRerelease: true }],
      });
      expect(payload.releases?.[0].isRerelease).toBe(true);
    });

    it('falls back to flat release fields when no releases array is given', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        releaseDate: '2023-05',
        releasePrice: 9800,
        releaseCurrency: 'JPY',
      });
      expect(payload.releases).toEqual([
        { date: '2023-05', price: 9800, currency: 'JPY', isRerelease: false },
      ]);
    });

    it('omits releases entirely when neither array nor flat fields are set', () => {
      expect(formDataToApiPayload(minimal)).not.toHaveProperty('releases');
    });

    it('prefers the releases array over flat fields when both are present', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        releases: [{ date: 'from-array' }],
        releaseDate: 'from-flat',
      });
      expect(payload.releases).toHaveLength(1);
      expect(payload.releases?.[0].date).toBe('from-array');
    });
  });

  describe('dimensions', () => {
    it('builds a dimensions object from whichever dimension fields are set', () => {
      const payload = formDataToApiPayload({ ...minimal, heightMm: 250, widthMm: 50, depthMm: 100 });
      expect(payload.dimensions).toEqual({ heightMm: 250, widthMm: 50, depthMm: 100 });
    });

    it('omits dimensions when none are set', () => {
      expect(formDataToApiPayload(minimal)).not.toHaveProperty('dimensions');
    });
  });

  describe('companyRoles', () => {
    it('maps company roles through to the payload', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        companyRoles: [{ companyId: 'c1', companyName: 'GSC', roleId: 'r1', roleName: 'Sculptor' }],
      });
      expect(payload.companyRoles).toEqual([
        { companyId: 'c1', companyName: 'GSC', roleId: 'r1', roleName: 'Sculptor' },
      ]);
    });

    it('backfills the top-level manufacturer from the Manufacturer role', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        manufacturer: 'placeholder',
        companyRoles: [
          { companyId: 'c1', companyName: 'Alter', roleId: 'r1', roleName: 'Manufacturer' },
        ],
      });
      expect(payload.manufacturer).toBe('Alter');
    });

    it('leaves manufacturer untouched when no Manufacturer role is present', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        manufacturer: 'keep',
        companyRoles: [{ companyName: 'X', roleId: 'r1', roleName: 'Distributor' }],
      });
      expect(payload.manufacturer).toBe('keep');
    });
  });

  it('maps artist roles', () => {
    const payload = formDataToApiPayload({
      ...minimal,
      artistRoles: [{ artistId: 'a1', artistName: 'Someone', roleId: 'r1', roleName: 'Sculptor' }],
    });
    expect(payload.artistRoles).toEqual([
      { artistId: 'a1', artistName: 'Someone', roleId: 'r1', roleName: 'Sculptor' },
    ]);
  });

  describe('purchaseInfo + merchant', () => {
    it('builds purchaseInfo and preserves a zero price', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        purchaseDate: '2024-02-01',
        purchasePrice: 0,
        purchaseCurrency: 'USD',
      });
      expect(payload.purchaseInfo).toEqual({ date: '2024-02-01', price: 0, currency: 'USD' });
    });

    it('builds a merchant from name + url', () => {
      const payload = formDataToApiPayload({
        ...minimal,
        merchantName: 'AmiAmi',
        merchantUrl: 'https://a',
      });
      expect(payload.merchant).toEqual({ name: 'AmiAmi', url: 'https://a' });
    });

    it('omits merchant when no merchant name is given', () => {
      const payload = formDataToApiPayload({ ...minimal, merchantUrl: 'https://orphan' });
      expect(payload).not.toHaveProperty('merchant');
    });
  });
});

describe('apiResponseToFormData', () => {
  const minimal: Figure = {
    _id: 'f1',
    manufacturer: 'GSC',
    name: 'Saber',
    scale: '1/7',
    userId: 'u1',
    createdAt: 't',
    updatedAt: 't',
  };

  it('maps only the required core fields when nothing optional is set', () => {
    expect(apiResponseToFormData(minimal)).toEqual({
      manufacturer: 'GSC',
      name: 'Saber',
      scale: '1/7',
    });
  });

  it('flattens the first release to flat fields and preserves the full array', () => {
    const formData = apiResponseToFormData({
      ...minimal,
      releases: [
        { date: '2024-01', price: 12000, currency: 'JPY' },
        { date: '2025-01', price: 13000, currency: 'JPY', isRerelease: true },
      ],
    });
    expect(formData.releaseDate).toBe('2024-01');
    expect(formData.releasePrice).toBe(12000);
    expect(formData.releaseCurrency).toBe('JPY');
    expect(formData.releases).toHaveLength(2);
    expect(formData.releases?.[1].isRerelease).toBe(true);
  });

  it('flattens dimensions and preserves a zero value (!== undefined)', () => {
    const formData = apiResponseToFormData({ ...minimal, dimensions: { heightMm: 0, widthMm: 80 } });
    expect(formData.heightMm).toBe(0);
    expect(formData.widthMm).toBe(80);
  });

  it('filters out company roles that have no companyName', () => {
    const formData = apiResponseToFormData({
      ...minimal,
      companyRoles: [
        { companyId: 'c1', companyName: 'GSC', roleId: 'r1' },
        { companyId: 'c2', roleId: 'r2' },
      ],
    });
    expect(formData.companyRoles).toHaveLength(1);
    expect(formData.companyRoles?.[0].companyName).toBe('GSC');
  });

  it('filters out artist roles that have no artistName', () => {
    const formData = apiResponseToFormData({
      ...minimal,
      artistRoles: [
        { artistId: 'a1', artistName: 'Real', roleId: 'r1' },
        { artistId: 'a2', roleId: 'r2' },
      ],
    });
    expect(formData.artistRoles).toHaveLength(1);
    expect(formData.artistRoles?.[0].artistName).toBe('Real');
  });

  it('flattens purchaseInfo (zero price preserved) and merchant', () => {
    const formData = apiResponseToFormData({
      ...minimal,
      purchaseInfo: { date: '2024-02', price: 0, currency: 'USD' },
      merchant: { name: 'AmiAmi', url: 'https://a' },
    });
    expect(formData.purchaseDate).toBe('2024-02');
    expect(formData.purchasePrice).toBe(0);
    expect(formData.purchaseCurrency).toBe('USD');
    expect(formData.merchantName).toBe('AmiAmi');
    expect(formData.merchantUrl).toBe('https://a');
  });

  it('preserves numeric zero values for rating/quantity/mfcId (!== undefined)', () => {
    const formData = apiResponseToFormData({ ...minimal, rating: 0, quantity: 0, mfcId: 0 });
    expect(formData.rating).toBe(0);
    expect(formData.quantity).toBe(0);
    expect(formData.mfcId).toBe(0);
  });
});

describe('zero is a real value, not absence (forward/reverse round-trip consistency)', () => {
  const minimalForm: FigureFormData = { manufacturer: 'GSC', name: 'Saber', scale: '1/7' };

  it('keeps a zero dimension going to the API (matches the reverse direction)', () => {
    const payload = formDataToApiPayload({ ...minimalForm, heightMm: 0, widthMm: 80 });
    expect(payload.dimensions).toEqual({ heightMm: 0, widthMm: 80 });
  });

  it('keeps a lone zero purchase price', () => {
    const payload = formDataToApiPayload({ ...minimalForm, purchasePrice: 0 });
    expect(payload.purchaseInfo).toEqual({ price: 0 });
  });

  it('keeps a lone zero release price in the flat fallback', () => {
    const payload = formDataToApiPayload({ ...minimalForm, releasePrice: 0 });
    expect(payload.releases).toEqual([{ price: 0, isRerelease: false }]);
  });
});
