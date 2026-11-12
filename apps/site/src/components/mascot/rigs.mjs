/**
 * The mascot's cut pieces put back together, so a page can move one part and leave the rest.
 *
 * The pieces are a pose's own pixels (`apps/site/scripts/cut-mascot-pieces.ts`), each on the pose's canvas: drawn
 * over each other in the order below they are the pose. A joint is a group that turns about a point on that canvas,
 * and what hangs from it turns with it. The markup wraps each joint in a move to its pivot and back, so a stylesheet
 * turns `.j-<name>` with a plain `rotate` and no `transform-origin`, which browsers do not agree on inside an SVG.
 *
 * A joint named twice moves as one: the paw hangs from the sleeve but lies over the head, and the tail rides with
 * the scooter but lies under its wheels.
 *
 * Plain `.mjs`, as the site's other modules a page imports are: `lint:deadcode` reads no `.astro` file, and would
 * call a TypeScript export only pages use dead.
 *
 * A part is a piece, a joint and what hangs from it, or the ground's shadow: an ellipse a page colours for its theme.
 *
 * @typedef {readonly [number, number]} Pivot
 * @typedef {{ piece: { src: string } } | { joint: string, pivot: Pivot, parts: readonly Part[] } | { ground: readonly [number, number, number, number] }} Part
 * @typedef {{ canvas: readonly [number, number], parts: readonly Part[] }} Rig
 */

import idleBody from '@brand/mascot/pieces/idle/body.webp';
import idleEarLeft from '@brand/mascot/pieces/idle/ear-left.webp';
import idleEarRight from '@brand/mascot/pieces/idle/ear-right.webp';
import idleHead from '@brand/mascot/pieces/idle/head.webp';
import idleLegs from '@brand/mascot/pieces/idle/legs.webp';
import idleMark from '@brand/mascot/pieces/idle/mark.webp';
import idleTail from '@brand/mascot/pieces/idle/tail.webp';
import ridingHead from '@brand/mascot/pieces/riding/head.webp';
import ridingLinesBottom from '@brand/mascot/pieces/riding/lines-bottom.webp';
import ridingLinesTop from '@brand/mascot/pieces/riding/lines-top.webp';
import ridingRide from '@brand/mascot/pieces/riding/ride.webp';
import ridingTail from '@brand/mascot/pieces/riding/tail.webp';
import ridingWheelFront from '@brand/mascot/pieces/riding/wheel-front.webp';
import ridingWheelRear from '@brand/mascot/pieces/riding/wheel-rear.webp';
import wavingBody from '@brand/mascot/pieces/waving/body.webp';
import wavingEarLeft from '@brand/mascot/pieces/waving/ear-left.webp';
import wavingEarRight from '@brand/mascot/pieces/waving/ear-right.webp';
import wavingHead from '@brand/mascot/pieces/waving/head.webp';
import wavingLegs from '@brand/mascot/pieces/waving/legs.webp';
import wavingPaw from '@brand/mascot/pieces/waving/paw.webp';
import wavingSleeve from '@brand/mascot/pieces/waving/sleeve.webp';
import wavingSparks from '@brand/mascot/pieces/waving/sparks.webp';
import wavingTail from '@brand/mascot/pieces/waving/tail.webp';

/** @type {(image: { src: string }) => Part} */
const piece = (image) => ({ piece: image });
/** @type {(name: string, pivot: Pivot, parts: readonly Part[]) => Part} */
const joint = (name, pivot, parts) => ({ joint: name, pivot, parts });

/**
 * Each set: the canvas its pieces are drawn on, and its parts back to front. Left and right are the viewer's.
 * `idle` is the cat that stands in the docs' corner and `riding` the hero's while it travels; `waving` is cut and put
 * together and waits for a page.
 * @type {Record<'idle' | 'riding' | 'waving', Rig>}
 */
const RIGS = {
  idle: {
    canvas: [369, 480],
    parts: [
      joint('ground', [190, 474], [{ ground: [190, 474, 86, 8] }]),
      joint('cat', [190, 478], [
        joint('tail', [122, 392], [piece(idleTail)]),
        piece(idleLegs),
        joint('torso', [222, 392], [
          piece(idleBody),
          joint('head', [232, 262], [
            piece(idleHead),
            joint('mark', [249, 86], [piece(idleMark)]),
            joint('ear-left', [118, 88], [piece(idleEarLeft)]),
            joint('ear-right', [300, 72], [piece(idleEarRight)]),
          ]),
        ]),
      ]),
    ],
  },
  riding: {
    canvas: [512, 512],
    parts: [
      joint('lines-top', [120, 140], [piece(ridingLinesTop)]),
      joint('lines-bottom', [90, 370], [piece(ridingLinesBottom)]),
      joint('bike', [300, 472], [
        joint('ride', [300, 440], [joint('tail', [198, 322], [piece(ridingTail)])]),
        joint('wheel-rear', [200, 438], [piece(ridingWheelRear)]),
        joint('wheel-front', [436, 438], [piece(ridingWheelFront)]),
        joint('ride', [300, 440], [piece(ridingRide), joint('head', [330, 268], [piece(ridingHead)])]),
      ]),
    ],
  },
  waving: {
    canvas: [512, 512],
    parts: [
      joint('ground', [248, 468], [{ ground: [248, 468, 112, 12] }]),
      joint('cat', [250, 470], [
        joint('tail', [158, 408], [piece(wavingTail)]),
        piece(wavingLegs),
        joint('torso', [250, 400], [
          piece(wavingBody),
          joint('sleeve', [318, 308], [piece(wavingSleeve)]),
          joint('head', [250, 282], [
            piece(wavingHead),
            joint('ear-left', [125, 136], [piece(wavingEarLeft)]),
            joint('ear-right', [308, 86], [piece(wavingEarRight)]),
          ]),
          joint('sleeve', [318, 308], [joint('paw', [371, 276], [piece(wavingPaw)])]),
          joint('sparks', [432, 192], [piece(wavingSparks)]),
        ]),
      ]),
    ],
  },
};

/** @type {(canvas: readonly [number, number], parts: readonly Part[]) => string} */
function draw(canvas, parts) {
  return parts
    .map((part) => {
      if ('piece' in part) return `<image href="${part.piece.src}" width="${canvas[0]}" height="${canvas[1]}"/>`;
      if ('ground' in part) return `<ellipse class="rig-ground" cx="${part.ground[0]}" cy="${part.ground[1]}" rx="${part.ground[2]}" ry="${part.ground[3]}"/>`;
      const [x, y] = part.pivot;
      return `<g transform="translate(${x} ${y})"><g class="j-${part.joint}"><g transform="translate(${-x} ${-y})">${draw(canvas, part.parts)}</g></g></g>`;
    })
    .join('');
}

/**
 * A set's parts as SVG, to go inside an `<svg>` whose view box holds the set's canvas.
 * @type {(set: keyof typeof RIGS) => string}
 */
export const rigMarkup = (set) => draw(RIGS[set].canvas, RIGS[set].parts);
