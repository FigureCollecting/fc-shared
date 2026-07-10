// Contract test (testing doctrine Rule 4: compile-error guarantee — see
// tests/mocks/builders.ts) for the display+grounding metadata that the
// Python image-manager service PRODUCES and fc-mobile CONSUMES. src/types is
// the single TypeScript source of truth for this shape; the Python side
// mirrors these exact field names/types. This file exists to make a drift
// in either the shape or its optionality a `tsc --noEmit` failure, not a
// silent runtime mismatch.
import { Figure, FigureDisplayMeta } from '../../src/types';
import { aFigure } from '../mocks/builders';

describe('Figure.displayMeta contract (image-manager -> fc-mobile)', () => {
  const meta: FigureDisplayMeta = {
    matted: true,
    matteImageId: 'img-abc123',
    matteVersionId: 'v-7',
    bottomMarginFrac: 0.0421,
    contactBand: { centerXFrac: 0.52, widthFrac: 0.31 },
    thumbhash: 'L6Pj0^jE.AyE_3t7t7R**0o#DgR4',
    dominantColor: '#8899AA',
  };

  it('type-checks a fully-populated representative object against the frozen shape', () => {
    const figure: Figure = { ...aFigure(), displayMeta: meta };
    expect(figure.displayMeta).toEqual(meta);
  });

  it('type-checks with every displayMeta field omitted (all-optional contract)', () => {
    const figure: Figure = { ...aFigure(), displayMeta: {} };
    expect(figure.displayMeta).toEqual({});
  });

  it('type-checks a Figure with no displayMeta at all (backward compatible)', () => {
    const figure: Figure = aFigure();
    expect(figure.displayMeta).toBeUndefined();
  });

  it('round-trips through JSON without loss or coercion', () => {
    const figure: Figure = { ...aFigure(), displayMeta: meta };
    const roundTripped = JSON.parse(JSON.stringify(figure)) as Figure;

    expect(roundTripped.displayMeta).toEqual(meta);
    expect(typeof roundTripped.displayMeta?.matted).toBe('boolean');
    expect(typeof roundTripped.displayMeta?.matteImageId).toBe('string');
    expect(typeof roundTripped.displayMeta?.matteVersionId).toBe('string');
    expect(typeof roundTripped.displayMeta?.bottomMarginFrac).toBe('number');
    expect(typeof roundTripped.displayMeta?.contactBand?.centerXFrac).toBe('number');
    expect(typeof roundTripped.displayMeta?.contactBand?.widthFrac).toBe('number');
    expect(typeof roundTripped.displayMeta?.thumbhash).toBe('string');
    expect(typeof roundTripped.displayMeta?.dominantColor).toBe('string');
  });
});
