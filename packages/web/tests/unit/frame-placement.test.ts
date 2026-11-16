import { describe, expect, it } from 'vitest';
import { placeInFrame } from '../../src/driver/frames.ts';

const FRAME = { content: { x: 40, y: 30, width: 300, height: 150 }, scale: { x: 1, y: 1 } };

describe('placeInFrame', () => {
  it('shifts a box inside the frame, with no origin when its corner is its own', () => {
    expect(placeInFrame({ rect: { x: 10, y: 20, width: 50, height: 40 } }, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
    });
  });

  it('shifts a bordered node origin with its box', () => {
    expect(placeInFrame({ rect: { x: 10, y: 20, width: 50, height: 40 }, origin: { x: 18, y: 28 } }, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
      origin: { x: 58, y: 58 },
    });
  });

  it('keeps the unclipped corner as the origin of a box the frame clips', () => {
    expect(placeInFrame({ rect: { x: 0, y: -125, width: 200, height: 400 } }, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 40, y: -95 },
    });
  });

  it('keeps a bordered origin unclipped when the frame clips the box', () => {
    expect(placeInFrame({ rect: { x: 0, y: -125, width: 200, height: 400 }, origin: { x: 1, y: -124 } }, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 41, y: -94 },
    });
  });

  it('drops the box and origin of a node outside the frame', () => {
    expect(placeInFrame({ rect: { x: 0, y: 400, width: 20, height: 20 }, origin: { x: 1, y: 401 } }, FRAME)).toEqual({});
  });

  it('scales a box and its origin by the frame before shifting them', () => {
    expect(placeInFrame({ rect: { x: 10, y: 20, width: 50, height: 40 }, origin: { x: 18, y: 28 } }, { ...FRAME, scale: { x: 0.5, y: 2 } })).toEqual({
      rect: { x: 45, y: 70, width: 25, height: 80 },
      origin: { x: 49, y: 86 },
    });
  });

  it('places no box in a frame that lays out none or is turned, nor for a node with none', () => {
    const node = { rect: { x: 10, y: 20, width: 50, height: 40 }, origin: { x: 18, y: 28 } };
    expect(placeInFrame(node, null)).toEqual({});
    expect(placeInFrame(node, { turned: { width: 300, height: 150, inset: { x: 0, y: 0, width: 300, height: 150 }, quad: null } })).toEqual({});
    expect(placeInFrame({}, FRAME)).toEqual({});
  });
});
